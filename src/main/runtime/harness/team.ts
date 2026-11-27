import { tool, type StructuredToolInterface } from '../../ai/tools'
import { z } from 'zod'

/**
 * Agent Teams / 超级智能体 —— 共享任务板（按 topicId 隔离，快照 + 事件日志持久化）。
 *
 * 机制参考 deepseek-harness（packages/team/agent-team）：
 * - Team = 根会话（RytenBench 的 topic）+ 它的前后台子代理树，**不新增 agent 类型**；
 * - 协作靠一张共享任务板：任务有 subject/description/status/owner/blockedBy/writeScopes，
 *   主智能体（lead）与子代理（member）用 team_task_* 工具读写同一张板；
 * - 任务按 revision 做 CAS：认领/更新时带上看到的 revision，冲突即失败并让模型重读，
 *   避免两个子代理同时改同一行；
 * - writeScopes 只是**建议性**的写入范围提示（给模型排冲突用），不是锁。
 *
 * 持久化：任务板整板快照写 `team_board` 表（每话题一行 JSON，含 deleted tombstone）；
 * 每次 create/claim/complete/update/delete 同时追加 `team_task_event` 事件（协作面板最近活动）。
 * 存储适配器由系统启动时注入（`setPersistence`），运行时不直接依赖数据库；重启后
 * 第一次访问任务板（IPC 拉取 / team_task_* 工具）时懒加载，恢复 revision/counter/任务。
 */

export type TeamTaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted'

/** 调用者身份：主智能体为 lead，子代理为 member（由各自图的 configurable 传入） */
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

/** 任务板行（附带依赖就绪判定，渲染层/工具输出共用） */
export interface TeamTaskView extends TeamTask {
  /** 依赖是否全部完成（blockedBy 里有未完成/不存在/已删除的 id 即 false） */
  ready: boolean
  /** 未完成的依赖 id（ready=false 时非空） */
  blockers: string[]
}

/** 任务板快照（IPC 推送与团队工具输出同构） */
export interface TeamBoardSnapshot {
  topicId: number
  /** 每次变更 +1：渲染层据此丢弃乱序的旧快照 */
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

/** 状态排序：进行中 → 待办 → 已完成（组内按最近更新倒序，与 DSH 目录同一口径） */
const STATUS_RANK: Record<TeamTaskStatus, number> = {
  in_progress: 0,
  pending: 1,
  completed: 2,
  deleted: 3
}

/** 允许的状态迁移（认领走 claim；其余走 update） */
const ALLOWED_TRANSITIONS: Record<TeamTaskStatus, TeamTaskStatus[]> = {
  pending: ['in_progress', 'deleted'],
  in_progress: ['completed', 'pending', 'deleted'],
  completed: ['in_progress', 'deleted'],
  deleted: []
}

/** 单板任务数上限：防止模型无限建任务把内存/UI 撑爆 */
const MAX_TASKS_PER_TOPIC = 200

interface Board {
  revision: number
  counter: number
  tasks: Map<string, TeamTask>
}

/** 持久化快照（与 Board 同构，tasks 用可 JSON 序列化的数组） */
export interface TeamBoardPersistedSnapshot {
  revision: number
  counter: number
  tasks: TeamTask[]
}

/**
 * 任务板存储适配器：由系统启动装配（DB 实现见 `system/harness.ts`）。
 * 运行时只依赖这个接口——离线回归（不启数据库）不注入即可跑。
 */
export interface TeamBoardPersistence {
  load: (topicId: number) => Promise<TeamBoardPersistedSnapshot | null>
  save: (topicId: number, snapshot: TeamBoardPersistedSnapshot) => Promise<void>
  remove: (topicId: number) => Promise<void>
  /** 追加一条任务事件（可选：离线回归/未装配事件表时静默跳过） */
  appendEvent?: (event: TeamTaskEventInput) => Promise<void>
  /** 删除话题下的事件（可选；话题删除外键级联是主路径） */
  removeEvents?: (topicId: number) => Promise<void>
}

/** 任务事件（协作面板最近活动/后续审计用） */
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
  /** 已尝试从持久化层加载过的话题（无持久化时也会标记：内存模式没有远端数据） */
  private readonly loaded = new Set<number>()
  /** 同一话题的并发加载去重（工具/IPC 同时到达时只读一次库） */
  private readonly loading = new Map<number, Promise<void>>()
  private persistence?: TeamBoardPersistence

