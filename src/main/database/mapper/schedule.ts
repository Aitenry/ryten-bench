/**
 * Scheduled task database mapper (PGlite / Drizzle).
 *
 * Conventions: every time column is a `timestamp` in the database and is normalized to an **ISO string**
 * after reading (`new Date(value).toISOString()`); the business layer only handles ISO and writes ISO too.
 * The rule column is split into `when_kind` + `when_json`; this mapper serializes/deserializes it and skips
 * invalid rules as null (one bad row must not break the whole list).
 */
import { and, desc, eq, sql } from 'drizzle-orm'
import { withOrm } from '../orm'
import { scheduled_task_runs, scheduled_tasks } from '../schema'
import { normalizeAgentSelection, type AgentSelection } from '../../../shared/harness/agent-config'
import type {
  ScheduleCreateInput,
  ScheduleRunArtifact,
  ScheduleRunRecord,
  ScheduleRunStatus,
  ScheduleRunStep,
  ScheduleRunUsage,
  ScheduledTask,
  ScheduledTaskPatch
} from '../../runtime/harness/schedule-types'
import type { ScheduleWhen } from '../../runtime/harness/schedule-core'

/** JSON column write (null/undefined → null) */
function serializeJson(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value)
}

/** JSON column read: anything malformed degrades to null instead of breaking the run list */
function parseJson<T>(raw: string | null | undefined): T | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/** Time column → ISO (accepts PG's 'YYYY-MM-DD HH:MM:SS+00' as well as existing ISO strings) */
function toIso(value: string | null | undefined): string | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/** Serialize a rule */
function serializeWhen(when: ScheduleWhen): { kind: ScheduleWhen['kind']; json: string } {
  return { kind: when.kind, json: JSON.stringify(when) }
}

/** Deserialize a rule (returns null when the shape is wrong) */
function parseWhen(kind: string, json: string): ScheduleWhen | null {
  try {
    const parsed: unknown = JSON.parse(json)
    if (!parsed || typeof parsed !== 'object') return null
    const value = parsed as Record<string, unknown>
    if (kind === 'once') {
      return typeof value.at === 'string' ? { kind: 'once', at: value.at } : null
    }
    if (kind === 'every') {
      return typeof value.minutes === 'number' ? { kind: 'every', minutes: value.minutes } : null
    }
    if (kind === 'daily') {
      return typeof value.time === 'string' ? { kind: 'daily', time: value.time } : null
    }
    return null
  } catch {
    return null
  }
}

type TaskRow = typeof scheduled_tasks.$inferSelect

/** JSON column → task-level agent selection (invalid data becomes null) */
function parseAgentConfig(raw: string | null): AgentSelection | null {
  if (!raw) return null
  try {
    return normalizeAgentSelection(JSON.parse(raw))
  } catch {
    return null
  }
}

/** Task-level agent selection → JSON column (null is stored as null) */
function serializeAgentConfig(selection: AgentSelection | null | undefined): string | null {
  if (!selection) return null
  return JSON.stringify(selection)
}
type RunRow = typeof scheduled_task_runs.$inferSelect

/** Row → domain object (returns null when the rule is invalid) */
function toTask(row: TaskRow): ScheduledTask | null {
  const when = parseWhen(row.when_kind, row.when_json)
  if (!when) return null
  const createdAt = toIso(row.created_at) ?? new Date().toISOString()
  return {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    when,
    enabled: row.enabled,
    topicId: row.topic_id ?? null,
    workspaceId: row.workspace_id ?? null,
    targetMode: (row.target_mode as ScheduledTask['targetMode']) ?? null,
    targetWorkspaceId: row.target_workspace_id ?? null,
    targetMemoryScope: row.target_memory_scope ?? null,
    agentConfig: parseAgentConfig(row.agent_config),
    model: row.model ?? null,
    createdAt,
    updatedAt: toIso(row.updated_at) ?? createdAt,
    nextRunAt: toIso(row.next_run_at),
    lastRunAt: toIso(row.last_run_at) ?? undefined,
    lastStatus: row.last_status ?? undefined
  }
}

