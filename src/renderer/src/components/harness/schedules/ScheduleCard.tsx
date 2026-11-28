/**
 * Schedule card (the "Schedules" page in the sidebar).
 *
 * Layout matches the design: title + status pill, **all action icons grouped before the `⋯` in
 * the top-right corner** (pause/resume, edit, delete in that order), no actions at the bottom;
 * the body then shows the rule and next trigger, the conversation tag and last run, and a prompt
 * excerpt (clamped to 2 lines).
 */
import React from 'react'
import { Button, Dropdown, Tooltip, theme } from 'antd'
import {
  RiDeleteBin6Line,
  RiMore2Fill,
  RiPauseLine,
  RiPencilLine,
  RiPlayLine,
  RiTimeLine
} from '@remixicon/react'
import { useTranslation } from '@renderer/i18n'
import type { ScheduleView } from '../../../api/harness'
import { formatDateTime, formatRelativeDay, remainingParts } from '../../../utils/schedules/format'
import { describeScheduleRule } from './describe-rule'

export interface ScheduleCardActions {
  onPause: (task: ScheduleView) => void
  onResume: (task: ScheduleView) => void
  onEdit: (task: ScheduleView) => void
  onDelete: (task: ScheduleView) => void
  onViewRuns: (task: ScheduleView) => void
  onDuplicate: (task: ScheduleView) => void
  busy: boolean
}

const ICON_SIZE = 14

