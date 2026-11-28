import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { theme, Tooltip, App } from 'antd'
import {
  RiFileCopyLine,
  RiCheckLine,
  RiThumbUpLine,
  RiThumbDownLine,
  RiBrainLine,
  RiGitBranchLine,
  RiTimerLine,
  RiDatabase2Line,
  RiDeleteBin6Line
} from '@remixicon/react'
import dayjs from 'dayjs'
import { useMessage } from '@renderer/hooks/useMessage'
import { useTranslation } from '@renderer/i18n'

import UsagePanel from './UsagePanel'
import { buildUsageDetails } from '../../../utils/harness/usage'
import type { HarnessDialogueUsageRow } from '../../../../../shared/harness/types'
import type { Message } from '../../../types/harness/types'
import { harnessApi } from '../../../api/harness'

type Feedback = 'up' | 'down' | null

interface MessageActionsProps {
  message: Message
  /** Index of the message in the list (for deleting this turn / branching truncation) */
  index: number
  /** Timestamp of this turn's question: subtracted from the answer timestamp to get the elapsed time */
  turnStartedAt?: number
  /** Current topic (feedback is stored in a local index) */
  topicId: number | null
  /** Read-only (archived conversation): keep only copy and read-only metadata; hide feedback / save to memory / branch / delete */
  readOnly?: boolean
  /** Real usage of this reply (harness_dialogue_usage row); undefined when nothing was returned, in which case usage is not shown */
  usage?: HarnessDialogueUsageRow
  /** Branch: handled by the hook (only it knows the topic list and the switch flow) */
  onBranch: (upToIndex: number) => Promise<void>
  /** Copy text is generated lazily: joining every block's body on each streaming batch is too expensive, so compute it only on copy */
  getCopyText: () => string
  isCopied: boolean
  onCopy: (text: string, id: string) => void
  onDelete: (index: number) => void
}

/** Prefix for the local feedback index key (there is no feedback column yet, so store locally by topic + timestamp) */
const FEEDBACK_KEY = 'rytenbench:message-feedback:'

function readFeedback(key: string): Feedback {
  try {
    const raw = localStorage.getItem(FEEDBACK_KEY + key)
    return raw === 'up' || raw === 'down' ? raw : null
  } catch {
    return null
  }
}

/* ──────────── Adaptive positioning of the "this turn's usage" panel ──────────── */

/** Default panel width (used when it fits) and the gap from the clip container edge */
const USAGE_PANEL_W = 300
const USAGE_EDGE_GAP = 12

/** The four edges of the clip container (viewport coordinates) */
interface Bounds {
  left: number
  right: number
  top: number
  bottom: number
}

/**
 * Available area for the usage panel (viewport coordinates).
 *
 * The panel is absolutely positioned relative to the usage badge (see the hover block below). As
 * soon as it pokes past the edge of the **clip container**, the message area gets horizontal
 * scrollbars — the scroll container is `overflow-y-scroll`, and per spec the other axis's visible
 * is computed as auto, so a narrow window brings out a horizontal scrollbar (reported by the user
 * on 2026-09-24), while vertically the panel is clipped in half.
 *
 * So walk up to the nearest clipping ancestor and use its **content box** as the bounds:
 * `clientLeft / clientWidth / clientHeight` already exclude borders and scrollbars, so there is no
 * need to guess the scrollbar width. If none is found (unexpected path), fall back to the window.
 */
const clipBounds = (el: HTMLElement): Bounds => {
  for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
    const style = window.getComputedStyle(node)
    if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
      const rect = node.getBoundingClientRect()
      return {
        left: rect.left + node.clientLeft,
        right: rect.left + node.clientLeft + node.clientWidth,
        top: rect.top + node.clientTop,
        bottom: rect.top + node.clientTop + node.clientHeight
      }
    }
  }
  return {
    left: 0,
    right: document.documentElement.clientWidth,
    top: 0,
    bottom: document.documentElement.clientHeight
  }
}

