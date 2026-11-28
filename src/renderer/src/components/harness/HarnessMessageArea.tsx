import React, { useRef, useEffect, useLayoutEffect, useCallback, useMemo, useState } from 'react'
import { SkeletonMessages } from '@renderer/components/system/Skeleton'
import { useTranslation } from '@renderer/i18n'

import UserMessage from './messages/UserMessage'
import AssistantMessage from './messages/AssistantMessage'
import GoalRoundBanner from './messages/GoalRoundBanner'
import ScrollToBottomButton from './ScrollToBottomButton'
import MessageLocator from './MessageLocator'
import WelcomeIntro from './WelcomeIntro'
import type { HarnessDialogueUsageRow } from '../../../../shared/harness/types'
import type { Message } from '../../types/harness/types'
import { harnessApi } from '../../api/harness'

interface HarnessMessageAreaProps {
  messages: Message[]
  isDarkMode: boolean
  /** Whether the current topic is streaming (drives stick-to-bottom following and the button's rotating glow) */
  streaming: boolean
  /** Current topic id: switching topics / starting a new conversation resets to the stick-to-bottom state */
  currentTopicId: number | null
  /** Read-only (archived conversation): view actions such as copy are kept; edit / delete / branch / save to memory are hidden */
  readOnly?: boolean
  colorText: string
  colorTextSecondary: string
  colorTextTertiary: string
  colorFillAlter: string
  colorBorderSecondary: string
  copiedId: string | null
  /** Pagination */
  hasMoreMessages: boolean
  isLoadingMoreMessages: boolean
  onCopy: (text: string, id: string) => Promise<void>
  onDelete: (msgIndex: number) => Promise<void>
  /**
   * Inline editing inside the bubble of an orphan question (no reply): enter edit mode / submit
   * with Enter (replace in place and resend) / cancel.
   * Only used for orphan questions.
   */
  onStartEditMessage: (msgIndex: number) => void
  onSubmitEditMessage: (msgIndex: number, content: string) => Promise<void>
  onCancelEditMessage: () => void
  /** Id of the question currently being edited inside its bubble */
  editingMessageId: string | null
  /** Branch: copy the messages up to this one into a new topic and switch to it (the hooks handle the list and the switch) */
  onBranch: (upToIndex: number) => Promise<void>
  onLoadMoreMessages: () => void
  messagesEndRef: React.RefObject<HTMLDivElement | null>
  /**
   * Pending-review changes (path → number of pending items).
   *
   * Marks on the **task segment header** "which files this segment changed and how many items are
   * still unreviewed": once a segment is folded, all of its edit cards are unmounted and the user
   * only sees a single task name (exactly the issue reported on 2026-09-23: "it clearly edited files
   * but I can't find the edit cards in the chat"). With this count, the changes stay visible and
   * expandable from the segment header.
   */
  pendingByPath?: Map<string, number>
  /** Clicking the change badge on a segment header: open the diff view for that file */
  onOpenChangedFile?: (path: string) => void
  /**
   * Id of the conversation row to locate after a conversation search hit (`harness_dialogue.id`).
   *
   * When "content hit" is clicked in the sidebar search, the conversation opens first and then
   * whether its messages are loaded is checked; MessageArea scrolls to that row and briefly
   * highlights it, then calls `onJumpToDialogueConsumed` so the parent clears the target.
   */
  jumpToDialogueId?: number | null
  /** Notify the parent to clear the pending target after locating it (or confirming it isn't in the current list) */
  onJumpToDialogueConsumed?: () => void
}

