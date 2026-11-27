import React from 'react'
import { theme } from 'antd'
import { RiArrowRightSLine, RiLoader4Line, RiTerminalBoxLine } from '@remixicon/react'
import { useTranslation } from '@renderer/i18n'

import type { JobSnapshot } from '../../../../shared/harness/types'

/**
 * 顶部栏「后台任务」入口（execute run_in_background=true）。
 *
 * 按用户 2026-11-26 的设计口径：按钮本身是**整个内联托盘的折叠开关**，
 * 左侧是折叠箭头，右边显示运行数；真正的任务行在 HarnessHeader 下方展开，
 * 不再用 Popover/Modal。数据由 useBackgroundJobs 提供，这里只负责渲染。
 */
interface BackgroundJobsButtonProps {
  jobs: JobSnapshot[]
  open: boolean
  onToggle: () => void
}

/** 运行中的任务数（stopping 也算「还在跑」，与托盘的停止按钮状态一致） */
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
      {/* 左侧折叠箭头：整个托盘的开合状态 */}
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
