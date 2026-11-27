/**
 * 旧版定时任务 JSON 解析与导入计划（纯逻辑，无 fs / DB / electron，可离线测试）。
 *
 * 背景：0.2.6 之前定时任务存在 `userData/schedules/schedules.json`；现在统一迁到数据库。
 * 这里只负责「把旧 JSON 转成可导入的规范化任务」：
 * - 规则形状非法 / 关键字段缺失 → 跳过（一条坏数据不能挡住迁移）；
 * - 启用中的重复任务按**当前时间**重算下一次触发（迁移等价于重启，错过的触发不补跑）；
 * - 一次性任务时间已过 → 保留为「已暂停」（用户可改时间后恢复），不立即触发。
 */
import { validateScheduleWhen, type ScheduleWhen } from './schedule-core'
import type { ScheduleRunStatus } from './schedule-types'

/** 规范化后的旧任务（待导入） */
export interface LegacyScheduleTask {
  id: string
  title: string
  prompt: string
  when: ScheduleWhen
  enabled: boolean
  topicId: number
  nextRunAt: string | null
  createdAt: string
  updatedAt: string
  lastRunAt?: string
  lastStatus?: ScheduleRunStatus
}

const RUN_STATUSES: readonly ScheduleRunStatus[] = ['completed', 'cancelled', 'failed']

/** 规则形状校验（与时间先后无关；时间合法性交给 validateScheduleWhen） */
function isWhenShape(value: unknown): value is ScheduleWhen {
  if (!value || typeof value !== 'object') return false
  const when = value as Record<string, unknown>
  if (when.kind === 'once') {
    return typeof when.at === 'string' && !Number.isNaN(Date.parse(when.at))
  }
  if (when.kind === 'every') {
    return typeof when.minutes === 'number' && when.minutes >= 5 && when.minutes <= 10_080
  }
  if (when.kind === 'daily') {
    return typeof when.time === 'string' && /^\d{2}:\d{2}$/.test(when.time)
  }
  return false
}

/** 按当前时间重算下一次触发；规则时间非法（如一次性已过期）时停用 */
function planNextRun(
  when: ScheduleWhen,
  enabled: boolean,
  now: Date
): { enabled: boolean; nextRunAt: string | null } {
  if (!enabled) return { enabled: false, nextRunAt: null }
  const validated = validateScheduleWhen(when, now)
  if (!validated.ok) return { enabled: false, nextRunAt: null }
  return { enabled: true, nextRunAt: validated.nextRunAt }
}

/** 从任意 JSON 值里解析旧任务（数组；非法项跳过、重复 id 去重） */
export function parseLegacySchedules(raw: unknown, now = new Date()): LegacyScheduleTask[] {
  if (!Array.isArray(raw)) return []
  const out: LegacyScheduleTask[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const task = item as Record<string, unknown>
    const id = typeof task.id === 'string' ? task.id.trim() : ''
    const prompt = typeof task.prompt === 'string' ? task.prompt.trim() : ''
    const when = task.when
    const topicId = typeof task.topicId === 'number' ? task.topicId : Number.NaN
    if (!id || seen.has(id) || !prompt || !isWhenShape(when)) continue
    if (!Number.isFinite(topicId) || topicId <= 0) continue
    const lastStatus =
      typeof task.lastStatus === 'string' &&
      RUN_STATUSES.includes(task.lastStatus as ScheduleRunStatus)
        ? (task.lastStatus as ScheduleRunStatus)
        : undefined
    const planned = planNextRun(when, task.enabled !== false, now)
    seen.add(id)
    out.push({
      id,
      title: typeof task.title === 'string' && task.title.trim() ? task.title.trim() : '定时任务',
      prompt,
      when,
      enabled: planned.enabled,
      topicId,
      nextRunAt: planned.nextRunAt,
      createdAt: typeof task.createdAt === 'string' ? task.createdAt : now.toISOString(),
      updatedAt: typeof task.updatedAt === 'string' ? task.updatedAt : now.toISOString(),
      lastRunAt: typeof task.lastRunAt === 'string' ? task.lastRunAt : undefined,
      lastStatus
    })
  }
  return out
}
