import { tool, type StructuredToolInterface } from '../../ai/tools'
import { z } from 'zod'

/**
 * Agent Teams / super agent — shared task board (isolated by topicId, persisted as a snapshot
 * plus an event log).
 *
 * - Team = the root session (a topic) + its foreground/background subagent tree, with **no new
 *   agent type**;
 * - Collaboration runs on one shared task board: tasks have
 *   subject/description/status/owner/blockedBy/writeScopes, and the main agent (lead) and
 *   subagents (members) read and write the same board through the team_task_* tools;
 * - Tasks use revision-based CAS: claim/update carries the revision that was seen, a conflict
 *   fails and makes the model re-read, so two subagents cannot change the same row at once;
 * - writeScopes is only an **advisory** write-range hint (to help the model avoid conflicts), not
 *   a lock.
 *
 * Persistence: the whole board snapshot is written to the `team_board` table (one JSON row per
 * topic, including deleted tombstones); every create/claim/complete/update/delete also appends a
 * `team_task_event` event (recent activity for the collaboration panel). The storage adapter is
 * injected at system startup (`setPersistence`), so the runtime does not depend on the database
 * directly; after a restart, the first access to the board (IPC pull / team_task_* tools) lazily
 * loads it and restores revision/counter/tasks.
 */

export type TeamTaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted'

/** Caller identity: the main agent is lead, subagents are members (passed via each graph's configurable) */
export interface TeamActor {
  id: string
  name: string
  isLead: boolean
}

export interface TeamTask {
  id: string
  revision: number
  subject: string
  description: string
  status: TeamTaskStatus
  ownerId?: string
  ownerName?: string
  blockedBy: string[]
  writeScopes: string[]
  createdBy: { id: string; name: string }
  createdAt: number
  updatedAt: number
}

/** Board task view (with dependency readiness, shared by the renderer and tool output) */
export interface TeamTaskView extends TeamTask {
  /** Whether every dependency is complete (false if blockedBy has an unfinished/missing/deleted id) */
  ready: boolean
  /** Unfinished dependency ids (non-empty when ready=false) */
  blockers: string[]
}

/** Board snapshot (same shape for IPC pushes and team tool output) */
export interface TeamBoardSnapshot {
  topicId: number
  /** Incremented on every change: the renderer uses it to discard out-of-order stale snapshots */
  revision: number
  tasks: TeamTaskView[]
}

export interface TeamTaskCreateInput {
  subject: string
  description?: string
  blockedBy?: string[]
  writeScopes?: string[]
}

export interface TeamTaskUpdateInput {
  status?: TeamTaskStatus
  subject?: string
  description?: string
  ownerId?: string
  ownerName?: string
  blockedBy?: string[]
  writeScopes?: string[]
}

/** Status ordering: in progress → pending → completed (within a group, most recently updated first) */
const STATUS_RANK: Record<TeamTaskStatus, number> = {
  in_progress: 0,
  pending: 1,
  completed: 2,
  deleted: 3
}

/** Allowed status transitions (claiming goes through claim; everything else through update) */
const ALLOWED_TRANSITIONS: Record<TeamTaskStatus, TeamTaskStatus[]> = {
  pending: ['in_progress', 'deleted'],
  in_progress: ['completed', 'pending', 'deleted'],
  completed: ['in_progress', 'deleted'],
  deleted: []
}

/** Per-board task cap: prevents the model from creating tasks without bound and blowing up memory/UI */
const MAX_TASKS_PER_TOPIC = 200

interface Board {
  revision: number
  counter: number
  tasks: Map<string, TeamTask>
}

/** Persisted snapshot (same shape as Board, with tasks as a JSON-serializable array) */
export interface TeamBoardPersistedSnapshot {
  revision: number
  counter: number
  tasks: TeamTask[]
}

/**
 * Task board storage adapter, wired at system startup (the DB implementation lives in
 * `system/harness.ts`).
 * The runtime only depends on this interface — offline regression (without a database) runs
 * without injecting it.
 */