/** Closer to the bottom than this counts as "at the bottom" */
const STICK_THRESHOLD = 10
/** Smooth-scroll window after a button click (ms): scroll events during it count as programmatic, not a user interruption */
const PROGRAMMATIC_WINDOW = 600
/**
 * Mount window limit (in rows): beyond it only the most recent rows are mounted and older ones go
 * into the "hidden area".
 *
 * Background: continued scrolling up loads pagination page by page (20 rows each), and historical
 * replies often carry tens to hundreds of KB of body text and tool output; keeping all of that in
 * the DOM is one of the main sources of renderer OOM. A virtual list is not introduced here (too
 * many dependencies and too much regression surface); instead the number of messages resident in
 * the DOM is capped: older messages stay in memory and can be restored with the top notice bar when
 * needed, while scrolling feel and locator behavior stay exactly the same.
 */
const HISTORY_RENDER_CAP = 60
/**
 * On-screen message limit while streaming (far below the 60 of the history state).
 *
 * Why a separate, smaller limit is needed: **the cost of each commit is proportional to the number
 * of on-screen messages**, not to the single message that changed. A simulation with the real
 * components (test/sim-renderer-memory.mjs: node count and content unchanged, only streaming chunks
 * appended in batches, forcing GC after each batch and then measuring the heap) measured:
 *   mounting 60 rows → 1,112 KB net resident per batch | 24 rows → 445 KB | 12 rows → 272 KB (-76%)
 * Streaming runs at ~30 commits/s, so 60 rows on screen means ~33 MB/s of resident pressure (long
 * tasks are guaranteed to be OOM-killed).
 * So while streaming only the most recent 12 rows are mounted; when a round ends and the history
 * state returns they are not automatically restored (the top "show earlier" restores them in one
 * click), avoiding another full mount right at the end.
 *
 * Only tightened while the user is at the bottom watching the latest output; scrolling up to read
 * history leaves the window alone so content being read isn't pulled away.
 */
const STREAMING_RENDER_CAP = 12
/** Internal event for "record the viewport anchor before the body changes": see the scroll compensation below */
const VIEWPORT_SAVED_EVENT = 'harness-viewport-saved'

