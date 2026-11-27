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

/** 顶部栏面包屑里的子代理状态文案（与后台代理列表同一套口径） */
const headerSubagentStatusText = (t: TFunction, breadcrumb: HeaderSubagentBreadcrumb): string => {
  if (breadcrumb.status === 'running') return t('harness.backgroundAgents.running')
  if (breadcrumb.status === 'inactive') return t('harness.backgroundAgents.inactive')
  if (breadcrumb.lastStatus === 'failed') return t('harness.backgroundAgents.failed')
  if (breadcrumb.lastStatus === 'killed') return t('harness.backgroundAgents.killed')
  return t('harness.backgroundAgents.completed')
}

/** 顶部栏面包屑里的子代理状态色（暗色/亮色同一套语义色，与后台代理列表一致） */
const headerSubagentStatusColor = (breadcrumb: HeaderSubagentBreadcrumb): string => {
  if (breadcrumb.status === 'running') return '#1677ff'
  if (breadcrumb.status === 'inactive') return '#8c8c8c'
  if (breadcrumb.lastStatus === 'failed') return '#ef4444'
  if (breadcrumb.lastStatus === 'killed') return '#8c8c8c'
  return '#52c41a'
}

/** 正在查看的后台子代理（面包屑放进顶部栏，不额外占一行高度） */
export interface HeaderSubagentBreadcrumb {
  agentId: string
  name: string
  status: 'running' | 'idle' | 'inactive'
  lastStatus?: 'completed' | 'failed' | 'killed'
  queuedMessages: number
}

interface HarnessHeaderProps {
  /** 右侧「开始」面板是否打开（顶部按钮带激活态） */
  startOpen: boolean
  /** 顶部按钮：打开/收起右侧「开始」工具面�� */
  onToggleStart: () => void
  colorBorderSecondary: string
  currentTopicId: number | null
  /** 点顶部栏后台子代理：主对话区切换到该子代理的流式会话（见 SubagentConversationView） */
  onSelectSubagent?: (agent: SubagentSessionRow) => void
  /** 当前正在查看的子代理（入口列表里高亮；切回主对话时为 null） */
  activeSubagentId?: string | null
  /**
   * 当前正在查看的子智能体：非空时顶部栏左侧变成
   * 「← 返回主智能体 ｜ 主智能体 › 子代理名」的面包屑（用户 2026-11-26 口径：
   * 面包屑内容放在顶部栏里，且子代理名称字号与主智能体一致）。
   */
  subagentBreadcrumb?: HeaderSubagentBreadcrumb | null
  onBackToMainAgent?: () => void
}

/**
 * 对话消息区顶部栏。
 *
 * 只放视角相关的操作（后台智能体入口 / 后台任务入口 / 工作区面板开关），**不显示会话标题**——
 * 会话已在左侧系统侧栏里高亮选中（用户 2026-11-19 口径：顶部不要显示标题；随后又明确
 * 「面板按钮要放在对话消息的顶部，搞一个顶部栏，不要放在输入框里面」）。
 * 空白会话没有消息，不渲染这条栏，输入框与欢迎语一起居中（见 Index 的 isWelcomeMode）。
 *
 * 2026-11-26：后台任务（execute run_in_background）入口按用户圈定的位置放在**左侧**，
 * 后台智能体与面板开关仍在右侧——左侧的圈就是原话里「圈中的区域」。
 * 同日后半段按用户确认的设计改成「顶部内联托盘」：点击按钮在标题栏下方展开任务行，
 * 每行左侧折叠输出、右侧停止，不再使用 Popover / Modal。
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

  // 切话题：托盘收起（任务按 topicId 隔离，不在新话题上显示旧任务）
  useEffect(() => {
    setJobsOpen(false)
  }, [currentTopicId])

  // 任务被清理干净（例如话题删除）：托盘不能留着一个空壳
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
                    /* 与「主智能体」同字号、同字重（用户口径：子智能体标题不能比前面突兀） */
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
          {/* 合并后的「协作」入口：后台子代理 + 共享任务板（方案 A，2026-11-26 用户选定） */}
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
