/**
 * One-line description of a schedule rule (every day at 09:00 / every 30 minutes / one-off
 * 12-05 14:00).
 *
 * Extracted from `ScheduleCard.tsx`: a component file must only export components for
 * react-refresh (HMR) to apply to the card; pure formatting functions live in a .ts file in the
 * same directory.
 */
import type { TFunction } from 'i18next'
import type { ScheduleView } from '../../../api/harness'
import { formatDateTime } from '../../../utils/schedules/format'

export function describeScheduleRule(task: ScheduleView, t: TFunction): string {
  if (task.when.kind === 'daily') {
    return t('schedulesPage.ruleDaily', { time: task.when.time })
  }
  if (task.when.kind === 'every') {
    return t('schedulesPage.ruleEvery', { minutes: String(task.when.minutes) })
  }
  return t('schedulesPage.ruleOnce', { time: formatDateTime(task.when.at) })
}
