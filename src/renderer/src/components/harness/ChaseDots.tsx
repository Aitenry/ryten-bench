import React, { useLayoutEffect } from 'react'
import { useTranslation } from '@renderer/i18n'

interface ChaseDotsProps {
  /** Icon size in px, defaults to 16 */
  size?: number
  /** Color, defaults to currentColor (follows the text color) */
  color?: string
  className?: string
}

/** Positions (x, y) of the 8 squares in the 10×10 viewBox, in chase order */
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

/** Base styles and keyframes for the chase animation (injected globally only once) */
export const CHASE_DOT_CSS = `
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

/** Square-chase loading icon: 8 squares blink in sequence to create a rotating chase effect */
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