/** List all tasks (newest first; rows with invalid rules are skipped) */
export async function listScheduledTasks(): Promise<ScheduledTask[]> {
  return withOrm('listScheduledTasks', async (db) => {
    const rows = await db.select().from(scheduled_tasks).orderBy(desc(scheduled_tasks.created_at))
    return rows.map(toTask).filter((task): task is ScheduledTask => task !== null)
  })
}

/** Read one task by id */
export async function getScheduledTask(id: string): Promise<ScheduledTask | undefined> {
  return withOrm('getScheduledTask', async (db) => {
    const rows = await db.select().from(scheduled_tasks).where(eq(scheduled_tasks.id, id))
    const task = rows[0] ? toTask(rows[0]) : null
    return task ?? undefined
  })
}

/** Total task count (limit check before creating) */
export async function countScheduledTasks(): Promise<number> {
  return withOrm('countScheduledTasks', async (db) => {
    const rows = await db.select({ value: sql<number>`count(*)::int` }).from(scheduled_tasks)
    return rows[0]?.value ?? 0
  })
}

/** Create a task (the caller generates the id so a stable id is available before writing) */
export async function createScheduledTask(
  input: ScheduleCreateInput & { id: string }
): Promise<ScheduledTask> {
  return withOrm('createScheduledTask', async (db) => {
    const when = serializeWhen(input.when)
    const now = new Date().toISOString()
    await db.insert(scheduled_tasks).values({
      id: input.id,
      workspace_id: input.workspaceId ?? null,
      topic_id: input.topicId,
      target_mode: input.targetMode ?? null,
      target_workspace_id: input.targetWorkspaceId ?? null,
      target_memory_scope: input.targetMemoryScope ?? null,
      agent_config: serializeAgentConfig(input.agentConfig),
      model: input.model ?? null,
      title: input.title,
      prompt: input.prompt,
      when_kind: when.kind,
      when_json: when.json,
      enabled: true,
      next_run_at: input.nextRunAt,
      created_at: now,
      updated_at: now
    })
    const rows = await db.select().from(scheduled_tasks).where(eq(scheduled_tasks.id, input.id))
    const task = rows[0] ? toTask(rows[0]) : null
    if (!task) throw new Error('scheduled task created but could not be read back')
    return task
  })
}

/** Update a task; returns undefined when it does not exist */
export async function updateScheduledTask(
  id: string,
  patch: ScheduledTaskPatch
): Promise<ScheduledTask | undefined> {
  return withOrm('updateScheduledTask', async (db) => {
    const values: Partial<typeof scheduled_tasks.$inferInsert> = {
      updated_at: new Date().toISOString()
    }
    if (patch.title !== undefined) values.title = patch.title
    if (patch.prompt !== undefined) values.prompt = patch.prompt
    if (patch.topicId !== undefined) values.topic_id = patch.topicId
    if (patch.targetMode !== undefined) values.target_mode = patch.targetMode
    if (patch.targetWorkspaceId !== undefined) values.target_workspace_id = patch.targetWorkspaceId
    if (patch.targetMemoryScope !== undefined) values.target_memory_scope = patch.targetMemoryScope
    if (patch.agentConfig !== undefined)
      values.agent_config = serializeAgentConfig(patch.agentConfig)
    if (patch.model !== undefined) values.model = patch.model ?? null
    if (patch.workspaceId !== undefined) values.workspace_id = patch.workspaceId ?? null
    if (patch.enabled !== undefined) values.enabled = patch.enabled
    if (patch.nextRunAt !== undefined) values.next_run_at = patch.nextRunAt
    if (patch.lastRunAt !== undefined) values.last_run_at = patch.lastRunAt
    if (patch.lastStatus !== undefined) values.last_status = patch.lastStatus
    if (patch.when !== undefined) {
      const when = serializeWhen(patch.when)
      values.when_kind = when.kind
      values.when_json = when.json
    }
    await db.update(scheduled_tasks).set(values).where(eq(scheduled_tasks.id, id))
    const rows = await db.select().from(scheduled_tasks).where(eq(scheduled_tasks.id, id))
    const task = rows[0] ? toTask(rows[0]) : null
    return task ?? undefined
  })
}