export interface TeamBoardPersistence {
  load: (topicId: number) => Promise<TeamBoardPersistedSnapshot | null>
  save: (topicId: number, snapshot: TeamBoardPersistedSnapshot) => Promise<void>
  remove: (topicId: number) => Promise<void>
  /** Append one task event (optional: silently skipped in offline regression or when no event table is wired) */
  appendEvent?: (event: TeamTaskEventInput) => Promise<void>
  /** Delete the events under a topic (optional; the foreign-key cascade on topic deletion is the main path) */
  removeEvents?: (topicId: number) => Promise<void>
}

/** Task event (recent activity for the collaboration panel / later auditing) */
export type TeamTaskEventAction = 'created' | 'claimed' | 'completed' | 'updated' | 'deleted'

export interface TeamTaskEventInput {
  topicId: number
  taskId: string
  action: TeamTaskEventAction
  actorId: string
  actorName: string
  subject: string
  taskRevision: number
}

function notFound(taskId: string): Error {
  return new Error(`task ${taskId} does not exist on this team board`)
}

export class TeamTaskStore {
  private readonly boards = new Map<number, Board>()
  /** Topics already attempted to load from persistence (also marked without persistence: in-memory mode has no remote data) */
  private readonly loaded = new Set<number>()
  /** Deduplicates concurrent loads of the same topic (the DB is read once when tool/IPC calls arrive together) */
  private readonly loading = new Map<number, Promise<void>>()
  private persistence?: TeamBoardPersistence

  /**
   * Change callback (used by the IPC layer for throttling/broadcasting).
   * Every change pushes the **full snapshot**: the board is small (capped at 200), so replacing
   * the whole board is simpler and more reliable than an incremental protocol.
   */
  onChange?: (snapshot: TeamBoardSnapshot) => void

  /** Install/remove the board storage adapter (wired at system startup; memory is cleared externally when switching accounts) */
  setPersistence(persistence?: TeamBoardPersistence): void {
    this.persistence = persistence
    this.loaded.clear()
    this.loading.clear()
  }

  /**
   * Lazily load a topic's board (called by IPC pulls and by team tools before they operate).
   * Without a persistence adapter (offline regression) or when loading fails, the in-memory board
   * stays empty and board operations are not blocked.
   */
  async ensureLoaded(topicId: number): Promise<void> {
    if (this.loaded.has(topicId)) return
    const persistence = this.persistence
    if (!persistence) {
      this.loaded.add(topicId)
      return
    }
    const pending = this.loading.get(topicId)
    if (pending) return pending
    const load = (async () => {
      try {
        const saved = await persistence.load(topicId)
        if (saved) {
          const board = this.board(topicId)
          board.revision = saved.revision
          board.counter = saved.counter
          board.tasks.clear()
          for (const task of saved.tasks) {
            if (task && typeof task.id === 'string') board.tasks.set(task.id, task)
          }
        }
        this.loaded.add(topicId)
      } catch {
        // Do not mark loaded on read failure: retry on the next access (the board never stays
        // "permanently empty")
      } finally {
        this.loading.delete(topicId)
      }
    })()
    this.loading.set(topicId, load)
    return load
  }

  /** Append a task event (fire-and-forget; silently skipped when no event table is wired) */
  private recordEvent(
    topicId: number,
    action: TeamTaskEventAction,
    actor: TeamActor | { id: string; name: string },
    task: TeamTask
  ): void {
    const persistence = this.persistence
    if (!persistence?.appendEvent) return
    void persistence
      .appendEvent({
        topicId,
        taskId: task.id,
        action,
        actorId: actor.id,
        actorName: actor.name,
        subject: task.subject,
        taskRevision: task.revision
      })
      .catch(() => {
        // Events only serve activity display/auditing: a failed write must not affect the board
      })
  }

  /** Persist the whole-board snapshot (fire-and-forget: a storage failure must not block tool calls) */
  private persist(topicId: number): void {
    const persistence = this.persistence
    const board = this.boards.get(topicId)
    if (!persistence || !board) return
    void persistence
      .save(topicId, {
        revision: board.revision,
        counter: board.counter,
        tasks: [...board.tasks.values()]
      })
      .catch(() => {
        // Fail silently: memory remains authoritative for this process, and the next change
        // retries
      })
  }

