/**
 * Schedule "run history" modal.
 *
 * Run records are **kept forever** (the database table is never pruned); they are listed here in
 * reverse chronological order with pagination, and "Load more" pages further back when there is a
 * lot of history — nothing is cleaned up automatically.
 */
import React, { useCallback, useEffect, useState } from 'react'
import { Button, Modal, theme } from 'antd'
import { RiArrowRightSLine } from '@remixicon/react'
import { useTranslation } from '@renderer/i18n'
import { harnessApi, type ScheduleRunView, type ScheduleView } from '../../../api/harness'
import { formatDateTime } from '../../../utils/schedules/format'

const PAGE_SIZE = 20

interface Props {
  open: boolean
  task: ScheduleView | null
  onClose: () => void
  /** Open the floating run-detail panel for one record */
  onOpenRun?: (run: ScheduleRunView) => void
}

const ScheduleRunsModal: React.FC<Props> = ({ open, task, onClose, onOpenRun }) => {
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

  /**
   * One-line summary under the status row ("3 步 · 2 个产物 · 19 秒") so the history itself shows
   * what a run did; older runs have no detail and render nothing.
   */
  const runMeta = (run: ScheduleRunView): string => {
    const parts: string[] = []
    if (run.steps && run.steps.length > 0) {
      parts.push(t('schedulesPage.runStepsCount', { count: String(run.steps.length) }))
    }
    if (run.artifacts && run.artifacts.length > 0) {
      parts.push(t('schedulesPage.runArtifactsCount', { count: String(run.artifacts.length) }))
    }
    const seconds = run.usage?.durationMs ? Math.max(1, Math.round(run.usage.durationMs / 1000)) : 0
    if (seconds > 0) {
      parts.push(t('schedulesPage.runPanelDuration', { seconds: String(seconds) }))
    }
    return parts.join(' · ')
  }

  return (
    <Modal open={open} onCancel={onClose} footer={null} width={520} title={t('schedulesPage.runsTitle')}>
      <div style={{ fontSize: 12.3, color: token.colorTextSecondary, marginBottom: 12 }}>
        {task ? `${task.title} · ` : ''}
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
            <button
              key={`${run.at}-${index}`}
              type="button"
              onClick={() => onOpenRun?.(run)}
              title={t('schedulesPage.runRowHint')}
              className="ryt-run-row"
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
                padding: '7px 10px',
                borderRadius: 8,
                border: 'none',
                textAlign: 'left',
                width: '100%',
                background: token.colorFillQuaternary,
                cursor: onOpenRun ? 'pointer' : 'default'
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
              <div style={{ minWidth: 0, flex: '1 1 auto' }}>
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
                {runMeta(run) ? (
                  <div style={{ marginTop: 3, fontSize: 11, color: token.colorTextTertiary }}>
                    {runMeta(run)}
                  </div>
                ) : null}
              </div>
              {onOpenRun ? (
                <span
                  style={{
                    flex: '0 0 auto',
                    alignSelf: 'center',
                    color: token.colorTextTertiary,
                    display: 'flex'
                  }}
                >
                  <RiArrowRightSLine size={14} />
                </span>
              ) : null}
            </button>
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
