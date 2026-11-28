/**
 * Legacy scheduled-task JSON parsing and import planning (pure logic, no fs / DB / electron,
 * offline-testable).
 *
 * Background: before 0.2.6 scheduled tasks lived in `userData/schedules/schedules.json`; they are
 * now stored in the database. This module only turns the old JSON into normalized, importable
 * tasks:
 * - invalid rule shape / missing key fields -> skip (one bad record must not block the migration);
 * - enabled repeating tasks get their next trigger recomputed from **the current time**
 *   (migration is equivalent to a restart; missed triggers are not caught up);
 * - one-off tasks whose time already passed are kept as "paused" (the user can edit the time and
 *   resume them) instead of firing immediately.
 */
import { validateScheduleWhen, type ScheduleWhen } from './schedule-core'
import type { ScheduleRunStatus } from './schedule-types'

/** Normalized legacy task (pending import) */
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

/** Rule shape check (independent of time order; temporal validity is left to validateScheduleWhen) */
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

/** Recompute the next trigger from now; disable when the rule time is invalid (one-off already past) */
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

/** Parse legacy tasks from any JSON value (array; invalid items skipped, duplicate ids deduped) */
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
