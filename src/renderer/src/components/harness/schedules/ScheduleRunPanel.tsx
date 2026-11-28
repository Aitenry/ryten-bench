/**
 * One scheduled run in a floating side panel: **process** (tool steps) and **artifacts**
 * (files written / declared) of that run.
 *
 * Opened from the run-history modal; it floats over the schedules page (dimmed backdrop, close by
 * ✕ / backdrop click / Esc) so the list stays where it was. The data comes from the run record
 * (`steps` / `artifacts` / `usage`), written by the scheduler after the turn finished — old runs
 * have none of it and simply show fewer sections.
 */
import React, { useEffect, useMemo, useState } from 'react'
import { Dropdown, theme } from 'antd'
import {
  RiArrowDownSLine,
  RiArrowRightSLine,
  RiCheckboxCircleFill,
  RiCloseLine,
  RiErrorWarningFill,
  RiFileImageLine,
  RiFileTextLine,
  RiTimeLine
} from '@remixicon/react'
import { useTranslation } from '@renderer/i18n'
import { harnessApi, type ScheduleRunView, type ScheduleView } from '../../../api/harness'
import OpenWithButton from '../OpenWithButton'
import { formatDateTime } from '../../../utils/schedules/format'

interface Props {
  open: boolean
  task: ScheduleView | null
  run: ScheduleRunView | null
  onClose: () => void
  /** Open the conversation this run executed in (the page owns topic lookup + navigation) */
  onOpenConversation?: (topicId: number) => void
  /** Switch the panel to another record of the same task (keeps the panel open) */
  onSelectRun?: (run: ScheduleRunView) => void
  /** Open one artifact in the workspace panel (via the conversation handoff) */
  onOpenArtifact?: (path: string) => void
}

type Tab = 'process' | 'artifacts'

/** Seconds with one decimal below a minute, whole seconds above */
function formatDuration(ms: number | null | undefined): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null
  const seconds = ms / 1000
  return seconds < 10 ? seconds.toFixed(1) : String(Math.round(seconds))
}

function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(path)
}

