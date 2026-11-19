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
import type { QueuedMessageView } from '../../shared/types'

interface QueueDockProps {
  queue: QueuedMessageView[]
  /** 本话题正在生成中：只有生成中才允许「立即插话」 */
  running: boolean
  /** 刚并入当前回合的插话正文（瞬时反馈；插话不落库、不进对话流） */
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
 * 生成中的插话队列（输入框正上方）。
 *
 * 主进程是队列的单一真源，这里只渲染镜像 + 派发动作：
 * - 删除：丢掉这条排队消息；
 * - 编辑：就地改写正文（回车保存、Esc 取消）；
 * - 立即插话：把这条**纯注入**正在运行的回合（下一个工具节点边界模型就能读到）。
 *   插话不落库、不在对话流里生成气泡、也不切分助手消息；命中后由 steeredNotice
 *   给一句短反馈说明它被并进去了，该行随即从队列消失。
 *
 * 本轮没等到注入边界的条目会被放回队列并标 held（模型已不再调用工具、没有边界可用），
 * 显示为「将随下一次发送带出」，避免用户写的内容悄悄丢失。
 *
 * 队列与反馈都为空时不渲染任何东西。
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

  // 队列里那一条被消费/删除后自动退出编辑态（避免编辑框挂在消失的行上）
  useEffect(() => {
    if (editingId && !queue.some((item) => item.id === editingId)) setEditingId(null)
  }, [editingId, queue])

  // 本轮没等到注入边界的条目（模型已不再调用工具 → 没有边界可用）：留在队列里，
  // 随下一次发送带出，避免用户写的内容悄悄丢失
  const heldCount = useMemo(() => queue.filter((item) => item.held).length, [queue])
  const count = queue.length
  const title = useMemo(() => t('harness.queue.count', { count }), [count, t])

  // 插话命中（steeredNotice）只是一句短反馈，不产生对话流内容：
  // 用角落轻提示而非弹窗，避免打断；队列为空时它也不该把队列条重新撑出来
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
                      // 只有正在生成时才能「插进去」：空闲时这条会自然作为新一轮发出
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
