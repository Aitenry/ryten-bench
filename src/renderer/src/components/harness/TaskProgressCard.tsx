import React, { useState, useEffect, useRef } from 'react'
import { theme } from 'antd'
import { RiListCheck2, RiArrowDownSLine, RiCheckboxCircleFill } from '@remixicon/react'
import { Trans } from '@renderer/i18n'

import type { TodoItem } from '../../../../shared/harness/types'
import { harnessApi } from '../../api/harness'

/** Monospace digits: counts use monospace glyphs so the row does not jitter as digit counts change */
const MONO_FONT = "'JetBrains Mono', 'Cascadia Code', Consolas, 'Courier New', monospace"

/**
 * In-progress task card — shows above the input the plan the model made during the conversation
 *
 * Data source: the conversation todo list written by the write_todos tool (a process-level
 * singleton in the main process, isolated by topicId); each write broadcasts a
 * harness-todos-updated event, which this component listens to live.
 * - Only the list of the current conversation (matching topicId) is shown; once all tasks are done
 *   the card **stays visible** (6/6 completed) and disappears only when the user starts a new
 *   round (sends a new message / switches topic / starts a new conversation);
 * - The header can be clicked to collapse/expand; completed tasks are grayed out (kept in the list
 *   for counting).
 */
const TaskProgressCard: React.FC<{ currentTopicId: number | null }> = ({ currentTopicId }) => {
  const {
    token: {
      colorBgLayout,
      colorBorder,
      colorBorderSecondary,
      colorText,
      colorTextSecondary,
      colorTextTertiary,
      colorPrimary,
      colorSuccess
    }
  } = theme.useToken()

  const [todos, setTodos] = useState<TodoItem[]>([])
  const [expanded, setExpanded] = useState(true)

  // Hold the current topicId in a ref so changes do not resubscribe
  const currentTopicIdRef = useRef(currentTopicId)
  currentTopicIdRef.current = currentTopicId

  useEffect(() => {
    // Topic switch: clear the old list and wait for the new topic's write events
    setTodos([])
    const unsubscribe = harnessApi.harness.onHarnessTodosUpdated((data) => {
      if (data.topicId === currentTopicIdRef.current) {
        setTodos(data.todos)
      }
    })
    // Fetch the current topic's list once: the card is remounted after page/topic switches, and
    // subscribing only to "write broadcasts" would leave it empty until the model's next
    // write_todos (the card would appear to vanish)
    if (currentTopicId !== null) {
      let cancelled = false
      void harnessApi.harness
        .getHarnessTodos(currentTopicId)
        .then((todos) => {
          // Discard if the topic changed meanwhile (the latest topic's list wins)
          if (!cancelled && currentTopicIdRef.current === currentTopicId) setTodos(todos)
        })
        .catch((error) => console.error('Failed to load harness todos:', error))
      return () => {
        cancelled = true
        unsubscribe()
      }
    }
    return unsubscribe
  }, [currentTopicId])

  // New round (user sends a new message): clear the list and wait for the model to re-plan
  useEffect(() => {
    const onSendStarted = (): void => setTodos([])
    window.addEventListener('harness-send-started', onSendStarted)
    return () => window.removeEventListener('harness-send-started', onSendStarted)
  }, [])

  // Show the card whenever a list exists (including the all-completed state)
  const completedCount = todos.filter((t) => t.status === 'completed').length
  const inProgressCount = todos.filter((t) => t.status === 'in_progress').length
  if (todos.length === 0) return null

  return (
    <div
      style={{
        border: `1px solid ${colorBorder}`,
        borderRadius: 14,
        background: colorBgLayout,
        marginBottom: 10,
        overflow: 'hidden'
      }}
    >
      {/* In-progress state: a thin ring spinner (primary-colored top arc, smooth rotation) */}
      <style>{`
        @keyframes task-card-spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
      {/* Header bar: click to collapse/expand */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center w-full border-none cursor-pointer transition-colors"
        style={{
          gap: 8,
          padding: '9px 14px',
          background: 'transparent',
          textAlign: 'left',
          borderRadius: 0
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(128,128,128,0.07)')}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
      >
        <RiListCheck2 size={15} style={{ color: colorTextSecondary, flexShrink: 0 }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: colorText }}>
          <Trans
            i18nKey="harness.taskCard.completed"
            values={{ done: completedCount, total: todos.length }}
            components={{ mono: <span style={{ fontFamily: MONO_FONT }} /> }}
          />
        </span>
        {inProgressCount > 0 && (
          <span style={{ fontSize: 12, color: colorTextTertiary }}>
            <Trans
              i18nKey="harness.taskCard.inProgress"
              count={inProgressCount}
              components={{ mono: <span style={{ fontFamily: MONO_FONT }} /> }}
            />
          </span>
        )}
        <RiArrowDownSLine
          size={16}
          style={{
            marginLeft: 'auto',
            color: colorTextTertiary,
            flexShrink: 0,
            transform: expanded ? 'rotate(180deg)' : 'none',
            transition: 'transform 0.2s'
          }}
        />
      </button>

      {/* Task list */}
      {expanded && (
        <div
          className="custom-scrollbar"
          style={{ maxHeight: 220, overflowY: 'auto', padding: '2px 14px 10px' }}
        >
          {todos.map((t, i) => {
            const done = t.status === 'completed'
            return (
              <div key={i} className="flex items-start gap-2.5" style={{ padding: '5px 0' }}>
                {done ? (
                  <RiCheckboxCircleFill
                    size={16}
                    // Completed = green (same semantics as message-area section headers / lists; previously primary blue)
                    style={{ color: colorSuccess, marginTop: 2, flexShrink: 0 }}
                  />
                ) : t.status === 'in_progress' ? (
                  <span
                    style={{
                      width: 16,
                      height: 16,
                      marginTop: 2,
                      flexShrink: 0,
                      borderRadius: '50%',
                      border: `1.5px solid ${colorBorderSecondary}`,
                      borderTopColor: colorPrimary,
                      animation: 'task-card-spin 0.8s linear infinite'
                    }}
                  />
                ) : (
                  <span
                    style={{
                      width: 16,
                      height: 16,
                      marginTop: 2,
                      flexShrink: 0,
                      borderRadius: '50%',
                      border: `1.5px dashed ${colorBorderSecondary}`
                    }}
                  />
                )}
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 13.5,
                      lineHeight: '20px',
                      wordBreak: 'break-word',
                      color: done ? colorTextTertiary : colorText
                    }}
                  >
                    {t.content}
                  </div>
                  {t.status === 'in_progress' && t.activeForm && (
                    <div style={{ fontSize: 11, lineHeight: '16px', color: colorTextTertiary }}>
                      {t.activeForm}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default TaskProgressCard
