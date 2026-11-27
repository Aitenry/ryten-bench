/**
 * 定时任务数据库 mapper（PGlite / Drizzle）。
 *
 * 约定：所有时间列在数据库里是 `timestamp`，读出后统一归一化为 **ISO 字符串**
 * （`new Date(value).toISOString()`），业务层只处理 ISO；写入时也传 ISO。
 * 规则列拆成 `when_kind` + `when_json`，这里负责序列化/反序列化，非法规则按 null 跳过
 * （一条坏数据不能让整个列表挂掉）。
 */
import { desc, eq, sql } from 'drizzle-orm'
import { withOrm } from '../orm'
import { scheduled_task_runs, scheduled_tasks } from '../schema'
import type {
  ScheduleCreateInput,
  ScheduleRunRecord,
  ScheduleRunStatus,
  ScheduledTask,
  ScheduledTaskPatch
} from '../../runtime/harness/schedule-types'
import type { ScheduleWhen } from '../../runtime/harness/schedule-core'

/** 时间列 → ISO（兼容 PG 的 'YYYY-MM-DD HH:MM:SS+00' 与已有 ISO） */
function toIso(value: string | null | undefined): string | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/** 规则序列化 */
function serializeWhen(when: ScheduleWhen): { kind: ScheduleWhen['kind']; json: string } {
  return { kind: when.kind, json: JSON.stringify(when) }
}

/** 规则反序列化（形状不对返回 null） */
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
type RunRow = typeof scheduled_task_runs.$inferSelect

/** 行 → 领域对象（规则非法时返回 null） */
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
    topicId: row.topic_id,
    workspaceId: row.workspace_id ?? null,
    createdAt,
    updatedAt: toIso(row.updated_at) ?? createdAt,
    nextRunAt: toIso(row.next_run_at),
    lastRunAt: toIso(row.last_run_at) ?? undefined,
    lastStatus: row.last_status ?? undefined
  }
}

/** 列出全部任务（新建在前；非法规则的行跳过） */
export async function listScheduledTasks(): Promise<ScheduledTask[]> {
  return withOrm('listScheduledTasks', async (db) => {
    const rows = await db
      .select()
      .from(scheduled_tasks)
      .orderBy(desc(scheduled_tasks.created_at))
    return rows.map(toTask).filter((task): task is ScheduledTask => task !== null)
  })
}

/** 按 id 读取一条任务 */
export async function getScheduledTask(id: string): Promise<ScheduledTask | undefined> {
  return withOrm('getScheduledTask', async (db) => {
    const rows = await db.select().from(scheduled_tasks).where(eq(scheduled_tasks.id, id))
    const task = rows[0] ? toTask(rows[0]) : null
    return task ?? undefined
  })
}

/** 任务总数（创建前的上限检查） */
export async function countScheduledTasks(): Promise<number> {
  return withOrm('countScheduledTasks', async (db) => {
    const rows = await db.select({ value: sql<number>`count(*)::int` }).from(scheduled_tasks)
    return rows[0]?.value ?? 0
  })
}

/** 创建任务（id 由调用方生成，便于在写库前返回稳定 id） */
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

/** 更新任务；不存在返回 undefined */
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

/** 删除任务（执行记录随外键级联删除）；返回是否真的删掉 */
export async function deleteScheduledTask(id: string): Promise<boolean> {
  return withOrm('deleteScheduledTask', async (db) => {
    const rows = await db.delete(scheduled_tasks).where(eq(scheduled_tasks.id, id)).returning({
      id: scheduled_tasks.id
    })
    return rows.length > 0
  })
}

/**
 * 记录一次执行：更新任务状态 + 追加永久执行记录（同一事务）。
 *
 * `nextRunAt = null` 表示不再触发；`enabled` 缺省按 nextRunAt 推导。
 */
export async function markScheduledTaskRun(args: {
  taskId: string
  status: ScheduleRunStatus
  ranAt: string
  nextRunAt: string | null
  enabled?: boolean
  detail?: string | null
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
        detail: args.detail ?? null
      })
    })
    const rows = await db.select().from(scheduled_tasks).where(eq(scheduled_tasks.id, args.taskId))
    const task = rows[0] ? toTask(rows[0]) : null
    return task ?? undefined
  })
}

/** 读取执行记录（倒序分页；永久保存，不裁剪） */
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
    return rows.map((row: RunRow) => ({
      at: toIso(row.ran_at) ?? new Date().toISOString(),
      status: row.status,
      detail: row.detail
    }))
  })
}

/** 执行记录总数（分页组件用） */
export async function countScheduledTaskRuns(taskId: string): Promise<number> {
  return withOrm('countScheduledTaskRuns', async (db) => {
    const rows = await db
      .select({ value: sql<number>`count(*)::int` })
      .from(scheduled_task_runs)
      .where(eq(scheduled_task_runs.task_id, taskId))
    return rows[0]?.value ?? 0
  })
}

/** 旧 JSON 数据导入：逐条插入并跳过已存在的 id */
export async function importScheduledTasks(
  tasks: Array<{
    id: string
    title: string
    prompt: string
    when: ScheduleWhen
    enabled: boolean
    topicId: number
    workspaceId: number | null
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
