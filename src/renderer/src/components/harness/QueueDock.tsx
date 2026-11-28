import React, { useEffect, useMemo, useState } from 'react'
import { App, Button, Input, Tooltip } from 'antd'
import {
  RiCheckLine,
  RiCloseLine,
  RiEditLine,
  RiStackLine,
  RiDeleteBin6Line,
  RiArrowUpLine
} from '@remixicon/react'
import { useTranslation } from '@renderer/i18n'
import type { QueuedMessageView } from '../../../../shared/harness/types'

interface QueueDockProps {
  queue: QueuedMessageView[]
  /** This topic is generating: steering is only allowed while generating */
  running: boolean
  /** Steer text just merged into the current turn (transient feedback; steers are not persisted) */
  steeredNotice: string | null
  colorBorderSecondary: string
  colorText: string
  colorTextSecondary: string
  colorTextTertiary: string
  colorFillAlter: string
  onRemove: (itemId: string) => Promise<void>
  onUpdate: (itemId: string, text: string) => Promise<void>
  onSteer: (itemId: string) => Promise<void>
}

/**
 * Steering queue while generating (directly above the input box).
 *
 * The main process is the single source of truth for the queue; this only renders a mirror and
 * dispatches actions:
 * - Delete: drop this queued message;
 * - Edit: rewrite the text in place (Enter saves, Esc cancels);
 * - Steer now: inject this entry **purely** into the running turn (the model can read it at the
 *   next tool-node boundary).
 *   A steer is not persisted, produces no bubble in the conversation stream, and does not split
 *   the assistant message; when it lands, steeredNotice gives a short feedback saying it was
 *   merged in, and the row disappears from the queue.
 *
 * Entries that did not reach an injection boundary this turn go back into the queue and are
 * marked held (the model no longer calls tools, so no boundary is available), shown as "will be
 * sent with the next send", so nothing the user wrote is silently lost.
 *
 * Nothing renders when both the queue and the feedback are empty.
 */
const QueueDock: React.FC<QueueDockProps> = ({
  queue,
  running,
  steeredNotice,
  colorBorderSecondary,
  colorText,
  colorTextSecondary,
  colorTextTertiary,
  colorFillAlter,
  onRemove,
  onUpdate,
  onSteer
}) => {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)

  // Leave edit mode automatically once that queue entry is consumed or deleted (so the editor
  // does not hang on a row that disappeared)
  useEffect(() => {
    if (editingId && !queue.some((item) => item.id === editingId)) setEditingId(null)
  }, [editingId, queue])

  // Entries that did not reach an injection boundary this turn (the model no longer calls tools,
  // so no boundary is available): keep them in the queue so they go out with the next send,
  // instead of silently losing what the user wrote
  const heldCount = useMemo(() => queue.filter((item) => item.held).length, [queue])
  const count = queue.length
  const title = useMemo(() => t('harness.queue.count', { count }), [count, t])

  // A steer hit (steeredNotice) is only a short feedback and adds nothing to the conversation
  // stream: use a corner toast instead of a modal to avoid interrupting; when the queue is empty
  // it must not bring the queue bar back
  useEffect(() => {
    if (steeredNotice) {
      message.success({ content: t('harness.queue.steered'), duration: 2 })
    }
  }, [steeredNotice, message, t])

  if (count === 0) return null

  const saveEdit = async (itemId: string): Promise<void> => {
    const text = draft.trim()
    if (!text) return
    setBusyId(itemId)
    try {
      await onUpdate(itemId, text)
      setEditingId(null)
    } catch {
      message.error(t('harness.queue.editFailed'))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div
      className="mb-2 rounded-xl overflow-hidden"
      style={{ background: colorFillAlter, border: `1px solid ${colorBorderSecondary}` }}
    >
      <div
        className="flex items-center gap-1.5 px-3 py-1.5"
        style={{ borderBottom: `1px solid ${colorBorderSecondary}`, color: colorTextSecondary }}
      >
        <RiStackLine size={13} style={{ color: colorTextTertiary }} />
        <span className="text-xs">{title}</span>
        <span className="flex-1" />
        <span className="text-xs" style={{ color: colorTextTertiary }}>
          {heldCount > 0 ? t('harness.queue.heldHint') : t('harness.queue.hint')}
        </span>
      </div>
      <ul className="m-0 p-0" style={{ listStyle: 'none' }}>
        {queue.map((item, index) => (
          <li
            key={item.id}
            className="flex items-center gap-2 px-3 py-1.5"
            style={{
              borderTop: index === 0 ? undefined : `1px solid ${colorBorderSecondary}`
            }}
          >
            <span
              className="shrink-0 tabular-nums text-xs"
              style={{ color: colorTextTertiary, minWidth: 14 }}
            >
              {index + 1}
            </span>
            {editingId === item.id ? (
              <Input
                size="small"
                autoFocus
                variant="borderless"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setEditingId(null)
                    return
                  }
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    void saveEdit(item.id)
                  }
                }}
                style={{ flex: 1, padding: 0, color: colorText }}
              />
            ) : (
              <span className="flex-1 min-w-0 truncate text-xs" style={{ color: colorText }}>
                {item.attachments.length > 0 && (
                  <span style={{ color: colorTextTertiary }}>
                    {t('harness.queue.attachmentCount', { count: item.attachments.length })}
                  </span>
                )}
                {item.text}
              </span>
            )}
            <span className="shrink-0 flex items-center gap-0.5">
              {editingId === item.id ? (
                <>
                  <Tooltip title={t('harness.queue.save')}>
                    <Button
                      type="text"
                      size="small"
                      icon={<RiCheckLine size={13} />}
                      disabled={busyId === item.id || draft.trim() === ''}
                      onClick={() => void saveEdit(item.id)}
                    />
                  </Tooltip>
                  <Tooltip title={t('harness.queue.cancelEdit')}>
                    <Button
                      type="text"
                      size="small"
                      icon={<RiCloseLine size={13} />}
                      onClick={() => setEditingId(null)}
                    />
                  </Tooltip>
                </>
              ) : (
                <>
                  <Tooltip title={t('harness.queue.edit')}>
                    <Button
                      type="text"
                      size="small"
                      icon={<RiEditLine size={13} />}
                      onClick={() => {
                        setEditingId(item.id)
                        setDraft(item.text)
                      }}
                    />
                  </Tooltip>
                  <Tooltip title={t('harness.queue.remove')}>
                    <Button
                      type="text"
                      size="small"
                      icon={<RiDeleteBin6Line size={13} />}
                      onClick={() => void onRemove(item.id)}
                    />
                  </Tooltip>
                  <Tooltip
                    title={running ? t('harness.queue.steer') : t('harness.queue.steerUnavailable')}
                  >
                    <Button
                      type="text"
                      size="small"
                      // Steering is only possible while generating: when idle this entry goes out
                      // naturally as a new turn
                      disabled={!running}
                      icon={<RiArrowUpLine size={13} />}
                      onClick={() => void onSteer(item.id)}
                    />
                  </Tooltip>
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export default QueueDock
