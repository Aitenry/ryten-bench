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
   * This question has no corresponding reply (the next message is not an assistant message, or it
   * is itself the last one).
   *
   * Typical cases for such an orphan question: the stream failed/was aborted on send, or a database
   * incident left only the question behind. In that case there is no actionable entry point after
   * the bubble and the user can only stare at it — so add "edit / delete" for it.
   */
  orphan?: boolean
  /** Editing this question **inside the bubble** */
  editing?: boolean
  /** Read-only (archived session): no "edit / delete" entry even for orphan questions */
  readOnly?: boolean
  /** Enter edit mode */
  onEdit?: () => void
  /** Enter inside the bubble submits (content replaces this question in place; no new user bubble) */
  onEditSubmit?: (content: string) => void
  /** Esc / cancel editing */
  onEditCancel?: () => void
  /** Click delete (after confirmation the parent removes the DB row and the UI message) */
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
  /** Draft for in-bubble editing */
  const [draft, setDraft] = useState(message.content)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Enter edit mode: the draft starts from the current body and focus lands at the end (matches the
  // "keep editing where I left off" intuition)
  useEffect(() => {
    if (!editing) return
    setDraft(message.content)
  }, [editing, message.content])

  // Textarea height adapts to content (the bubble must not grow a scrollbar)
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
   * In-bubble keyboard convention: Enter sends, Shift+Enter inserts a newline, Esc cancels.
   * Enter while an IME is composing must not send (very easy to trigger by accident in Chinese).
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
  // Goal auto-continuation round: rendered as a centered auto-run banner (not a normal user bubble)
  const goalRoundBlock = message.blocks.find((b) => b.type === 'goalRound')

  if (goalRoundBlock) {
    /* Continuation banner for a single round / unmerged rounds: same component as the batch banner
       (shrinkable in narrow windows, single-line ellipsis) */
    return (
      <GoalRoundBanner
        current={goalRoundBlock.round ?? 1}
        objective={goalRoundBlock.objective ?? ''}
        colorTextSecondary={colorTextSecondary}
        colorBorderSecondary={colorBorderSecondary}
      />
    )
  }

  /** Action buttons for an orphan question: same as the assistant message action bar (icon + Tooltip, background darkens on hover) */
  const actionButton = (
    kind: 'edit' | 'delete',
    icon: React.ReactNode,
    title: string,
    onClick: () => void
  ): React.ReactNode => {
    const active = hovered === kind
    return (
      /* Aligned with the assistant message action bar (tooltipCommon in MessageActions): both pop
         downward so they never cover the question text the user just finished typing */
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
      {/* min-w-0: flex children default to min-width:auto, so long unbreakable tokens such as
          hashes/URLs push the bubble past the 80% limit */}
      <div className="max-w-[80%] min-w-0">
        <div
          style={{
            /* User bubble: neutral dark gray (style specified by the user on 2026-11-19 as
                rgb(60 60 60) / rgba(255,255,255,.85)), replacing the old blue bubble; the light
                theme uses the corresponding neutral light gray so no jarring blue block appears. */
            background: isDarkMode ? 'rgb(60 60 60)' : token.colorFillSecondary,
            color: colorText,
            // Editing: add a primary-colored outline to make "editing this question" obvious
            boxShadow: editing ? `0 0 0 1.5px ${token.colorPrimary}` : undefined
          }}
          className="px-5 py-3 rounded-2xl rounded-br-sm"
        >
          {editing ? (
            /* In-place editing: the input lives inside the bubble (not the chat input), Enter sends */
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

        {/* Only for orphan questions (no reply): status text + edit / delete; while editing it
            turns into the keyboard convention hint */}
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