const HarnessMessageArea: React.FC<HarnessMessageAreaProps> = ({
  messages,
  isDarkMode,
  streaming,
  currentTopicId,
  readOnly = false,
  colorText,
  colorTextSecondary,
  colorTextTertiary,
  colorFillAlter,
  colorBorderSecondary,
  copiedId,
  hasMoreMessages,
  isLoadingMoreMessages,
  onCopy,
  onDelete,
  onStartEditMessage,
  onSubmitEditMessage,
  onCancelEditMessage,
  editingMessageId,
  onBranch,
  onLoadMoreMessages,
  messagesEndRef,
  pendingByPath,
  onOpenChangedFile,
  jumpToDialogueId,
  onJumpToDialogueConsumed
}) => {
  const { t } = useTranslation()
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const prevScrollHeightRef = useRef(0)
  const prevMessagesLengthRef = useRef(0)
  const prevFirstIdRef = useRef<string | null>(null)

  /**
   * Render window start (messages index): only messages.slice(renderFrom) is mounted.
   * See HISTORY_RENDER_CAP for the limit; the top notice bar restores hidden older messages.
   */
  const [renderFrom, setRenderFrom] = useState(0)

  // Keep "resident rows <= limit" as the message count grows: only push the window start forward,
  // and leave it alone when already expanded (renderFrom=0) or when the count is below the limit.
  // Functional updates keep this from fighting the high-frequency messages changes during streaming.
  // While streaming a smaller STREAMING_RENDER_CAP is used (each commit costs proportionally to the
  // number of on-screen messages), and it is only tightened when the user is at the bottom —
  // scrolling up to read history doesn't pull content away. stickToBottomRef is a ref and is read
  // only once when messages.length changes, which is sufficient.
  useEffect(() => {
    const cap = streaming && stickToBottomRef.current ? STREAMING_RENDER_CAP : HISTORY_RENDER_CAP
    const overflow = messages.length - cap
    if (overflow <= 0) return
    setRenderFrom((prev) => (prev < overflow ? overflow : prev))
  }, [messages.length, streaming])

  const visibleMessages = useMemo(
    () => (renderFrom > 0 ? messages.slice(renderFrom) : messages),
    [messages, renderFrom]
  )
  const hiddenCount = Math.min(renderFrom, messages.length)

  /**
   * Scroll anchor: a mutable object (not ref.current, whose assignment narrowing in TS would make
   * reads resolve to never). Fields are written in the VIEWPORT_SAVED_EVENT callback and read in the
   * layout effect.
   */
  const viewportAnchor = useRef<{ msgIndex: number; scrollTop: number; offset: number | null }>({
    msgIndex: -1,
    scrollTop: 0,
    offset: null
  })

  /**
   * Records "the message at the top of the viewport + the scrollTop at the time" before the body
   * updates. Registered once on window and dispatched by the layout effect below before each commit.
   * An event is used instead of a direct call so that "save" and "restore" strictly happen across
   * two different DOM states.
   */
  useEffect(() => {
    const onSave = (): void => {
      const el = scrollRef.current
      const inner = contentRef.current
      if (!el || !inner) {
        viewportAnchor.current = { msgIndex: -1, scrollTop: 0, offset: null }
        return
      }
      const innerTop = inner.getBoundingClientRect().top
      const probe = el.scrollTop + STICK_THRESHOLD + 1
      const nodes = inner.querySelectorAll<HTMLElement>('[data-msg-i]')
      let found = -1
      for (const node of nodes) {
        if (node.getBoundingClientRect().top - innerTop >= probe) {
          found = Number(node.getAttribute('data-msg-i'))
          break
        }
      }
      if (found < 0 && nodes.length > 0) {
        found = Number(nodes[nodes.length - 1].getAttribute('data-msg-i'))
      }
      if (found < 0) {
        viewportAnchor.current = { msgIndex: -1, scrollTop: 0, offset: null }
        return
      }
      const anchor = inner.querySelector<HTMLElement>(`[data-msg-i="${found}"]`)
      viewportAnchor.current = {
        msgIndex: found,
        scrollTop: el.scrollTop,
        offset: anchor ? anchor.getBoundingClientRect().top - innerTop : null
      }
    }
    window.addEventListener(VIEWPORT_SAVED_EVENT, onSave)
    return () => window.removeEventListener(VIEWPORT_SAVED_EVENT, onSave)
  }, [])

  // Moving the window start forward removes content above and shifts the body up by a chunk. Without
  // compensation a user scrolling up through history gets "dragged" downward (especially noticeable
  // when new messages arrive).
  // Compensation doesn't rely on estimating "how tall each row is"; it uses "the message at the top
  // of the viewport" as the anchor: before the body changes, record its offset from the content top
  // and the scrollTop at the time; after reflow, restore scrollTop from the anchor's new offset, so
  // the reader's gaze landing point stays the same (likewise when the top "show earlier" adds
  // content back).
  useLayoutEffect(() => {
    const el = scrollRef.current
    const inner = contentRef.current
    if (!el || !inner) return
    el.dispatchEvent(new CustomEvent(VIEWPORT_SAVED_EVENT))
    const saved = viewportAnchor.current
    if (saved.offset === null || saved.msgIndex < 0) return
    const node = inner.querySelector<HTMLElement>(`[data-msg-i="${saved.msgIndex}"]`)
    if (!node) return
    const innerTop = inner.getBoundingClientRect().top
    const next = Math.max(
      0,
      saved.scrollTop + (node.getBoundingClientRect().top - innerTop - saved.offset)
    )
    if (Math.abs(next - el.scrollTop) > 0.5) el.scrollTop = next
  })

  /** Stick-to-bottom switch: when true new content scrolls to the bottom automatically; turned off when the user scrolls up to read history, restored on returning to the bottom or clicking the button */
  const stickToBottomRef = useRef(true)
  /** Active smooth-scroll window for the button: scroll events during it don't count as a user interruption */
  const programmaticUntilRef = useRef(0)
  const [atBottom, setAtBottom] = useState(true)

  // After switching topics / starting a new conversation, return to the latest position by default
  useEffect(() => {
    stickToBottomRef.current = true
    setAtBottom(true)
    // Reset the prepend-detection baseline (messages are replaced wholesale after a topic switch,
    // so "first id changed" can't be used to detect a prepend)
    prevFirstIdRef.current = null
    // The render window must be reset too: the new topic's message list is a different one, and
    // keeping the old start would slice an empty window
    setRenderFrom(0)
    viewportAnchor.current = { msgIndex: -1, scrollTop: 0, offset: null }
  }, [currentTopicId])

  /**
   * Conversation search hit → scroll to the target dialogue row and briefly highlight it (data comes
   * from clicking "content hit" in the sidebar search).
   *
   * Locating flow: the sidebar calls `handleSelectTopic` to open the conversation, then writes
   * `pendingJumpDialogueId`; here the index is found in the full messages by `dialogueId` (dialogue
   * ids are globally unique, so an old topic can't be matched by mistake).
   * - Target row outside the render window → reset renderFrom to zero, then locate;
   * - Not in the list yet (conversation not fully loaded / the hit is in an earlier page) → wait for
   *   the next messages change, and clear the target if it still isn't found after 2.5s (to avoid
   *   repeated scrolling after a topic switch);
   * - Once in place, highlight for 1.8s and call back to the parent to clear the target.
   */
  useEffect(() => {
    if (jumpToDialogueId == null) return
    const index = messages.findIndex(
      (message) => Number(message.dialogueId ?? message.id) === jumpToDialogueId
    )
    if (index < 0) {
      const fallback = window.setTimeout(() => onJumpToDialogueConsumed?.(), 2500)
      return () => window.clearTimeout(fallback)
    }
    if (index < renderFrom) {
      setRenderFrom(0)
      return
    }
    const timer = window.setTimeout(() => {
      const el = scrollRef.current
      const inner = contentRef.current
      const node = inner?.querySelector<HTMLElement>(`[data-msg-i="${index}"]`)
      if (el && inner && node) {
        stickToBottomRef.current = false
        setAtBottom(false)
        programmaticUntilRef.current = Date.now() + PROGRAMMATIC_WINDOW
        const offset = node.getBoundingClientRect().top - inner.getBoundingClientRect().top
        el.scrollTo({ top: Math.max(0, offset - 16), behavior: 'smooth' })
        node.classList.add('harness-jump-highlight')
        window.setTimeout(() => node.classList.remove('harness-jump-highlight'), 1800)
      }
      onJumpToDialogueConsumed?.()
    }, 80)
    return () => window.clearTimeout(timer)
  }, [jumpToDialogueId, messages, renderFrom, onJumpToDialogueConsumed])

  // Keep the scroll position stable after loading more history
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const prevLen = prevMessagesLengthRef.current
    const newLen = messages.length
    const prevFirstId = prevFirstIdRef.current
    const firstId = messages[0]?.id ?? null
    // Only compensate the scroll position when "a new message appears at the head" (older history
    // prepended). Fix: previously any length growth was treated as a prepend — while the user
    // scrolled up reading history, goal auto-continuation appending messages to the tail of the
    // current topic (first id unchanged) also forced the reading position down
    if (newLen > prevLen && prevLen > 0 && prevFirstId !== null && firstId !== prevFirstId) {
      const newScrollHeight = el.scrollHeight
      const delta = newScrollHeight - prevScrollHeightRef.current
      el.scrollTop += delta
    }
    prevScrollHeightRef.current = el.scrollHeight
    prevMessagesLengthRef.current = messages.length
    prevFirstIdRef.current = firstId
  }, [messages])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const nearBottom = distFromBottom <= STICK_THRESHOLD
    setAtBottom(nearBottom)
    if (nearBottom) {
      // The user scrolled back to the bottom: restore stick-to-bottom following
      stickToBottomRef.current = true
    } else if (Date.now() >= programmaticUntilRef.current) {
      // The user deliberately scrolled up to read: interrupt continuous scrolling to the bottom
      stickToBottomRef.current = false
    }
    if (!isLoadingMoreMessages && hasMoreMessages && el.scrollTop <= 40) {
      onLoadMoreMessages()
    }
  }, [isLoadingMoreMessages, hasMoreMessages, onLoadMoreMessages])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
  }, [handleScroll])

  // New messages / streaming chunks: follow to the bottom when sticking (no disturbance when the user scrolled up, stick=false)
  useEffect(() => {
    if (!stickToBottomRef.current) return
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages, renderFrom])

  /* The user sent a question: return to the latest message unconditionally.
   *  Sending means they want to keep reading downward, so it must not stay in place just because
   *  they had scrolled up through history before.
   *  handleSend dispatches harness-send-started before appending the message; this sticks to the
   *  bottom immediately, and the subsequent messages change pins it again with the restored stick
   *  switch (covering the frame where the message isn't rendered yet).
   *  A programmatic scroll window is opened at the same time: the scroll event from this jump
   *  doesn't count as "the user scrolled up and interrupted"; otherwise, right after a message is
   *  appended and the content grows taller, it would be misjudged as leaving the bottom and the
   *  stick would be turned off. */
  useEffect(() => {
    const handleSendStarted = (): void => {
      stickToBottomRef.current = true
      setAtBottom(true)
      programmaticUntilRef.current = Date.now() + PROGRAMMATIC_WINDOW
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    }
    window.addEventListener('harness-send-started', handleSendStarted)
    return () => window.removeEventListener('harness-send-started', handleSendStarted)
  }, [])

  // Content grows asynchronously (image / mermaid rendering, etc.): stay pinned to the bottom while sticking
  useEffect(() => {
    const el = scrollRef.current
    const inner = contentRef.current
    if (!el || !inner) return
    const ro = new ResizeObserver(() => {
      if (stickToBottomRef.current) {
        el.scrollTop = el.scrollHeight
      }
    })
    ro.observe(inner)
    return () => ro.disconnect()
  }, [])

  /** Start of the turn each message belongs to (timestamp of the most recent user message): the action bar uses it to compute "elapsed time" */
  const turnStartByIndex = useMemo(() => {
    const out: number[] = []
    let lastUserAt = 0
    messages.forEach((message, i) => {
      if (message.role === 'user') lastUserAt = message.timestamp
      out[i] = lastUserAt || message.timestamp
    })
    return out
  }, [messages])

  /**
   * Orphan questions: user messages with no corresponding reply (the next message isn't an assistant
   * message, or it is the last one).
   *
   * Typical causes: the stream failed/was aborted while sending, retries were abandoned after a
   * model error, or a database incident left only the question. Such bubbles previously had no
   * actionable entry point at all — marking them by id adds "edit and resend / delete".
   * Ids are used instead of indices: the render window slices the list, so indices are only valid
   * for this particular message.
   */
  const orphanUserIds = useMemo(() => {
    const ids = new Set<string>()
    messages.forEach((message, i) => {
      if (message.role !== 'user') return
      const next = messages[i + 1]
      if (!next || next.role !== 'assistant') ids.add(message.id)
    })
    return ids
  }, [messages])

  /**
   * Goal continuation batches: merge "assistant replies of the same batch" into one row and switch
   * between rounds with the left/right controls.
   *
   * Background (user, 2026-09-19): "I want to merge the AI reply rounds within the same batch and
   * switch between them with left/right clicks, which also reduces rendering."
   *
   * Data shape: the goal round driver (goal-driver in the main process) emits a `goalRound` marker
   * chunk at the start of each round, and the renderer mounts it as a user message
   * (blocks=[{type:'goalRound',round,objective}]), so the same batch appears in the list as
   * alternating [assistant][banner][assistant][banner]…. With many rounds, bubbles and mounted
   * blocks grow linearly.
   *
   * Merging only recognizes **structured goalRound blocks**: user input plays no part in the
   * decision, and ordinary messages always stay ordinary bubbles.
   *  - A run of consecutive "assistant + banner + assistant + banner + assistant" is one batch,
   *    **including the leading assistant** (it is the first round of the batch's work and all
   *    auto-continuation builds on it);
   *  - A batch renders as one row: a banner (showing round N/M + objective + left/right switching)
   *    plus **the assistant message of the currently selected round**;
   *  - The other rounds are not mounted — this is where "reduces rendering" comes from;
   *  - The last round (newest) is selected by default; after the user manually pages back it is no
   *    longer taken over by new rounds, and paging back to the last round restores following.
   */
  const goalRoundBlockOf = (m: Message | undefined): Message['blocks'][number] | undefined =>
    m?.role === 'user' ? m.blocks.find((b) => b.type === 'goalRound') : undefined

  type RenderRow =
    | { kind: 'single'; index: number }
    | {
        kind: 'batch'
        key: string
        rounds: { index: number; objective: string }[]
      }

  const renderRows = useMemo<RenderRow[]>(() => {
    const rows: RenderRow[] = []
    const total = visibleMessages.length
    const isBanner = (m: Message | undefined): boolean => Boolean(goalRoundBlockOf(m))
    /** The objective text is read only from the structured block, never parsed out of the message body */
    const objectiveOf = (m: Message | undefined): string => goalRoundBlockOf(m)?.objective ?? ''

    for (let i = 0; i < total; i += 1) {
      const message = visibleMessages[i]
      const last = rows[rows.length - 1]

      // Banner → assistant = one round, appended to the previous batch
      if (isBanner(message)) {
        const assistant = visibleMessages[i + 1]
        if (last && last.kind === 'batch' && assistant?.role === 'assistant') {
          last.rounds.push({ index: i + 1, objective: objectiveOf(message) })
          i += 1
          continue
        }
        rows.push({ kind: 'single', index: i })
        continue
      }

      // Assistant followed by a banner → start a new batch (this assistant is the batch's first round)
      if (message.role === 'assistant' && isBanner(visibleMessages[i + 1])) {
        rows.push({
          kind: 'batch',
          key: message.id,
          rounds: [{ index: i, objective: objectiveOf(visibleMessages[i + 1]) }]
        })
        continue
      }
      rows.push({ kind: 'single', index: i })
    }
    return rows
  }, [visibleMessages])

  /**
   * Manually selected rounds (batch key → round index). **Only choices that deviate from the newest
   * are recorded**: paging to the last round deletes the entry so new rounds keep being followed;
   * after paging back it stays put and streaming output doesn't steal the view.
   */
  const [pinnedRound, setPinnedRound] = useState<Record<string, number>>({})
  const gotoRound = useCallback((key: string, target: number, last: number) => {
    setPinnedRound((prev) => {
      const next = { ...prev }
      if (target >= last) delete next[key]
      else next[key] = target
      return next
    })
  }, [])

  /** Real conversation usage (harness_dialogue_usage): filled into each assistant message by dialogue_id instead of estimates */
  const [usageByDialogue, setUsageByDialogue] = useState<Record<string, HarnessDialogueUsageRow>>(
    {}
  )
  useEffect(() => {
    const api = harnessApi
    if (currentTopicId === null || streaming) return
    let cancelled = false
    void (async () => {
      try {
        const rows = await api.harness.getUsageByTopic(currentTopicId)
        if (cancelled) return
        setUsageByDialogue(
          Object.fromEntries(rows.map((row) => [String(row.dialogue_id), row])) as Record<
            string,
            HarnessDialogueUsageRow
          >
        )
      } catch (error) {
        console.error('Failed to load dialogue usage:', error)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [currentTopicId, streaming, messages.length])

  const handleScrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    stickToBottomRef.current = true
    setAtBottom(true)
    programmaticUntilRef.current = Date.now() + PROGRAMMATIC_WINDOW
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [])

  /** Locator click: smooth-scroll to that message; jumping to the last one restores stick-to-bottom following */
  const handleJumpToMessage = useCallback(
    (index: number) => {
      const el = scrollRef.current
      const inner = contentRef.current
      if (!el || !inner) return
      const node = inner.querySelector<HTMLElement>(`[data-msg-i="${index}"]`)
      if (!node) return
      const offset = node.getBoundingClientRect().top - inner.getBoundingClientRect().top
      const isLast = index === messages.length - 1
      stickToBottomRef.current = isLast
      setAtBottom(isLast)
      programmaticUntilRef.current = Date.now() + PROGRAMMATIC_WINDOW
      el.scrollTo({ top: Math.max(0, offset - 12), behavior: 'smooth' })
    },
    [messages.length]
  )

  // While streaming the button is always shown (the glow is the "generating" indicator); otherwise it only appears when away from the bottom
  const showScrollButton = messages.length > 0 && (!atBottom || streaming)

  return (
    // harness-message-list: style scope for the chat area (rules such as fold header alignment live in the style block in Index.tsx)
    <div className="harness-message-list relative flex-1 min-h-0 flex flex-col">
      <div
        ref={scrollRef}
        // The bottom pb-14 (56px) reserves room for the floating "back to bottom" button: button
        // 30px + 20px from the bottom + 4px outer glow arc = 54px, so 56px just fits; that is 24px
        // less than the former pb-20, so the button neither covers the last message nor leaves a
        // large empty gap.
        // endRef is moved outside the content container so the last row can hit :last-child and lose
        // its trailing spacing.
        className="flex-1 overflow-y-scroll my-1 mr-1 ml-3 px-8 pt-5 pb-14 harness-scrollbar"
      >
        <div ref={contentRef} className={messages.length === 0 ? 'h-full' : 'max-w-4xl mx-auto'}>
          {messages.length === 0 ? (
            <WelcomeIntro colorText={colorText} colorTextSecondary={colorTextSecondary} />
          ) : (
            <>
              {isLoadingMoreMessages && (
                /* Older messages are above, so a bubble outline placeholder is used; a centered spinner would look like "sending a message" */
                <div className="py-2">
                  <SkeletonMessages rows={2} />
                </div>
              )}
              {hiddenCount > 0 && (
                /* Entry point for restoring the hidden area: this only affects mounting; the messages themselves are still in memory (see HISTORY_RENDER_CAP) */
                <div className="flex items-center gap-3 pb-3">
                  <span
                    className="flex-1"
                    style={{ height: 1, background: colorBorderSecondary }}
                    aria-hidden="true"
                  />
                  <button
                    type="button"
                    onClick={() => setRenderFrom(0)}
                    style={{
                      background: 'none',
                      border: 'none',
                      padding: '2px 4px',
                      color: colorTextTertiary,
                      fontSize: 12,
                      cursor: 'pointer'
                    }}
                  >
                    {t('harness.messageArea.showEarlier', { count: hiddenCount })}
                  </button>
                  <span
                    className="flex-1"
                    style={{ height: 1, background: colorBorderSecondary }}
                    aria-hidden="true"
                  />
                </div>
              )}
              {renderRows.map((row) => {
                /* idx is a **global** index: the locator, delete and branch all locate by the full
                   messages array; window slicing only changes the mount range, not index semantics */
                if (row.kind === 'batch') {
                  const last = row.rounds.length - 1
                  const active = Math.min(pinnedRound[row.key] ?? last, last)
                  const round = row.rounds[active]
                  const idx = renderFrom + round.index
                  return (
                    /* A batch occupies one row: banner (with left/right switching) + the current round's assistant message; other rounds are not mounted */
                    <div
                      key={row.key}
                      data-msg-i={idx}
                      data-goal-batch={row.rounds.length}
                      className="harness-message-row"
                    >
                      <GoalRoundBanner
                        current={active + 1}
                        total={row.rounds.length}
                        objective={round.objective}
                        colorTextSecondary={colorTextSecondary}
                        colorBorderSecondary={colorBorderSecondary}
                        onPrev={() => gotoRound(row.key, active - 1, last)}
                        onNext={() => gotoRound(row.key, active + 1, last)}
                      />
                      <AssistantMessage
                        message={visibleMessages[round.index]}
                        index={idx}
                        readOnly={readOnly}
                        isDarkMode={isDarkMode}
                        copiedId={copiedId}
                        colorText={colorText}
                        colorTextSecondary={colorTextSecondary}
                        colorTextTertiary={colorTextTertiary}
                        colorFillAlter={colorFillAlter}
                        colorBorderSecondary={colorBorderSecondary}
                        topicId={currentTopicId}
                        turnStartedAt={turnStartByIndex[idx]}
                        usage={
                          usageByDialogue[
                            String(
                              visibleMessages[round.index].dialogueId ??
                                visibleMessages[round.index].id
                            )
                          ]
                        }
                        onBranch={onBranch}
                        onCopy={onCopy}
                        onDelete={onDelete}
                        pendingByPath={pendingByPath}
                        onOpenChangedFile={onOpenChangedFile}
                      />
                    </div>
                  )
                }
                const i = row.index
                const message = visibleMessages[i]
                const idx = renderFrom + i
                return (
                  /* data-msg-i: the locator measures each message's position in the body by this index */
                  <div key={message.id} data-msg-i={idx} className="harness-message-row">
                    {message.role === 'user' ? (
                      <UserMessage
                        message={message}
                        isDarkMode={isDarkMode}
                        colorText={colorText}
                        colorTextSecondary={colorTextSecondary}
                        colorBorderSecondary={colorBorderSecondary}
                        orphan={orphanUserIds.has(message.id)}
                        editing={editingMessageId === message.id}
                        readOnly={readOnly}
                        onEdit={() => onStartEditMessage(idx)}
                        onEditSubmit={(content) => void onSubmitEditMessage(idx, content)}
                        onEditCancel={onCancelEditMessage}
                        onDelete={() => void onDelete(idx)}
                      />
                    ) : (
                      <AssistantMessage
                        message={message}
                        index={idx}
                        readOnly={readOnly}
                        isDarkMode={isDarkMode}
                        copiedId={copiedId}
                        colorText={colorText}
                        colorTextSecondary={colorTextSecondary}
                        colorTextTertiary={colorTextTertiary}
                        colorFillAlter={colorFillAlter}
                        colorBorderSecondary={colorBorderSecondary}
                        topicId={currentTopicId}
                        turnStartedAt={turnStartByIndex[idx]}
                        usage={usageByDialogue[String(message.dialogueId ?? message.id)]}
                        onBranch={onBranch}
                        onCopy={onCopy}
                        onDelete={onDelete}
                        pendingByPath={pendingByPath}
                        onOpenChangedFile={onOpenChangedFile}
                      />
                    )}
                  </div>
                )
              })}
            </>
          )}
        </div>
        {/* The scroll anchor sits outside the content container: if it stayed inside it would always
            be the last child, .harness-message-row:last-child would never match, and the last row
            would keep its 14px trailing gap */}
        <div ref={messagesEndRef} />
      </div>
      <MessageLocator
        messages={messages}
        scrollRef={scrollRef}
        contentRef={contentRef}
        onJumpTo={handleJumpToMessage}
      />
      <ScrollToBottomButton
        visible={showScrollButton}
        streaming={streaming}
        isDarkMode={isDarkMode}
        onClick={handleScrollToBottom}
      />
    </div>
  )
}

export default HarnessMessageArea