const ScheduleRunPanel: React.FC<Props> = ({
  open,
  task,
  run,
  onClose,
  onOpenConversation,
  onSelectRun,
  onOpenArtifact
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [tab, setTab] = useState<Tab>('process')
  /** Recent runs of this task, newest first (for the "第 N 次 / 切换" control) */
  const [runs, setRuns] = useState<ScheduleRunView[]>([])

  // Load the run list whenever the panel opens: the switcher should work without going back to
  // the history list first.
  useEffect(() => {
    if (!open || !task) return
    let cancelled = false
    void harnessApi.harness
      .getScheduleRuns(task.id, 50, 0)
      .then((result) => {
        if (!cancelled) setRuns(result.runs)
      })
      .catch(() => {
        if (!cancelled) setRuns([])
      })
    return () => {
      cancelled = true
    }
  }, [open, task])

  // Newest-first list → chronological ordinal ("第 3 / 5 次")
  const runIndex = runs.findIndex((item) => item.at === run?.at && item.status === run?.status)
  const runOrdinal = runIndex >= 0 ? runs.length - runIndex : 0

  const steps = run?.steps ?? []
  const artifacts = run?.artifacts ?? []
  const hasProcess = steps.length > 0
  const hasArtifacts = artifacts.length > 0

  // Default to the tab that actually has content; artefact-only runs should not open on an
  // empty process list.
  useEffect(() => {
    if (!open) return
    setTab(hasProcess ? 'process' : hasArtifacts ? 'artifacts' : 'process')
  }, [open, hasProcess, hasArtifacts])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const duration = formatDuration(run?.usage?.durationMs)
  const tokens = run?.usage?.totalTokens

  const statusText = useMemo(() => {
    if (!run) return ''
    if (run.status === 'completed') return t('schedulesPage.runsStatusCompleted')
    if (run.status === 'cancelled') return t('schedulesPage.runsStatusCancelled')
    return t('schedulesPage.runsStatusFailed')
  }, [run, t])

  const statusColor = !run
    ? token.colorTextTertiary
    : run.status === 'completed'
      ? token.colorSuccess
      : run.status === 'cancelled'
        ? token.colorTextTertiary
        : token.colorError

  if (!open || !run) return null

  const tabButton = (key: Tab, label: string, count: number | null): React.ReactElement => {
    const active = tab === key
    return (
      <button
        type="button"
        onClick={() => setTab(key)}
        style={{
          height: 28,
          padding: '0 12px',
          borderRadius: 8,
          border: 'none',
          cursor: 'pointer',
          fontSize: 12,
          fontWeight: active ? 600 : 400,
          color: active ? token.colorText : token.colorTextSecondary,
          background: active ? token.colorFillSecondary : 'transparent'
        }}
      >
        {label}
        {count !== null ? ` ${count}` : ''}
      </button>
    )
  }

  return (
    <div
      data-run-panel="open"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        justifyContent: 'flex-end',
        padding: 14,
        background: 'rgba(0,0,0,.42)'
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        style={{
          width: 462,
          maxWidth: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: token.colorBgElevated,
          border: `1px solid ${token.colorBorderSecondary}`,
          borderRadius: 18,
          boxShadow: '0 24px 60px rgba(0,0,0,.45)'
        }}
      >
        <div style={{ padding: '14px 16px 10px', borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 650, color: token.colorText }}>
                {task?.title ?? t('schedulesPage.runsTitle')}
              </div>
              <div
                style={{
                  marginTop: 5,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 7,
                  flexWrap: 'wrap',
                  fontSize: 11.5,
                  color: token.colorTextTertiary
                }}
              >
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    height: 19,
                    padding: '0 7px',
                    borderRadius: 999,
                    color: statusColor,
                    background: `${statusColor}1f`
                  }}
                >
                  <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'currentColor' }} />
                  {statusText}
                </span>
                <span>{formatDateTime(run.at)}</span>
                {duration ? <span>· {t('schedulesPage.runPanelDuration', { seconds: duration })}</span> : null}
                {typeof tokens === 'number' ? (
                  <span>· {t('schedulesPage.runPanelTokens', { count: String(tokens) })}</span>
                ) : null}
                {run.topicId ? (
                  <span>· {t('schedulesPage.runPanelConversation', { topicId: String(run.topicId) })}</span>
                ) : null}
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              title={t('schedulesPage.runPanelClose')}
              style={{
                marginLeft: 'auto',
                width: 26,
                height: 26,
                borderRadius: 7,
                border: `1px solid ${token.colorBorderSecondary}`,
                background: token.colorFillTertiary,
                color: token.colorTextSecondary,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              <RiCloseLine size={14} />
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 12 }}>
            {tabButton('process', t('schedulesPage.runPanelProcess'), hasProcess ? steps.length : null)}
            {tabButton(
              'artifacts',
              t('schedulesPage.runPanelArtifacts'),
              hasArtifacts ? artifacts.length : null
            )}
            {onSelectRun && runs.length > 0 ? (
              <Dropdown
                trigger={['click']}
                menu={{
                  selectedKeys: runIndex >= 0 ? [String(runIndex)] : [],
                  items: runs.map((item, index) => ({
                    key: String(index),
                    label: (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                        <span style={{ color: item.status === 'completed' ? '#3fb950' : item.status === 'failed' ? '#f85149' : token.colorTextTertiary }}>
                          ●
                        </span>
                        {formatDateTime(item.at)}
                        <span style={{ color: token.colorTextTertiary, fontSize: 11 }}>
                          {item.status === 'completed'
                            ? t('schedulesPage.runsStatusCompleted')
                            : item.status === 'cancelled'
                              ? t('schedulesPage.runsStatusCancelled')
                              : t('schedulesPage.runsStatusFailed')}
                        </span>
                      </span>
                    )
                  })),
                  onClick: ({ key }) => {
                    const next = runs[Number(key)]
                    if (next) onSelectRun(next)
                  }
                }}
              >
                <button
                  type="button"
                  title={t('schedulesPage.runPanelSwitch')}
                  style={{
                    marginLeft: 'auto',
                    height: 26,
                    padding: '0 8px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    borderRadius: 7,
                    border: `1px solid ${token.colorBorderSecondary}`,
                    background: token.colorFillTertiary,
                    color: token.colorTextSecondary,
                    fontSize: 11,
                    cursor: 'pointer'
                  }}
                >
                  {runOrdinal > 0
                    ? t('schedulesPage.runPanelRunOrdinal', {
                        index: String(runOrdinal),
                        total: String(runs.length)
                      })
                    : t('schedulesPage.runPanelSwitch')}
                  <RiArrowDownSLine size={12} />
                </button>
              </Dropdown>
            ) : null}
          </div>
        </div>

        <div className="custom-scrollbar" style={{ flex: '1 1 auto', overflowY: 'auto', padding: '12px 16px' }}>
          {run.detail ? (
            <div
              style={{
                marginBottom: 12,
                padding: '8px 10px',
                borderRadius: 9,
                border: `1px solid ${run.status === 'failed' ? token.colorErrorBorder : token.colorBorderSecondary}`,
                background: run.status === 'failed' ? token.colorErrorBg : token.colorFillQuaternary,
                color: run.status === 'failed' ? token.colorErrorText : token.colorTextSecondary,
                fontSize: 11.5,
                lineHeight: 1.6
              }}
            >
              {run.detail}
            </div>
          ) : null}
          {tab === 'process' ? (
            !hasProcess ? (
              <div style={{ padding: '10px 0', fontSize: 12, color: token.colorTextTertiary }}>
                {t('schedulesPage.runPanelNoSteps')}
              </div>
            ) : (
              <div style={{ position: 'relative', paddingLeft: 16 }}>
                <div
                  style={{
                    position: 'absolute',
                    left: 3,
                    top: 6,
                    bottom: 10,
                    width: 1,
                    background: token.colorBorderSecondary
                  }}
                />
                {steps.map((step, index) => (
                  <div key={`${step.name}-${index}`} style={{ position: 'relative', paddingBottom: 13 }}>
                    <span
                      style={{
                        position: 'absolute',
                        left: -16,
                        top: 4,
                        color: step.status === 'ok' ? token.colorSuccess : token.colorError,
                        display: 'flex'
                      }}
                    >
                      {step.status === 'ok' ? (
                        <RiCheckboxCircleFill size={8} />
                      ) : (
                        <RiErrorWarningFill size={8} />
                      )}
                    </span>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                      <span style={{ fontSize: 12.5, color: token.colorText, fontFamily: 'inherit' }}>
                        {step.name}
                      </span>
                      {step.path ? (
                        <span
                          title={step.path}
                          style={{
                            fontSize: 11,
                            color: token.colorTextTertiary,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap'
                          }}
                        >
                          {step.path}
                        </span>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            )
          ) : !hasArtifacts ? (
            <div style={{ padding: '10px 0', fontSize: 12, color: token.colorTextTertiary }}>
              {t('schedulesPage.runPanelNoArtifacts')}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {artifacts.map((artifact) => (
                <div
                  key={`${artifact.kind}-${artifact.path}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '9px 11px',
                    border: `1px solid ${token.colorBorderSecondary}`,
                    borderRadius: 11,
                    background: token.colorFillQuaternary,
                    minWidth: 0
                  }}
                >
                  <span
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: 8,
                      flex: '0 0 auto',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: token.colorPrimary,
                      background: token.colorPrimaryBg
                    }}
                  >
                    {isImagePath(artifact.path) ? <RiFileImageLine size={15} /> : <RiFileTextLine size={15} />}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 12.3,
                        fontWeight: 600,
                        color: token.colorText,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap'
                      }}
                      title={artifact.path}
                    >
                      {artifact.path.split('/').pop() ?? artifact.path}
                    </div>
                    <div
                      style={{
                        marginTop: 3,
                        fontSize: 10.5,
                        color: token.colorTextTertiary,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap'
                      }}
                    >
                      {artifact.description ??
                        (artifact.kind === 'deliverable'
                          ? t('schedulesPage.runPanelDeliverable')
                          : artifact.path)}
                    </div>
                  </div>
                  {onOpenArtifact ? (
                    <span style={{ marginLeft: 'auto', display: 'inline-flex', flex: '0 0 auto' }}>
                      <OpenWithButton
                        virtualPath={artifact.path}
                        label={t('schedulesPage.runPanelOpen')}
                        onOpenInApp={() => onOpenArtifact(artifact.path)}
                      />
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>

        <div
          style={{
            padding: '12px 16px',
            borderTop: `1px solid ${token.colorBorderSecondary}`,
            display: 'flex',
            alignItems: 'center',
            gap: 8
          }}
        >
          <button
            type="button"
            disabled={!run.topicId || !onOpenConversation}
            onClick={() => run.topicId && onOpenConversation?.(run.topicId)}
            style={{
              height: 30,
              padding: '0 12px',
              borderRadius: 8,
              border: `1px solid ${token.colorBorderSecondary}`,
              background: token.colorFillTertiary,
              color: token.colorText,
              fontSize: 12.5,
              cursor: run.topicId && onOpenConversation ? 'pointer' : 'not-allowed',
              opacity: run.topicId && onOpenConversation ? 1 : 0.5,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6
            }}
          >
            {t('schedulesPage.runPanelOpenConversation')}
            <RiArrowRightSLine size={13} />
          </button>
          <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: token.colorTextTertiary }}>
            <RiTimeLine size={12} />
            {run.usage?.durationMs ? t('schedulesPage.runPanelDuration', {
              seconds: formatDuration(run.usage.durationMs) ?? '0'
            }) : t('schedulesPage.runPanelNoDuration')}
          </span>
        </div>
      </div>
    </div>
  )
}

export default ScheduleRunPanel
