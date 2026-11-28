import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { theme } from 'antd'
import type { TFunction } from 'i18next'
import { useTranslation } from '@renderer/i18n'
import { tailContentIndices } from '../../utils/harness/harnessHelpers'
import type { Message } from '../../types/harness/types'

interface MessageLocatorProps {
  messages: Message[]
  /** Message scroll container (measures height, listens for scrolling) */
  scrollRef: React.RefObject<HTMLDivElement | null>
  /** Content container inside the scroll container (measures each turn's question offset) */
  contentRef: React.RefObject<HTMLDivElement | null>
  /** Tick click: jump to that message (restoring bottom-follow is up to the parent) */
  onJumpTo: (index: number) => void
}

/* ──────────── Visual spec ──────────── */

/** Natural spacing between adjacent ticks (--turn-natural-position steps by 10px) */
const PITCH = 10
/** Tick width (normal / current) and height */
const TICK_W = 8
const TICK_W_ACTIVE = 14
const TICK_H = 2
/** Distance from the container's right edge: clears the 6px scrollbar + 4px margin */
const RAIL_INSET = 20
/** Vertical padding of the rail (used to decide how many ticks fit) */
const PAD_Y = 8
/** Downward tolerance (px) when deciding the "current turn" */
const PROBE_OFFSET = 24
/** Hover card: width, maximum answer lines shown and line height */
const CARD_W = 300
const ANSWER_LINES = 3
const ANSWER_LINE_H = 20
/** Hit area height (a 2px line is too thin to point at) */
const HIT_H = TICK_H + 6

interface Turn {
  /** Index of this turn's question in messages */
  index: number
  /** Question text (title) */
  question: string
  /**
   * The turn's **conclusion** (the final answer of each assistant message joined in order;
   * one part = one assistant message).
   *
   * A turn usually has more than one assistant message: an interjection or a stop followed by
   * "continue" splits it, and goal auto-continuation adds one per round as well. Each message
   * contributes only its own final answer — narration between tool calls stays out of the card.
   */
  answer: string
}

/**
 * Flatten Markdown into a single plain-text line: the preview card needs no syntax marks
 * (not a component function, since the caller passes its own t in)
 */
const plainTextRaw = (t: TFunction, raw: string | null | undefined): string =>
  (raw ?? '')
    .replace(/```[\s\S]*?```/g, t('harness.messageLocator.codePlaceholder'))
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, t('harness.messageLocator.imagePlaceholder'))
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/\*\*|__/g, '')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * Plain-text conversion cache (renderer memory/CPU protection).
 *
 * The regex chain above is real work on long replies, and `turns` is fully recomputed whenever
 * messages change — during streaming that fires on every chunk batch, effectively running every
 * historical reply (often tens to hundreds of KB) through the regexes again each time. The cache
 * key is "language + raw string": historical messages' content strings are the same reference, so
 * a hit returns at once; the streaming message gets a new string every batch and is evicted by
 * the capacity limit in LRU order. The language in the key keeps the other language's cached
 * translations from being hit after a language switch.
 */
const PLAIN_TEXT_CACHE_MAX = 80
const plainTextCache = new Map<string, string>()

const plainText = (t: TFunction, lang: string, raw: string | null | undefined): string => {
  const text = raw ?? ''
  if (text.length === 0) return ''
  const key = `${lang}\u0000${text}`
  const cached = plainTextCache.get(key)
  if (cached !== undefined) {
    // A hit refreshes "most recently used" (Map keeps insertion order, matching the eviction below)
    plainTextCache.delete(key)
    plainTextCache.set(key, cached)
    return cached
  }
  const value = plainTextRaw(t, text)
  if (plainTextCache.size >= PLAIN_TEXT_CACHE_MAX) {
    const oldest = plainTextCache.keys().next().value
    if (oldest !== undefined) plainTextCache.delete(oldest)
  }
  plainTextCache.set(key, value)
  return value
}

