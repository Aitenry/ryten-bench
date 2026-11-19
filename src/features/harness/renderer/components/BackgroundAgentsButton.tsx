import React, { useCallback, useEffect, useState } from 'react'
import { Button, Modal, Popover, theme } from 'antd'
import { RiAiAgentLine } from '@remixicon/react'
import type { TFunction } from 'i18next'
import { useTranslation } from '@renderer/i18n'

import type { SubagentSessionRow } from '../../shared/types'
import { harnessApi } from '../api'

/**
 * 顶部栏「后台子智能体」入口（最右端）：
 * - 后台子代理（task background=true）在对话流只显示轻量派发卡，进度/结果收敛到本按钮；
 * - 按钮 = RiAiAgentLine + 文字摘要「x 进行中，x 已完成/失败/已停止」；无任务整块隐藏；
 * - 点击弹出列表：每项显示任务标签 + 状态；点项弹窗查看结果：
 *   标题 = 智能体名（会话 id），内容区顶部 = 任务指令 + 状态徽标，下方 = 输出全文；
 * - 输出自动更新：打开弹窗时 watch 该 agent，后端有增量（运行中）/终态输出即推送刷新，
 *   无需手动刷新按钮。
 */

/** 状态徽标文案与颜色（非组件函数：译文由调用方传入 t） */
const statusMeta = (t: TFunction, row: SubagentSessionRow): { text: string; color: string } => {
  if (row.status === 'running') {
    return { text: t('harness.backgroundAgents.running'), color: '#1677ff' }
  }
  if (row.lastStatus === 'failed') {
    return { text: t('harness.backgroundAgents.failed'), color: '#ef4444' }
  }
  if (row.lastStatus === 'killed') {
    return { text: t('harness.backgroundAgents.killed'), color: '#8c8c8c' }
  }
  return { text: t('harness.backgroundAgents.completed'), color: '#52c41a' }
}

/** 会话输出视图（agentOutput / 后端推送同构） */
interface AgentOutputView {
  text: string
  status: 'running' | 'idle'
  lastStatus?: SubagentSessionRow['lastStatus']
  prompt: string
}

interface BackgroundAgentsButtonProps {
  currentTopicId: number | null
}

