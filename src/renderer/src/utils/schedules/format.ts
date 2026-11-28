/**
 * Pure formatting/computation for the schedules page (no React dependency, easy to reuse
 * and read).
 *
 * Note: the "next trigger" rule keeps the same semantics as the main process's
 * `schedule-core`:
 * - once: the given time (already past counts as expired);
 * - every: now + N minutes;
 * - daily: if that time today has passed → tomorrow.
 * The page only **previews**; actual scheduling is still computed by the main process.
 */
import type { ScheduleView } from '../../api/harness'

/** Zero-pad to two digits */
const pad = (value: number): string => String(value).padStart(2, '0')

/** Local date-time: `2026-11-28 09:00` */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`
}

/** Local time: `09:00` */
export function formatClock(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Relative to today: today / tomorrow / an explicit date */
export function formatRelativeDay(iso: string | null, now = new Date()): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const startOfDay = (value: Date): number =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
  const diffDays = Math.round((startOfDay(date) - startOfDay(now)) / 86_400_000)
  const clock = formatClock(iso)
  if (diffDays === 0) return `今天 ${clock}`
  if (diffDays === 1) return `明天 ${clock}`
  if (diffDays === -1) return `昨天 ${clock}`
  return `${formatDateTime(iso)}`
}

/** Next trigger (for preview only; same semantics as the main process, but never persisted) */
export function computeNextRunPreview(
  when: ScheduleView['when'],
  now = new Date()
): Date | null {
  if (when.kind === 'once') {
    const at = new Date(when.at)
    return Number.isNaN(at.getTime()) || at.getTime() <= now.getTime() ? null : at
  }
  if (when.kind === 'every') {
    return new Date(now.getTime() + when.minutes * 60_000)
  }
  const match = /^(\d{2}):(\d{2})$/.exec(when.time)
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  return next
}
