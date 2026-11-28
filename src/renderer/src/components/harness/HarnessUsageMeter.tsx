import React, { useEffect, useRef, useState } from 'react'
import { theme } from 'antd'
import { useTranslation } from '@renderer/i18n'
import { harnessApi } from '../../api/harness'
import type { TurnUsageView } from '../../../../shared/harness/types'
import {
  buildUsageSummary,
  formatCompactTokens,
  type UsageSummary
} from '../../utils/harness/usage'

/**
 * Usage status bar on the right of the input box footer, with two shapes:
 *
 * - **Generating**: `3 calls this turn · 12.4k tok` — the main process pushes one
 *   `harness-turn-usage` each time a model round trip ends (accumulated for the turn), shown
 *   directly here; numbers only grow, no interpolation.
 * - **Idle**: `2.5M tok · 98% cache hit  ◯ 8%` — cumulative tokens → cache hit rate → context
 *   usage ring.
 *
 * Idle values all come from `harness_dialogue_usage` (tokens really reported by the model,
 * accumulated over the whole topic):
 * - cumulative tokens: the sum of every turn's total;
 * - cache hit: cache reads / input tokens;
 * - ring: context size of the most recent model call / the model profile's `context_window`.
 *
 * A value that cannot be obtained is simply not drawn (no cache details → no "cache hit"; no
 * context window in the model profile → no ring; no usage at all for the topic → the whole bar
 * is not rendered). Nothing is estimated.
 *
 * The two shapes swap at the end of a turn (`streaming` becomes false): the live numbers are
 * discarded and the ledger is re-read from the database — the write lands before
 * `harness-stream-done`, so this fetch already contains the turn that just ran.
 */

/**
 * Ring diameter / stroke width / optical offset.
 *
 * - Diameter is 14 (slightly larger than the `1em` text): a small share such as 8% leaves only a
 *   short arc, and the smaller the ring the more it looks like a single dot;
 * - Stroke width is 2.5 (not 2): a thin ring hardly reads as "progress" in the light theme, and
 *   the extra weight is what gives the arc presence;
 * - Optical offset +1px: flex `align-items: center` aligns the **line box**, while digits sit
 *   about 1px below its center (the box includes descender space), so without this compensation
 *   the ring looks half a beat higher than "8%".
 */
const RING_SIZE = 14
const RING_STROKE = 2.5
const RING_OPTICAL_OFFSET = 1

const ContextRing: React.FC<{ percent: number; color: string; track: string }> = ({
  percent,
  color,
  track
}) => {
  const center = RING_SIZE / 2
  const radius = (RING_SIZE - RING_STROKE) / 2
  const circumference = 2 * Math.PI * radius
  const filled = Math.max(0, Math.min(100, percent))
  return (
    <svg
      width={RING_SIZE}
      height={RING_SIZE}
      viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
      aria-hidden="true"
      style={{
        flexShrink: 0,
        display: 'block',
        transform: `translateY(${RING_OPTICAL_OFFSET}px)`
      }}
    >
      {/* Track ring: the full dark circle, standing for the whole window */}
      <circle
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        stroke={track}
        strokeWidth={RING_STROKE}
      />
      {/* Usage ring: drawn clockwise from 12 o'clock up to percent */}
      {filled > 0 && (
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={RING_STROKE}
          strokeLinecap="round"
          strokeDasharray={`${(circumference * filled) / 100} ${circumference}`}
          transform={`rotate(-90 ${center} ${center})`}
        />
      )}
    </svg>
  )
}

interface HarnessUsageMeterProps {
  /** Current topic; null = no conversation yet (first turn of a new chat), nothing is shown */
  topicId: number | null
  /** Context window of the current model (provider profile metadata.context_window); null =
   * unknown */
  contextWindow: number | null
  /** Generating: show the live turn accumulation; when it ends (false) fall back to the stored
   * summary */
  streaming: boolean
}

