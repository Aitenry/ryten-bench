import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Popover, theme } from 'antd'
import { RiArrowRightSLine, RiTeamLine } from '@remixicon/react'
import type { TFunction } from 'i18next'
import { useTranslation } from '@renderer/i18n'

import type {
  SubagentSessionRow,
  TeamBoardSnapshot,
  TeamTaskEventView,
  TeamTaskView
} from '../../../../shared/harness/types'
import { harnessApi } from '../../api/harness'

/**
 * "Collaboration" entry in the top bar — merges "background subagents" and the "shared task board"
 * into a single entry (option A chosen on 2026-11-26).
 *
 * Style:
 * - The entry is a plain text button ("2 agents · 3 tasks") that doesn't distract from the top
 *   bar; the whole block is hidden when both are empty;
 * - The Popover is 396px wide with two sections: agents / shared tasks;
 * - Each row uses only a 5px status dot plus small status text, no colored pills or blocks;
 * - The owner is a 15px letter avatar (gold for lead), and blocking dependencies show as gold
 *   small text reading "waiting for <blocking task>";
 * - Completed tasks get reduced opacity + strikethrough; row height is a uniform 34px to match the
 *   main conversation's list density.
 *
 * Data: agents = listAgents + onAgentsUpdated; tasks = listTeamTasks + onTeamUpdated.
 * Clicking an agent row opens its conversation view via the top-level Harness page's
 * onSelectAgent; task rows are read-only in v1.
 */
interface CollabButtonProps {
  currentTopicId: number | null
  /** Click a subagent row: switch the main conversation area to its streaming conversation */
  onSelectAgent?: (agent: SubagentSessionRow) => void
  /** Subagent currently being viewed (highlighted in the list) */
  activeAgentId?: string | null
}

/** Subagent status: text / color (same scheme as the old top-bar entry, minus the colored pills) */
const agentStatus = (t: TFunction, agent: SubagentSessionRow): { text: string; color: string } => {
  if (agent.status === 'running')
    return { text: t('harness.backgroundAgents.running'), color: '#4096ff' }
  if (agent.status === 'inactive')
    return { text: t('harness.backgroundAgents.inactive'), color: '#8c8c8c' }
  if (agent.lastStatus === 'failed')
    return { text: t('harness.backgroundAgents.failed'), color: '#ff7875' }
  if (agent.lastStatus === 'killed')
    return { text: t('harness.backgroundAgents.killed'), color: '#8c8c8c' }
  return { text: t('harness.backgroundAgents.completed'), color: '#73d13d' }
}

/** Task status dot colors: in progress blue / pending gold / completed green */
const taskDotColor = (task: TeamTaskView): string => {
  if (task.status === 'in_progress') return '#4096ff'
  if (task.status === 'completed') return '#73d13d'
  return '#d4a72c'
}

/** Owner avatar: first character of the name (gold is reserved for lead) */
function ownerInitial(ownerName: string): string {
  const name = ownerName.trim()
  if (!name) return '?'
  const match = name.match(/[\u4e00-\u9fa5A-Za-z0-9]/)
  return (match?.[0] ?? name[0]).toUpperCase()
}

