import React, { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { theme } from 'antd'
import { RiArrowDownWideLine, RiArrowUpWideLine } from '@remixicon/react'
import { useTranslation } from '@renderer/i18n'

/**
 * Folded content box: **fixed height (scrolls internally when overflowing) + optional expand-all
 * + interruptible stick-to-bottom following**.
 *
 * The user requirement of 2026-09-19 (verbatim): "Default to a fixed height with the option to
 * expand everything. While streaming it should scroll to the bottom to stream-load, and the
 * scroll-to-bottom can be interrupted; when at the bottom, loading can continue. Make sure the
 * fixed height does not cover the thinking content." A follow-up added: "This (the content of the
 * folded segment) should work the same way" — so this is not thinking-specific: thinking process,
 * task segments, tool output and subagent output all use the same box with identical behavior.
 * (Since 2026-09-25 the early exploration segment is no longer folded, so it no longer uses this
 * box: only task segments fold.)
 *
 * "Expand all" is now an **explicit per-use switch** (user 2026-09-23: "Thinking content doesn't
 * need it; the expand-all below the content — that button isn't needed"): thinking boxes
 * (`thinking` / `thinking-nested`, plus tools and subagent output that already have their own
 * expand entry points) pass `expandable={false}`, so no button is rendered below the box and long
 * content just scrolls inside the fixed height; only task segment content still carries this
 * control by default. The switch always lives at the call site: whether a box needs a button is
 * part of its semantics, not something tracked from outside.
 *
 * Before this change there were two separate implementations, exactly the problems those
 * statements point at:
 *  - the content box hard-coded `max-h-64 overflow-y-auto`, so long content could only be scrolled
 *    back and forth within a 256px window — no "see it all at once";
 *  - stick-to-bottom was an **indiscriminate** effect inside AssistantMessage: on every streaming
 *    chunk it set `scrollTop = scrollHeight` on all scroll containers. It did not check whether
 *    the user was reading upwards — someone who just wanted to look back a few lines was yanked
 *    to the bottom (the behavior the user's "can be interrupted" removes); nor did it check
 *    whether the container was already at the bottom, it just assigned blindly.
 *
 * The three requirements, one by one:
 *  1. Fixed height: capped by `maxHeight` by default, scrolling internally when overflowing
 *     (while streaming the message no longer grows with content); clicking the expand icon lifts
 *     the cap to show the whole text; clicking collapse again returns to the fixed height and
 *     pins to the latest line;
 *  2. Stick-to-bottom: follows only **while streaming** and only when the user **is at the
 *     bottom** (once per chunk); scrolling up interrupts it, and scrolling back to the bottom
 *     resumes it automatically — not "following is turned off" but "the user's position wins";
 *  3. No occlusion: the box contains only the content itself; the expand/collapse control sits
 *     **outside** the box (below, right-aligned), so no control ever covers the text.
 */

/** Tolerance for "at the bottom" (px): same order as the chat area's STICK_THRESHOLD */
const NEAR_BOTTOM = 12

/** Expand/collapse icon size (px): matches the other small icons in the message area */
const TOGGLE_ICON_SIZE = 16

/**
 * "Expand all / collapse" icon (specified by the user on 2026-09-19):
 * **folded = ri-arrow-down-wide-line, expanded = ri-arrow-up-wide-line, and it must be centered**.
 * A fixed-size flex box wraps the glyph and centers it both horizontally and vertically (an inline
 * svg rests on the text baseline and looks shifted upward).
 */
const FoldToggleIcon: React.FC<{ expanded: boolean }> = ({ expanded }) => (
  <span
    data-fold-toggle-icon={expanded ? 'up' : 'down'}
    // Center with inline styles rather than utility classes: this is the control's own geometry
    // and should not depend on whether Tailwind is present
    // (jsdom has no Tailwind, so class-based computed styles are inline and cannot be tested reliably)
    style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: TOGGLE_ICON_SIZE,
      height: TOGGLE_ICON_SIZE,
      lineHeight: 0
    }}
  >
    {expanded ? (
      <RiArrowUpWideLine size={TOGGLE_ICON_SIZE} />
    ) : (
      <RiArrowDownWideLine size={TOGGLE_ICON_SIZE} />
    )}
  </span>
)