const ScheduleCard: React.FC<{ task: ScheduleView; topicTitle?: string } & ScheduleCardActions> = ({
  task,
  topicTitle,
  onPause,
  onResume,
  onEdit,
  onDelete,
  onViewRuns,
  onDuplicate,
  busy
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  const statusLabel =
    task.lastStatus === 'completed'
      ? t('schedulesPage.statusCompleted')
      : task.lastStatus === 'cancelled'
        ? t('schedulesPage.statusCancelled')
        : task.lastStatus === 'failed'
          ? t('schedulesPage.statusFailed')
          : ''

  const nextText = task.enabled
    ? task.nextRunAt
      ? formatRelativeDay(task.nextRunAt)
      : t('schedulesPage.nextExpired')
    : t('schedulesPage.nextNone')

  /**
   * "还有 3 小时 12 分" chip: makes the stored next-run readable at a glance. When the instant has
   * already passed (the app was closed when it was due, and the runner has not ticked yet) it says
   * "即将执行" instead of showing a negative countdown.
   */
  const remaining = task.enabled && task.nextRunAt ? remainingParts(task.nextRunAt) : null
  const remainingText = remaining
    ? remaining.overdue
      ? t('schedulesPage.dueNow')
      : remaining.days > 0
        ? t('schedulesPage.remainingDays', {
            days: String(remaining.days),
            hours: String(remaining.hours)
          })
        : remaining.hours > 0
          ? t('schedulesPage.remainingHours', {
              hours: String(remaining.hours),
              minutes: String(remaining.minutes)
            })
          : t('schedulesPage.remainingMinutes', {
              minutes: String(Math.max(1, remaining.minutes))
            })
    : null

  /** Task-level run selection summary ("跟随会话" when the task has no override) */
  const selection = task.agentConfig
  const toolCount = selection?.tools?.length ?? 0
  const skillCount = selection?.skills?.length ?? 0
  const mcpCount = selection?.mcpTools?.length ?? 0
  const runInfoText =
    toolCount + skillCount + mcpCount === 0
      ? t('schedulesPage.followConversation')
      : t('schedulesPage.runInfo', {
          tools: String(toolCount),
          skills: String(skillCount),
          mcp: String(mcpCount)
        })

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: 158,
        padding: '15px 16px 14px',
        background: token.colorBgContainer,
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: 16,
        transition: 'background .15s, border-color .15s'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        {/* The title takes the remaining width and truncates: a long task name must not push the
            status pill / icons to a second line (narrow cards used to break the label mid-word). */}
        <span
          title={task.title}
          style={{
            flex: '1 1 auto',
            minWidth: 0,
            fontSize: 14.5,
            fontWeight: 650,
            color: token.colorText,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {task.title}
        </span>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            flex: '0 0 auto',
            height: 20,
            padding: '0 8px',
            borderRadius: 999,
            fontSize: 10.5,
            whiteSpace: 'nowrap',
            color: task.enabled ? '#7bd13f' : token.colorTextTertiary,
            background: task.enabled ? 'rgba(73,170,25,.12)' : token.colorFillTertiary
          }}
        >
          <span
            style={{
              width: 5,
              height: 5,
              borderRadius: '50%',
              background: 'currentColor'
            }}
          />
          {task.enabled ? t('schedulesPage.stateEnabled') : t('schedulesPage.statePaused')}
        </span>

        <div
          style={{
            marginLeft: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            flex: '0 0 auto'
          }}
        >
          <Tooltip title={task.enabled ? t('schedulesPage.pause') : t('schedulesPage.resume')}>
            <Button
              type="text"
              size="small"
              disabled={busy}
              icon={task.enabled ? <RiPauseLine size={ICON_SIZE} /> : <RiPlayLine size={ICON_SIZE} />}
              onClick={() => (task.enabled ? onPause(task) : onResume(task))}
            />
          </Tooltip>
          <Tooltip title={t('schedulesPage.edit')}>
            <Button
              type="text"
              size="small"
              disabled={busy}
              icon={<RiPencilLine size={ICON_SIZE} />}
              onClick={() => onEdit(task)}
            />
          </Tooltip>
          <Tooltip title={t('schedulesPage.delete')}>
            <Button
              type="text"
              size="small"
              danger
              disabled={busy}
              icon={<RiDeleteBin6Line size={ICON_SIZE} />}
              onClick={() => onDelete(task)}
            />
          </Tooltip>
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                { key: 'runs', label: t('schedulesPage.viewRuns') },
                { key: 'duplicate', label: t('schedulesPage.duplicate') }
              ],
              onClick: ({ key }) => {
                if (key === 'runs') onViewRuns(task)
                if (key === 'duplicate') onDuplicate(task)
              }
            }}
          >
            <Button type="text" size="small" icon={<RiMore2Fill size={ICON_SIZE} />} />
          </Dropdown>
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          marginTop: 11,
          fontSize: 12.5,
          color: token.colorTextSecondary,
          // Single line: the rule + next-run text may truncate, the countdown on the right stays
          flexWrap: 'nowrap',
          minWidth: 0
        }}
      >
        <RiTimeLine size={13} style={{ color: token.colorTextTertiary, flex: '0 0 auto' }} />
        <span style={{ flex: '0 0 auto' }}>{describeScheduleRule(task, t)}</span>
        <span
          style={{
            width: 3,
            height: 3,
            borderRadius: '50%',
            background: token.colorTextTertiary,
            flex: '0 0 auto'
          }}
        />
        <span
          style={{
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {t('schedulesPage.nextPrefix')}{' '}
          <span style={{ color: token.colorText, fontWeight: 550 }}>{nextText}</span>
        </span>
        {remainingText && (
          <span
            style={{
              marginLeft: 'auto',
              fontSize: 11,
              color: token.colorTextTertiary,
              flex: '0 0 auto',
              whiteSpace: 'nowrap'
            }}
          >
            {remainingText}
          </span>
        )}
      </div>

      {/* One line only: the conversation chip absorbs the missing width (ellipsis), while the
          run-selection chip and the last-run text never wrap (they used to break onto a second
          row in a narrow card, which read as a layout bug). */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginTop: 10,
          flexWrap: 'nowrap',
          minWidth: 0,
          overflow: 'hidden'
        }}
      >
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            height: 22,
            padding: '0 8px',
            borderRadius: 6,
            background: token.colorFillQuaternary,
            color: token.colorTextSecondary,
            fontSize: 11,
            flex: '1 1 auto',
            minWidth: 0,
            maxWidth: '100%'
          }}
        >
          <span style={{ color: token.colorTextTertiary, flex: '0 0 auto' }}>
            {t('schedulesPage.conversationLabel')}
          </span>
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0
            }}
          >
            {task.topicId != null
              ? (topicTitle ?? String(task.topicId))
              : t('schedulesPage.newSessionTag')}
          </span>
        </span>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            height: 22,
            padding: '0 8px',
            borderRadius: 6,
            background: token.colorFillQuaternary,
            color: token.colorTextSecondary,
            fontSize: 11,
            flex: '0 0 auto',
            whiteSpace: 'nowrap'
          }}
        >
          <span style={{ color: token.colorTextTertiary }}>{t('schedulesPage.runLabel')}</span>
          <span>{runInfoText}</span>
        </span>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 11,
            color: token.colorTextTertiary,
            flex: '0 0 auto',
            whiteSpace: 'nowrap'
          }}
        >
          {task.lastRunAt ? (
            <>
              <span style={{ color: task.lastStatus === 'completed' ? '#49aa19' : token.colorTextTertiary }}>
                ✓
              </span>
              {t('schedulesPage.lastRunAt', {
                time: formatDateTime(task.lastRunAt),
                status: statusLabel
              })}
            </>
          ) : (
            <>{t('schedulesPage.lastNone')}</>
          )}
        </span>
      </div>

      <div
        title={task.prompt}
        style={{
          marginTop: 11,
          padding: '8px 10px',
          borderLeft: `2px solid ${token.colorBorderSecondary}`,
          background: token.colorFillQuaternary,
          borderRadius: 9,
          // Padding lives here, **not** on the clamped element: `-webkit-line-clamp` sizes the
          // content box while `overflow: hidden` clips at the padding box, so a padded clamp box
          // leaks the first few pixels of the next line into its own bottom padding (the
          // "2 行省略却还能看到第 3 行" bug).
          overflow: 'hidden'
        }}
      >
        <div
          style={{
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            fontSize: 11.8,
            lineHeight: 1.55,
            color: token.colorTextSecondary
          }}
        >
          {task.prompt}
        </div>
      </div>
    </div>
  )
}

export default ScheduleCard
