import React, { useEffect, useState } from 'react'
import { Button, theme } from 'antd'
import {
  RiAiAgentLine,
  RiArrowLeftLine,
  RiArrowRightSLine,
  RiLayoutRightLine,
  RiLayoutRightFill
} from '@remixicon/react'
import { useTranslation } from '@renderer/i18n'
import BackgroundJobsButton from './BackgroundJobsButton'
import BackgroundJobsTray from './BackgroundJobsTray'
import CollabButton from './CollabButton'
import { useBackgroundJobs } from '../../hooks/harness/useBackgroundJobs'
import type { SubagentSessionRow } from '../../../../shared/harness/types'
import type { TFunction } from 'i18next'

/** Subagent status text for the top bar breadcrumb (same wording as the background agent list) */
const headerSubagentStatusText = (t: TFunction, breadcrumb: HeaderSubagentBreadcrumb): string => {
  if (breadcrumb.status === 'running') return t('harness.backgroundAgents.running')
  if (breadcrumb.status === 'inactive') return t('harness.backgroundAgents.inactive')
  if (breadcrumb.lastStatus === 'failed') return t('harness.backgroundAgents.failed')
  if (breadcrumb.lastStatus === 'killed') return t('harness.backgroundAgents.killed')
  return t('harness.backgroundAgents.completed')
}

/** Subagent status color for the top bar breadcrumb (one semantic palette for dark/light, matching the background agent list) */
const headerSubagentStatusColor = (breadcrumb: HeaderSubagentBreadcrumb): string => {
  if (breadcrumb.status === 'running') return '#1677ff'
  if (breadcrumb.status === 'inactive') return '#8c8c8c'
  if (breadcrumb.lastStatus === 'failed') return '#ef4444'
  if (breadcrumb.lastStatus === 'killed') return '#8c8c8c'
  return '#52c41a'
}

/** Background subagent currently being viewed (its breadcrumb sits in the top bar and takes no extra row) */
export interface HeaderSubagentBreadcrumb {
  agentId: string
  name: string
  status: 'running' | 'idle' | 'inactive'
  lastStatus?: 'completed' | 'failed' | 'killed'
  queuedMessages: number
}

interface HarnessHeaderProps {
  /** Whether the "Start" panel on the right is open (the top button shows an active state) */
  startOpen: boolean
  /** Top button: open/collapse the "Start" tool panel on the right */
  onToggleStart: () => void
  colorBorderSecondary: string
  currentTopicId: number | null
  /** Clicking a background subagent in the top bar: the main conversation area switches to that subagent's streaming session (see SubagentConversationView) */
  onSelectSubagent?: (agent: SubagentSessionRow) => void
  /** Subagent currently being viewed (highlighted in the entry list; null when back on the main conversation) */
  activeSubagentId?: string | null
  /**
   * The subagent currently being viewed: when non-null, the left side of the top bar becomes
   * the breadcrumb "← Back to main agent | Main agent › Subagent name" (user requirement of
   * 2026-11-26: the breadcrumb content goes in the top bar, and the subagent name uses the same
   * font size as the main agent).
   */
  subagentBreadcrumb?: HeaderSubagentBreadcrumb | null
  onBackToMainAgent?: () => void
}

/**
 * Top bar above the conversation message area.
 *
 * Only view-related actions live here (background agent entry / background job entry / workspace
 * panel toggle); the **conversation title is not shown** — the conversation is already
 * highlighted in the system sidebar on the left (user requirement of 2026-11-19: no title at the
 * top; later clarified as "the panel buttons must sit at the top of the conversation messages,
 * make a top bar, don't put them inside the input box").
 * A blank conversation has no messages, so this bar is not rendered and the input box and
 * welcome text are centered together (see isWelcomeMode in Index).
 *
 * 2026-11-26: the background jobs (execute run_in_background) entry sits on the **left** at the
 * position marked by the user, while background agents and the panel toggle remain on the
 * right — the circled area on the left is the "circled region" mentioned originally.
 * Later that same day, per the design confirmed by the user, it changed to an "inline top tray":
 * clicking the button expands job rows below the title bar, each row with collapsible output on
 * the left and a stop action on the right, no longer using Popover / Modal.
 */
