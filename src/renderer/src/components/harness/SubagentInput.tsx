import React, { useCallback, useRef, useState } from 'react'
import { App } from 'antd'
import { useTranslation } from '@renderer/i18n'
import HarnessInput from './HarnessInput'
import ConversationFooter from './ConversationFooter'
import { harnessApi } from '../../api/harness'

/**
 * Input area for a subagent conversation — **fully reuses the main conversation's `HarnessInput`**
 * (user, 2026-11-26: "reuse the whole implementation"); `simpleMode` only hides the
 * main-agent-only controls (attachments / permission mode / model selection / tools & skills /
 * usage bar) and routes send and stop to the subagent's inbox and current turn respectively.
 *
 * The outer `ConversationFooter` is the same one the main conversation uses (same padding, width,
 * background, fade mask), so the input area is visually the same component for both targets —
 * there is no "simplified input box".
 */
interface SubagentInputProps {
  topicId: number
  agentId: string
  /** Whether the subagent currently has a running turn (controls the stop button and placeholder) */
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

  /** Deliver a follow-up message: same inbox semantics as the main agent's send_message (starts a new turn when idle, queues while running) */
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

  /** Stop the current turn (queued messages are kept; the stream ends in a killed terminal state) */
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

  // The placeholder does not switch with the running state: TipTap's Placeholder extension fixes
  // its text when the editor is created, so writing one per state leaves a stale "queued while
  // running" hint after completion. Running state is shown in the top bar breadcrumb, so the input
  // just keeps one stable follow-up prompt.
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
