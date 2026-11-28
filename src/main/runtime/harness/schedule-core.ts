/**
 * Pure time math and validation for scheduled tasks (no electron / fs dependency,
 * offline-testable).
 *
 * Repetition is expressed with an explicit small subset that covers most cases, so the schema
 * stays small and the model is less likely to get it wrong:
 *
 * - `once`: run once at a given instant (ISO 8601, local or with a time zone);
 * - `every`: every N minutes (from 5 minutes up to 7 days);
 * - `daily`: every day at a fixed local time (HH:MM).
 *
 * Stored times are always ISO strings (UTC); the display layer formats them in the local time
 * zone.
 */

/** Repeat rule (subset) */
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

/** `once.at` must be at least this many ms ahead, so it cannot expire right after creation */
const MIN_LEAD_MS = 30_000

/** Parse `HH:MM`; returns null when invalid */
export function parseDailyTime(time: string): { hours: number; minutes: number } | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec((time ?? '').trim())
  if (!match) return null
  return { hours: Number(match[1]), minutes: Number(match[2]) }
}

/**
 * Compute the next trigger time after `from` (strictly later; null when there is none).
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

/** Validate and return the first trigger time (used on create/edit) */
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

/** One-line description for list/detail views (the rule itself is data, not localized) */
export function describeScheduleWhen(when: ScheduleWhen): string {
  if (when.kind === 'once') return `once at ${when.at}`
  if (when.kind === 'every') return `every ${when.minutes} min`
  return `daily at ${when.time}`
}

/** Minimal fields the scheduler needs to pick due tasks */
export interface ScheduleTaskLike {
  id: string
  enabled: boolean
  nextRunAt: string | null
}

/**
 * Pick the ids of **due** tasks: ascending by nextRunAt, skipping disabled/unscheduled/running
 * ones, at most `limit`.
 *
 * It is a pure function so "which tasks should run" can be verified offline; the runner only
 * executes them one by one and keeps the books.
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
 * Next trigger time (ISO) after one execution.
 *
 * - One-off tasks always return null (they end once executed);
 * - Repeating tasks are recomputed from `now` — triggers missed while the app was closed are
 *   **not caught up** (old reminders are usually meaningless, and catching up would start several
 *   rounds at once).
 */
export function nextRunAfterRun(when: ScheduleWhen, now: Date): string | null {
  if (when.kind === 'once') return null
  const next = computeNextRun(when, now)
  return next ? next.toISOString() : null
}