  private board(topicId: number): Board {
    let board = this.boards.get(topicId)
    if (!board) {
      board = { revision: 0, counter: 0, tasks: new Map() }
      this.boards.set(topicId, board)
    }
    return board
  }

  /** Dependency readiness check: every id in blockedBy must be an existing, completed task */
  private checkReady(task: TeamTask, board: Board): { ready: boolean; blockers: string[] } {
    const blockers: string[] = []
    for (const dependencyId of task.blockedBy) {
      const dependency = board.tasks.get(dependencyId)
      if (!dependency || dependency.status !== 'completed') blockers.push(dependencyId)
    }
    return { ready: blockers.length === 0, blockers }
  }

  private view(task: TeamTask, board: Board): TeamTaskView {
    const { ready, blockers } = this.checkReady(task, board)
    return {
      ...task,
      blockedBy: [...task.blockedBy],
      writeScopes: [...task.writeScopes],
      ready,
      blockers
    }
  }

  private sortedViews(board: Board): TeamTaskView[] {
    return [...board.tasks.values()]
      .filter((task) => task.status !== 'deleted')
      .sort((a, b) => {
        const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status]
        return rank !== 0 ? rank : b.updatedAt - a.updatedAt
      })
      .map((task) => this.view(task, board))
  }

  /** Current board snapshot (including revision) */
  snapshot(topicId: number): TeamBoardSnapshot {
    const board = this.board(topicId)
    return { topicId, revision: board.revision, tasks: this.sortedViews(board) }
  }

  /** Task list (excluding deleted) */

  private touch(board: Board): void {
    board.revision += 1
  }

  private broadcast(topicId: number): void {
    this.persist(topicId)
    this.onChange?.(this.snapshot(topicId))
  }

  /** Create a task (anyone may create): pending and unowned by default */
  create(topicId: number, input: TeamTaskCreateInput, actor: TeamActor): TeamTaskView {
    const board = this.board(topicId)
    const activeTaskCount = [...board.tasks.values()].filter(
      (task) => task.status !== 'deleted'
    ).length
    if (activeTaskCount >= MAX_TASKS_PER_TOPIC) {
      throw new Error(`the team board is full (${MAX_TASKS_PER_TOPIC} tasks)`)
    }
    const subject = input.subject?.trim()
    if (!subject) throw new Error('subject is required')
    const blockedBy = input.blockedBy ? [...new Set(input.blockedBy.filter(Boolean))] : []
    for (const dependencyId of blockedBy) {
      if (!board.tasks.has(dependencyId)) {
        throw new Error(`blockedBy refers to unknown task ${dependencyId}`)
      }
    }
    const writeScopes = input.writeScopes ? [...new Set(input.writeScopes.filter(Boolean))] : []
    board.counter += 1
    const now = Date.now()
    const task: TeamTask = {
      id: `task-${board.counter}`,
      revision: 1,
      subject,
      description: (input.description ?? '').trim(),
      status: 'pending',
      blockedBy,
      writeScopes,
      createdBy: { id: actor.id, name: actor.name },
      createdAt: now,
      updatedAt: now
    }
    board.tasks.set(task.id, task)
    this.recordEvent(topicId, 'created', actor, task)
    this.touch(board)
    this.broadcast(topicId)
    return this.view(task, board)
  }

  /**
   * Claim a task: it must be pending, unowned and dependency-ready; on success it becomes
   * in_progress with owner = the caller.
   * When expectedRevision is provided, do a CAS (the revision the model got from list).
   */
  claim(
    topicId: number,
    taskId: string,
    actor: TeamActor,
    expectedRevision?: number
  ): TeamTaskView {
    const board = this.board(topicId)
    const task = board.tasks.get(taskId)
    if (!task) throw notFound(taskId)
    if (typeof expectedRevision === 'number' && task.revision !== expectedRevision) {
      throw new Error(
        `revision mismatch for ${taskId}: expected ${expectedRevision}, current ${task.revision}; re-read the board`
      )
    }
    if (task.status !== 'pending') {
      throw new Error(`task ${taskId} is ${task.status}, not pending`)
    }
    if (task.ownerId) {
      throw new Error(`task ${taskId} is already owned by ${task.ownerName ?? task.ownerId}`)
    }
    const { ready, blockers } = this.checkReady(task, board)
    if (!ready) {
      throw new Error(`task ${taskId} is blocked by ${blockers.join(', ')}`)
    }
    task.status = 'in_progress'
    task.ownerId = actor.id
    task.ownerName = actor.name
    task.revision += 1
    task.updatedAt = Date.now()
    this.touch(board)
    this.recordEvent(topicId, 'claimed', actor, task)
    this.broadcast(topicId)
    return this.view(task, board)
  }

  /**
   * Update a task:
   * - Permissions: the lead can change any task and reassign the owner; a member can only change
   *   tasks it owns and cannot reassign;
   * - only the lead can set ownerId/ownerName (reassignment); an empty string releases the task;
   * - status transitions must be legal (see ALLOWED_TRANSITIONS), deleting = status 'deleted';
   * - when expectedRevision is provided, do a CAS.
   */
  update(
    topicId: number,
    taskId: string,
    patch: TeamTaskUpdateInput,
    actor: TeamActor,
    expectedRevision?: number
  ): TeamTaskView {
    const board = this.board(topicId)
    const task = board.tasks.get(taskId)
    if (!task) throw notFound(taskId)
    if (task.status === 'deleted') throw new Error(`task ${taskId} is deleted`)
    if (typeof expectedRevision === 'number' && task.revision !== expectedRevision) {
      throw new Error(
        `revision mismatch for ${taskId}: expected ${expectedRevision}, current ${task.revision}; re-read the board`
      )
    }
    const isOwner = Boolean(task.ownerId && task.ownerId === actor.id)
    if (!actor.isLead && !isOwner) {
      throw new Error(`only the lead or the task owner can update ${taskId}`)
    }

    const nextStatus = patch.status
    if (nextStatus !== undefined && nextStatus !== task.status) {
      if (!ALLOWED_TRANSITIONS[task.status].includes(nextStatus)) {
        throw new Error(`cannot move ${taskId} from ${task.status} to ${nextStatus}`)
      }
    }

    if (patch.ownerId !== undefined || patch.ownerName !== undefined) {
      if (!actor.isLead) throw new Error('only the lead can reassign the owner')
      const ownerId = (patch.ownerId ?? '').trim()
      if (!ownerId) {
        task.ownerId = undefined
        task.ownerName = undefined
      } else {
        task.ownerId = ownerId
        task.ownerName = (patch.ownerName ?? ownerId).trim() || ownerId
      }
    }

    if (patch.status === 'deleted' && !actor.isLead && !isOwner) {
      throw new Error(`only the lead or the task owner can delete ${taskId}`)
    }

    if (patch.subject !== undefined) {
      const subject = patch.subject.trim()
      if (!subject) throw new Error('subject must not be empty')
      task.subject = subject
    }
    if (patch.description !== undefined) task.description = patch.description.trim()
    if (patch.blockedBy !== undefined) {
      const blockedBy = [...new Set(patch.blockedBy.filter(Boolean))]
      for (const dependencyId of blockedBy) {
        if (dependencyId === taskId) throw new Error('a task cannot block itself')
        if (!board.tasks.has(dependencyId)) {
          throw new Error(`blockedBy refers to unknown task ${dependencyId}`)
        }
      }
      task.blockedBy = blockedBy
    }
    if (patch.writeScopes !== undefined) {
      task.writeScopes = [...new Set(patch.writeScopes.filter(Boolean))]
    }

    if (nextStatus !== undefined) {
      task.status = nextStatus
      // Keep the owner on completion (traceable history); clear the owner on deletion (no longer
      // owned by anyone)
      if (nextStatus === 'deleted') {
        task.ownerId = undefined
        task.ownerName = undefined
      }
    }
    task.revision += 1
    task.updatedAt = Date.now()
    this.touch(board)
    this.recordEvent(
      topicId,
      nextStatus === 'deleted' ? 'deleted' : nextStatus === 'completed' ? 'completed' : 'updated',
      actor,
      task
    )
    this.broadcast(topicId)
    return this.view(task, board)
  }

  /** Clean up when a topic is deleted (boards belong to a topicId; also removes the persisted row, with the foreign-key cascade as the main path) */
  clearTopic(topicId: number): void {
    this.boards.delete(topicId)
    this.loaded.delete(topicId)
    this.loading.delete(topicId)
    void this.persistence?.remove(topicId).catch(() => {
      // Fail silently: the foreign-key cascade on topic deletion still removes that row
    })
    void this.persistence?.removeEvents?.(topicId).catch(() => {
      // Same as above: the event table also has a foreign-key cascade as a fallback
    })
  }

  /** Clear all boards when switching accounts / logging out (do not delete the database: data belongs to each account's own DB) */
  clearAll(): void {
    this.boards.clear()
    this.loaded.clear()
    this.loading.clear()
  }
}