const HarnessUsageMeter: React.FC<HarnessUsageMeterProps> = ({
  topicId,
  contextWindow,
  streaming
}) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  /** Summary is stored together with the topic it belongs to: on a topic switch the old value dies
   * at once and never leaks into a new conversation */
  const [snapshot, setSnapshot] = useState<{ topicId: number; summary: UsageSummary } | null>(null)
  /** Live accumulation for this turn (pushed by the main process when each model call ends); null =
   * nothing to show for this turn yet */
  const [turnUsage, setTurnUsage] = useState<TurnUsageView | null>(null)
  /**
   * Topic whose summary has already been fetched (or confirmed empty).
   *
   * It separates "same topic, still generating" (keep the old numbers, do not refetch) from
   * "just switched to a generating topic" (must fetch right away) — gating only on `streaming`
   * would leave the footer blank for the whole generation when switching to a conversation
   * running in the background, even though its earlier turns already had usage.
   */
  const fetchedTopicRef = useRef<number | null>(null)

  useEffect(() => {
    if (topicId === null) {
      fetchedTopicRef.current = null
      setSnapshot(null)
      return
    }
    // Generating and this topic's ledger was already fetched: keep the previous numbers and refresh
    // when the stream ends (no flicker, no extra request)
    if (streaming && fetchedTopicRef.current === topicId) return
    let cancelled = false
    void harnessApi.harness
      .getUsageByTopic(topicId)
      .then((rows) => {
        if (cancelled) return
        fetchedTopicRef.current = topicId
        const summary = buildUsageSummary(rows)
        setSnapshot(summary ? { topicId, summary } : null)
      })
      .catch((err) => {
        // Stay silent when the channel is unavailable (plugin disabled, etc.): one missing footer
        // line must not break the rest of the input box
        console.warn('[harness-usage-meter] load usage failed:', err)
      })
    return () => {
      cancelled = true
    }
  }, [topicId, streaming])

  // Live progress while generating: clear on topic switch, then accept only the current topic's
  // events (background turns of the same topic still show)
  useEffect(() => {
    setTurnUsage(null)
    if (topicId === null) return
    return harnessApi.harness.onTurnUsage((data) => {
      if (data.topicId !== topicId) return
      setTurnUsage(data)
    })
  }, [topicId])

  // Turn finished: the live numbers are discarded and the effect below re-reads the summary from
  // the database (persisted before stream-done)
  useEffect(() => {
    if (!streaming) setTurnUsage(null)
  }, [streaming])

  // The old snapshot stops counting after a topic switch (draw nothing until new numbers arrive: an
  // empty bar beats another conversation's usage)
  const summary = snapshot && snapshot.topicId === topicId ? snapshot.summary : null
  /** Show live numbers only while generating; switch back to the conversation summary as soon as
   * the stream stops */
  const live = streaming && turnUsage && turnUsage.topicId === topicId ? turnUsage : null
  if (!live && !summary) return null

  /** Cache hit rate rounded to a whole percentage; some protocols report cache fields above 100%,
   * so the display is capped */
  const cachePercent =
    summary && summary.cacheHitRate !== null
      ? Math.min(100, Math.max(0, Math.round(summary.cacheHitRate * 100)))
      : null
  const contextPercent =
    summary && contextWindow !== null && contextWindow > 0 && summary.contextTokens !== null
      ? Math.min(100, Math.max(0, Math.round((summary.contextTokens / contextWindow) * 100)))
      : null

  return (
    <div
      style={{
        marginLeft: 'auto',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        paddingRight: 2,
        fontSize: 11.5,
        lineHeight: 1,
        whiteSpace: 'nowrap',
        fontVariantNumeric: 'tabular-nums',
        color: token.colorTextTertiary
      }}
    >
      {live ? (
        <span title={t('harness.usageMeter.turnLiveHint')}>
          {t('harness.usageMeter.turnLive', {
            calls: live.calls,
            value: formatCompactTokens(live.totalTokens)
          })}
        </span>
      ) : summary ? (
        <>
          <span>
            {t('harness.usageMeter.tokens', { value: formatCompactTokens(summary.totalTokens) })}
          </span>
          {cachePercent !== null && (
            <>
              <span aria-hidden="true">·</span>
              <span>{t('harness.usageMeter.cacheHit', { percent: cachePercent })}</span>
            </>
          )}
          {contextPercent !== null && contextWindow !== null && (
            <span
              title={t('harness.usageMeter.contextAria', {
                percent: contextPercent,
                window: formatCompactTokens(contextWindow)
              })}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 2 }}
            >
              {/* Track uses colorBorder, progress uses colorText: both are opaque enough to be
                  visible, so "how much is used" reads in light and dark themes alike. The former
                  colorFillTertiary (≈4%) almost disappeared on white, leaving a short arc that
                  looked like a stray comma. */}
              <ContextRing
                percent={contextPercent}
                color={token.colorText}
                track={token.colorBorder}
              />
              <span>{contextPercent}%</span>
            </span>
          )}
        </>
      ) : null}
    </div>
  )
}

export default HarnessUsageMeter