/** Delete a task (run records cascade via the foreign key); returns whether anything was actually deleted */
export async function deleteScheduledTask(id: string): Promise<boolean> {
  return withOrm('deleteScheduledTask', async (db) => {
    const rows = await db.delete(scheduled_tasks).where(eq(scheduled_tasks.id, id)).returning({
      id: scheduled_tasks.id
    })
    return rows.length > 0
  })
}

/**
 * Record one run: update the task status and append a permanent run record (same transaction).
 *
 * `nextRunAt = null` means no further trigger; `enabled` defaults to being derived from nextRunAt.
 */
export async function markScheduledTaskRun(args: {
  taskId: string
  status: ScheduleRunStatus
  ranAt: string
  nextRunAt: string | null
  enabled?: boolean
  detail?: string | null
  topicId?: number | null
  dialogueId?: number | null
  usage?: ScheduleRunUsage | null
  steps?: ScheduleRunStep[] | null
  artifacts?: ScheduleRunArtifact[] | null
}): Promise<ScheduledTask | undefined> {
  return withOrm('markScheduledTaskRun', async (db) => {
    await db.transaction(async (tx) => {
      await tx
        .update(scheduled_tasks)
        .set({
          last_run_at: args.ranAt,
          last_status: args.status,
          next_run_at: args.nextRunAt,
          enabled: args.enabled ?? args.nextRunAt !== null,
          updated_at: args.ranAt
        })
        .where(eq(scheduled_tasks.id, args.taskId))
      await tx.insert(scheduled_task_runs).values({
        task_id: args.taskId,
        status: args.status,
        ran_at: args.ranAt,
        detail: args.detail ?? null,
        topic_id: args.topicId ?? null,
        dialogue_id: args.dialogueId ?? null,
        usage_json: serializeJson(args.usage),
        steps_json: serializeJson(args.steps),
        artifacts_json: serializeJson(args.artifacts)
      })
    })
    const rows = await db.select().from(scheduled_tasks).where(eq(scheduled_tasks.id, args.taskId))
    const task = rows[0] ? toTask(rows[0]) : null
    return task ?? undefined
  })
}

/** Run row → domain object */
function toRun(row: RunRow): ScheduleRunRecord {
  return {
    id: row.id,
    at: toIso(row.ran_at) ?? new Date().toISOString(),
    status: row.status,
    detail: row.detail,
    topicId: row.topic_id ?? null,
    dialogueId: row.dialogue_id ?? null,
    usage: parseJson<ScheduleRunUsage>(row.usage_json),
    steps: parseJson<ScheduleRunStep[]>(row.steps_json),
    artifacts: parseJson<ScheduleRunArtifact[]>(row.artifacts_json)
  }
}

/** Read run records (reverse-order pagination; kept permanently, never trimmed) */
export async function listScheduledTaskRuns(
  taskId: string,
  limit = 20,
  offset = 0
): Promise<ScheduleRunRecord[]> {
  return withOrm('listScheduledTaskRuns', async (db) => {
    const rows = await db
      .select()
      .from(scheduled_task_runs)
      .where(eq(scheduled_task_runs.task_id, taskId))
      .orderBy(desc(scheduled_task_runs.ran_at), desc(scheduled_task_runs.id))
      .limit(Math.max(1, Math.min(500, Math.floor(limit))))
      .offset(Math.max(0, Math.floor(offset)))
    return rows.map(toRun)
  })
}

/** Read one run record (used by "re-run" before executing, so a missing row never starts a turn) */
export async function getScheduledTaskRun(
  taskId: string,
  runId: number
): Promise<ScheduleRunRecord | undefined> {
  return withOrm('getScheduledTaskRun', async (db) => {
    const rows = await db
      .select()
      .from(scheduled_task_runs)
      .where(and(eq(scheduled_task_runs.id, runId), eq(scheduled_task_runs.task_id, taskId)))
    return rows[0] ? toRun(rows[0]) : undefined
  })
}

