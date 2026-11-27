/**
 * 定时任务规则的「一句话描述」（每天 09:00 / 每 30 分钟 / 一次性 12-05 14:00）。
 *
 * 从 `ScheduleCard.tsx` 拆出来：组件文件只导出组件，才能让
 * react-refresh（HMR）对卡片生效；纯格式化函数放在同目录的 .ts 文件里。
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