  /**
   * 变更回调（IPC 层节流/广播用）。
   * 每次变更推送**完整快照**：任务板规模很小（上限 200），整板替换比增量协议简单可靠。
   */
  onChange?: (snapshot: TeamBoardSnapshot) => void

  /** 注入/撤销任务板存储适配器（系统启动装配；切换账号时由外部清理内存） */
  setPersistence(persistence?: TeamBoardPersistence): void {
    this.persistence = persistence
    this.loaded.clear()
    this.loading.clear()
  }

  /**
   * 懒加载话题任务板（IPC 拉取、团队工具在操作前调用）。
   * 无持久化适配器（离线回归）/加载失败时保持内存空板，不阻塞任务板操作。
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
        // 读取失败不标记 loaded：下一次访问再重试（任务板不会是"永久空"）
      } finally {
        this.loading.delete(topicId)
      }
    })()
    this.loading.set(topicId, load)
    return load
  }

  /** 追加任务事件（fire-and-forget；未装配事件表时静默跳过） */
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
        // 事件只服务活动展示/审计：写失败不能影响任务板本身
      })
  }

  /** 整板快照持久化（fire-and-forget：存储失败不能阻塞工具调用） */
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
        // 持久化失败静默：内存仍是本次进程的权威，下一次变更会再次尝试
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

  /** 依赖就绪判定：blockedBy 里每个 id 都必须是已完成的现存任务 */
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

  /** 当前任务板快照（含 revision） */
  snapshot(topicId: number): TeamBoardSnapshot {
    const board = this.board(topicId)
    return { topicId, revision: board.revision, tasks: this.sortedViews(board) }
  }

  /** 任务列表（不含已删除） */

  private touch(board: Board): void {
    board.revision += 1
  }

  private broadcast(topicId: number): void {
    this.persist(topicId)
    this.onChange?.(this.snapshot(topicId))
  }

  /** 新建任务（任何人可建）：默认 pending、未认领 */
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
   * 认领任务：pending + 未认领 + 依赖就绪 才能认领；成功即 in_progress、owner = 调用者。
   * expectedRevision 提供时做 CAS（模型从 list 拿到的 revision）。
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
   * 更新任务：
   * - 权限：lead 可改任意任务/改派负责人；member 只能改自己认领的任务，且不能改派；
   * - ownerId/ownerName 只有 lead 能设置（改派），传空字符串表示放回未认领；
   * - 状态迁移必须合法（见 ALLOWED_TRANSITIONS），删除 = status 'deleted'；
   * - expectedRevision 提供时做 CAS。
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
      // 完成时保留 owner（历史可追溯）；删除时清空 owner（不再归属任何人）
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

  /** 话题删除时清理（任务板按 topicId 归属；同时删持久化行，外键级联是主路径） */
  clearTopic(topicId: number): void {
    this.boards.delete(topicId)
    this.loaded.delete(topicId)
    this.loading.delete(topicId)
    void this.persistence?.remove(topicId).catch(() => {
      // 删除失败静默：话题删除的外键级联仍会清掉该行
    })
    void this.persistence?.removeEvents?.(topicId).catch(() => {
      // 同上：事件表也有外键级联兜底
    })
  }

  /** 切换账号 / 退出时清空全部任务板（不删数据库：数据属于各自账号库） */
  clearAll(): void {
    this.boards.clear()
    this.loaded.clear()
    this.loading.clear()
  }
}

/** 进程级单例（与 todo/goal/jobs 等运行时注册表同一口径） */
export const teamStore = new TeamTaskStore()

type ToolConfig = { configurable?: Record<string, unknown> } | undefined

/** 从工具调用 config 里解析调用者身份（主图不传 teamAgent → 视为 lead） */
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

/** 从工具调用 config 里解析话题（主图/子代理图都会把 topicId 放进 configurable） */
function topicFromConfig(config: ToolConfig, fallback: number): number {
  const value = config?.configurable?.topicId
  return typeof value === 'number' && value > 0 ? value : fallback
}

function formatTask(task: TeamTaskView): string {
  return JSON.stringify({ ok: true, task })
}

/**
 * 构建共享任务板工具（注入主智能体与子代理）。
 *
 * @param store 任务板注册表
 * @param fallbackTopicId 构建期兜底话题 id（调用期优先取 config.configurable.topicId）
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
            .describe('Short imperative task title, e.g. "Inspect the DSH subagent package"'),
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
