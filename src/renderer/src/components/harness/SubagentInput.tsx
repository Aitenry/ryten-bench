import React, { useCallback, useRef, useState } from 'react'
import { App } from 'antd'
import { useTranslation } from '@renderer/i18n'
import HarnessInput from './HarnessInput'
import ConversationFooter from './ConversationFooter'
import { harnessApi } from '../../api/harness'

/**
 * 子代理会话的输入区 —— **完整复用主对话的 `HarnessInput`**（用户 2026-11-26：
 * "全部内容实现复用"），只通过 `simpleMode` 隐藏主代理专属控件（附件 / 权限档位 /
 * 模型选择 / 工具技能 / 用量条），并把发送、停止分别路由到子代理的收件箱与当前轮。
 *
 * 外层使用与主对话相同的 `ConversationFooter`（同样的留白、宽度、背景、渐隐遮罩），
 * 因此两个 target 的输入区在外观上是同一个组件，不存在"简化版输入框"。
 */
interface SubagentInputProps {
  topicId: number
  agentId: string
  /** 子代理当前是否有一轮在运行（决定「停止」按钮与 placeholder） */
  running: boolean
  isDarkMode: boolean
  colorBgLayout: string
  colorBgContainer: string
  colorBorder: string
  colorText: string
  colorBorderSecondary: string
}

const SubagentInput: React.FC<SubagentInputProps> = ({
  topicId,
  agentId,
  running,
  isDarkMode,
  colorBgLayout,
  colorBgContainer,
  colorBorder,
  colorText,
  colorBorderSecondary
}) => {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const editorRef = useRef<HTMLDivElement | null>(null)
  const historyRef = useRef<string[]>([])

  /** 投递续聊消息：与主代理 send_message 走同一个收件箱语义（空闲开新一轮、运行中排队） */
  const handleSend = useCallback((): void => {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    void (async () => {
      try {
        const result = await harnessApi.harness.sendAgentPrompt(topicId, agentId, text)
        if (!result?.ok) {
          void message.error(
            t('harness.backgroundAgents.conversation.sendFailed', {
              reason: result?.error ?? 'unknown'
            })
          )
          return
        }
        setDraft('')
      } catch (error) {
        void message.error(
          t('harness.backgroundAgents.conversation.sendFailed', {
            reason: error instanceof Error ? error.message : String(error)
          })
        )
      } finally {
        setSending(false)
      }
    })()
  }, [agentId, draft, message, sending, t, topicId])

  /** 停止当前轮（已排队消息保留；运行结束会以 killed 终态收流） */
  const handleStop = useCallback((): void => {
    void (async () => {
      try {
        await harnessApi.harness.interruptAgent(topicId, agentId)
      } catch (error) {
        void message.error(
          t('harness.backgroundAgents.conversation.sendFailed', {
            reason: error instanceof Error ? error.message : String(error)
          })
        )
      }
    })()
  }, [agentId, message, t, topicId])

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        handleSend()
      }
    },
    [handleSend]
  )

  // 输入框 placeholder 不随运行态切换：TipTap 的 Placeholder 扩展在编辑器创建时固定文案，
  // 运行中/空闲各写一套会出现「已完成仍显示运行中会排队」的滞留文案。
  // 运行状态在顶部栏面包屑里展示，输入框保持一句稳定的续聊提示即可。
  const placeholder = t('harness.backgroundAgents.conversation.placeholder')

  return (
    <ConversationFooter
      colorBgContainer={colorBgContainer}
      colorBorderSecondary={colorBorderSecondary}
    >
      <HarnessInput
        inputValue={draft}
        onInputChange={setDraft}
        textareaRef={editorRef}
        inputHistoryRef={historyRef}
        attachments={[]}
        onAttachmentsChange={() => {}}
        isLoading={running}
        selectedProviderId={null}
        onSelectProvider={() => {}}
        groupedProviderOptions={[]}
        modelSupportsTools={false}
        modelSupportsVision={false}
        currentTopicId={topicId}
        showMascot={false}
        modelContextWindow={null}
        isDarkMode={isDarkMode}
        colorBgLayout={colorBgLayout}
        colorBorder={colorBorder}
        colorText={colorText}
        colorBorderSecondary={colorBorderSecondary}
        onSend={handleSend}
        onStop={handleStop}
        onKeyDown={handleKeyDown}
        simpleMode
        placeholder={placeholder}
      />
    </ConversationFooter>
  )
}

export default SubagentInput
