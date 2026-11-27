/**
 * 定时任务页面用的纯格式化/计算（无 React 依赖，便于复用与阅读）。
 *
 * 注意：规则「下一次触发」的计算与主进程 `schedule-core` 保持同一语义：
 * - once：给定时间（已经过去则视为过期）；
 * - every：现在 + N 分钟；
 * - daily：今天该时刻已过 → 明天。
 * 页面只用于**预览**，真正排期仍以主进程计算为准。
 */
import type { ScheduleView } from '../../api/harness'

/** 两位数补零 */
const pad = (value: number): string => String(value).padStart(2, '0')

/** 本地日期时间：`2026-11-28 09:00` */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`
}

/** 本地时间：`09:00` */
export function formatClock(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 相对今天：今天 / 明天 / 具体日期 */
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

/** 下一个触发（预览用；与主进程语义一致，但不落库） */
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