const BackgroundAgentsButton: React.FC<BackgroundAgentsButtonProps> = ({ currentTopicId }) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const [agents, setAgents] = useState<SubagentSessionRow[]>([])
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [viewing, setViewing] = useState<SubagentSessionRow | null>(null)
  const [output, setOutput] = useState<AgentOutputView | null>(null)

  const api = harnessApi

  /** 拉取当前话题的后台子代理列表 */
  const refreshAgents = useCallback(async (): Promise<void> => {
    if (currentTopicId == null) {
      setAgents([])
      return
    }
    try {
      const rows = await api.harness.listAgents(currentTopicId)
      setAgents(rows ?? [])
    } catch {
      /* 忽略：列表刷新失败不打扰 */
    }
  }, [api, currentTopicId])

  // 拉列表 + 列表变更广播
  useEffect(() => {
    void refreshAgents()
    const unsubscribe = api.harness.onAgentsUpdated((data) => {
      if (data.topicId === currentTopicId) setAgents(data.rows ?? [])
    })
    return () => {
      unsubscribe()
    }
  }, [api, currentTopicId, refreshAgents])

  // 打开的弹窗与列表实时同步（状态徽标随 进行中→已完成 变化）
  useEffect(() => {
    if (!viewing) return
    const fresh = agents.find((a) => a.id === viewing.id)
    if (fresh && fresh !== viewing) setViewing(fresh)
  }, [agents, viewing])

  /** 打开结果弹窗：watch 后端推送 + 拉一次当前快照 */
  const openResult = (agent: SubagentSessionRow): void => {
    setViewing(agent)
    setPopoverOpen(false)
    if (currentTopicId != null) {
      api.harness.watchAgentOutput(currentTopicId, agent.id, true)
      void api.harness.agentOutput(currentTopicId, agent.id).then((result) => {
        if (result) setOutput(result)
      })
    }
  }

  // 后端输出推送：匹配当前弹窗的 agent 即刷新内容（运行中增量 / 终态最终输出）
  useEffect(() => {
    const unsubscribe = api.harness.onAgentOutputUpdated((data) => {
      if (currentTopicId == null) return
      if (viewing && data.topicId === currentTopicId && data.agentId === viewing.id) {
        setOutput(data.output)
      }
    })
    return () => {
      unsubscribe()
    }
  }, [api, currentTopicId, viewing])

  // 关闭弹窗：取消 watch
  const closeViewer = (): void => {
    if (viewing && currentTopicId != null) {
      api.harness.watchAgentOutput(currentTopicId, viewing.id, false)
    }
    setViewing(null)
    setOutput(null)
  }

  // 顶部栏文字摘要：「x 进行中，x 已完成」（有失败/已停止时同样计入，避免遗漏）
  const countParts: string[] = []
  const runningCount = agents.filter((a) => a.status === 'running').length
  const completedCount = agents.filter(
    (a) => a.status === 'idle' && (a.lastStatus === 'completed' || !a.lastStatus)
  ).length
  const failedCount = agents.filter((a) => a.status === 'idle' && a.lastStatus === 'failed').length
  const killedCount = agents.filter((a) => a.status === 'idle' && a.lastStatus === 'killed').length
  if (runningCount > 0)
    countParts.push(t('harness.backgroundAgents.runningCount', { count: runningCount }))
  if (completedCount > 0)
    countParts.push(t('harness.backgroundAgents.completedCount', { count: completedCount }))
  if (failedCount > 0)
    countParts.push(t('harness.backgroundAgents.failedCount', { count: failedCount }))
  if (killedCount > 0)
    countParts.push(t('harness.backgroundAgents.killedCount', { count: killedCount }))
  const summaryText = countParts.join(t('harness.backgroundAgents.summarySeparator'))

  const viewingMeta = viewing ? statusMeta(t, viewing) : null

  // 没有任何后台子代理任务：整块隐藏（顶部栏不占位）
  if (agents.length === 0) return null

  const listContent = (
    <div className="min-w-72 max-w-96 py-1">
      {agents.map((agent) => {
        const meta = statusMeta(t, agent)
        return (
          <button
            key={agent.id}
            type="button"
            onClick={() => openResult(agent)}
            className="w-full flex items-center gap-2 px-3 py-2 text-left rounded-lg transition-colors"
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              color: token.colorText
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = token.colorFillTertiary
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent'
            }}
          >
            <RiAiAgentLine size={16} style={{ color: token.colorTextSecondary, flexShrink: 0 }} />
            <span
              className="flex-1 min-w-0 truncate"
              style={{ color: token.colorText, fontSize: 13 }}
            >
              {agent.label}
            </span>
            <span
              className="shrink-0 rounded px-1.5 py-0.5"
              style={{ background: `${meta.color}1f`, color: meta.color, fontSize: 11 }}
            >
              {meta.text}
            </span>
          </button>
        )
      })}
    </div>
  )

  return (
    <>
      <Popover
        content={listContent}
        trigger="click"
        placement="bottomRight"
        open={popoverOpen}
        onOpenChange={setPopoverOpen}
      >
        <Button
          type="text"
          size="small"
          disabled={currentTopicId == null}
          icon={<RiAiAgentLine size={16} style={{ color: token.colorTextSecondary }} />}
        >
          <span style={{ fontSize: 12, color: token.colorTextSecondary }}>{summaryText}</span>
        </Button>
      </Popover>
      <Modal
        open={viewing != null}
        title={
          <span className="flex items-center gap-2">
            <RiAiAgentLine size={16} style={{ color: token.colorTextSecondary }} />
            <span style={{ fontSize: 14 }}>
              {viewing ? `${viewing.name}（${viewing.id}）` : ''}
            </span>
          </span>
        }
        onCancel={closeViewer}
        footer={null}
        width={720}
      >
        <div className="flex flex-col gap-2">
          {/* 顶部：任务指令 + 状态徽标（标题只放 智能体名（会话 id）） */}
          <div
            className="gap-2 rounded-lg p-2"
            style={{
              background: token.colorFillTertiary,
              border: `1px solid ${token.colorBorderSecondary}`
            }}
          >
            <div className="flex items-center justify-between">
              <span
                className="shrink-0 rounded pl-2 text-sm"
                style={{ color: token.colorTextSecondary }}
              >
                {t('harness.backgroundAgents.promptLabel')}
              </span>
              {viewingMeta ? (
                <span
                  className="shrink-0 rounded px-1.5 py-0.5"
                  style={{
                    background: `${viewingMeta.color}1f`,
                    color: viewingMeta.color,
                    fontSize: 12
                  }}
                >
                  {viewingMeta.text}
                </span>
              ) : null}
            </div>
            <div
              className="harness-scrollbar px-2 max-h-40 overflow-y-auto flex-1 min-w-0 whitespace-pre-wrap break-words text-sm"
              style={{ color: token.colorText }}
            >
              {output?.prompt ?? viewing?.label ?? ''}
            </div>
          </div>
          {/* 下方：智能体输出全文（后端推送自动刷新，无手动刷新按钮） */}
          <pre
            className="harness-scrollbar whitespace-pre-wrap break-words m-0 p-3 rounded-lg text-sm max-h-96 overflow-y-auto"
            style={{
              background: token.colorFillTertiary,
              color: token.colorText,
              border: `1px solid ${token.colorBorderSecondary}`
            }}
          >
            {output?.text ||
              (viewing?.status === 'running'
                ? t('harness.backgroundAgents.generating')
                : t('harness.backgroundAgents.noOutput'))}
          </pre>
        </div>
      </Modal>
    </>
  )
}

export default BackgroundAgentsButton
