/**
 * 定时任务（schedule）的纯时间计算与校验（无 electron / fs 依赖，可离线测试）。
 *
 * 对照 DSH 的 `@deepseek-ai/dsh-tool-schedule`：DSH 用 RFC 5545 rrule 表达重复；
 * 本项目先落地三种覆盖绝大多数场景的**显式子集**，schema 更小、模型更不容易写错：
 *
 * - `once`  —— 指定时刻执行一次（ISO 8601，本地或带时区）；
 * - `every` —— 每 N 分钟（5 分钟起，上限 7 天）；
 * - `daily` —— 每天固定本地时间（HH:MM）。
 *
 * 存储里的时间统一是 ISO 字符串（UTC），展示层再按本地时区格式化。
 */

/** 重复规则（子集） */
export type ScheduleWhen =
  | { kind: 'once'; at: string }
  | { kind: 'every'; minutes: number }
  | { kind: 'daily'; time: string }

export type ScheduleValidationFailure =
  | 'missing'
  | 'unknown-kind'
  | 'invalid-at'
  | 'at-in-past'
  | 'invalid-minutes'
  | 'invalid-time'

export type ScheduleValidationResult =
  | { ok: true; nextRunAt: string }
  | { ok: false; reason: ScheduleValidationFailure }

export const MIN_EVERY_MINUTES = 5
export const MAX_EVERY_MINUTES = 7 * 24 * 60

/** `once.at` 至少要比现在晚这么多毫秒，避免「创建完立刻过期」 */
const MIN_LEAD_MS = 30_000

/** 解析 `HH:MM`，非法返回 null */
export function parseDailyTime(time: string): { hours: number; minutes: number } | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec((time ?? '').trim())
  if (!match) return null
  return { hours: Number(match[1]), minutes: Number(match[2]) }
}

/**
 * 从 `from` 之后计算下一次触发时间（严格晚于 from；没有下一次返回 null）。
 */
export function computeNextRun(when: ScheduleWhen, from: Date): Date | null {
  if (when.kind === 'once') {
    const at = new Date(when.at)
    if (Number.isNaN(at.getTime()) || at.getTime() <= from.getTime()) return null
    return at
  }
  if (when.kind === 'every') {
    if (!Number.isFinite(when.minutes) || when.minutes < MIN_EVERY_MINUTES) return null
    return new Date(from.getTime() + Math.floor(when.minutes) * 60_000)
  }
  const parsed = parseDailyTime(when.time)
  if (!parsed) return null
  const next = new Date(from.getTime())
  next.setHours(parsed.hours, parsed.minutes, 0, 0)
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1)
  return next
}

/** 校验并给出首次触发时间（创建/编辑时用） */
export function validateScheduleWhen(
  when: ScheduleWhen | null | undefined,
  now = new Date()
): ScheduleValidationResult {
  if (!when || typeof when !== 'object') return { ok: false, reason: 'missing' }
  if (when.kind === 'once') {
    const at = new Date(when.at)
    if (Number.isNaN(at.getTime())) return { ok: false, reason: 'invalid-at' }
    if (at.getTime() <= now.getTime() + MIN_LEAD_MS) return { ok: false, reason: 'at-in-past' }
    return { ok: true, nextRunAt: at.toISOString() }
  }
  if (when.kind === 'every') {
    const minutes = Number(when.minutes)
    if (
      !Number.isInteger(minutes) ||
      minutes < MIN_EVERY_MINUTES ||
      minutes > MAX_EVERY_MINUTES
    ) {
      return { ok: false, reason: 'invalid-minutes' }
    }
    const next = computeNextRun({ kind: 'every', minutes }, now)
    return next
      ? { ok: true, nextRunAt: next.toISOString() }
      : { ok: false, reason: 'invalid-minutes' }
  }
  if (when.kind === 'daily') {
    if (!parseDailyTime(when.time)) return { ok: false, reason: 'invalid-time' }
    const next = computeNextRun({ kind: 'daily', time: when.time }, now)
    return next ? { ok: true, nextRunAt: next.toISOString() } : { ok: false, reason: 'invalid-time' }
  }
  return { ok: false, reason: 'unknown-kind' }
}

/** 供列表/详情展示的一句话描述（规则本身是数据，不本地化） */
export function describeScheduleWhen(when: ScheduleWhen): string {
  if (when.kind === 'once') return `once at ${when.at}`
  if (when.kind === 'every') return `every ${when.minutes} min`
  return `daily at ${when.time}`
}

/** 调度器挑选到期任务所需的最小字段 */
export interface ScheduleTaskLike {
  id: string
  enabled: boolean
  nextRunAt: string | null
}

/**
 * 选出**到期**的任务 id：按 nextRunAt 升序，跳过停用/无排期/正在执行的，最多 `limit` 个。
 *
 * 抽成纯函数是为了让「哪些任务该跑」可离线验证；runner 只负责逐个执行与记账。
 */
export function selectDueTaskIds(
  tasks: ScheduleTaskLike[],
  now: Date,
  options: { running?: ReadonlySet<string>; limit?: number } = {}
): string[] {
  const running = options.running ?? new Set<string>()
  const limit = Math.max(1, Math.floor(options.limit ?? 3))
  const nowMs = now.getTime()
  return tasks
    .filter((task) => {
      if (!task.enabled || !task.nextRunAt || running.has(task.id)) return false
      const at = Date.parse(task.nextRunAt)
      return Number.isFinite(at) && at <= nowMs
    })
    .sort((a, b) => Date.parse(a.nextRunAt ?? '') - Date.parse(b.nextRunAt ?? ''))
    .slice(0, limit)
    .map((task) => task.id)
}

/**
 * 一次执行后的下一次触发时间（ISO）。
 *
 * - 一次性任务永远返回 null（执行完即结束）；
 * - 重复任务从 `now` 重新计算——应用关着错过的多次触发**不补跑**（旧提醒通常已无意义，
 *   补跑还会瞬间连开多轮）。
 */
export function nextRunAfterRun(when: ScheduleWhen, now: Date): string | null {
  if (when.kind === 'once') return null
  const next = computeNextRun(when, now)
  return next ? next.toISOString() : null
}
