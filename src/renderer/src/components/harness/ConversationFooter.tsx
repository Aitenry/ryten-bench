import React from 'react'

/**
 * Footer shell for the input area of the conversation main region (shared by the main agent
 * and subagents).
 *
 * Per the 2026-11-26 requirement ("reuse everything"), the input area of the main conversation
 * and of subagent sessions must be one and the same shell: the same horizontal padding, max
 * width, background, top divider and fade mask, and the same centered width in welcome state.
 * Only the inner control differs (full HarnessInput for the main conversation, simpleMode
 * HarnessInput for subagents), plus the topic cards above it (goal/tasks/queue belong only to
 * the main conversation and are passed through the `top` slot).
 */
interface ConversationFooterProps {
  /** Empty-conversation (welcome page) layout: no top divider, narrower max width, more vertical padding */
  welcome?: boolean
  /** Topic cards above the input box (main conversation: task progress / goal / queue; subagents have none) */
  top?: React.ReactNode
  colorBgContainer: string
  colorBorderSecondary: string
  children: React.ReactNode
}

const ConversationFooter: React.FC<ConversationFooterProps> = ({
  welcome = false,
  top,
  colorBgContainer,
  colorBorderSecondary,
  children
}) => {
  return (
    <div
      className={`relative px-8 pb-6 ${welcome ? 'pt-4' : 'pt-2'}`}
      style={{
        background: colorBgContainer,
        borderTop: welcome ? 'none' : `1px solid ${colorBorderSecondary}`
      }}
    >
      {/* Fade mask above the input area: messages fade out at the scroll boundary instead of
          looking cut off by the input box. The welcome layout has no messages to fade, so the
          mask only applies in the regular layout. */}
      {!welcome ? (
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: -28,
            left: 0,
            right: 0,
            height: 28,
            zIndex: 2,
            pointerEvents: 'none',
            background: `linear-gradient(to bottom, transparent, ${colorBgContainer})`
          }}
        />
      ) : null}
      <div className={`${welcome ? 'max-w-2xl' : 'max-w-4xl'} mx-auto`}>
        {top}
        {children}
      </div>
    </div>
  )
}

export default ConversationFooter