interface FoldBodyProps {
  children: React.ReactNode
  /** Fixed height cap (px): 256 for thinking, 192 for nested subagent content, 320 for segment content */
  maxHeight?: number
  /**
   * Whether to offer "expand all / collapse" (offered by default).
   *
   * **Thinking boxes must pass false** (user 2026-09-23: "Thinking content doesn't need it; the
   * expand-all below the content — that button isn't needed"); tool/subagent output already
   * passes false (they have their own expand entries); only task segment content uses the default.
   */
  expandable?: boolean
  /** Whether streaming: when false (historical messages) scrolling is not managed at all, and the box opens at the first line */
  streaming?: boolean
  /** Trigger signal for stick-to-bottom: pass `message.lastChunkAt` while streaming (changes once per chunk) */
  followSignal?: number
  /** Extra class names (padding/font size differ per call site: px-1.5, ml-2 pl-2, text-sm/text-xs…) */
  className?: string
  /** Left accent border color: the thinking block uses it to distinguish "thinking / body"; segment content and tool output do not pass it */
  borderColor?: string
  /**
   * Usage marker (written to `data-fold-body`): several content boxes coexist in one message
   * (segment content + thinking + tool + subagent), and regression fixtures need stable anchors
   * to tell them apart.
   */
  kind?:
    | 'thinking'
    | 'thinking-nested'
    | 'segment'
    /** Content of a same-name tool run (reading the same file ten times still scrolls inside the fixed height) */
    | 'tool-run'
    | 'tool'
    | 'tool-nested'
    | 'subagent'
    | 'subagent-nested'
}

const FoldBody: React.FC<FoldBodyProps> = ({
  children,
  maxHeight = 256,
  expandable = true,
  streaming = false,
  followSignal,
  className = '',
  borderColor,
  kind = 'segment'
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const boxRef = useRef<HTMLDivElement>(null)
  /** Whether to follow the bottom: set false when the user scrolls up, back to true when scrolled to the bottom */
  const stickRef = useRef(true)
  const [expanded, setExpanded] = useState(false)
  /** Whether content exceeds the fixed height: only render the control when it can actually expand; no useless controls */
  const [overflow, setOverflow] = useState(false)

  /**
   * Measure the box height once and (when sticking) follow the latest line.
   *
   * Triggers are "a new chunk arrived" and "expanded state / cap changed", **not every render**:
   * in a message with hundreds of chunks, reading `scrollHeight` on every render forces a
   * synchronous layout, a documented source of jank that was fixed earlier. While streaming,
   * `followSignal` fires in step with the content, which is enough.
   */
  useLayoutEffect(() => {
    const el = boxRef.current
    if (!el) return
    const over = el.scrollHeight - el.clientHeight > 1
    setOverflow((prev) => (prev === over ? prev : over))
    if (streaming && stickRef.current) el.scrollTop = el.scrollHeight
  }, [followSignal, expanded, maxHeight, streaming])

  /** User scroll: resume following at the bottom, interrupt when scrolling up (returning to the bottom resumes automatically; no extra switch needed) */
  const handleScroll = useCallback(() => {
    const el = boxRef.current
    if (!el) return
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM
  }, [])

  /** When collapsing back to the fixed height, pin to the latest line: after reading the beginning while expanded, collapsing should not leave the user at the start */
  const handleToggle = useCallback(() => {
    setExpanded((prev) => {
      if (prev) {
        stickRef.current = true
        const el = boxRef.current
        if (el) el.scrollTop = el.scrollHeight
      }
      return !prev
    })
  }, [])

  const toggleLabel = expanded
    ? t('harness.assistantMessage.foldCollapse')
    : t('harness.assistantMessage.foldExpand')

  return (
    <>
      <div
        ref={boxRef}
        data-fold-body={kind}
        onScroll={handleScroll}
        className={`overflow-y-auto harness-scrollbar ${borderColor ? 'border-l-2 pl-3' : ''} ${className}`}
        style={{ borderColor, maxHeight: expanded ? 'none' : maxHeight }}
      >
        {children}
      </div>
      {/* The control sits outside the box: the fixed height only scrolls the content, so the
          expand/collapse button never covers it. The button content is the icon itself (user
          2026-09-19: "The expand-all content should switch to an icon"), and the text label moves
          to title/aria-label so accessibility is unaffected.
          **Centered both horizontally and vertically** (user 2026-09-19, second round: "it isn't
          centered horizontally and vertically"): the outer row, the button and the icon are each
          centered, all with inline styles — this is the control's own geometry and should not
          depend on whether Tailwind is present (jsdom has no Tailwind, so class-based styles
          cannot be tested reliably). */}
      {expandable && (overflow || expanded) ? (
        <div
          data-fold-toggle
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <button
            type="button"
            data-fold-toggle-state={expanded ? 'up' : 'down'}
            onClick={handleToggle}
            title={toggleLabel}
            aria-label={toggleLabel}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 0,
              border: 'none',
              background: 'transparent',
              color: token.colorTextSecondary,
              cursor: 'pointer',
              lineHeight: 0
            }}
          >
            <FoldToggleIcon expanded={expanded} />
          </button>
        </div>
      ) : null}
    </>
  )
}

export default FoldBody