/**
 * Assistant message action bar: copy / feedback / save to memory / branch to a new conversation /
 * usage / elapsed time / timestamp.
 *
 * - Copy reuses the parent's existing implementation (the same "copied" state);
 * - Feedback is kept in localStorage (located by topicId + message timestamp, so it survives a
 *   reload); persisting it needs a feedback column on harness_dialogue;
 * - Save to memory = start a background "memory organization" subagent that reads this turn's Q&A,
 *   decides what is worth remembering and writes it to Mnemon (progress is visible in the
 *   background-agent entry in the top bar); the renderer never writes hot memory directly;
 * - Branch = create a new topic in the same workspace and copy the messages before this one into it;
 * - Usage shows the tokens actually returned by the model (harness_dialogue_usage); when nothing is
 *   returned it is not shown, and nothing is estimated.
 */
const MessageActions: React.FC<MessageActionsProps> = ({
  message,
  index,
  turnStartedAt,
  topicId,
  readOnly = false,
  usage,
  onBranch,
  getCopyText,
  isCopied,
  onCopy,
  onDelete
}) => {
  const { token } = theme.useToken()
  const api = harnessApi
  const { viewMessage } = useMessage()
  const { modal } = App.useApp()
  const { t } = useTranslation()

  const feedbackKey = `${topicId ?? 0}:${message.timestamp}`
  const [feedback, setFeedback] = useState<Feedback>(() => readFeedback(feedbackKey))
  const [savingMemory, setSavingMemory] = useState(false)
  const [branching, setBranching] = useState(false)
  const [usageOpen, setUsageOpen] = useState(false)
  /** Measured layout of the usage panel: width narrowed to the available space, horizontal offset + vertical flip keep it inside the clip container */
  const [usageLayout, setUsageLayout] = useState({ width: USAGE_PANEL_W, offset: 0, above: true })
  const usageAnchorRef = useRef<HTMLSpanElement>(null)
  const usagePanelRef = useRef<HTMLSpanElement>(null)

  /**
   * Measure the usage panel layout once:
   * - width = min(default width, available width);
   * - horizontally, the left edge aligns with the badge by default; if it does not fit on the
   *   right, shift left until it hits a boundary;
   * - vertically, attach above by default (requested by the user on 2026-09-19); only flip below
   *   when there is not enough room above.
   * The goal is for the whole panel to stay inside the clip container: it must neither push the
   * message area into scrollbars nor be clipped in half.
   */
  const measureUsagePanel = useCallback((): void => {
    const anchorEl = usageAnchorRef.current
    if (!anchorEl) return
    const anchor = anchorEl.getBoundingClientRect()
    const { left, right, top, bottom } = clipBounds(anchorEl)
    const width = Math.min(USAGE_PANEL_W, Math.max(0, right - left - USAGE_EDGE_GAP * 2))
    const preferred = Math.min(anchor.left, right - USAGE_EDGE_GAP - width)
    const offset = Math.max(left + USAGE_EDGE_GAP, preferred) - anchor.left
    /**
     * Vertical flip: the height cannot be measured before the panel is mounted (0), so stay
     * "above" in that case — the layout effect after mounting runs again with the real height.
     * When the room on both sides is smaller than the panel, pick the side with more room (it will
     * be clipped anyway, at least clip less).
     */
    const height = usagePanelRef.current?.offsetHeight ?? 0
    const roomAbove = anchor.top - top - USAGE_EDGE_GAP
    const roomBelow = bottom - anchor.bottom - USAGE_EDGE_GAP
    const above = height <= roomAbove || roomBelow <= roomAbove
    setUsageLayout((prev) =>
      prev.width === width && prev.offset === offset && prev.above === above
        ? prev
        : { width, offset, above }
    )
  }, [])

  /**
   * Measure once after the panel mounts (layout phase, before paint): flips/narrowing happen before
   * the first frame, so nothing flickers. Depends on width because narrowing changes line-wrapping
   * and therefore height — after a width change the side must be re-decided from the new height.
   */
  useLayoutEffect(() => {
    if (usageOpen) measureUsagePanel()
  }, [usageOpen, usageLayout.width, measureUsagePanel])

  /* While the panel is open, a window resize (dragging the window) → measure again so it does not poke outside again */
  useEffect(() => {
    if (!usageOpen) return
    const onResize = (): void => measureUsagePanel()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [usageOpen, measureUsagePanel])

  useEffect(() => {
    setFeedback(readFeedback(feedbackKey))
  }, [feedbackKey])

  const handleFeedback = useCallback(
    (next: Exclude<Feedback, null>) => {
      const value: Feedback = feedback === next ? null : next
      setFeedback(value)
      try {
        if (value) localStorage.setItem(FEEDBACK_KEY + feedbackKey, value)
        else localStorage.removeItem(FEEDBACK_KEY + feedbackKey)
      } catch {
        /* Keep the in-memory state only when local storage is unavailable */
      }
      viewMessage(
        'msg-feedback',
        'success',
        value === 'up'
          ? t('harness.messageActions.feedbackUpRecorded')
          : value === 'down'
            ? t('harness.messageActions.feedbackDownRecorded')
            : t('harness.messageActions.feedbackCanceled'),
        1.5
      )
    },
    [feedback, feedbackKey, viewMessage, t]
  )

  /**
   * Save to memory = hand it to the background "memory organization" subagent.
   *
   * The renderer no longer truncates the body and writes hot memory directly: a single reply is
   * often thousands of characters, and stuffing it in would fill hot memory and record one-off
   * progress as a long-term fact. Instead the subagent reads this turn's Q&A, decides which facts
   * are reusable and which layer they belong to (hot memory / project docs / long-term memory
   * space), and writes them; progress is visible in the background-agent entry in the top bar.
   */
  const handleSaveToMemory = useCallback(async (): Promise<void> => {
    const text = (message.content ?? '').trim()
    if (!text) {
      viewMessage('msg-memory', 'warning', t('harness.messageActions.saveToMemoryEmpty'), 2)
      return
    }
    if (topicId == null) {
      viewMessage('msg-memory', 'warning', t('harness.messageActions.saveToMemoryNoTopic'), 2)
      return
    }
    setSavingMemory(true)
    try {
      const result = await api.harness.startMemoryAgent({
        topicId,
        answer: text,
        dialogueId: message.dialogueId,
        // The provider this reply itself used (usage row snapshot): make organization follow the
        // same model; without a usage row the main process falls back to the default provider
        providerId: usage?.provider_id ?? undefined
      })
      if (result.ok) {
        viewMessage('msg-memory', 'success', t('harness.messageActions.saveToMemoryStarted'), 3)
      } else if (result.reason === 'memory-disabled') {
        viewMessage('msg-memory', 'warning', t('harness.messageActions.saveToMemoryDisabled'), 3)
      } else if (result.reason === 'no-model') {
        viewMessage('msg-memory', 'warning', t('harness.messageActions.saveToMemoryNoModel'), 3)
      } else {
        viewMessage('msg-memory', 'error', t('harness.messageActions.saveToMemoryFailed'), 2)
      }
    } catch (error) {
      console.error('Failed to hand the answer to the memory agent:', error)
      viewMessage('msg-memory', 'error', t('harness.messageActions.saveToMemoryFailed'), 2)
    } finally {
      setSavingMemory(false)
    }
  }, [api, message.content, message.dialogueId, topicId, usage, viewMessage, t])

  /** Branch: creating the topic, copying messages, refreshing the list and switching views all live in the hook; this only handles the button state */
  const handleBranch = useCallback(async (): Promise<void> => {
    setBranching(true)
    try {
      await onBranch(index)
    } catch (error) {
      console.error('Failed to branch conversation:', error)
    } finally {
      setBranching(false)
    }
  }, [index, onBranch])

  /* Elapsed time: this turn's question time → answer end time (while streaming, the last chunk; for persisted messages, their own timestamp) */
  const elapsedMs = ((): number => {
    if (message.loading) return 0
    const started = turnStartedAt ?? message.timestamp
    const ended = message.lastChunkAt ?? message.timestamp
    return Math.max(0, ended - started)
  })()

  /** Elapsed text: one decimal below the minute level, "xm ys" at the minute level */
  const elapsedText = ((): string => {
    if (elapsedMs <= 0) return ''
    if (elapsedMs < 60_000) {
      return t('harness.messageActions.elapsedSeconds', {
        seconds: (elapsedMs / 1000).toFixed(1)
      })
    }
    const minutes = Math.floor(elapsedMs / 60_000)
    const seconds = Math.round((elapsedMs % 60_000) / 1000)
    return t('harness.messageActions.elapsedMinutes', { minutes, seconds })
  })()

  /** Usage: show only tokens actually returned by the model (nothing when nothing is returned, never estimate) */
  const formatTokens = (value: number): string =>
    value >= 10_000
      ? `${Math.round(value / 1000)}k`
      : value >= 1000
        ? `${(value / 1000).toFixed(1)}k`
        : String(value)
  const usageText =
    usage?.total_tokens != null
      ? t('harness.usagePanel.tokensValue', { value: formatTokens(usage.total_tokens) })
      : ''
  /** "This turn's usage" panel shown when hovering the usage badge (cache hits/reasoning details live in usage_metadata) */
  const usageDetails = useMemo(() => buildUsageDetails(usage), [usage])

  /**
   * The tooltips for this row of buttons all go **below** (user 2026-09-19: "the tooltip content
   * for these buttons needs to be at the bottom, like the 'branch in new conversation' tooltip
   * component" — that one happened to land below because antd auto-flips). The reason is also
   * noted: the action bar sits right below the body, so a tooltip above would cover the text the
   * user is reading; a fixed bottom placement behaves consistently instead of flipping around.
   *
   * Two follow-ups (same day): **no arrow** (arrow: false) + **close to the content**
   * (align.offset down to 4px). antd's default spacing is `halfArrowWidth + marginXXS(8)` (about
   * 12px with the arrow); with the arrow off arrowWidth=0, so offset has to be given explicitly to
   * get 4px.
   */
  const tooltipCommon = {
    placement: 'bottom' as const,
    arrow: false,
    align: { offset: [0, 4] }
  }

  const iconButton = (
    icon: React.ReactNode,
    title: string,
    onClick: () => void,
    options?: { active?: boolean; danger?: boolean; disabled?: boolean }
  ): React.ReactNode => (
    <Tooltip title={title} {...tooltipCommon}>
      <button
        type="button"
        aria-label={title}
        aria-pressed={options?.active}
        disabled={options?.disabled}
        onClick={onClick}
        className="p-1.5 rounded-lg transition-colors"
        style={{
          color: options?.active
            ? token.colorPrimary
            : options?.danger
              ? token.colorTextTertiary
              : token.colorTextTertiary,
          background: options?.active ? token.colorPrimaryBg : 'transparent',
          opacity: options?.disabled ? 0.5 : 1,
          cursor: options?.disabled ? 'default' : 'pointer'
        }}
        onMouseEnter={(e) => {
          if (options?.disabled) return
          e.currentTarget.style.background = options?.active
            ? token.colorPrimaryBg
            : token.colorFillTertiary
          e.currentTarget.style.color = options?.danger
            ? token.colorError
            : options?.active
              ? token.colorPrimary
              : token.colorTextSecondary
        }}
        onMouseLeave={(e) => {
          if (options?.disabled) return
          e.currentTarget.style.background = options?.active ? token.colorPrimaryBg : 'transparent'
          e.currentTarget.style.color = options?.danger
            ? token.colorTextTertiary
            : token.colorTextTertiary
        }}
      >
        {icon}
      </button>
    </Tooltip>
  )

  /**
   * Badge: icon + text.
   *
   * Read-only metadata (time / elapsed / usage) has no clickable action of its own, so the tooltip
   * is optional: only when a title is passed is a tooltip line rendered. The usage badge does not
   * get one — its hover already pops up the "this turn's usage" detail panel, and stacking a black
   * tooltip box on top is just repetition (user 2026-09-24: "remove the 'this turn's usage' thing",
   * which referred exactly to that antd tooltip).
   */
  const chip = (icon: React.ReactNode, text: string, title?: string): React.ReactNode => {
    const pill = (
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          height: 22,
          padding: '0 8px',
          borderRadius: 11,
          background: token.colorFillTertiary,
          color: token.colorTextTertiary,
          fontSize: 11,
          whiteSpace: 'nowrap'
        }}
      >
        {icon}
        {text}
      </span>
    )
    return title ? (
      <Tooltip title={title} {...tooltipCommon}>
        {pill}
      </Tooltip>
    ) : (
      pill
    )
  }

  return (
    <div className="flex items-center gap-1 mt-2 flex-wrap">
      {iconButton(
        isCopied ? <RiCheckLine size={16} /> : <RiFileCopyLine size={16} />,
        isCopied ? t('harness.messageActions.copied') : t('harness.messageActions.copy'),
        () => onCopy(getCopyText(), message.id)
      )}
      {!readOnly && (
        <>
          {iconButton(
            <RiThumbUpLine size={16} />,
            feedback === 'up'
              ? t('harness.messageActions.feedbackUpMarked')
              : t('harness.messageActions.feedbackUp'),
            () => handleFeedback('up'),
            { active: feedback === 'up' }
          )}
          {iconButton(
            <RiThumbDownLine size={16} />,
            feedback === 'down'
              ? t('harness.messageActions.feedbackDownMarked')
              : t('harness.messageActions.feedbackDown'),
            () => handleFeedback('down'),
            { active: feedback === 'down' }
          )}
          {iconButton(
            <RiBrainLine size={16} />,
            savingMemory
              ? t('harness.messageActions.savingToMemory')
              : t('harness.messageActions.saveToMemory'),
            () => {
              void handleSaveToMemory()
            },
            { disabled: savingMemory }
          )}
          {iconButton(
            <RiGitBranchLine size={16} />,
            branching ? t('harness.messageActions.branching') : t('harness.messageActions.branch'),
            () => {
              void handleBranch()
            },
            { disabled: branching }
          )}
          {iconButton(
            <RiDeleteBin6Line size={16} />,
            t('harness.messageActions.deleteTurn'),
            () =>
              modal.confirm({
                title: t('harness.messageActions.deleteConfirmTitle'),
                content: t('harness.messageActions.deleteConfirmContent'),
                okText: t('common.action.delete'),
                cancelText: t('common.action.cancel'),
                okButtonProps: { danger: true },
                onOk: () => onDelete(index)
              }),
            { danger: true }
          )}
        </>
      )}

      {/* Divider: interactive actions on the left, read-only metadata on the right */}
      <span
        style={{
          width: 1,
          height: 14,
          margin: '0 4px',
          background: token.colorBorderSecondary,
          flexShrink: 0
        }}
      />

      {usageText && usageDetails && (
        /* Hovering shows the "this turn's usage" panel: title (label on the left / total on the right) + hairline + dt/dd details */
        <span
          ref={usageAnchorRef}
          style={{ position: 'relative', display: 'inline-flex' }}
          onMouseEnter={() => setUsageOpen(true)}
          onMouseLeave={() => setUsageOpen(false)}
        >
          {/* The usage badge has no antd tooltip: hovering shows the "this turn's usage" detail panel directly (see below); a tooltip box would be redundant */}
          {chip(<RiDatabase2Line size={12} />, usageText)}
          {usageOpen && (
            <span
              ref={usagePanelRef}
              style={{
                position: 'absolute',
                // The usage panel is attached **above** by default (user 2026-09-19: "this tooltip
                // content doesn't need to be below"): it has 7 detail rows, so attaching it below
                // would cover the next message; when there is not enough room above, flip it below
                // based on the measured result.
                ...(usageLayout.above
                  ? { bottom: 'calc(100% + 4px)' }
                  : { top: 'calc(100% + 4px)' }),
                // Left edge aligns with the badge by default; if it does not fit on the right, shift left by the measured offset (width narrows accordingly, see measureUsagePanel)
                left: usageLayout.offset,
                zIndex: 30,
                display: 'block'
              }}
            >
              <UsagePanel details={usageDetails} width={usageLayout.width} />
            </span>
          )}
        </span>
      )}
      {elapsedText &&
        chip(
          <RiTimerLine size={12} />,
          t('harness.messageActions.elapsed', { elapsed: elapsedText }),
          t('harness.messageActions.elapsedTooltip')
        )}

      <span style={{ flex: 1 }} />

      <span style={{ fontSize: 11, color: token.colorTextQuaternary }}>
        {dayjs(message.timestamp).format('HH:mm')}
      </span>
    </div>
  )
}

export default MessageActions
