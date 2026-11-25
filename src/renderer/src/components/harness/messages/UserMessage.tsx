import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { App, Image, Tag, Tooltip, theme } from 'antd'
import { RiAttachment2, RiPencilLine, RiDeleteBin6Line } from '@remixicon/react'
import { useTranslation } from '@renderer/i18n'
import GoalRoundBanner from './GoalRoundBanner'
import type { Message } from '../../../types/harness/types'

interface UserMessageProps {
  message: Message
  isDarkMode: boolean
  colorText: string
  colorTextSecondary: string
  colorBorderSecondary: string
  /**
   * 这条提问没有对应的回复（下一条不是助手消息，或它本身就是最后一条）。
   *
   * 出现这种孤立提问的典型场景：发送时流失败/被中止、或数据库事故后只留下了提问。
   * 此时气泡后面没有任何可操作的入口，只能干看着——所以给它补上「编辑 / 删除」。
   */
  orphan?: boolean
  /** 正在**气泡内**编辑这条提问 */
  editing?: boolean
  /** 只读（归档会话）：孤立提问也不给「编辑 / 删除」入口 */
  readOnly?: boolean
  /** 进入编辑态 */
  onEdit?: () => void
  /** 气泡内回车提交（内容已就地替换这条提问，不会新增用户气泡） */
  onEditSubmit?: (content: string) => void
  /** Esc / 取消编辑 */
  onEditCancel?: () => void
  /** 点击删除（确认后由上层删除库内行与界面消息） */
  onDelete?: () => void
}