/**
 * The **conclusion** body of one assistant message (the final answer delivered this turn).
 *
 * Why not use `message.content` directly: it accumulates the message's **entire** body, including
 * the narration between tool calls ("let me take a look first…", "now I'll make the change…"), so
 * the preview card would degenerate into a running log. The boundary comes from the protocol
 * layer (see main/harness/service/answer-boundary.ts):
 *   - `Set`: these blocks are this turn's answer (indices refer to this message's blocks);
 *   - `null`: explicitly no answer (aborted / tools and thinking only);
 *   - `undefined`: the main process gave no conclusion (streaming in progress / historical
 *     message / older version), so fall back to the reverse scan the chat area uses
 *     (tailContentIndices: the trailing run of "thinking + text", requiring at least one text
 *     block to count as a conclusion).
 * Only text blocks are taken: thinking is where the answer came from but is not the conclusion
 * itself, so the preview card does not expand it.
 */
const answerTextOf = (t: TFunction, lang: string, message: Message): string => {
  const blocks = message.blocks
  // Block-less message (history / abnormal path): the whole body is the only usable content
  if (blocks.length === 0) return plainText(t, lang, message.content)
  if (message.answer === null) return ''
  const indices =
    message.answer instanceof Set
      ? [...message.answer].sort((a, b) => a - b)
      : tailContentIndices(
          blocks,
          blocks.map((_, i) => i)
        )
  const parts: string[] = []
  for (const index of indices) {
    const block = blocks[index]
    if (block?.type === 'text' && block.text) parts.push(block.text)
  }
  return plainText(t, lang, parts.join('\n\n'))
}

/**
 * Turn navigation (locating messages in the conversation).
 *
 * - One tick = one question (**user messages only**), aggregated into an evenly spaced short list
 *   that is vertically centered in the message area;
 * - when there are many ticks the spacing is compressed in place, never exceeding the visible
 *   height;
 * - "current turn" = the nearest question above the viewport top; its tick turns white and grows
 *   longer (scrolling only compares offsets, it does not measure the DOM);
 * - hovering opens a card: the title is this turn's question and the body is the **conclusions**
 *   (final answers) of the turn's assistant messages concatenated in order — narration, tool
 *   calls and thinking stay out of the card (3 lines, scrollable when longer; blank lines carry
 *   the paragraph breaks so it is visible how often the turn was split);
 * - clicking smoothly scrolls to that turn's question.
 */
