import React from 'react'
import { RiArrowLeftSLine, RiArrowRightSLine, RiFlag2Line } from '@remixicon/react'
import { useTranslation } from '@renderer/i18n'

/**
 * 目标自动续跑的批次横幅：居中的一行虚框，显示「第 N/M 轮」+ 目标原文，多轮时带左右切换。
 *
 * 两个约束都来自用户 2026-09-19 的反馈：
 *  ①「这个内容在窄窗口时，会导致滚动条的出现，优化布局」——横幅**任何宽度下都不许撑宽容器**：
 *     外层 min-width:0、横幅 max-width:100% + min-width:0 + overflow:hidden，
 *     除了 13px 的旗标与切换按钮外，文字一律可收缩并按省略号截断（单行）；
 *  ②「同一个批次里面的 AI 回复这些轮次合并起来，使用左右点击切换」——轮次切换就落在这里：
 *     ‹ › 紧跟标签，永远可见（不参与收缩），未选中的轮次由调用方**不挂载**。
 */
export interface GoalRoundBannerProps {
  /** 当前轮次（1 基，批次内位置） */
  current: number
  /** 批次总轮次；不传表示这条横幅不属于多轮批次（无左右切换） */
  total?: number
  /** 目标原文（可收缩、单行省略） */
  objective: string
  colorTextSecondary: string
  colorBorderSecondary: string
  /** 上一轮（current > 1 时才可点） */
  onPrev?: () => void
  /** 下一轮（current < total 时才可点） */
  onNext?: () => void
}

/** 单行可收缩文本：min-width 0 是能省略号截断的前提（flex 项默认 min-width:auto 不会缩到内容以下） */
const shrinkable: React.CSSProperties = {
  minWidth: 0,
  flex: '0 1 auto',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap'
}

/**
 * 目标原文：收缩优先级远高于「第 N/M 轮」标签（shrink 权重 100 : 1）。
 * 否则窄窗口下两个可收缩项会按内容大小平分压缩，标签被挤成「目…」——轮次信息反而没了。
 * 目标原文本身在输入框上方的 GoalBar 里也有完整版，这里先让它缩。
 */
const objectiveStyle: React.CSSProperties = {
  ...shrinkable,
  flex: '0 100 auto'
}

const NavButton: React.FC<{
  disabled: boolean
  title: string
  onClick: () => void
  children: React.ReactNode
}> = ({ disabled, title, onClick, children }) => (
  <button
    type="button"
    data-goal-nav
    disabled={disabled}
    title={title}
    aria-label={title}
    onClick={onClick}
    style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 0,
      border: 'none',
      background: 'transparent',
      color: 'inherit',
      lineHeight: 0,
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.3 : 1,
      flex: '0 0 auto'
    }}
  >
    {children}
  </button>
)

const GoalRoundBanner: React.FC<GoalRoundBannerProps> = ({
  current,
  total,
  objective,
  colorTextSecondary,
  colorBorderSecondary,
  onPrev,
  onNext
}) => {
  const { t } = useTranslation()
  const totalRounds = total ?? 1
  const navigable = totalRounds > 1 && Boolean(onPrev || onNext)

  return (
    <>
      {/* min-width:0 / max-width:100%：让居中的一行在窄容器里能整体收缩，
          且永远不会比父级更宽（否则 flex 项按内容最小宽撑宽父级 → 横向滚动条） */}
      <div className="flex justify-center mb-4" style={{ minWidth: 0, maxWidth: '100%' }}>
        <div
          data-goal-banner
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 12px',
            borderRadius: 12,
            border: `1px dashed ${colorBorderSecondary}`,
            color: colorTextSecondary,
            fontSize: 12,
            maxWidth: '100%',
            minWidth: 0,
            overflow: 'hidden'
          }}
        >
          <RiFlag2Line size={13} style={{ flex: '0 0 auto' }} />
          {/* 轮次标签不参与收缩：它是这条横幅的主要信息（目标原文在 GoalBar 里有完整版）。
              `text-overflow: ellipsis` 对 1px 溢出也会触发，让标签可缩会被目标原文挤掉一个字。 */}
          <span style={{ flex: '0 0 auto', whiteSpace: 'nowrap' }}>
            {t('harness.userMessage.goalRound', {
              round: navigable ? `${current}/${totalRounds}` : current
            })}
          </span>
          {navigable ? (
            <span style={{ display: 'flex', alignItems: 'center', flex: '0 0 auto' }}>
              <NavButton
                disabled={current <= 1}
                title={t('harness.userMessage.goalPrev')}
                onClick={() => onPrev?.()}
              >
                <RiArrowLeftSLine size={16} />
              </NavButton>
              <NavButton
                disabled={current >= totalRounds}
                title={t('harness.userMessage.goalNext')}
                onClick={() => onNext?.()}
              >
                <RiArrowRightSLine size={16} />
              </NavButton>
            </span>
          ) : null}
          {objective ? (
            <>
              <span style={{ opacity: 0.75, flex: '0 0 auto' }}>—</span>
              <span data-goal-objective style={objectiveStyle} title={objective}>
                {objective}
              </span>
            </>
          ) : null}
        </div>
      </div>
    </>
  )
}

export default GoalRoundBanner
