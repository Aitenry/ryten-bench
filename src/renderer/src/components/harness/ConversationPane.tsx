import React from 'react'
import HarnessMessageArea from './HarnessMessageArea'
import type { Message } from '../../types/harness/types'

/**
 * Conversation main region (message window + bottom input area) — the **shared shell** for the
 * main agent and background subagents.
 *
 * Background (2026-11-26): the subagent conversation view used to mount its own
 * `HarnessMessageArea`; the component was the same, but the outer layout and input area were
 * separate, so visuals and behavior diverged. The "message area + input area" from the Harness
 * page is now extracted into this component:
 * - the main conversation passes its own messages / handlers / inputArea;
 * - subagent sessions pass messages / no-op handlers / the continue-chat input from
 *   useSubagentConversation.
 * Both occupy the same component position on the page, so on target switch React reuses the same
 * message window tree (scroll position, fold state and other internal state carry over) and only
 * the data source is swapped — the conversation is effectively rebound in place.
 */
interface ConversationPaneProps {
  /** Messages (main conversation or subagent session; structurally identical) */
  messages: Message[]
  /** Whether output is streaming (drives stick-to-bottom following and the generating glow) */
  streaming: boolean
  /** Current topic id (parent topic for subagents; used for usage and tool-detail attribution) */
  currentTopicId: number | null
  /** Read-only conversation (archived main conversation / subagent session) */
  readOnly?: boolean
  isDarkMode: boolean
  colorText: string
  colorTextSecondary: string
  colorTextTertiary: string
  colorFillAlter: string
  colorBorderSecondary: string
  copiedId: string | null
  hasMoreMessages: boolean
  isLoadingMoreMessages: boolean
  onCopy: (text: string, id: string) => Promise<void>
  onDelete: (msgIndex: number) => Promise<void>
  onStartEditMessage: (msgIndex: number) => void
  onSubmitEditMessage: (msgIndex: number, content: string) => Promise<void>
  onCancelEditMessage: () => void
  editingMessageId: string | null
  onBranch: (upToIndex: number) => Promise<void>
  onLoadMoreMessages: () => void
  messagesEndRef: React.RefObject<HTMLDivElement | null>
  pendingByPath?: Map<string, number>
  onOpenChangedFile?: (path: string) => void
  /** Dialogue row id to jump to after a session-search hit (main conversation only; not passed for subagents) */
  jumpToDialogueId?: number | null
  /** Jump target consumed (the parent clears the pending target) */
  onJumpToDialogueConsumed?: () => void
  /**
   * Placeholder when there are no messages (subagent sessions: loading / empty / missing conversation).
   * Non-empty main conversations never reach this; empty conversations are still handled by the Harness page's welcome layout.
   */
  empty?: React.ReactNode
  /** Bottom input area (full input area for the main conversation, continue-chat input for subagents) */
  footer: React.ReactNode
}

const ConversationPane: React.FC<ConversationPaneProps> = ({
  messages,
  streaming,
  currentTopicId,
  readOnly = false,
  isDarkMode,
  colorText,
  colorTextSecondary,
  colorTextTertiary,
  colorFillAlter,
  colorBorderSecondary,
  copiedId,
  hasMoreMessages,
  isLoadingMoreMessages,
  onCopy,
  onDelete,
  onStartEditMessage,
  onSubmitEditMessage,
  onCancelEditMessage,
  editingMessageId,
  onBranch,
  onLoadMoreMessages,
  messagesEndRef,
  pendingByPath,
  onOpenChangedFile,
  jumpToDialogueId,
  onJumpToDialogueConsumed,
  empty,
  footer
}) => {
  return (
    <>
      {messages.length === 0 && empty ? (
        <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
          {empty}
        </div>
      ) : (
        <HarnessMessageArea
          messages={messages}
          isDarkMode={isDarkMode}
          streaming={streaming}
          currentTopicId={currentTopicId}
          readOnly={readOnly}
          colorText={colorText}
          colorTextSecondary={colorTextSecondary}
          colorTextTertiary={colorTextTertiary}
          colorFillAlter={colorFillAlter}
          colorBorderSecondary={colorBorderSecondary}
          copiedId={copiedId}
          hasMoreMessages={hasMoreMessages}
          isLoadingMoreMessages={isLoadingMoreMessages}
          onCopy={onCopy}
          onDelete={onDelete}
          onStartEditMessage={onStartEditMessage}
          onSubmitEditMessage={onSubmitEditMessage}
          onCancelEditMessage={onCancelEditMessage}
          editingMessageId={editingMessageId}
          onBranch={onBranch}
          onLoadMoreMessages={onLoadMoreMessages}
          messagesEndRef={messagesEndRef}
          pendingByPath={pendingByPath}
          onOpenChangedFile={onOpenChangedFile}
          jumpToDialogueId={jumpToDialogueId}
          onJumpToDialogueConsumed={onJumpToDialogueConsumed}
        />
      )}
      {footer}
    </>
  )
}

export default ConversationPane
