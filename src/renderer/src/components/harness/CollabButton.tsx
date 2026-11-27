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
 * 顶部栏「协作」入口 —— 把「后台子代理」与「共享任务板」合并为一个入口
 * （用户 2026-11-26 选定方案 A）。
 *
 * 样式口径：
 * - 入口是纯文字按钮「2 子代理 · 3 任务」，不抢顶部栏注意力；两者都为空时整块隐藏；
 * - Popover 396px，分「子代理 / 共享任务」两段；
 * - 每行只有 5px 状态点 + 状态小字，不再用彩色胶囊/色块；
 * - 负责人用 15px 字母头像（lead 为金色），阻塞依赖显示为「等待 <前置任务名>」的金色小字；
 * - 已完成任务降透明度 + 删除线；行高统一 34px，和主对话的列表密度一致。
 *
 * 数据：agents = listAgents + onAgentsUpdated；tasks = listTeamTasks + onTeamUpdated。
 * 子代理行点击直接用顶层 Harness 页的 onSelectAgent 打开会话视图；任务行 v1 只读展示。
 */
interface CollabButtonProps {
  currentTopicId: number | null
  /** 点某条子代理：主对话区切到它的流式会话 */
  onSelectAgent?: (agent: SubagentSessionRow) => void
  /** 当前正在查看的子代理（列表里高亮） */
  activeAgentId?: string | null
}

/** 子代理状态：文案 / 颜色（与顶部栏旧入口同一套口径，只是去掉了彩色胶囊） */
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

/** 任务状态点颜色：进行中蓝 / 待办金 / 已完成绿 */
const taskDotColor = (task: TeamTaskView): string => {
  if (task.status === 'in_progress') return '#4096ff'
  if (task.status === 'completed') return '#73d13d'
  return '#d4a72c'
}

/** 负责人头像：取名字首字符（lead 用金色区分） */
function ownerInitial(ownerName: string): string {
  const name = ownerName.trim()
  if (!name) return '?'
  const match = name.match(/[\u4e00-\u9fa5A-Za-z0-9]/)
  return (match?.[0] ?? name[0]).toUpperCase()
}

/** token 数紧凑展示：< 1000 原样，>= 1000 用 k 保留一位小数 */
function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`
  return `${(tokens / 1_000_000).toFixed(1)}m`
}

/** 任务事件动作 → 本地化短语（最近活动行用；缺省回退 updated） */
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
  /** 拉取请求代次：慢的旧请求不能覆盖新请求/推送结果 */
  const refreshSeqRef = useRef(0)
  /** 最近一次 agents 推送时间：拉取若早于该推送，结果已过期 */
  const lastAgentsPushAtRef = useRef(0)
  /** 最近一条任务事件（存储适配器追加写；面板 footer 展示团队最近活动） */
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
      // 拉取结果同样走 revision 去旧：慢请求不能把任务板回滚到旧状态
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
      // 整板快照带 revision：只接受不旧于当前板子的快照（防 IPC 乱序回退）
      setBoard((prev) => (prev && snapshot.revision < prev.revision ? prev : snapshot))
      // 任务变更会追加事件；面板打开时同步刷新最近活动（节流由任务变更频率决定）
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

  // 切话题：收起列表（子代理与任务板都按 topicId 隔离）
  useEffect(() => {
    setOpen(false)
  }, [currentTopicId])

  const tasks = useMemo(() => board?.tasks ?? [], [board])
  const tasksById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks])
  /** 任务状态汇总：面板顶部（任务段头）展示团队进度 */
  const taskCounts = useMemo(
    () => ({
      running: tasks.filter((task) => task.status === 'in_progress').length,
      pending: tasks.filter((task) => task.status === 'pending').length,
      completed: tasks.filter((task) => task.status === 'completed').length
    }),
    [tasks]
  )
  /** 每个子代理当前负责的任务数（owner 是后台会话 id；未认领不计） */
  const agentTaskCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const task of tasks) {
      if (!task.ownerId || task.ownerId === 'lead') continue
      counts.set(task.ownerId, (counts.get(task.ownerId) ?? 0) + 1)
    }
    return counts
  }, [tasks])

  // 入口摘要：两个都为空时整块隐藏（顶部栏不占位）
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
            // 负责人是某个子代理会话时，任务行可直接跳去它的会话（v1：只对后台可续接会话可跳）
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
