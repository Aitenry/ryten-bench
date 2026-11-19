import React from 'react'
import { Modal, Divider, theme } from 'antd'
import dayjs from 'dayjs'
import { useTranslation } from '@renderer/i18n'
import type { TodoItem } from '../../types'

/* ──────────── Types ──────────── */

export interface TodoPreviewModalProps {
  open: boolean
  todo: TodoItem | null
  onClose: () => void
}

/* ──────────── Helpers ──────────── */

const PRIORITY_COLORS: Record<number, string> = {
  0: '#f5222d',
  1: '#fa8c16',
  2: '#fadb14',
  3: '#52c41a',
  4: '#13c2c2',
  5: '#1677ff',
  6: '#2f54eb',
  7: '#722ed1'
}

/** 状态 → 词条键 / 配色（词条键在组件内 t() 求值，模块级常量表不调 hook） */
type TodoStatusKey =
  'notes.status.pending' | 'notes.status.doing' | 'notes.status.done' | 'common.state.unknown'

const STATUS_MAP: Record<number, { labelKey: TodoStatusKey; color: string }> = {
  0: { labelKey: 'notes.status.pending', color: '#1677ff' },
  1: { labelKey: 'notes.status.doing', color: '#fa8c16' },
  2: { labelKey: 'notes.status.done', color: '#52c41a' }
}

/* ──────────── Component ──────────── */

const TodoPreviewModal: React.FC<TodoPreviewModalProps> = ({ open, todo, onClose }) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()

  if (!todo) return null

  const status: { labelKey: TodoStatusKey; color: string } = STATUS_MAP[todo.status ?? 0] ?? {
    labelKey: 'common.state.unknown',
    color: token.colorTextTertiary
  }
  const priorityColor = PRIORITY_COLORS[todo.priority ?? 0] ?? token.colorTextTertiary

  const dot = (color: string): React.ReactNode => (
    <span
      style={{
        display: 'inline-block',
        width: 7,
        height: 7,
        borderRadius: '50%',
        background: color
      }}
    />
  )

  return (
    <Modal title={todo.title} open={open} onCancel={onClose} width={520} centered footer={null}>
      {/* 正文内容（Markdown 源文本预览） */}
      {todo.content && (
        <div
          style={{
            fontSize: 14,
            color: token.colorText,
            lineHeight: 1.7,
            whiteSpace: 'pre-wrap',
            marginBottom: 16
          }}
        >
          {todo.content}
        </div>
      )}

      {/* Priority & status line */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 20,
          marginBottom: 0,
          fontSize: 13,
          color: token.colorTextSecondary
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {dot(priorityColor)}
          {t('notes.todo.priority', { level: todo.priority })}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {dot(status.color)}
          {t(status.labelKey)}
        </span>
        {todo.category && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {dot(token.colorFill)}
            {todo.category}
          </span>
        )}
      </div>

      <Divider style={{ margin: '14px 0' }} />

      {/* Meta grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '10px 24px'
        }}
      >
        <MetaItem
          token={token}
          label={t('notes.field.dueDate')}
          value={todo.due_date ? dayjs(todo.due_date).format('YYYY-MM-DD') : t('common.state.none')}
        />
        {todo.started_at && (
          <MetaItem
            token={token}
            label={t('notes.field.startTime')}
            value={dayjs(todo.started_at).format('YYYY-MM-DD HH:mm')}
          />
        )}
        {todo.completed_at && (
          <MetaItem
            token={token}
            label={t('notes.field.completedTime')}
            value={dayjs(todo.completed_at).format('YYYY-MM-DD HH:mm')}
          />
        )}
        <MetaItem
          token={token}
          label={t('notes.field.createdTime')}
          value={dayjs(todo.created_at).format('YYYY-MM-DD HH:mm')}
        />
        <MetaItem
          token={token}
          label={t('notes.field.updatedTime')}
          value={dayjs(todo.updated_at).format('YYYY-MM-DD HH:mm')}
        />
      </div>
    </Modal>
  )
}

/* ──────────── Meta item ──────────── */

interface MetaItemProps {
  token: ReturnType<typeof theme.useToken>['token']
  label: string
  value: string
}

const MetaItem: React.FC<MetaItemProps> = ({ token, label, value }) => (
  <div>
    <div style={{ fontSize: 12, color: token.colorTextTertiary, marginBottom: 2 }}>{label}</div>
    <div style={{ fontSize: 14, color: token.colorText }}>{value}</div>
  </div>
)

export default TodoPreviewModal
