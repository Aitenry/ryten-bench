import React, { useLayoutEffect } from 'react'

/**
 * 会话行首的「呼吸点」——等待用户确认（黄）/ 刚完成未查看（绿）。
 *
 * 用户口径 2026-11-23：「当需要用户继续确认操作时，这个图标需要变成黄色的点在呼吸……
 * 当任务完成时，需要将进行中，变成绿色的点在呼吸」。所以这里只做**一个会呼吸的圆点**，
 * 颜色由调用方给（黄=等待确认、绿=刚完成），状态机在 useTopicRunStatus / HarnessSidebar。
 *
 * 视觉：实心 7px 圆点做透明度呼吸，外加一圈同色晕环向外扩散后淡出——
 * 16px 的行首槽位里，单靠透明度变化在深色侧栏上不够明显，加晕环才有「在动」的感觉。
 * 节奏 2s（比骨架屏的 1.8s 略慢，属于氛围提示、不抢眼）。
 */

interface TopicStatusDotProps {
  /** 圆点颜色（黄 = colorWarning / 绿 = colorSuccess） */
  color: string
  /** 悬浮与读屏用的文案（等待确认 / 已完成） */
  label: string
  /** 槽位尺寸（px），默认 16——与会话行行首指示槽一致 */
  size?: number
}

/** 呼吸动画与样式（全局只注入一次，同 ChaseDots 的做法） */
export const TOPIC_STATUS_DOT_CSS = `
.ryt-topic-dot {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
}
.ryt-topic-dot__core,
.ryt-topic-dot__halo {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
}
.ryt-topic-dot__core {
  animation: ryt-topic-dot-breathe 2s ease-in-out infinite;
}
.ryt-topic-dot__halo {
  position: absolute;
  opacity: 0;
  animation: ryt-topic-dot-halo 2s ease-out infinite;
}
@keyframes ryt-topic-dot-breathe {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.55; transform: scale(0.8); }
}
@keyframes ryt-topic-dot-halo {
  0% { opacity: 0.42; transform: scale(1); }
  70%, 100% { opacity: 0; transform: scale(2.15); }
}
/* 减少动态：保留「有状态」的静止外观（实心点 + 淡晕环），不播动画 */
@media (prefers-reduced-motion: reduce) {
  .ryt-topic-dot__core { animation: none; }
  .ryt-topic-dot__halo { animation: none; opacity: 0.3; transform: scale(1.75); }
}
`

let dotCssInjected = false

const TopicStatusDot: React.FC<TopicStatusDotProps> = ({ color, label, size = 16 }) => {
  useLayoutEffect(() => {
    if (dotCssInjected) return
    dotCssInjected = true
    const style = document.createElement('style')
    style.textContent = TOPIC_STATUS_DOT_CSS
    document.head.appendChild(style)
  }, [])

  return (
    <span
      className="ryt-topic-dot"
      style={{ width: size, height: size, color }}
      role="status"
      aria-label={label}
      title={label}
    >
      <span className="ryt-topic-dot__halo" aria-hidden="true" />
      <span className="ryt-topic-dot__core" aria-hidden="true" />
    </span>
  )
}

export default TopicStatusDot