/** Process-level singleton (same pattern as the todo/goal/jobs runtime registries) */
export const teamStore = new TeamTaskStore()

type ToolConfig = { configurable?: Record<string, unknown> } | undefined

/** Resolve the caller identity from the tool call config (the main graph passes no teamAgent → treated as lead) */
function actorFromConfig(config: ToolConfig): TeamActor {
  const raw = config?.configurable?.teamAgent as Partial<TeamActor> | undefined
  if (raw && typeof raw.id === 'string' && raw.id) {
    return {
      id: raw.id,
      name: typeof raw.name === 'string' && raw.name ? raw.name : raw.id,
      isLead: raw.isLead === true
    }
  }
  return { id: 'lead', name: 'lead', isLead: true }
}

/** Resolve the topic from the tool call config (both the main and subagent graphs put topicId in configurable) */
function topicFromConfig(config: ToolConfig, fallback: number): number {
  const value = config?.configurable?.topicId
  return typeof value === 'number' && value > 0 ? value : fallback
}

function formatTask(task: TeamTaskView): string {
  return JSON.stringify({ ok: true, task })
}

/**
 * Build the shared task board tools (injected into the main agent and subagents).
 *
 * @param store task board registry
 * @param fallbackTopicId fallback topic id at build time (call time prefers config.configurable.topicId)
 */