const HarnessHeader: React.FC<HarnessHeaderProps> = ({
  startOpen,
  onToggleStart,
  colorBorderSecondary,
  currentTopicId,
  onSelectSubagent,
  activeSubagentId,
  subagentBreadcrumb,
  onBackToMainAgent
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const { jobs, refresh, stopJob, peekOutput } = useBackgroundJobs(currentTopicId)
  const [jobsOpen, setJobsOpen] = useState(false)

  // Switching topics: collapse the tray (jobs are isolated per topicId, so old jobs must not show on a new topic)
  useEffect(() => {
    setJobsOpen(false)
  }, [currentTopicId])

  // All jobs were cleared (e.g. the topic was deleted): the tray must not remain as an empty shell
  useEffect(() => {
    if (jobs.length === 0) setJobsOpen(false)
  }, [jobs.length])

  const toggleJobs = (): void => {
    const next = !jobsOpen
    setJobsOpen(next)
    if (next) void refresh()
  }

  return (
    <>
      <div
        className="shell-topbar justify-between px-3"
        style={{ borderBottom: `1px solid ${colorBorderSecondary}` }}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          {subagentBreadcrumb ? (
            <>
              <Button
                type="text"
                size="small"
                data-header-back-to-main="1"
                icon={<RiArrowLeftLine size={15} />}
                onClick={onBackToMainAgent}
                title={t('harness.backgroundAgents.conversation.backToMain')}
              >
                <span style={{ fontSize: 12 }}>
                  {t('harness.backgroundAgents.conversation.backToMain')}
                </span>
              </Button>
              <span
                aria-hidden="true"
                style={{ width: 1, height: 16, background: colorBorderSecondary, flexShrink: 0 }}
              />
              <span className="flex items-center gap-1.5 min-w-0">
                <RiAiAgentLine
                  size={15}
                  style={{ color: token.colorTextSecondary, flexShrink: 0 }}
                />
                <span style={{ fontSize: 12, color: token.colorTextTertiary, flexShrink: 0 }}>
                  {t('harness.backgroundAgents.conversation.breadcrumbMain')}
                </span>
                <RiArrowRightSLine
                  size={14}
                  style={{ color: token.colorTextTertiary, flexShrink: 0 }}
                />
                <span
                  data-header-subagent-name={subagentBreadcrumb.agentId}
                  title={subagentBreadcrumb.name}
                  style={{
                    maxWidth: 360,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    /* Same font size and weight as "Main Agent" (user requirement: the subagent title must not look out of place next to it) */
                    fontSize: 12,
                    fontWeight: 400,
                    color: token.colorText
                  }}
                >
                  {subagentBreadcrumb.name}
                </span>
                {subagentBreadcrumb.queuedMessages > 0 ? (
                  <span
                    className="shrink-0 rounded px-1.5 py-0.5"
                    style={{
                      background: token.colorFillTertiary,
                      color: token.colorTextSecondary,
                      fontSize: 10.5
                    }}
                  >
                    {t('harness.backgroundAgents.conversation.queuedCount', {
                      count: subagentBreadcrumb.queuedMessages
                    })}
                  </span>
                ) : null}
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    flexShrink: 0,
                    marginLeft: 2,
                    color: headerSubagentStatusColor(subagentBreadcrumb),
                    fontSize: 11
                  }}
                >
                  <span
                    style={{
                      width: 5,
                      height: 5,
                      borderRadius: '50%',
                      background: headerSubagentStatusColor(subagentBreadcrumb)
                    }}
                  />
                  {headerSubagentStatusText(t, subagentBreadcrumb)}
                </span>
              </span>
              <span
                aria-hidden="true"
                style={{ width: 1, height: 16, background: colorBorderSecondary, flexShrink: 0 }}
              />
            </>
          ) : null}
          <BackgroundJobsButton jobs={jobs} open={jobsOpen} onToggle={toggleJobs} />
        </div>
        <div className="flex items-center gap-2.5">
          {/* Merged "Collaborate" entry: background subagents + shared task board (option A, chosen by the user on 2026-11-26) */}
          <CollabButton
            currentTopicId={currentTopicId}
            onSelectAgent={onSelectSubagent}
            activeAgentId={activeSubagentId}
          />
          <Button
            type="text"
            size="small"
            data-harness-start-toggle="1"
            title={t('harness.header.openStart')}
            icon={startOpen ? <RiLayoutRightFill size={16} /> : <RiLayoutRightLine size={16} />}
            onClick={onToggleStart}
          />
        </div>
      </div>
      {jobsOpen && jobs.length > 0 ? (
        <BackgroundJobsTray
          key={currentTopicId ?? 'none'}
          jobs={jobs}
          onStop={stopJob}
          peekOutput={peekOutput}
        />
      ) : null}
    </>
  )
}

export default HarnessHeader