/**
 * Overwrite one existing run record in place ("re-run"): the row id, its `ran_at` and its place in
 * the history stay the same; status / detail / conversation / usage / steps / artifacts are replaced
 * by the new execution's data.
 *
 * Deliberately does not touch the task row's schedule fields: a manual re-run is not a new scheduled
 * occurrence, so `next_run_at` and `last_run_at` keep describing the real schedule (the runner may
 * sync `last_status` separately when this record is the newest one).
 */
export async function replaceScheduledTaskRun(
  taskId: string,
  runId: number,
  result: {
    status: ScheduleRunStatus
    detail?: string | null
    topicId?: number | null
    dialogueId?: number | null
    usage?: ScheduleRunUsage | null
    steps?: ScheduleRunStep[] | null
    artifacts?: ScheduleRunArtifact[] | null
  }
): Promise<ScheduleRunRecord | undefined> {
  return withOrm('replaceScheduledTaskRun', async (db) => {
    const rows = await db
      .update(scheduled_task_runs)
      .set({
        status: result.status,
        detail: result.detail ?? null,
        topic_id: result.topicId ?? null,
        dialogue_id: result.dialogueId ?? null,
        usage_json: serializeJson(result.usage),
        steps_json: serializeJson(result.steps),
        artifacts_json: serializeJson(result.artifacts)
      })
      .where(and(eq(scheduled_task_runs.id, runId), eq(scheduled_task_runs.task_id, taskId)))
      .returning()
    return rows[0] ? toRun(rows[0]) : undefined
  })
}

/** Total run record count (used by the pagination component) */
export async function countScheduledTaskRuns(taskId: string): Promise<number> {
  return withOrm('countScheduledTaskRuns', async (db) => {
    const rows = await db
      .select({ value: sql<number>`count(*)::int` })
      .from(scheduled_task_runs)
      .where(eq(scheduled_task_runs.task_id, taskId))
    return rows[0]?.value ?? 0
  })
}

/** Import legacy JSON data: insert row by row and skip ids that already exist */
export async function importScheduledTasks(
  tasks: Array<{
    id: string
    title: string
    prompt: string
    when: ScheduleWhen
    enabled: boolean
    topicId: number | null
    workspaceId: number | null
    targetMode?: 'chat' | 'work' | 'plugin' | null
    targetWorkspaceId?: number | null
    targetMemoryScope?: string | null
    agentConfig?: AgentSelection | null
    model?: string | null
    nextRunAt: string | null
    createdAt: string
    updatedAt: string
    lastRunAt?: string
    lastStatus?: ScheduleRunStatus
  }>
): Promise<number> {
  return withOrm('importScheduledTasks', async (db) => {
    if (tasks.length === 0) return 0
    const existing = await db.select({ id: scheduled_tasks.id }).from(scheduled_tasks)
    const existingIds = new Set(existing.map((row) => row.id))
    const fresh = tasks.filter((task) => !existingIds.has(task.id))
    if (fresh.length === 0) return 0
    await db.insert(scheduled_tasks).values(
      fresh.map((task) => {
        const when = serializeWhen(task.when)
        return {
          id: task.id,
          workspace_id: task.workspaceId,
          topic_id: task.topicId,
          target_mode: task.targetMode ?? null,
          target_workspace_id: task.targetWorkspaceId ?? null,
          target_memory_scope: task.targetMemoryScope ?? null,
          agent_config: serializeAgentConfig(task.agentConfig),
          model: task.model ?? null,
          title: task.title,
          prompt: task.prompt,
          when_kind: when.kind,
          when_json: when.json,
          enabled: task.enabled,
          next_run_at: task.nextRunAt,
          last_run_at: task.lastRunAt ?? null,
          last_status: task.lastStatus ?? null,
          created_at: task.createdAt,
          updated_at: task.updatedAt
        }
      })
    )
    return fresh.length
  })
}
