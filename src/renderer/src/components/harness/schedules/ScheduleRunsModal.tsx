/**
 * 定时任务「执行记录」弹窗。
 *
 * 执行记录**永久保存**（数据库表不裁剪），这里按时间倒序分页展示；
 * 历史多时用「加载更多」继续翻，不做自动清理。
 */
import React, { useCallback, useEffect, useState } from 'react'
import { Button, Modal, theme } from 'antd'
import { useTranslation } from '@renderer/i18n'
import { harnessApi, type ScheduleRunView, type ScheduleView } from '../../../api/harness'
import { formatDateTime } from '../../../utils/schedules/format'

const PAGE_SIZE = 20

interface Props {
  open: boolean
  task: ScheduleView | null
  onClose: () => void
}

const ScheduleRunsModal: React.FC<Props> = ({ open, task, onClose }) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [runs, setRuns] = useState<ScheduleRunView[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)

  const load = useCallback(
    async (offset: number): Promise<void> => {
      if (!task) return
      setLoading(true)
      try {
        const result = await harnessApi.harness.getScheduleRuns(task.id, PAGE_SIZE, offset)
        setRuns((prev) => (offset === 0 ? result.runs : [...prev, ...result.runs]))
        setTotal(result.total)
      } catch {
        if (offset === 0) {
          setRuns([])
          setTotal(0)
        }
      } finally {
        setLoading(false)
      }
    },
    [task]
  )

  useEffect(() => {
    if (!open) return
    setRuns([])
    setTotal(0)
    void load(0)
  }, [open, load])

  const statusText = (status: ScheduleRunView['status']): string =>
    status === 'completed'
      ? t('schedulesPage.runsStatusCompleted')
      : status === 'cancelled'
        ? t('schedulesPage.runsStatusCancelled')
        : t('schedulesPage.runsStatusFailed')

  const statusColor = (status: ScheduleRunView['status']): string =>
    status === 'completed'
      ? token.colorSuccess
      : status === 'cancelled'
        ? token.colorTextTertiary
        : token.colorError

  return (
    <Modal open={open} onCancel={onClose} footer={null} width={520} title={t('schedulesPage.runsTitle')}>
      <div style={{ fontSize: 12.3, color: token.colorTextSecondary, marginBottom: 12 }}>
        {task ? `${task.title} · ` : ''}
        {t('schedulesPage.runsDesc')}
        {' · '}
        {t('schedulesPage.runsCount', { count: total })}
      </div>
      {runs.length === 0 && !loading ? (
        <div style={{ padding: '18px 0', color: token.colorTextTertiary, fontSize: 12.5 }}>
          {t('schedulesPage.runsEmpty')}
        </div>
      ) : (
        <div
          className="custom-scrollbar app-modal-scroll"
          style={{
            maxHeight: 360,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 6
          }}
        >
          {runs.map((run, index) => (
            <div
              key={`${run.at}-${index}`}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
                padding: '7px 10px',
                borderRadius: 8,
                background: token.colorFillQuaternary
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  marginTop: 6,
                  background: statusColor(run.status)
                }}
              />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12.5, color: token.colorText }}>
                  {statusText(run.status)}
                  <span style={{ marginLeft: 8, color: token.colorTextTertiary, fontSize: 11.5 }}>
                    {formatDateTime(run.at)}
                  </span>
                </div>
                {run.detail && (
                  <div style={{ marginTop: 3, fontSize: 11.5, color: token.colorTextSecondary }}>
                    {run.detail}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 14 }}>
        {runs.length < total ? (
          <Button size="small" loading={loading} onClick={() => void load(runs.length)}>
            {t('schedulesPage.runsLoadMore')}
          </Button>
        ) : (
          <span />
        )}
        <Button onClick={onClose}>{t('schedulesPage.cancel')}</Button>
      </div>
    </Modal>
  )
}

export default ScheduleRunsModal
