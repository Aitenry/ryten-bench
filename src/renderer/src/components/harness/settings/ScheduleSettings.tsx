import React, { useCallback, useEffect, useState } from 'react'
import { Button, Empty, Tag, theme } from 'antd'
import {
  RiCalendar2Line,
  RiDeleteBin6Line,
  RiPauseLine,
  RiPlayLine,
  RiRefreshLine
} from '@remixicon/react'
import { useTranslation } from '@renderer/i18n'
import { useMessage } from '@renderer/hooks/useMessage'
import {
  SettingsPageHeader,
  SettingsSection
} from '@renderer/components/system/settings/SettingsUI'
import { harnessApi, type ScheduleView } from '../../../api/harness'

/**
 * 设置 →「定时任务」：列出模型创建的调度任务，支持暂停 / 恢复 / 删除。
 *
 * 创建仍走模型工具（需要会话归属与自然语言提示词）；这里只做管理，避免用户
 * 为了关掉一个提醒还得去跟助手对话。
 */
const ScheduleSettings: React.FC = () => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const { viewMessage } = useMessage()

  const [tasks, setTasks] = useState<ScheduleView[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      setTasks(await harnessApi.harness.listSchedules())
    } catch (error) {
      viewMessage(
        'schedule-settings-load',
        'error',
        t('scheduleSettings.loadFailed', { reason: String(error) })
      )
      setTasks([])
    } finally {
      setLoading(false)
    }
  }, [t, viewMessage])

  useEffect(() => {
    void load()
  }, [load])

  const act = useCallback(
    async (id: string, action: 'pause' | 'resume' | 'delete'): Promise<void> => {
      setBusyId(id)
      try {
        const result = await harnessApi.harness.updateSchedule({ id, action })
        if (!result.ok) {
          viewMessage(
            'schedule-settings-action',
            'error',
            t('scheduleSettings.actionFailed')
          )
          return
        }
        await load()
      } catch (error) {
        viewMessage(
          'schedule-settings-action',
          'error',
          t('scheduleSettings.loadFailed', { reason: String(error) })
        )
      } finally {
        setBusyId(null)
      }
    },
    [load, t, viewMessage]
  )

  const timeText = (iso: string | null): string =>
    iso ? new Date(iso).toLocaleString() : t('scheduleSettings.never')

  const statusText = (status: ScheduleView['lastStatus']): string => {
    if (status === 'completed') return t('scheduleSettings.statusCompleted')
    if (status === 'cancelled') return t('scheduleSettings.statusCancelled')
    if (status === 'failed') return t('scheduleSettings.statusFailed')
    return t('scheduleSettings.never')
  }

  const ruleText = (task: ScheduleView): string => {
    if (task.when.kind === 'once') {
      return t('scheduleSettings.ruleOnce', { at: timeText(task.when.at) })
    }
    if (task.when.kind === 'every') {
      return t('scheduleSettings.ruleEvery', { minutes: task.when.minutes })
    }
    return t('scheduleSettings.ruleDaily', { time: task.when.time })
  }

  return (
    <div>
      <SettingsPageHeader
        title={t('scheduleSettings.pageTitle')}
        description={t('scheduleSettings.pageDescription')}
        extra={
          <Button size="small" icon={<RiRefreshLine size={14} />} onClick={() => void load()}>
            {t('scheduleSettings.refresh')}
          </Button>
        }
      />
      <SettingsSection
        title={t('scheduleSettings.sectionTitle')}
        description={t('scheduleSettings.sectionDescription')}
        icon={<RiCalendar2Line size={16} />}
      >
        {loading ? (
          <div style={{ padding: 16, color: token.colorTextTertiary }}>…</div>
        ) : tasks.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={t('scheduleSettings.empty')}
            style={{ padding: '16px 0' }}
          />
        ) : (
          tasks.map((task) => (
            <div
              key={task.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 14px',
                borderTop: `1px solid ${token.colorBorderSecondary}`
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontWeight: 600, color: token.colorText }}>{task.title}</span>
                  <Tag
                    color={task.enabled ? 'green' : 'default'}
                    style={{ marginInlineEnd: 0 }}
                  >
                    {task.enabled
                      ? t('scheduleSettings.stateEnabled')
                      : t('scheduleSettings.statePaused')}
                  </Tag>
                </div>
                <div style={{ fontSize: 12, color: token.colorTextSecondary, marginTop: 2 }}>
                  {ruleText(task)}
                  {' · '}
                  {t('scheduleSettings.nextRun', { time: timeText(task.nextRunAt) })}
                </div>
                {task.lastRunAt ? (
                  <div style={{ fontSize: 12, color: token.colorTextTertiary, marginTop: 2 }}>
                    {t('scheduleSettings.lastRun', {
                      time: timeText(task.lastRunAt),
                      status: statusText(task.lastStatus)
                    })}
                  </div>
                ) : null}
                <div
                  style={{
                    fontSize: 12,
                    color: token.colorTextTertiary,
                    marginTop: 2,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis'
                  }}
                  title={task.prompt}
                >
                  {t('scheduleSettings.prompt', { prompt: task.prompt })}
                </div>
              </div>
              <Button
                size="small"
                disabled={busyId !== null}
                icon={task.enabled ? <RiPauseLine size={14} /> : <RiPlayLine size={14} />}
                onClick={() => void act(task.id, task.enabled ? 'pause' : 'resume')}
              >
                {task.enabled
                  ? t('scheduleSettings.pause')
                  : t('scheduleSettings.resume')}
              </Button>
              <Button
                size="small"
                danger
                disabled={busyId !== null}
                icon={<RiDeleteBin6Line size={14} />}
                onClick={() => void act(task.id, 'delete')}
              >
                {t('scheduleSettings.delete')}
              </Button>
            </div>
          ))
        )}
      </SettingsSection>
    </div>
  )
}

export default ScheduleSettings
