import React, { useLayoutEffect } from 'react'
import { useTranslation } from '@renderer/i18n'

interface ChaseDotsProps {
  /** 图标尺寸（px），默认 16 */
  size?: number
  /** 颜色，默认 currentColor（跟随文字颜色） */
  color?: string
  className?: string
}

/** 8 个方块在 10×10 viewBox 中的位置（x, y），按追逐顺序排列 */
const DOT_POSITIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [4, 0],
  [8, 0],
  [8, 4],
  [8, 8],
  [4, 8],
  [0, 8],
  [0, 4]
]

/** 追逐动画基础样式与关键帧（全局仅注入一次） */
const CHASE_DOT_CSS = `
.ryt-chase-dot {
  fill: currentColor;
  opacity: 0.15;
  animation: ryt-dot-chase 1s infinite;
}
@keyframes ryt-dot-chase {
  0%, 12.4% { opacity: 1; }
  12.5%, 24.9% { opacity: 0.6; }
  25%, 37.4% { opacity: 0.35; }
  37.5%, 100% { opacity: 0.15; }
}
@media (prefers-reduced-motion: reduce) {
  .ryt-chase-dot {
    animation: none;
    opacity: 1;
  }
}
`

let chaseCssInjected = false

/** 方块追逐加载图标：8 个方块依次闪烁，形成旋转追逐效果 */
const ChaseDots: React.FC<ChaseDotsProps> = ({ size = 16, color = 'currentColor', className }) => {
  const { t } = useTranslation()

  useLayoutEffect(() => {
    if (chaseCssInjected) return
    chaseCssInjected = true
    const style = document.createElement('style')
    style.textContent = CHASE_DOT_CSS
    document.head.appendChild(style)
  }, [])

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 10 10"
      shapeRendering="crispEdges"
      className={className}
      style={{ color, flex: 'none' }}
      role="status"
      aria-label={t('common.state.loading')}
    >
      {DOT_POSITIONS.map(([x, y], index) => (
        <rect
          key={`${x}-${y}`}
          x={x}
          y={y}
          width="2"
          height="2"
          className="ryt-chase-dot"
          style={{ animationDelay: `${index * 125 - 1000}ms` }}
        />
      ))}
    </svg>
  )
}

export default ChaseDots