const UserMessage: React.FC<UserMessageProps> = ({
  message,
  isDarkMode,
  colorText,
  colorTextSecondary,
  colorBorderSecondary,
  orphan = false,
  editing = false,
  readOnly = false,
  onEdit,
  onEditSubmit,
  onEditCancel,
  onDelete
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const { modal } = App.useApp()
  const [hovered, setHovered] = useState<'edit' | 'delete' | null>(null)
  /** 气泡内编辑的草稿 */
  const [draft, setDraft] = useState(message.content)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // 进入编辑态：草稿取当前正文，焦点落到末尾（与「接着改」的直觉一致）
  useEffect(() => {
    if (!editing) return
    setDraft(message.content)
  }, [editing, message.content])

  // 输入框高度随内容自适应（气泡不能被撑出滚动条）
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [draft, editing])

  useEffect(() => {
    if (!editing) return
    const el = textareaRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [editing])

  /**
   * 气泡内键盘约定：Enter 发送、Shift+Enter 换行、Esc 取消。
   * 输入法组词中的 Enter 不能当发送（中文场景极易误触）。
   */
  const handleEditorKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onEditCancel?.()
      return
    }
    if (e.key !== 'Enter' || e.shiftKey) return
    if (e.nativeEvent.isComposing) return
    e.preventDefault()
    const text = draft.trim()
    if (!text) return
    onEditSubmit?.(text)
  }

  const imageBlocks = message.blocks.filter((b) => b.type === 'image' && b.image_url)
  const documentBlocks = message.blocks.filter((b) => b.type === 'document' && b.fileName)
  // 目标自动续跑轮：渲染为居中的自动运行横幅（非普通用户气泡）
  const goalRoundBlock = message.blocks.find((b) => b.type === 'goalRound')

  if (goalRoundBlock) {
    /* 单轮/未合并时的续跑横幅：与批次横幅同一组件（窄窗口可收缩、单行省略） */
    return (
      <GoalRoundBanner
        current={goalRoundBlock.round ?? 1}
        objective={goalRoundBlock.objective ?? ''}
        colorTextSecondary={colorTextSecondary}
        colorBorderSecondary={colorBorderSecondary}
      />
    )
  }

  /** 孤立提问的操作按钮：与助手消息操作栏同款（图标 + Tooltip，悬停加底色变深） */
  const actionButton = (
    kind: 'edit' | 'delete',
    icon: React.ReactNode,
    title: string,
    onClick: () => void
  ): React.ReactNode => {
    const active = hovered === kind
    return (
      /* 与助手消息操作栏（MessageActions 的 tooltipCommon）对齐：都朝下弹，
         避免朝上盖住用户刚写完的那段提问正文 */
      <Tooltip title={title} placement="bottom">
        <button
          type="button"
          aria-label={title}
          onClick={onClick}
          onMouseEnter={() => setHovered(kind)}
          onMouseLeave={() => setHovered(null)}
          className="p-1 rounded-md transition-colors"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            background: active ? token.colorFillTertiary : 'transparent',
            color: kind === 'delete' && active ? token.colorError : token.colorTextTertiary
          }}
        >
          {icon}
        </button>
      </Tooltip>
    )
  }

  return (
    <div className="flex justify-end harness-message-body">
      {/* min-w-0：flex 子项默认 min-width:auto，长哈希/URL 这类不可断词会把气泡顶出 80% 上限 */}
      <div className="max-w-[80%] min-w-0">
        <div
          style={{
            /* 用户气泡：中性深灰（用户 2026-11-19 指定样式 rgb(60 60 60) / rgba(255,255,255,.85)），
               取代原先的蓝色气泡；亮色主题用对应的中性浅灰，避免颜色主题里出现突兀的蓝块。 */
            background: isDarkMode ? 'rgb(60 60 60)' : token.colorFillSecondary,
            color: colorText,
            // 编辑中：加一圈主色描边，明确「正在改这条提问」
            boxShadow: editing ? `0 0 0 1.5px ${token.colorPrimary}` : undefined
          }}
          className="px-5 py-3 rounded-2xl rounded-br-sm"
        >
          {editing ? (
            /* 就地编辑：输入区就在气泡里（不用聊天输入框），回车即发送 */
            <textarea
              ref={textareaRef}
              value={draft}
              rows={1}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleEditorKeyDown}
              className="whitespace-pre-wrap"
              style={{
                display: 'block',
                width: '100%',
                minWidth: 240,
                margin: 0,
                padding: 0,
                border: 'none',
                outline: 'none',
                resize: 'none',
                overflow: 'hidden',
                background: 'transparent',
                color: 'inherit',
                font: 'inherit',
                lineHeight: 'inherit',
                caretColor: token.colorPrimary,
                overflowWrap: 'anywhere',
                wordBreak: 'break-word'
              }}
            />
          ) : (
            <p
              className="whitespace-pre-wrap"
              style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}
            >
              {message.content}
            </p>
          )}
        </div>
        {imageBlocks.length > 0 && (
          <Image.PreviewGroup items={imageBlocks.map((b) => b.image_url!)}>
            <div className="flex gap-2 mt-2 justify-end flex-wrap">
              {imageBlocks.map((b, idx) => (
                <Image
                  key={idx}
                  src={b.image_url}
                  alt={`user-img-${idx}`}
                  className="max-w-[200px] max-h-[200px] object-cover rounded-lg"
                  style={{ border: `1px solid ${colorBorderSecondary}` }}
                  classNames={{ cover: 'rounded-lg' }}
                />
              ))}
            </div>
          </Image.PreviewGroup>
        )}
        {documentBlocks.length > 0 && (
          <div className="flex gap-2 mt-2 justify-end flex-wrap">
            {documentBlocks.map((b, idx) => (
              <Tag
                key={idx}
                color="blue"
                className="px-3 py-1 text-sm rounded-lg"
                style={{ maxWidth: '100%' }}
              >
                <div className="inline-flex items-center py-1 gap-1 min-w-0">
                  <RiAttachment2 size={14} className="shrink-0" />
                  <span style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
                    {b.fileName}
                  </span>
                </div>
              </Tag>
            ))}
          </div>
        )}

        {/* 孤立提问（没有回复）才有这行：状态说明 + 编辑 / 删除；编辑中就换成键盘约定提示 */}
        {orphan && !readOnly ? (
          <div
            className="flex items-center justify-end gap-2 mt-1.5"
            style={{ fontSize: 11.5, color: token.colorTextTertiary }}
          >
            {editing ? (
              <span>{t('harness.userMessage.editHint')}</span>
            ) : (
              <>
                <span>{t('harness.userMessage.noReply')}</span>
                {actionButton(
                  'edit',
                  <RiPencilLine size={14} />,
                  t('harness.userMessage.edit'),
                  () => onEdit?.()
                )}
                {actionButton(
                  'delete',
                  <RiDeleteBin6Line size={14} />,
                  t('harness.userMessage.deleteOrphan'),
                  () =>
                    modal.confirm({
                      title: t('harness.userMessage.deleteOrphanTitle'),
                      content: t('harness.userMessage.deleteOrphanContent'),
                      okText: t('common.action.delete'),
                      cancelText: t('common.action.cancel'),
                      okButtonProps: { danger: true },
                      onOk: () => onDelete?.()
                    })
                )}
              </>
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export default UserMessage
