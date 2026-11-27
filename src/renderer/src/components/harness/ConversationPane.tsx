import React from 'react'
import HarnessMessageArea from './HarnessMessageArea'
import type { Message } from '../../types/harness/types'

/**
 * 对话主区（消息窗口 + 底部输入区）—— 主智能体与后台子智能体的**共用外壳**。
 *
 * 背景（用户 2026-11-26）："消息区域也复用之前的" —— 之前子代理会话视图自己挂了一份
 * `HarnessMessageArea`，虽然组件同源，但外层布局/输入区是另起的，视觉与行为都不一致。
 * 现在把 Harness 页里的"消息区 + 输入区"抽成这个组件：
 * - 主对话传自己的 messages / handlers / inputArea；
 * - 子代理会话传 useSubagentConversation 的 messages / no-op handlers / 续聊输入框。
 * 两者在页面里是同一个组件位置，目标切换时 React 复用同一棵消息窗口（滚动位置 /
 * 折叠状态等内部状态延续），只把数据源换掉——与 DSH 的「conversation rebind」一致。
 */
interface ConversationPaneProps {
  /** 消息（主对话或子代理会话，结构完全同构） */
  messages: Message[]
  /** 是否正在流式输出（驱动贴底跟随与生成中的光圈） */
  streaming: boolean
  /** 当前话题 id（主对话 / 子代理的父话题；用量与工具详情归属用） */
  currentTopicId: number | null
  /** 只读会话（归档的主对话 / 子代理会话） */
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
  /**
   * 无消息时的占位（子代理会话用：加载中 / 空 / 会话不存在）。
   * 主对话的非空会话不会走到这里；空白会话仍由 Harness 页的欢迎布局处理。
   */
  empty?: React.ReactNode
  /** 底部输入区（主对话是完整输入区，子代理是续聊输入框） */
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
        />
      )}
      {footer}
    </>
  )
}

export default ConversationPane
