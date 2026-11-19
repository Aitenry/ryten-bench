import React, { useState, useEffect, useRef } from 'react'
import { theme } from 'antd'
import { RiListCheck2, RiArrowDownSLine, RiCheckboxCircleFill } from '@remixicon/react'
import { Trans } from '@renderer/i18n'

import type { TodoItem } from '../../shared/types'
import { harnessApi } from '../api'

/** 数字等宽字体：计数里的数字用等宽字形，避免位数变化时整行抖动 */
const MONO_FONT = "'JetBrains Mono', 'Cascadia Code', Consolas, 'Courier New', monospace"

/**
 * 进行中任务卡片 — 输入框上方展示「模型在对话中制定的计划」
 *
 * 数据源：write_todos 工具写入的对话待办清单（主进程进程级单例、按 topicId 隔离），
 * 写入即广播 harness-todos-updated 事件，本组件实时监听。
 * - 仅显示当前对话（topicId 匹配）的清单；任务全部完成后**保留显示**（6/6 已完成），
 *   用户开启新一轮问答（发送新消息 / 切话题 / 新对话）时才消失；
 * - 标题栏可点击折叠/展开；已完成任务置灰（保留在清单中参与统计）。
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

  // 用 ref 持有当前 topicId，避免每次变化重新订阅
  const currentTopicIdRef = useRef(currentTopicId)
  currentTopicIdRef.current = currentTopicId

  useEffect(() => {
    // 话题切换：清空旧清单，等待新话题的写入事件
    setTodos([])
    const unsubscribe = harnessApi.harness.onHarnessTodosUpdated((data) => {
      if (data.topicId === currentTopicIdRef.current) {
        setTodos(data.todos)
      }
    })
    // 主动拉一次当前话题的清单：卡片在切页 / 切话题后是重新挂载的，
    // 只订阅「写入选广播」会一直空着，直到模型下一次 write_todos（表现为卡片消失）
    if (currentTopicId !== null) {
      let cancelled = false
      void harnessApi.harness
        .getHarnessTodos(currentTopicId)
        .then((todos) => {
          // 期间又切了话题就丢弃（以最新话题的清单为准）
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

  // 新一轮问答（用户发送新消息）：清空清单，等待模型重新规划
  useEffect(() => {
    const onSendStarted = (): void => setTodos([])
    window.addEventListener('harness-send-started', onSendStarted)
    return () => window.removeEventListener('harness-send-started', onSendStarted)
  }, [])

  // 清单存在即展示（含全部完成态）
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
      {/* 进行中状态：细圆环转圈动画（主色顶弧 + 平滑旋转） */}
      <style>{`
        @keyframes task-card-spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
      {/* 标题栏：点击折叠/展开 */}
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

      {/* 任务列表 */}
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
                    // 已完成 = 绿（与消息区段头/清单同一套语义，此前是主色蓝）
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
