/**
 * 定时任务卡片（侧边栏「定时任务」页）。
 *
 * 版式对齐设计稿：标题 + 状态 pill，**所有操作图标收在右上角 `⋯` 之前**
 * （暂停/恢复、编辑、删除依次排列），底部不放操作；正文依次是规则与下次触发、
 * 会话 tag 与上次执行、提示词摘要（2 行截断）。
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
import { formatDateTime, formatRelativeDay } from '../../../utils/schedules/format'
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
      ? t('schedulesPage.nextAt', { time: formatRelativeDay(task.nextRunAt) })
      : t('schedulesPage.nextExpired')
    : t('schedulesPage.nextNone')

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
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 14.5, fontWeight: 650, color: token.colorText }}>{task.title}</span>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            height: 20,
            padding: '0 8px',
            borderRadius: 999,
            fontSize: 10.5,
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

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 1 }}>
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
          marginTop: 10,
          fontSize: 12.5,
          color: token.colorTextSecondary
        }}
      >
        <RiTimeLine size={13} style={{ color: token.colorTextTertiary }} />
        <span>{describeScheduleRule(task, t)}</span>
        <span style={{ width: 3, height: 3, borderRadius: '50%', background: token.colorTextTertiary }} />
        <span>{nextText}</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 9, flexWrap: 'wrap' }}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            height: 21,
            padding: '0 8px',
            borderRadius: 6,
            background: token.colorFillQuaternary,
            color: token.colorTextSecondary,
            fontSize: 11
          }}
        >
          {t('schedulesPage.conversation', {
            title:
              task.topicId != null
                ? (topicTitle ?? String(task.topicId))
                : t('schedulesPage.newSessionTag')
          })}
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: token.colorTextTertiary }}>
          {task.lastRunAt ? (
            <>
              <span style={{ color: task.lastStatus === 'completed' ? '#49aa19' : token.colorTextTertiary }}>✓</span>
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
          background: token.colorFillQuaternary,
          borderRadius: 9,
          fontSize: 11.8,
          lineHeight: 1.55,
          color: token.colorTextSecondary,
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden'
        }}
      >
        {task.prompt}
      </div>
    </div>
  )
}

export default ScheduleCard
