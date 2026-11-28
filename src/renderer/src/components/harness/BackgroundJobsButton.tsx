import React from 'react'
import { theme } from 'antd'
import { RiArrowRightSLine, RiLoader4Line, RiTerminalBoxLine } from '@remixicon/react'
import { useTranslation } from '@renderer/i18n'

import type { JobSnapshot } from '../../../../shared/harness/types'

/**
 * "Background jobs" entry in the top bar (execute run_in_background=true).
 *
 * Per the 2026-11-26 design: the button itself is the **collapse toggle for the entire inline
 * tray** — collapse arrow on the left, running count on the right. The actual job rows expand
 * below HarnessHeader instead of using a Popover/Modal. Data comes from useBackgroundJobs; this
 * component only renders it.
 */
interface BackgroundJobsButtonProps {
  jobs: JobSnapshot[]
  open: boolean
  onToggle: () => void
}

/** Number of active jobs (stopping counts as still running, matching the tray's stop button) */
const activeCountOf = (jobs: JobSnapshot[]): number =>
  jobs.filter((job) => job.status === 'running' || job.status === 'stopping').length

const BackgroundJobsButton: React.FC<BackgroundJobsButtonProps> = ({ jobs, open, onToggle }) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()

  if (jobs.length === 0) return null

  const activeCount = activeCountOf(jobs)
  const summary =
    activeCount > 0
      ? t('harness.backgroundJobs.runningCount', { count: activeCount })
      : t('harness.backgroundJobs.totalCount', { count: jobs.length })

  return (
    <button
      type="button"
      className="harness-bg-toggle"
      data-background-jobs-button
      data-background-jobs-open={open ? '1' : '0'}
      aria-expanded={open}
      title={t('harness.backgroundJobs.title')}
      onClick={onToggle}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        height: 28,
        padding: '0 10px 0 4px',
        border: '1px solid',
        borderColor: open ? token.colorBorderSecondary : 'transparent',
        borderRadius: 8,
        background: open ? token.colorFillTertiary : undefined,
        color: token.colorText,
        cursor: 'pointer',
        fontFamily: 'inherit'
      }}
    >
      {/* Left chevron: the expand/collapse state of the whole tray */}
      <span
        aria-hidden="true"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 20,
          height: 20,
          flex: '0 0 20px',
          border: `1px solid ${token.colorBorderSecondary}`,
          borderRadius: 5,
          background: token.colorFillQuaternary,
          color: token.colorTextSecondary
        }}
      >
        <RiArrowRightSLine
          size={12}
          style={{
            transform: open ? 'rotate(90deg)' : 'none',
            transition: 'transform 0.18s ease'
          }}
        />
      </span>

      {activeCount > 0 ? (
        <RiLoader4Line
          size={12}
          className="animate-spin"
          style={{ color: token.colorPrimary, flexShrink: 0 }}
        />
      ) : (
        <RiTerminalBoxLine size={13} style={{ color: token.colorTextSecondary, flexShrink: 0 }} />
      )}

      <span style={{ color: token.colorTextSecondary, fontSize: 12 }}>
        {t('harness.backgroundJobs.title')}
      </span>
      <span style={{ color: token.colorTextTertiary, fontSize: 11 }}>·</span>
      <span style={{ color: token.colorTextSecondary, fontSize: 11.5 }}>{summary}</span>
    </button>
  )
}

export default BackgroundJobsButton
