import React, { useLayoutEffect } from 'react'

/**
 * The "breathing dot" at the start of a conversation row — waiting for user confirmation
 * (yellow) / just completed and unviewed (green).
 *
 * User requirement 2026-11-23: "when the user needs to confirm an operation, this icon should
 * become a yellow dot that breathes... when the task completes, the in-progress state should
 * become a green dot that breathes". So this is just **one breathing dot**; the color is supplied
 * by the caller (yellow = waiting for confirmation, green = just completed) and the state machine
 * lives in useTopicRunStatus / HarnessSidebar.
 *
 * Visual: a solid 7px dot breathing in opacity, plus a same-hue halo ring that expands outward
 * and fades — in the 16px leading slot, an opacity change alone is not noticeable enough on the
 * dark sidebar; the halo is what gives the "it's moving" feel. Rhythm is 2s (slightly slower than
 * the skeleton's 1.8s; an ambient hint, not attention-grabbing).
 */

interface TopicStatusDotProps {
  /** Dot color (yellow = colorWarning / green = colorSuccess) */
  color: string
  /** Text for hover and screen readers (waiting for confirmation / completed) */
  label: string
  /** Slot size (px), default 16 — matches the leading indicator slot of a conversation row */
  size?: number
}

/** Breathing animation and styles (injected globally once, same approach as ChaseDots) */
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
/* Reduced motion: keep the static "stateful" look (solid dot + faint halo) without animating */
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