export function buildTeamTools(
  store: TeamTaskStore,
  fallbackTopicId: number
): StructuredToolInterface[] {
  const topicOf = (config: ToolConfig): number => topicFromConfig(config, fallbackTopicId)

  return [
    tool(
      async (
        args: {
          subject: string
          description?: string
          blockedBy?: string[]
          writeScopes?: string[]
        },
        config
      ) => {
        try {
          const topicId = topicOf(config as ToolConfig)
          await store.ensureLoaded(topicId)
          const task = store.create(
            topicId,
            {
              subject: args.subject,
              description: args.description,
              blockedBy: args.blockedBy,
              writeScopes: args.writeScopes
            },
            actorFromConfig(config as ToolConfig)
          )
          return formatTask(task)
        } catch (err) {
          return `team_task_create failed: ${(err as Error).message}`
        }
      },
      {
        name: 'team_task_create',
        description:
          'Create a shared task on the team board (visible to the main agent, its subagents and the user in the top bar). Use it to split delegated work: put the concrete deliverable in subject, the details in description, list dependency task ids in blockedBy, and optionally declare advisory writeScopes (files/directories) so teammates avoid overlapping edits. Returns the created task with its revision.',
        schema: z.object({
          subject: z
            .string()
            .describe('Short imperative task title, e.g. "Inspect the subagent package"'),
          description: z.string().optional().describe('Full instructions / acceptance details'),
          blockedBy: z
            .array(z.string())
            .optional()
            .describe('Task ids that must be completed before this task can be claimed'),
          writeScopes: z
            .array(z.string())
            .optional()
            .describe('Advisory workspace paths this task expects to write (not a lock)')
        })
      }
    ),
    tool(
      async (args: { status?: TeamTaskStatus }, config) => {
        try {
          const topicId = topicOf(config as ToolConfig)
          await store.ensureLoaded(topicId)
          const snapshot = store.snapshot(topicId)
          const tasks = args.status
            ? snapshot.tasks.filter((task) => task.status === args.status)
            : snapshot.tasks
          return JSON.stringify({
            ok: true,
            revision: snapshot.revision,
            tasks
          })
        } catch (err) {
          return `team_task_list failed: ${(err as Error).message}`
        }
      },
      {
        name: 'team_task_list',
        description:
          'List the shared team task board for this conversation: id, revision, status (pending / in_progress / completed), subject, description, owner, blockedBy and advisory writeScopes. ready=false means the task still has unfinished dependencies. Claim a ready task with team_task_claim before starting it.',
        schema: z.object({
          status: z
            .enum(['pending', 'in_progress', 'completed'])
            .optional()
            .describe('Optional status filter')
        })
      }
    ),
    tool(
      async (args: { taskId: string }, config) => {
        try {
          const topicId = topicOf(config as ToolConfig)
          await store.ensureLoaded(topicId)
          const task = store.snapshot(topicId).tasks.find((item) => item.id === args.taskId)
          if (!task) {
            return `team_task_get failed: task "${args.taskId}" was not found. Call team_task_list to see the current board.`
          }
          return formatTask(task)
        } catch (err) {
          return `team_task_get failed: ${(err as Error).message}`
        }
      },
      {
        name: 'team_task_get',
        description:
          'Read one shared team task in full (status, revision, owner, blockedBy, advisory writeScopes and description) before claiming, updating or working on it — the revision in a list snapshot may already be stale.',
        schema: z.object({
          taskId: z.string().describe('Task id from team_task_list, e.g. task-1')
        })
      }
    ),
    tool(
      async (args: { taskId: string; expectedRevision?: number }, config) => {
        try {
          const topicId = topicOf(config as ToolConfig)
          await store.ensureLoaded(topicId)
          const task = store.claim(
            topicId,
            args.taskId,
            actorFromConfig(config as ToolConfig),
            args.expectedRevision
          )
          return formatTask(task)
        } catch (err) {
          return `team_task_claim failed: ${(err as Error).message}`
        }
      },
      {
        name: 'team_task_claim',
        description:
          'Claim a ready pending task on the shared team board: marks it in_progress and assigns you as the owner. Fails when the task is already owned, not pending, still blocked by unfinished dependencies, or when expectedRevision does not match (another agent changed it — re-read the board first).',
        schema: z.object({
          taskId: z.string().describe('Task id from team_task_list, e.g. task-1'),
          expectedRevision: z
            .number()
            .optional()
            .describe('Revision you saw in team_task_list (optimistic concurrency check)')
        })
      }
    ),
    tool(
      async (
        args: {
          taskId: string
          status?: TeamTaskStatus
          subject?: string
          description?: string
          ownerId?: string
          ownerName?: string
          blockedBy?: string[]
          writeScopes?: string[]
          expectedRevision?: number
        },
        config
      ) => {
        try {
          const topicId = topicOf(config as ToolConfig)
          await store.ensureLoaded(topicId)
          const task = store.update(
            topicId,
            args.taskId,
            {
              status: args.status,
              subject: args.subject,
              description: args.description,
              ownerId: args.ownerId,
              ownerName: args.ownerName,
              blockedBy: args.blockedBy,
              writeScopes: args.writeScopes
            },
            actorFromConfig(config as ToolConfig),
            args.expectedRevision
          )
          return formatTask(task)
        } catch (err) {
          return `team_task_update failed: ${(err as Error).message}`
        }
      },
      {
        name: 'team_task_update',
        description:
          'Update a shared team task: move status (pending / in_progress / completed / deleted), edit subject/description, adjust blockedBy/writeScopes, or (lead only) reassign the owner with ownerId/ownerName (empty ownerId releases it). The lead can update any task; a member can only update tasks it owns and cannot reassign. Use expectedRevision from team_task_list to detect concurrent edits; on revision mismatch re-read the board.',
        schema: z.object({
          taskId: z.string().describe('Task id from team_task_list'),
          status: z
            .enum(['pending', 'in_progress', 'completed', 'deleted'])
            .optional()
            .describe('New status'),
          subject: z.string().optional(),
          description: z.string().optional(),
          ownerId: z.string().optional().describe('New owner agent id (lead only)'),
          ownerName: z.string().optional().describe('New owner display name (lead only)'),
          blockedBy: z.array(z.string()).optional(),
          writeScopes: z.array(z.string()).optional(),
          expectedRevision: z.number().optional()
        })
      }
    )
  ]
}
