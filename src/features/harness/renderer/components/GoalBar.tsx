import React, { useState, useEffect, useRef } from 'react'
import { theme } from 'antd'
import { RiFlag2Line } from '@remixicon/react'
import { useTranslation } from '@renderer/i18n'

import type { GoalView } from '../../shared/types'
import { harnessApi } from '../api'

/**
 * 目标栏（GoalBar）— 输入框上方展示当前对话的长期目标
 *
 * 数据源：主进程 GoalStore（create_goal/update_goal 工具 + 目标轮次驱动器），
 * 变更即广播 harness-goal-updated；本组件监听并实时刷新。
 * - 仅显示当前话题（topicId 匹配）的目标；切换话题清空并重新加载；
 * - 四态展示：active（进行中，armed 时显示自动推进转圈）/ paused / blocked / complete；
 * - blocked 显示阻塞原因（code + message）；
 * - 目标为长期状态：发送新消息不清空（与任务卡片不同）。
 */
const GoalBar: React.FC<{ currentTopicId: number | null }> = ({ currentTopicId }) => {
  const {
    token: {
      colorBgLayout,
      colorBorder,
      colorText,
      colorTextSecondary,
      colorTextTertiary,
      colorPrimary,
      colorWarning,
      colorError
    }
  } = theme.useToken()

  const [goal, setGoal] = useState<GoalView | null>(null)
  const { t } = useTranslation()

  // 用 ref 持有当前 topicId，避免每次变化重新订阅
  const currentTopicIdRef = useRef(currentTopicId)
  currentTopicIdRef.current = currentTopicId

  useEffect(() => {
    // 话题切换/重新打开：清空旧目标，加载新话题的目标（空则隐藏）
    setGoal(null)
    if (currentTopicId == null) return
    const requestedTopicId = currentTopicId
    void harnessApi.harness.getGoal(requestedTopicId).then((g) => {
      // 异步竞态守卫（修复：快速切话题时慢响应可能晚于新话题的 setGoal(null) 到达,
      // 把 A 的目标横幅展示在 B 上——与 onGoalUpdated 的 topicIdRef 守卫对齐）
      if (currentTopicIdRef.current !== requestedTopicId) return
      // 已完成的目标是历史记录：重新进入话题时不展示横幅
      // （会话内实时完成仍经下方广播显示「已完成」；历史行保留在数据库，供新目标替换）
      if (g && g.phase !== 'complete') setGoal(g)
    })

    const unsubscribe = harnessApi.harness.onGoalUpdated((data) => {
      if (data.topicId === currentTopicIdRef.current) {
        setGoal(data.goal)
      }
    })
    return unsubscribe
  }, [currentTopicId])

  if (!goal) return null

  const phaseText: Record<GoalView['phase'], string> = {
    active: t('harness.goalBar.phaseActive'),
    paused: t('harness.goalBar.phasePaused'),
    blocked: t('harness.goalBar.phaseBlocked'),
    complete: t('harness.goalBar.phaseComplete')
  }
  const phaseColor: Record<GoalView['phase'], string> = {
    active: colorPrimary,
    paused: colorTextTertiary,
    blocked: colorWarning,
    complete: colorTextTertiary
  }
  const autoDriving = goal.phase === 'active' && goal.activation === 'armed'
  // 轮次计数只在「仍可继续自动续跑」且确实已开始自动轮时展示：
  // - complete：目标已结束，"3/40" 会被读成「还剩 37 轮」，与「已完成」自相矛盾（此前无条件渲染）；
  // - roundsStarted === 0：尚无自动续跑（创建轮不计入轮次），"0/40" 是噪声。
  const showRound = goal.phase !== 'complete' && goal.roundsStarted > 0

  return (
    <div
      style={{
        border: `1px solid ${colorBorder}`,
        borderRadius: 14,
        background: colorBgLayout,
        marginBottom: 10,
        padding: '9px 14px',
        display: 'flex',
        alignItems: 'center',
        gap: 10
      }}
    >
      <style>{`
        @keyframes goal-bar-spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
      <RiFlag2Line size={15} style={{ color: colorTextSecondary, flexShrink: 0 }} />

      {/* 目标描述（最多两行截断） */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: colorText,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            wordBreak: 'break-word'
          }}
          title={goal.objective}
        >
          {goal.objective}
        </div>
        {goal.blockedReason && (
          <div style={{ fontSize: 11, lineHeight: '16px', color: colorTextTertiary }}>
            {t('harness.goalBar.blocked', {
              code: goal.blockedReason.code,
              message: goal.blockedReason.message
            })}
          </div>
        )}
      </div>

      {/* 状态徽标 + 轮次 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        {autoDriving && (
          <span
            style={{
              width: 12,
              height: 12,
              borderRadius: '50%',
              border: `1.5px solid ${colorBorder}`,
              borderTopColor: colorPrimary,
              animation: 'goal-bar-spin 0.8s linear infinite',
              flexShrink: 0
            }}
          />
        )}
        <span
          style={{
            fontSize: 11,
            lineHeight: '18px',
            padding: '0 8px',
            borderRadius: 9,
            border: `1px solid ${phaseColor[goal.phase]}`,
            color: goal.phase === 'blocked' ? colorError : phaseColor[goal.phase],
            whiteSpace: 'nowrap'
          }}
        >
          {phaseText[goal.phase]}
        </span>
        {showRound && (
          <span style={{ fontSize: 11, color: colorTextTertiary, whiteSpace: 'nowrap' }}>
            {t('harness.goalBar.round', {
              current: goal.roundsStarted,
              max: goal.maxGoalRounds
            })}
          </span>
        )}
      </div>
    </div>
  )
}

export default GoalBar