const MessageLocator: React.FC<MessageLocatorProps> = ({
  messages,
  scrollRef,
  contentRef,
  onJumpTo
}) => {
  const { token } = theme.useToken()
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const [railHeight, setRailHeight] = useState(0)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [hovered, setHovered] = useState<number | null>(null)
  /** Absolute offset of each turn's question in the content, only compared while scrolling */
  const offsetsRef = useRef<{ index: number; offset: number }[]>([])
  const frameRef = useRef<number | null>(null)
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /**
   * One turn = one user message plus every assistant message after it, up to the next question.
   *
   * Each assistant message contributes only its own **conclusion** (answerTextOf): keeping only
   * narration would read like a log, keeping only the last message would drop the turn's earlier
   * conclusions. Multiple parts are concatenated in order (not overwritten) — an interjection
   * splits the turn and resuming after a stop adds another assistant message, whose answer often
   * continues the previous one. Each part goes through plainText first, cached per "single
   * conclusion", so appending a paragraph while streaming still hits the cache for the earlier
   * ones instead of re-regexing the whole historical text.
   */
  const turns = useMemo<Turn[]>(() => {
    const list: Turn[] = []
    messages.forEach((message, index) => {
      if (message.role !== 'user') return
      // The goal auto-continuation banner is not a "question" (it renders as a batch banner
      // browsed with the arrows), so it takes no tick
      if (message.blocks.some((b) => b.type === 'goalRound')) return
      const parts: string[] = []
      for (let i = index + 1; i < messages.length; i++) {
        const next = messages[i]
        if (next.role === 'user') break
        if (next.role !== 'assistant') continue
        const text = answerTextOf(t, lang, next)
        if (text) parts.push(text)
      }
      list.push({
        index,
        question: plainText(t, lang, message.content),
        // Blank-line separated: the hover card uses whiteSpace: pre-wrap, so parts break apart
        // instead of gluing together
        answer: parts.join('\n\n')
      })
    })
    return list
  }, [messages, t, lang])

  /** Refresh the "current turn" from the scroll position */
  const syncActive = useCallback((): void => {
    const el = scrollRef.current
    if (!el) return
    const probe = el.scrollTop + PROBE_OFFSET
    const list = offsetsRef.current
    if (list.length === 0) return
    let index = list[0].index
    list.forEach((item) => {
      if (item.offset <= probe) index = item.index
    })
    setActiveIndex((prev) => (prev === index ? prev : index))
  }, [scrollRef])

  /** Measure each turn's question position (rAF-coalesced, at most once per frame) */
  const measure = useCallback((): void => {
    const el = scrollRef.current
    const inner = contentRef.current
    if (!el || !inner) return
    setRailHeight(Math.max(0, el.clientHeight - PAD_Y * 2))
    const innerTop = inner.getBoundingClientRect().top
    const offsets: { index: number; offset: number }[] = []
    turns.forEach((turn) => {
      const node = inner.querySelector<HTMLElement>(`[data-msg-i="${turn.index}"]`)
      if (!node) return
      offsets.push({ index: turn.index, offset: node.getBoundingClientRect().top - innerTop })
    })
    offsetsRef.current = offsets
    syncActive()
  }, [contentRef, scrollRef, turns, syncActive])

  const scheduleMeasure = useCallback((): void => {
    if (frameRef.current !== null) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null
      measure()
    })
  }, [measure])

  /* Turns changed / container or content size changed (streaming growth) → re-measure */
  useEffect(() => {
    scheduleMeasure()
    const el = scrollRef.current
    const inner = contentRef.current
    const ro = new ResizeObserver(() => scheduleMeasure())
    if (el) ro.observe(el)
    if (inner) ro.observe(inner)
    return () => {
      ro.disconnect()
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
    }
  }, [scheduleMeasure, scrollRef, contentRef])

  /* Scroll → update the current tick */
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = (): void => syncActive()
    el.addEventListener('scroll', onScroll, { passive: true })
    syncActive()
    return () => el.removeEventListener('scroll', onScroll)
  }, [scrollRef, syncActive])

  /* Delayed hover card close: it must not disappear when the pointer moves from the tick onto
     the card (the answer has to stay scrollable) */
  const cancelClear = useCallback((): void => {
    if (clearTimerRef.current) {
      clearTimeout(clearTimerRef.current)
      clearTimerRef.current = null
    }
  }, [])
  const scheduleClear = useCallback((): void => {
    cancelClear()
    clearTimerRef.current = setTimeout(() => setHovered(null), 140)
  }, [cancelClear])
  useEffect(() => () => cancelClear(), [cancelClear])

  /* Measured hover card height: the card's vertical center must align with the hovered tick */
  const cardRef = useRef<HTMLDivElement | null>(null)
  const [cardHeight, setCardHeight] = useState(0)
  useLayoutEffect(() => {
    if (hovered === null) return
    const el = cardRef.current
    if (el) setCardHeight(el.offsetHeight)
  }, [hovered, turns.length])

  /* Clear the hover state when the number of turns changes so it never points at the wrong turn */
  useEffect(() => {
    setHovered(null)
  }, [turns.length])

  if (turns.length < 2) return null

  /* Even stacking: compress the spacing when there are too many ticks, never exceeding the
     visible height */
  const gap =
    turns.length > 1
      ? Math.max(
          2,
          Math.min(PITCH - TICK_H, (railHeight - turns.length * TICK_H) / (turns.length - 1))
        )
      : 0

  const hoveredTurn = hovered === null ? null : (turns[hovered] ?? null)
  const hoveredTop = hovered === null ? 0 : hovered * (HIT_H + gap)
  /* Center the card vertically on the tick (height measured; 120 is assumed until it is) */
  const cardH = cardHeight || 120
  const cardTop = Math.max(
    0,
    Math.min(hoveredTop + HIT_H / 2 - cardH / 2, Math.max(0, railHeight - cardH))
  )

  return (
    <div
      style={{
        position: 'absolute',
        /* Clear the scrollbar and the container's rounded corners */
        right: RAIL_INSET,
        top: '50%',
        transform: 'translateY(-50%)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap,
        zIndex: 12,
        pointerEvents: 'none'
      }}
    >
      {turns.map((turn, i) => {
        const isActive = turn.index === activeIndex
        const isHovered = i === hovered
        return (
          <button
            key={turn.index}
            type="button"
            aria-label={t('harness.messageLocator.jumpToRound', { round: i + 1 })}
            aria-current={isActive ? 'true' : undefined}
            onMouseEnter={() => {
              cancelClear()
              setHovered(i)
            }}
            onMouseLeave={scheduleClear}
            onClick={() => onJumpTo(turn.index)}
            style={{
              width: TICK_W_ACTIVE + 4,
              height: HIT_H,
              padding: 0,
              border: 'none',
              background: 'transparent',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              cursor: 'pointer',
              pointerEvents: 'auto'
            }}
          >
            <span
              style={{
                height: TICK_H,
                borderRadius: 1,
                transition: 'width 0.12s, background 0.12s',
                width: isActive ? TICK_W_ACTIVE : isHovered ? TICK_W + 2 : TICK_W,
                background: isActive
                  ? token.colorText
                  : isHovered
                    ? token.colorTextSecondary
                    : token.colorTextQuaternary
              }}
            />
          </button>
        )
      })}

      {/* Hover card: title = this turn's question, body = the conclusions (final answers) of
          the turn's assistant messages joined together (3 lines, scroll on overflow) */}
      {hoveredTurn && (
        <div
          ref={cardRef}
          onMouseEnter={cancelClear}
          onMouseLeave={scheduleClear}
          style={{
            position: 'absolute',
            right: TICK_W_ACTIVE + 14,
            top: cardTop,
            width: CARD_W,
            background: token.colorBgElevated,
            border: `1px solid ${token.colorBorderSecondary}`,
            borderRadius: 10,
            padding: '10px 12px',
            boxShadow: token.boxShadowSecondary,
            pointerEvents: 'auto'
          }}
        >
          <div
            style={{
              fontSize: 13,
              lineHeight: 1.5,
              color: token.colorText,
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden'
            }}
          >
            {hoveredTurn.question || t('harness.messageLocator.emptyMessage')}
          </div>
          <div style={{ height: 1, background: token.colorBorderSecondary, margin: '8px 0' }} />
          {/* Answer area: fixed 3-line height, scroll on overflow; a fade at the bottom hints
              that more follows */}
          <div style={{ position: 'relative' }}>
            <div
              className="custom-scrollbar"
              style={{
                maxHeight: ANSWER_LINES * ANSWER_LINE_H,
                overflowY: 'auto',
                fontSize: 12.5,
                lineHeight: `${ANSWER_LINE_H}px`,
                color: token.colorTextSecondary,
                whiteSpace: 'pre-wrap'
              }}
            >
              {hoveredTurn.answer || t('harness.messageLocator.noAnswer')}
            </div>
            <div
              style={{
                position: 'absolute',
                left: 0,
                right: 6,
                bottom: 0,
                height: 14,
                background: `linear-gradient(to bottom, transparent, ${token.colorBgElevated})`,
                pointerEvents: 'none'
              }}
            />
          </div>
        </div>
      )}
    </div>
  )
}

export default MessageLocator