/** Compact token count: raw below 1000, otherwise k with one decimal */
function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`
  return `${(tokens / 1_000_000).toFixed(1)}m`
}

/** Task event action → localized phrase (for the recent activity line; falls back to updated) */
const eventActionLabel = (t: TFunction, action: TeamTaskEventView['action']): string => {
  switch (action) {
    case 'created':
      return t('harness.collab.eventCreated')
    case 'claimed':
      return t('harness.collab.eventClaimed')
    case 'completed':
      return t('harness.collab.eventCompleted')
    case 'deleted':
      return t('harness.collab.eventDeleted')
    default:
      return t('harness.collab.eventUpdated')
  }
}

const CollabButton: React.FC<CollabButtonProps> = ({
  currentTopicId,
  onSelectAgent,
  activeAgentId
}) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const [agents, setAgents] = useState<SubagentSessionRow[]>([])
  const [board, setBoard] = useState<TeamBoardSnapshot | null>(null)
  const [open, setOpen] = useState(false)
  /** Fetch request generation: a slow old request must not overwrite newer requests/pushes */
  const refreshSeqRef = useRef(0)
  /** Time of the latest agents push: a fetch started before it has stale results */
  const lastAgentsPushAtRef = useRef(0)
  /** Latest task event (appended by the storage adapter; the panel footer shows recent team activity) */
  const [lastEvent, setLastEvent] = useState<TeamTaskEventView | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    if (currentTopicId == null) {
      setAgents([])
      setBoard(null)
      setLastEvent(null)
      return
    }
    const requestId = ++refreshSeqRef.current
    const startedAt = Date.now()
    const api = harnessApi.harness
    const [agentsResult, boardResult, eventsResult] = await Promise.allSettled([
      api.listAgents(currentTopicId),
      api.listTeamTasks(currentTopicId),
      api.listTeamEvents(currentTopicId, 1)
    ])
    if (requestId !== refreshSeqRef.current) return
    if (agentsResult.status === 'fulfilled' && lastAgentsPushAtRef.current <= startedAt) {
      setAgents(agentsResult.value ?? [])
    }
    if (boardResult.status === 'fulfilled') {
      const pulled = boardResult.value ?? null
      // Fetched results also de-dup by revision: a slow request must not roll the board back
      setBoard((prev) => (prev && pulled && pulled.revision < prev.revision ? prev : pulled))
    }
    if (eventsResult.status === 'fulfilled') {
      setLastEvent(eventsResult.value?.[0] ?? null)
    }
  }, [currentTopicId])

  useEffect(() => {
    void refresh()
    const api = harnessApi.harness
    const unsubscribeAgents = api.onAgentsUpdated((data) => {
      if (data.topicId !== currentTopicId) return
      lastAgentsPushAtRef.current = Date.now()
      setAgents(data.rows ?? [])
    })
    const unsubscribeTeam = api.onTeamUpdated((snapshot) => {
      if (snapshot.topicId !== currentTopicId) return
      // Whole-board snapshots carry a revision: only accept snapshots no older than the current board (guards against IPC reordering)
      setBoard((prev) => (prev && snapshot.revision < prev.revision ? prev : snapshot))
      // Task changes append events; refresh the recent activity while the panel is open (throttled by task change rate)
      void api
        .listTeamEvents(currentTopicId, 1)
        .then((rows) => setLastEvent(rows[0] ?? null))
        .catch(() => {})
    })
    return () => {
      unsubscribeAgents()
      unsubscribeTeam()
    }
  }, [currentTopicId, refresh])

  // Topic switch: collapse the list (both agents and task board are isolated per topicId)
  useEffect(() => {
    setOpen(false)
  }, [currentTopicId])

  const tasks = useMemo(() => board?.tasks ?? [], [board])
  const tasksById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks])
  /** Task status summary shown at the top of the panel (task section header) */
  const taskCounts = useMemo(
    () => ({
      running: tasks.filter((task) => task.status === 'in_progress').length,
      pending: tasks.filter((task) => task.status === 'pending').length,
      completed: tasks.filter((task) => task.status === 'completed').length
    }),
    [tasks]
  )
  /** Number of tasks each subagent currently owns (owner is the background session id; unclaimed tasks are excluded) */
  const agentTaskCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const task of tasks) {
      if (!task.ownerId || task.ownerId === 'lead') continue
      counts.set(task.ownerId, (counts.get(task.ownerId) ?? 0) + 1)
    }
    return counts
  }, [tasks])

  // Entry summary: hide the whole block when both are empty (no space taken in the top bar)
  const summaryText = useMemo(() => {
    const parts: string[] = []
    if (agents.length > 0) parts.push(t('harness.collab.agentsCount', { count: agents.length }))
    if (tasks.length > 0) parts.push(t('harness.collab.tasksCount', { count: tasks.length }))
    return parts.join(t('harness.collab.summarySeparator'))
  }, [agents.length, tasks.length, t])

  const hasAny = agents.length > 0 || tasks.length > 0
  if (!hasAny) return null

  const rowBaseStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 9,
    width: '100%',
    height: 34,
    padding: '0 14px',
    border: 'none',
    textAlign: 'left'
  }

  const sectionHeader = (label: string, right: React.ReactNode): React.ReactNode => (
    <div className="flex items-center justify-between" style={{ padding: '10px 14px 4px' }}>
      <span
        style={{
          fontSize: 10.5,
          fontWeight: 600,
          letterSpacing: '0.06em',
          color: token.colorTextTertiary
        }}
      >
        {label}
      </span>
      <span style={{ fontSize: 10.5, color: token.colorTextTertiary }}>{right}</span>
    </div>
  )

  const listContent = (
    <div className="w-[396px] max-w-[92vw] py-1" data-collab-popover="1">
      {agents.length > 0 ? (
        <>
          {sectionHeader(t('harness.collab.sectionAgents'), agents.length)}
          {agents.map((agent) => {
            const meta = agentStatus(t, agent)
            const active = activeAgentId === agent.id
            return (
              <button
                key={agent.id}
                type="button"
                data-collab-agent-row={agent.id}
                data-collab-agent-active={active ? '1' : '0'}
                onClick={() => {
                  setOpen(false)
                  onSelectAgent?.(agent)
                }}
                className="w-full"
                style={{
                  ...rowBaseStyle,
                  background: active ? token.colorFillTertiary : 'transparent',
                  cursor: onSelectAgent ? 'pointer' : 'default',
                  color: token.colorText
                }}
                onMouseEnter={(event) => {
                  if (active || !onSelectAgent) return
                  event.currentTarget.style.background = token.colorFillQuaternary
                }}
                onMouseLeave={(event) => {
                  if (active) return
                  event.currentTarget.style.background = 'transparent'
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: 5,
                    height: 5,
                    flex: '0 0 5px',
                    borderRadius: '50%',
                    background: meta.color
                  }}
                />
                <span
                  className="flex-1 min-w-0 truncate"
                  style={{ fontSize: 13, color: token.colorText }}
                >
                  {agent.label}
                </span>
                {agentTaskCounts.get(agent.id) ? (
                  <span style={{ fontSize: 10.5, color: token.colorTextTertiary, flexShrink: 0 }}>
                    {t('harness.collab.agentTaskCount', { count: agentTaskCounts.get(agent.id) })}
                  </span>
                ) : null}
                {agent.hasUsage ? (
                  <span style={{ fontSize: 10.5, color: token.colorTextTertiary, flexShrink: 0 }}>
                    {t('harness.collab.agentUsage', {
                      tokens: formatTokenCount(agent.totalTokens)
                    })}
                  </span>
                ) : null}
                <span style={{ fontSize: 10.5, color: meta.color, flexShrink: 0 }}>
                  {meta.text}
                </span>
                <RiArrowRightSLine
                  size={14}
                  style={{ color: token.colorTextTertiary, flexShrink: 0 }}
                />
              </button>
            )
          })}
        </>
      ) : null}

      {agents.length > 0 && tasks.length > 0 ? (
        <div
          aria-hidden="true"
          style={{ height: 1, background: token.colorBorderSecondary, margin: '6px 0' }}
        />
      ) : null}

      {tasks.length > 0 ? (
        <>
          {sectionHeader(
            t('harness.collab.sectionTasks'),
            <span>
              {t('harness.collab.taskProgress', {
                running: taskCounts.running,
                pending: taskCounts.pending,
                completed: taskCounts.completed
              })}
            </span>
          )}
          {tasks.map((task) => {
            const dot = taskDotColor(task)
            const completed = task.status === 'completed'
            const ownerName = task.ownerName || task.ownerId || ''
            const owner = ownerName ? ownerName : t('harness.team.unowned')
            const lead = task.ownerId === 'lead'
            // When the owner is a subagent conversation the row can jump to it (v1: only background continuable sessions)
            const ownerAgent = task.ownerId
              ? agents.find((agent) => agent.id === task.ownerId)
              : undefined
            const blockerSubject = task.blockers
              .map((id) => tasksById.get(id)?.subject ?? id)
              .join('、')
            const title = [
              task.subject,
              task.description,
              t('harness.team.owner', { name: owner }),
              !task.ready ? t('harness.team.blockedBy', { tasks: blockerSubject }) : '',
              ownerAgent ? t('harness.collab.taskOpenOwner') : ''
            ]
              .filter(Boolean)
              .join('\n')
            return (
              <div
                key={task.id}
                role={ownerAgent ? 'button' : undefined}
                tabIndex={ownerAgent ? 0 : undefined}
                data-collab-task-row={task.id}
                data-collab-task-status={task.status}
                title={title}
                onClick={
                  ownerAgent
                    ? () => {
                        setOpen(false)
                        onSelectAgent?.(ownerAgent)
                      }
                    : undefined
                }
                onKeyDown={
                  ownerAgent
                    ? (event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          setOpen(false)
                          onSelectAgent?.(ownerAgent)
                        }
                      }
                    : undefined
                }
                style={{
                  ...rowBaseStyle,
                  color: token.colorText,
                  cursor: ownerAgent ? 'pointer' : 'default'
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: 5,
                    height: 5,
                    flex: '0 0 5px',
                    borderRadius: '50%',
                    background: dot
                  }}
                />
                <span
                  className="flex-1 min-w-0 truncate"
                  style={{
                    fontSize: 13,
                    color: completed ? token.colorTextTertiary : token.colorText,
                    textDecoration: completed ? 'line-through' : undefined
                  }}
                >
                  {task.subject}
                </span>
                {!task.ready ? (
                  <span
                    className="shrink-0 truncate"
                    style={{ fontSize: 10, color: '#d4a72c', maxWidth: 110 }}
                  >
                    {t('harness.team.blockedBy', { tasks: blockerSubject })}
                  </span>
                ) : null}
                <span
                  className="shrink-0 inline-flex items-center gap-1"
                  style={{ fontSize: 10.5, color: token.colorTextTertiary }}
                >
                  {ownerName ? (
                    <>
                      <span
                        aria-hidden="true"
                        style={{
                          width: 15,
                          height: 15,
                          flex: '0 0 15px',
                          borderRadius: '50%',
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: 8.5,
                          fontWeight: 600,
                          color: lead ? '#d8c48a' : token.colorTextSecondary,
                          background: lead ? 'rgba(212, 167, 44, 0.18)' : token.colorFillSecondary
                        }}
                      >
                        {ownerInitial(owner)}
                      </span>
                      <span
                        className="truncate"
                        style={{ maxWidth: 68, fontSize: 10.5, color: token.colorTextTertiary }}
                      >
                        {owner}
                      </span>
                    </>
                  ) : (
                    <span>{t('harness.team.unowned')}</span>
                  )}
                </span>
              </div>
            )
          })}
        </>
      ) : null}

      <div
        className="flex items-center justify-between"
        style={{
          marginTop: 6,
          padding: '9px 14px 10px',
          borderTop: `1px solid ${token.colorBorderSecondary}`,
          fontSize: 10.5,
          color: token.colorTextTertiary
        }}
      >
        <span className="inline-flex items-center gap-1.5 min-w-0">
          <span
            aria-hidden="true"
            style={{
              width: 5,
              height: 5,
              borderRadius: '50%',
              flex: '0 0 5px',
              background: token.colorTextTertiary
            }}
          />
          {lastEvent ? (
            <span
              className="truncate"
              style={{ maxWidth: 205 }}
              title={t('harness.collab.lastActivity', {
                name: lastEvent.actorName,
                action: eventActionLabel(t, lastEvent.action),
                task: lastEvent.subject
              })}
            >
              {t('harness.collab.lastActivity', {
                name: lastEvent.actorName,
                action: eventActionLabel(t, lastEvent.action),
                task: lastEvent.subject
              })}
            </span>
          ) : (
            t('harness.collab.footerShared')
          )}
        </span>
        <span>
          {agents.length > 0
            ? t('harness.collab.footerAgentsHint')
            : t('harness.collab.footerTasksHint')}
        </span>
      </div>
    </div>
  )

  return (
    <Popover
      content={listContent}
      trigger="click"
      placement="bottomRight"
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) void refresh()
      }}
    >
      <Button
        type="text"
        size="small"
        disabled={currentTopicId == null}
        data-collab-button="1"
        icon={<RiTeamLine size={16} style={{ color: token.colorTextSecondary }} />}
      >
        <span style={{ fontSize: 12, color: token.colorTextSecondary }}>{summaryText}</span>
      </Button>
    </Popover>
  )
}

export default CollabButton
