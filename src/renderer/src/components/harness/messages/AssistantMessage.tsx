import React, { useRef, useEffect, useCallback, useState, useMemo } from 'react'
import { Collapse, theme } from 'antd'
import MessageActions from './MessageActions'

import {
  RiRefreshLine,
  RiAiAgentLine,
  RiListCheck,
  RiCheckboxCircleLine,
  RiCheckboxBlankCircleLine,
  RiBrain4Line,
  RiPictureInPicture2Line,
  RiPencilLine,
  RiSparkling2Line
} from '@remixicon/react'
import MarkdownLoad from '@renderer/components/markdown/MarkdownLoad'
import { ShinyText, ShinyIcon } from '@renderer/components/effects/ShinyText'
import { useTranslation, Trans } from '@renderer/i18n'
import LoadingMessage from './LoadingMessage'
import ToolTextPreview from './ToolTextPreview'
import StreamTextWindow from './StreamTextWindow'
import FoldBody from './FoldBody'
import {
  ToolProgressCard,
  ToolResultCard,
  ToolImageStrip,
  PresentedFilesCard,
  type ToolCardStyle
} from './ToolResultCard'
import { toolIconFor } from '../../../utils/harness/toolIcons'
import { MONO_FONT, TruncatedTooltipText } from './TruncatedTooltipText'
import { useSubagentViewBridge } from '../../../contexts/harness/subagent-view-bridge'

import {
  getToolStatusLabel,
  shouldShowSilenceIndicator,
  buildTaskSegments,
  buildToolRuns,
  answerPhaseFrom,
  tailContentIndices,
  type TaskSegment,
  type ToolRunEntry
} from '../../../utils/harness/harnessHelpers'
import type {
  HarnessDialogueUsageRow,
  MessageBlock,
  ToolCall
} from '../../../../../shared/harness/types'
import type { Message } from '../../../types/harness/types'

/** Custom card tool set: in-progress and completed states share the same card shape
 * (the gloss only sweeps while running, then rests) */
const CARD_TOOLS = new Set([
  'read_file',
  'read_image',
  'write_file',
  'edit_file',
  'apply_patch',
  'ls',
  'glob',
  'grep',
  'execute'
])

/**
 * Center every collapse header vertically.
 *
 * antd defaults to `.ant-collapse-header { align-items: flex-start }`: when the header holds a
 * single line of small text, the text hugs the top edge and no longer shares a centerline with
 * the arrow on the left (users reported that the thinking-process label was not centered). Task
 * segments were previously patched separately through the `.task-segment-collapse` CSS (see the
 * style in Index.tsx), while the other headers (thinking process / subagent / injected memory /
 * generic tool) were not, so two kinds of alignment coexisted on the same screen.
 *
 * Passing an inline style through antd's semantic styles fixes this uniformly: inline wins over
 * CSS injection order and selector specificity, and no global rule has to be added per header
 * type.
 */
const COLLAPSE_HEADER_CENTERED = { header: { alignItems: 'center' } } as const

/**
 * Fixed height cap for a task segment's expanded body.
 *
 * A little taller than the thinking box's 256: a segment holds tool cards + thinking + text, and
 * individual blocks are taller (a tool card alone is 30+px), so 320 shows roughly 6~8 steps at
 * once — enough to tell what a step is doing without covering the whole screen. The early
 * exploration segment does not use this box (user, 2026-09-25: only task segments collapse), so
 * this serves task segments only.
 */
const SEGMENT_BODY_MAX_HEIGHT = 320

interface AssistantMessageProps {
  message: Message
  index: number
  isDarkMode: boolean
  copiedId: string | null
  colorText: string
  colorTextSecondary: string
  colorTextTertiary: string
  colorFillAlter: string
  colorBorderSecondary: string
  /** Current topic id (used by the action bar's rating index) */
  topicId: number | null
  /** Read-only (archived conversation): the action bar keeps only copy / metadata and hides branch,
   * save-to-memory and delete */
  readOnly?: boolean
  /** Timestamp of this turn's question (used by the action bar to compute elapsed time) */
  turnStartedAt?: number
  /** Real usage of this reply (a harness_dialogue_usage row; undefined when not reported) */
  usage?: HarnessDialogueUsageRow
  /** Branch: copy the messages up to this one into a new topic and switch to it */
  onBranch: (upToIndex: number) => Promise<void>
  onCopy: (text: string, id: string) => void
  onDelete: (index: number) => void
  /**
   * Pending review changes (file path → pending count), used on the **task segment header** to
   * report which files this segment changed.
   *
   * Background (user, 2026-09-23): "the file was edited but the chat shows no edit card" — once a
   * segment folds, the write/edit cards inside it are unmounted too (destroyOnHidden), and the
   * header keeps only the task name + step count, so "what changed" is lost from the chat. This
   * header badge lifts the changes back outside the fold.
   */
  pendingByPath?: Map<string, number>
  /** Segment-header change badge click: open that file's diff view in the right panel */
  onOpenChangedFile?: (path: string) => void
}

/**
 * Streaming silence indicator row ("generating…").
 *
 * Why it is a separate memo component: the row's visibility depends on how long ago the last
 * chunk arrived, which needs a 500ms clock. If the clock state lived in AssistantMessage, its two
 * ticks per second would re-render the whole message (hundreds of blocks and hundreds of
 * thousands of characters for long tasks) — measured on 2026-09-18: in a session with a 40-round
 * goal task, the renderer workingSet climbed from 534MB to 5991MB, and even during **in-stream
 * silence** (no chunk arriving at all) it kept growing at about 40MB/10s, precisely this clock
 * rebuilding a huge subtree. With the clock moved in here, a tick only affects this row, and the
 * parent re-renders only when content really changes (batched flush).
 */
const SilenceGeneratingHint = React.memo(function SilenceGeneratingHint({
  loading,
  hasStartedContent,
  getLastChunkAt,
  color,
  size = 14
}: {
  loading: boolean
  hasStartedContent: boolean
  /**
   * Stable getter for "time of the last chunk".
   *
   * Deliberately not passed as a `lastChunkAt` value: that time changes on every batch flush, and
   * passing the value would invalidate the block render cache (see renderBlocks) on every batch.
   * With a stable getter, this component reads the latest value in its own 500ms tick.
   */
  getLastChunkAt: () => number
  color: string
  /** Icon size and font size: 14 for the main message, 12 for nested subagent blocks */
  size?: number
}): React.ReactNode {
  const { t } = useTranslation()
  const [, tick] = useState(0)

  useEffect(() => {
    if (!loading) return
    const id = setInterval(() => tick((v) => v + 1), 500)
    return () => clearInterval(id)
  }, [loading])

  const silent = shouldShowSilenceIndicator({
    loading,
    hasStartedContent,
    now: Date.now(),
    lastChunkAt: getLastChunkAt()
  })
  if (!silent) return null

  return (
    <div className="flex items-center gap-2 mt-1" style={{ color }}>
      <ShinyIcon icon={RiSparkling2Line} size={size} baseColor={color} />
      <ShinyText baseColor={color}>
        <span style={{ fontSize: size === 14 ? 13 : 12 }}>
          {t('harness.assistantMessage.silentGenerating')}
        </span>
      </ShinyText>
    </div>
  )
})

const AssistantMessage: React.FC<AssistantMessageProps> = React.memo(
  ({
    message,
    index,
    isDarkMode,
    copiedId,
    colorText,
    colorTextSecondary,
    colorTextTertiary,
    colorFillAlter,
    colorBorderSecondary,
    topicId,
    readOnly = false,
    turnStartedAt,
    usage,
    onBranch,
    onCopy,
    onDelete,
    pendingByPath,
    onOpenChangedFile
  }) => {
    const { t, i18n } = useTranslation()
    const { token } = theme.useToken()
    const isCopied = copiedId === message.id
    /** Bridge to open the background subagent conversation view (the "dispatched" card jumps
     * straight there; null outside the Harness page) */
    const subagentViewBridge = useSubagentViewBridge()

    /**
     * Task segment fold state (key = segment key, value = whether folded).
     *
     * Only segments the user changed manually are recorded: the default state is derived — a
     * completed task that is not the last segment folds by default, while the running segment and
     * the last one start expanded (the last segment usually carries the final answer and must
     * never fold by default).
     */
    const [foldOverride, setFoldOverride] = useState<Record<string, boolean>>({})
    /** Task segments whose "list" is expanded (toggled by the list icon right of the label;
     * independent of the fold state) */
    const [listOpenKeys, setListOpenKeys] = useState<string[]>([])

    // Block-level render cache: the table is rebuilt whenever the key changes (see renderBlocks)
    const blockCacheRef = useRef<{
      key: string
      map: WeakMap<MessageBlock, { sig: string; node: React.ReactNode }>
    }>({ key: '', map: new WeakMap() })

    // Stable reader for "time of the last chunk": the value changes every batch but the reference
    // must stay stable, otherwise the block cache misses on every batch (the silence hint reads
    // this getter on its own timer)
    const lastChunkAtRef = useRef(message.lastChunkAt ?? message.timestamp)
    lastChunkAtRef.current = message.lastChunkAt ?? message.timestamp
    const getLastChunkAt = useCallback((): number => lastChunkAtRef.current, [])

    // Copy text is built on demand: it used to be useMemo([message]), which concatenated the body
    // of every block on each flush while streaming (measured: 160k characters ≈ a few ms plus as
    // much garbage), yet it is only needed when the user clicks copy.
    const getCopyText = useCallback((): string => {
      const parts: string[] = []
      const collect = (blocks: MessageBlock[] | undefined): void => {
        for (const b of blocks ?? []) {
          if (b.type === 'text' && b.text) parts.push(b.text)
          else if (b.type === 'subAgent') {
            if (b.subAgent?.output) parts.push(b.subAgent.output)
            collect(b.children)
          }
        }
      }
      collect(message.blocks)
      const joined = parts.join('\n\n').trim()
      return joined || message.content
    }, [message])

    // Scroll containers and streaming bottom-follow: **handled entirely by FoldBody** (fixed
    // height + interruptible bottom-follow).
    //
    // There used to be an indiscriminate effect here: every chunk while streaming set
    // `scrollTop = scrollHeight` on all collapse containers — without checking whether the user
    // was reading upwards, so scrolling back a few lines was yanked back to the bottom at once.
    // Users explicitly asked for "interruptible, follow again once back at the bottom", so each
    // content box decides on its own whether to follow; that centralized forced-scroll effect and
    // its scrollRefs were removed together.
    /** Trigger signal for streaming bottom-follow (changes once per chunk) */
    const followSignal = message.lastChunkAt
    const streamingFollow = Boolean(message.loading)

    // Still render when only "injected memory" / "compacting" blocks exist (the card stays
    // visible); other empty messages fall through to LoadingMessage. Same for the "retrying" block
    // (show the retry progress row rather than letting LoadingMessage replace the whole card).
    // These flags used to be 4 separate full-table scans (run on every flush); they are now a
    // single pass, memoized.
    const blockFlags = useMemo(() => {
      let memory = false
      let compacting = false
      let retrying = false
      let visibleTool = false
      for (const b of message.blocks) {
        if (b.type === 'memoryInjected') memory = true
        else if (b.type === 'historyCompacting') compacting = true
        else if (b.type === 'retrying') retrying = true
        else if (
          b.type === 'tool' &&
          b.tool &&
          (b.tool.status === 'preparing' ||
            b.tool.status === 'executing' ||
            b.tool.status === 'completed' ||
            (!b.tool.status && !b.tool.output))
        ) {
          visibleTool = true
        }
      }
      return { memory, compacting, retrying, visibleTool }
    }, [message.blocks])
    const hasMemoryBlock = blockFlags.memory
    const hasCompactingBlock = blockFlags.compacting
    const hasRetryingBlock = blockFlags.retrying
    const hasVisibleToolBlock = blockFlags.visibleTool

    /**
     * Merge adjacent reasoning blocks: the model may split its thinking into token-level events,
     * and without merging the screen fills with "thinking process".
     * Must "copy then merge" (never rewrite the shared state objects in place, otherwise the text
     * duplicates itself on every render pass).
     * Memoized at the top level: when the block list identity is unchanged (e.g. only loading /
     * fold state changed) the merge does not run again.
     */
    const mergedBlocks = useMemo(() => {
      const out: MessageBlock[] = []
      for (const block of message.blocks) {
        if (block.type === 'reasoning') {
          const last = out[out.length - 1]
          if (last && last.type === 'reasoning') {
            out[out.length - 1] = {
              ...last,
              reasoning: (last.reasoning || '') + (block.reasoning || '')
            }
            continue
          }
        }
        out.push(block)
      }
      return out
    }, [message.blocks])

    // Streaming silence hint: while a reasoning model generates large tool arguments the stream may
    // carry no events for a long time (not even a tool name) — the already-emitted content then
    // gets a "generating…" gloss line after it, honestly reporting "still generating", and
    // switches to a real tool card as soon as the tool call arrives.
    // The clock lives inside SilenceGeneratingHint (the 500ms tick only re-renders that row).
    // Manual expand record for subagent folds (key = stable identity such as the conversation
    // causeId): forced expanded while running, collapsed by default once completed but still
    // clickable to view the output. defaultActiveKey only applies on first mount, so a state flip
    // (running→completed) would not collapse it automatically — hence a controlled activeKey.
    const [saOpenOverride, setSaOpenOverride] = useState<Record<string, boolean>>({})
    const hasStartedContent = Boolean(
      message.content || message.reasoning_content || message.blocks.length > 0
    )
    // The silence row mounts only while streaming with no other status row to show; whether it is
    // really silent is decided by the child on its clock
    const showSilenceGenerating =
      Boolean(message.loading) &&
      hasStartedContent &&
      !hasVisibleToolBlock &&
      !hasMemoryBlock &&
      !hasCompactingBlock &&
      !hasRetryingBlock

    /** Whether the last child block is an in-progress tool card (then no silence hint is shown, the
     * card already has a status) */
    const lastChildIsActiveTool = (children: MessageBlock[]): boolean => {
      const last = children[children.length - 1]
      if (!last || last.type !== 'tool' || !last.tool) return false
      const st = last.tool.status
      return st === 'preparing' || st === 'executing' || (!st && !last.tool.output)
    }

    if (
      message.loading &&
      !message.content &&
      !message.reasoning_content &&
      (!message.toolCalls || message.toolCalls.length === 0) &&
      !hasMemoryBlock &&
      !hasCompactingBlock &&
      !hasRetryingBlock
    ) {
      return <LoadingMessage colorTextSecondary={colorTextSecondary} />
    }

    const codeBg = isDarkMode ? 'rgba(255,255,255,0.06)' : '#f3f4f6'
    const collapseBg = isDarkMode ? 'rgba(255,255,255,0.04)' : '#f9fafb'

    /**
     * Status dot + count pill (one geometry shared by task segment headers and same-tool group
     * headers).
     *
     * User, 2026-09-25: "the dot in front should sit inside the number, and the inside and the
     * number should be centered, horizontally and vertically" — the dot is now a **child element
     * of the pill**, no longer a separate dot to the left of it.
     *
     * Centering relies on flex: the pill itself is `inline-flex` with
     * `align-items/justify-content: center`, so the "dot + number" pair is centered both ways
     * inside the pill; the number uses tabular figures and the pill sets a minWidth, so numbers
     * stay aligned across rows when the digit count changes (tabular figures only for numbers).
     *
     * Both call sites share this single function: the pill's geometry (18px tall, 9px radius, 1px
     * stroke, 6px dot, 4px gap) written twice would inevitably drift — putting the same constraint
     * in two places has bitten this project more than once.
     */
    const countPill = (count: number, dotColor: string): React.ReactNode => (
      <span
        data-count-pill={count}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 4,
          flex: '0 0 auto',
          boxSizing: 'border-box',
          height: 18,
          minWidth: 30,
          padding: '0 6px',
          borderRadius: 9,
          border: `1px solid ${colorBorderSecondary}`,
          color: colorTextTertiary,
          fontSize: 11,
          fontFamily: MONO_FONT
        }}
      >
        <span
          data-count-dot={dotColor}
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            flex: '0 0 auto',
            background: dotColor
          }}
        />
        {/* lineHeight:1 so the line height cannot stretch the pill; vertical centering is flex's
            job */}
        <span style={{ lineHeight: 1 }}>{count}</span>
      </span>
    )

    /** Built-in tool cards (not collapsible): in-progress / completed share the same shape; the
     *  actual rendering lives in ToolResultCard.tsx.
     *
     *  Since 2026-09-19 these tools' results are no longer streamed or persisted — the path /
     *  count / exit code on the card is projected by the main process
     *  (service/tool-presentation.ts), and clicking the card opens the real file or result details
     *  in the right panel. */
    const renderToolCard = (
      tool: ToolCall,
      key: string | number,
      isNested = false,
      progress?: 'preparing' | 'executing'
    ): React.ReactNode => {
      const style: ToolCardStyle = {
        isDarkMode,
        colorText,
        colorTextSecondary,
        colorTextTertiary,
        colorFillAlter,
        colorBorderSecondary
      }
      if (progress) {
        return (
          <ToolProgressCard
            key={key}
            tool={tool}
            progress={progress}
            isNested={isNested}
            style={style}
          />
        )
      }
      // No card data and no images (abnormal shape): return null and let the generic collapse
      // handle it
      const images = tool.images ?? []
      if (!tool.card && images.length === 0) return null
      return (
        <div key={key}>
          {tool.card ? (
            <ToolResultCard tool={tool} topicId={topicId} isNested={isNested} style={style} />
          ) : null}
          <ToolImageStrip images={images} isNested={isNested} style={style} />
        </div>
      )
    }

    /** present: delivered-files card (the list comes from the tool input and is persisted with the
     * conversation) */
    const renderPresentCard = (
      tool: ToolCall,
      key: string | number,
      isNested = false
    ): React.ReactNode => {
      const style: ToolCardStyle = {
        isDarkMode,
        colorText,
        colorTextSecondary,
        colorTextTertiary,
        colorFillAlter,
        colorBorderSecondary
      }
      return <PresentedFilesCard key={key} tool={tool} isNested={isNested} style={style} />
    }

    // ── Mnemon memory tool custom cards ──────────────────────────────────
    // Read side (recall / inspect memory): mnemon_recall / mnemon_document_search / mnemon_related
    // /
    //   mnemon_memory_bodies / mnemon_status
    // Write side (persist / maintain memory): mnemon_runtime_memory / mnemon_remember /
    // mnemon_document_manage /
    //   mnemon_forget / mnemon_link / mnemon_memory_body_*
    const MEMORY_READ_TOOLS = [
      'mnemon_recall',
      'mnemon_document_search',
      'mnemon_related',
      'mnemon_memory_bodies',
      'mnemon_status'
    ]
    const MEMORY_WRITE_TOOLS = [
      'mnemon_runtime_memory',
      'mnemon_remember',
      'mnemon_document_manage',
      'mnemon_forget',
      'mnemon_link',
      'mnemon_memory_body_create',
      'mnemon_memory_body_update',
      'mnemon_memory_body_merge'
    ]
    /** Localized tool labels (card titles): only the message keys are stored, resolved with the
     * component's t */
    const MEMORY_TOOL_TITLES = {
      mnemon_status: 'harness.assistantMessage.memoryStatus',
      mnemon_memory_bodies: 'harness.assistantMessage.memorySpaces',
      mnemon_recall: 'harness.assistantMessage.memoryRecall',
      mnemon_document_search: 'harness.assistantMessage.memoryDocumentSearch',
      mnemon_related: 'harness.assistantMessage.memoryRelated'
    } as const

    /** Truncate long text (for memory entries / summaries) */
    const clampText = (text: string, max = 300): string =>
      text.length > max ? `${text.slice(0, max)}…` : text

    /** Render an mnemon_* memory tool as a custom card: each tool has its own kind of content and
     * storage paths are never shown */
    const renderMemoryToolCard = (
      tool: ToolCall,
      key: string | number,
      isNested = false
    ): React.ReactNode => {
      const size = isNested ? 14 : 16
      const fontSize = isNested ? '12px' : '13px'
      const smallFont = isNested ? '11px' : '12px'
      const query = (tool.input as Record<string, unknown>)?.query as string | undefined

      // Parse the tool output JSON safely
      let parsed: Record<string, unknown> | null = null
      if (tool.output) {
        try {
          parsed = JSON.parse(tool.output) as Record<string, unknown>
        } catch {
          parsed = null
        }
      }
      const asList = (v: unknown): Record<string, unknown>[] =>
        Array.isArray(v) ? (v as Record<string, unknown>[]) : []

      /** Shared entry row: primary text + meta line + optional badge (separated by hairlines) */
      const renderEntry = (
        entryKey: number,
        primary: string,
        meta?: string,
        badge?: { text: string; active?: boolean }
      ): React.ReactNode => (
        <div
          key={entryKey}
          className="flex items-start gap-2 py-1.5 first:pt-0"
          style={{
            borderTop: entryKey === 0 ? 'none' : `1px solid ${colorFillAlter}`
          }}
        >
          <div className="flex-1 min-w-0">
            <div style={{ color: colorText, fontSize }} className="whitespace-pre-wrap break-words">
              {clampText(primary)}
            </div>
            {meta ? (
              <div className="mt-0.5" style={{ color: colorTextTertiary, fontSize: smallFont }}>
                {meta}
              </div>
            ) : null}
          </div>
          {badge ? (
            <span
              className="shrink-0 rounded px-1.5 py-0.5 mt-px"
              style={{
                background: badge.active ? 'rgba(82,196,26,0.12)' : colorFillAlter,
                color: badge.active ? '#52c41a' : colorTextSecondary,
                fontSize: isNested ? '10px' : '11px'
              }}
            >
              {badge.text}
            </span>
          ) : null}
        </div>
      )

      /** Card shell: icon + title + header stats + query + content */
      const shell = (
        title: string,
        headExtra: React.ReactNode,
        body: React.ReactNode
      ): React.ReactNode => (
        <div
          key={key}
          style={{
            background: collapseBg,
            border: 'var(--ant-line-width) var(--ant-line-type) var(--ant-color-border)',
            marginBottom: isNested ? '4px' : '6px',
            borderRadius: '8px',
            padding: '8px 12px'
          }}
          className="rounded-lg"
        >
          <div className="flex items-center gap-2 mb-1">
            <RiBrain4Line size={size} style={{ color: colorTextSecondary, flexShrink: 0 }} />
            <span style={{ color: colorTextSecondary, fontSize, fontWeight: 500, flexShrink: 0 }}>
              {title}
            </span>
            {headExtra}
            {query ? (
              <span
                style={{ color: colorTextTertiary, fontSize: smallFont }}
                className="truncate text-right"
                title={query}
              >
                「{clampText(query, 60)}」
              </span>
            ) : null}
          </div>
          <div className="max-h-64 overflow-y-auto harness-scrollbar pl-0.5">{body}</div>
        </div>
      )

      /** Empty state row */
      const empty = (text: string): React.ReactNode => (
        <div style={{ color: colorTextTertiary, fontSize: smallFont }} className="py-0.5">
          {text}
        </div>
      )

      // ── mnemon_status: memory status overview ──
      if (tool.name === 'mnemon_status') {
        const activeSpaces = asList(parsed?.active_spaces)
        const rows: [string, string][] = [
          [
            t('harness.assistantMessage.memorySpaces'),
            t('harness.assistantMessage.memoryBodyActivate', {
              active: parsed?.memory_bodies_active ?? 0,
              total: parsed?.memory_bodies_total ?? 0
            })
          ],
          [
            t('harness.assistantMessage.memoryBodyHot'),
            parsed?.runtime_memory_configured
              ? t('common.state.configured')
              : t('common.state.notConfigured')
          ],
          [
            t('harness.assistantMessage.memoryBodyDocuments'),
            parsed?.documents_configured
              ? t('common.state.configured')
              : t('common.state.notConfigured')
          ]
        ]
        return shell(
          t(MEMORY_TOOL_TITLES.mnemon_status),
          null,
          <div>
            {parsed ? (
              <>
                {rows.map(([label, value], i) => (
                  <div
                    key={label}
                    className="flex items-center justify-between py-1"
                    style={{
                      borderTop: i === 0 ? 'none' : `1px solid ${colorFillAlter}`
                    }}
                  >
                    <span style={{ color: colorTextSecondary, fontSize: smallFont }}>{label}</span>
                    <span style={{ color: colorTextTertiary, fontSize: smallFont }}>{value}</span>
                  </div>
                ))}
                {activeSpaces.length > 0 ? (
                  <div className="flex flex-wrap gap-1 pt-1.5">
                    {activeSpaces.map((s, i) => (
                      <span
                        key={i}
                        className="rounded px-1.5 py-0.5"
                        style={{
                          background: colorFillAlter,
                          color: colorTextSecondary,
                          fontSize: isNested ? '10px' : '11px'
                        }}
                      >
                        {String(
                          s.name ??
                            t('harness.assistantMessage.memoryBodySpaceFallback', {
                              index: i + 1
                            })
                        )}{' '}
                        ·{' '}
                        {t('harness.assistantMessage.memoryBodyInsights', {
                          count: Number(s.totalInsights ?? 0)
                        })}
                      </span>
                    ))}
                  </div>
                ) : null}
              </>
            ) : (
              empty(t('harness.assistantMessage.statusParseFailed'))
            )}
          </div>
        )
      }

      // ── mnemon_memory_bodies: memory space catalog ──
      if (tool.name === 'mnemon_memory_bodies') {
        const bodies = asList(parsed?.bodies)
        return shell(
          t(MEMORY_TOOL_TITLES.mnemon_memory_bodies),
          parsed ? (
            <span style={{ color: colorTextTertiary, fontSize: smallFont, flexShrink: 0 }}>
              <Trans
                i18nKey="harness.assistantMessage.memoryBodyTotalActive"
                values={{
                  total: Number(parsed.total ?? 0),
                  active: Number(parsed.activeCount ?? 0)
                }}
                components={{ mono: <span style={{ fontFamily: MONO_FONT }} /> }}
              />
            </span>
          ) : null,
          bodies.length === 0 ? (
            empty(t('harness.assistantMessage.memoryBodyEmpty'))
          ) : (
            <div>
              {bodies.map((b, i) => (
                <div
                  key={i}
                  className="flex items-start gap-2 py-1.5 first:pt-0"
                  style={{
                    borderTop: i === 0 ? 'none' : `1px solid ${colorFillAlter}`
                  }}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span
                        style={{ color: colorText, fontSize, fontWeight: 500 }}
                        className="truncate"
                        title={String(b.name ?? '')}
                      >
                        {String(b.name ?? t('harness.assistantMessage.memoryBodyUnnamed'))}
                      </span>
                      <span
                        className="shrink-0 rounded px-1.5 py-px"
                        style={{
                          background: b.active ? 'rgba(82,196,26,0.12)' : colorFillAlter,
                          color: b.active ? '#52c41a' : colorTextTertiary,
                          fontSize: isNested ? '10px' : '11px'
                        }}
                      >
                        {b.active
                          ? t('harness.assistantMessage.memoryBodyActive')
                          : t('harness.assistantMessage.memoryBodyInactive')}
                      </span>
                    </div>
                    {b.description ? (
                      <div
                        className="mt-0.5 truncate"
                        style={{ color: colorTextTertiary, fontSize: smallFont }}
                        title={String(b.description)}
                      >
                        {String(b.description)}
                      </div>
                    ) : null}
                  </div>
                  <span
                    style={{
                      color: colorTextTertiary,
                      fontSize: smallFont,
                      flexShrink: 0
                    }}
                  >
                    <Trans
                      i18nKey="harness.assistantMessage.memoryBodyInsights"
                      count={Number(b.totalInsights ?? 0)}
                      components={{ mono: <span style={{ fontFamily: MONO_FONT }} /> }}
                    />
                  </span>
                </div>
              ))}
            </div>
          )
        )
      }

      // ── mnemon_recall: recalled memory entries ──
      if (tool.name === 'mnemon_recall') {
        const results = asList(parsed?.results)
        return shell(
          t(MEMORY_TOOL_TITLES.mnemon_recall),
          results.length > 0 ? (
            <span style={{ color: colorTextTertiary, fontSize: smallFont, flexShrink: 0 }}>
              <Trans
                i18nKey="harness.assistantMessage.memoryBodyCount"
                count={results.length}
                components={{ mono: <span style={{ fontFamily: MONO_FONT }} /> }}
              />
            </span>
          ) : null,
          results.length === 0 ? (
            empty(
              typeof parsed?.hint === 'string'
                ? String(parsed.hint)
                : t('harness.assistantMessage.memoryRecallEmpty')
            )
          ) : (
            <div>
              {results.map((item, i) => {
                const primary = String(item.content ?? '')
                const meta = [
                  typeof item.memory_body_name === 'string'
                    ? t('harness.assistantMessage.memoryEntrySource', {
                        name: item.memory_body_name
                      })
                    : '',
                  typeof item.score === 'number'
                    ? t('harness.assistantMessage.memoryEntryScore', {
                        score: item.score.toFixed(2)
                      })
                    : ''
                ]
                  .filter(Boolean)
                  .join(' · ')
                return renderEntry(
                  i,
                  primary,
                  meta || undefined,
                  typeof item.category === 'string'
                    ? { text: item.category, active: false }
                    : undefined
                )
              })}
            </div>
          )
        )
      }

      // ── mnemon_document_search: project document search ──
      if (tool.name === 'mnemon_document_search') {
        const results = asList(parsed?.results)
        return shell(
          t(MEMORY_TOOL_TITLES.mnemon_document_search),
          results.length > 0 ? (
            <span style={{ color: colorTextTertiary, fontSize: smallFont, flexShrink: 0 }}>
              <Trans
                i18nKey="harness.assistantMessage.memoryDocumentCount"
                count={results.length}
                components={{ mono: <span style={{ fontFamily: MONO_FONT }} /> }}
              />
            </span>
          ) : null,
          results.length === 0 ? (
            empty(t('harness.assistantMessage.memoryDocumentEmpty'))
          ) : (
            <div>
              {results.map((item, i) => {
                const title = String(item.title ?? '')
                const excerpt =
                  (typeof item.excerpt === 'string' && item.excerpt) ||
                  (typeof item.description === 'string' && item.description) ||
                  ''
                return (
                  <div
                    key={i}
                    className="py-1.5 first:pt-0"
                    style={{
                      borderTop: i === 0 ? 'none' : `1px solid ${colorFillAlter}`
                    }}
                  >
                    <div className="flex items-center gap-1.5">
                      <span
                        style={{ color: colorText, fontSize, fontWeight: 500 }}
                        className="truncate"
                        title={title}
                      >
                        {clampText(title, 80)}
                      </span>
                      {item.status ? (
                        <span
                          className="shrink-0 rounded px-1.5 py-px"
                          style={{
                            background:
                              item.status === 'active' ? 'rgba(82,196,26,0.12)' : colorFillAlter,
                            color: item.status === 'active' ? '#52c41a' : colorTextTertiary,
                            fontSize: isNested ? '10px' : '11px'
                          }}
                        >
                          {item.status === 'active'
                            ? t('harness.assistantMessage.memoryDocumentActive')
                            : item.status === 'archived'
                              ? t('harness.assistantMessage.memoryDocumentArchived')
                              : String(item.status)}
                        </span>
                      ) : null}
                    </div>
                    {excerpt ? (
                      <div
                        className="mt-0.5"
                        style={{ color: colorTextTertiary, fontSize: smallFont }}
                      >
                        {clampText(excerpt, 120)}
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>
          )
        )
      }

      // ── mnemon_related: related memory traversal ──
      if (tool.name === 'mnemon_related') {
        const results = asList(parsed?.results)
        return shell(
          t(MEMORY_TOOL_TITLES.mnemon_related),
          results.length > 0 ? (
            <span style={{ color: colorTextTertiary, fontSize: smallFont, flexShrink: 0 }}>
              <Trans
                i18nKey="harness.assistantMessage.memoryBodyCount"
                count={results.length}
                components={{ mono: <span style={{ fontFamily: MONO_FONT }} /> }}
              />
            </span>
          ) : null,
          results.length === 0 ? (
            empty(t('harness.assistantMessage.memoryRelatedEmpty'))
          ) : (
            <div>
              {results.map((item, i) => {
                const primary = String(item.content ?? '')
                const meta = [
                  typeof item.edge_type === 'string' ? item.edge_type : '',
                  typeof item.depth === 'number'
                    ? t('harness.assistantMessage.memoryEntryDepth', { depth: item.depth })
                    : ''
                ]
                  .filter(Boolean)
                  .join(' · ')
                return renderEntry(i, primary, meta || undefined)
              })}
            </div>
          )
        )
      }

      // ── Write side: persist / maintain results ──
      const writeBody = (): React.ReactNode => {
        // mnemon_remember: JSON output, shows where the entry was persisted
        if (tool.name === 'mnemon_remember' && parsed) {
          const category =
            typeof parsed.category === 'string'
              ? t('harness.assistantMessage.memoryCategory', { category: parsed.category })
              : ''
          const importance =
            typeof parsed.importance === 'number'
              ? t('harness.assistantMessage.memoryImportance', { importance: parsed.importance })
              : ''
          return (
            <div>
              <div style={{ color: colorText, fontSize }}>
                {t('harness.assistantMessage.memoryRemembered', {
                  name: String(
                    parsed.memory_body_name ?? t('harness.assistantMessage.memorySpaces')
                  )
                })}
              </div>
              {category || importance ? (
                <div className="mt-0.5" style={{ color: colorTextTertiary, fontSize: smallFont }}>
                  {[category, importance].filter(Boolean).join(' · ')}
                </div>
              ) : null}
            </div>
          )
        }
        return (
          <div style={{ color: colorText, fontSize }} className="whitespace-pre-wrap break-words">
            {clampText(tool.output, 500)}
          </div>
        )
      }
      // Note: mnemon_remember returns **plain text** (not JSON), so a failed JSON parse must not
      // show "cannot parse" — writeBody itself falls back to "JSON first, otherwise show as is"
      return shell(t('harness.assistantMessage.memoryWrite'), null, writeBody())
    }

    /** In-progress card for an mnemon memory tool: brain icon + title + status suffix, with the
     * gloss sweeping (a completed call still renders its dedicated result card) */
    const renderMemoryInProgressCard = (
      tool: ToolCall,
      key: string | number,
      isNested = false,
      progress: 'preparing' | 'executing'
    ): React.ReactNode => {
      const size = isNested ? 14 : 16
      const fontSize = isNested ? '12px' : '13px'
      const title = MEMORY_TOOL_TITLES[tool.name]
        ? t(MEMORY_TOOL_TITLES[tool.name])
        : MEMORY_WRITE_TOOLS.includes(tool.name)
          ? t('harness.assistantMessage.memoryWrite')
          : t('harness.assistantMessage.memoryTool')
      const status =
        progress === 'preparing'
          ? ` · ${t('harness.assistantMessage.toolPreparing')}`
          : ` · ${t('harness.assistantMessage.toolExecuting')}`
      return (
        <div
          key={key}
          style={{
            background: collapseBg,
            border: 'var(--ant-line-width) var(--ant-line-type) var(--ant-color-border)',
            marginBottom: isNested ? '4px' : '6px',
            borderRadius: '8px',
            padding: '8px 12px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px'
          }}
          className="rounded-lg"
        >
          <ShinyIcon icon={RiBrain4Line} size={size} baseColor={colorTextSecondary} />
          <TruncatedTooltipText
            text={`${title}${status}`}
            shinyBaseColor={colorTextSecondary}
            style={{ color: colorTextSecondary, fontSize }}
          />
        </div>
      )
    }

    const renderBlocks = (): React.ReactNode => {
      if (message.blocks.length === 0) {
        if (message.content) {
          return (
            <div style={{ color: colorText }} className="mb-2">
              {/* Block-less messages (history / abnormal path) also go through the window: the body
                  may be hundreds of thousands of characters */}
              <StreamTextWindow
                content={message.content}
                renderMarkdown={(text) => <MarkdownLoad content={text} isDarkMode={isDarkMode} />}
              />
            </div>
          )
        }
        return null
      }

      // Merge adjacent reasoning blocks: prevent the model from splitting its thinking into
      // token-level events, which would fill the screen with "thinking process".
      // Must "copy then merge": this used to rewrite the original block object directly
      // (last.reasoning += ...), mutating shared state during render; with adjacent blocks of the
      // same kind the text duplicated itself on every render pass and was never trimmed (renderer
      // OOM risk). Copy-then-merge has zero side effects on the original state.
      // The merge result is memoized at the component top level (mergedBlocks, see useMemo): it
      // does
      // not rerun while the block list identity is unchanged.

      // ── Block-level render cache (the main cost measured by the 2026-09-18 simulation) ─────
      // Measured (.git/sim/render-sim.mjs, a realistic 375-block / 160k-character message):
      //   one flush while content grows took 165ms, of which "content unchanged, forced
      //   re-render only" still cost 178ms — the cost is almost entirely in **rebuilding the vdom
      //   of every block on each flush**, while the grown blocks that truly need recomputation take
      //   only ~10ms. React skips a subtree's re-render entirely when element references are all
      //   identical, so render results are cached by **block object identity**: block objects that
      //   do not change during streaming keep their identity (useHarnessHandlers updates
      //   immutably), and cached blocks no longer take part in the rebuild.
      //
      // Cache key: mutable parent state that block bodies read (theme, language, loading,
      // subagent fold state). Any change to these invalidates and rebuilds the whole table. Note
      // lastChunkAt is deliberately NOT in the key — it changes every batch, and passing the value
      // would make the cache never hit; the silence hint passes a stable getter instead
      // (getLastChunkAt).
      const blockCacheKey = `${isDarkMode}|${i18n.language}|${message.loading ? 1 : 0}|${JSON.stringify(saOpenOverride)}|${topicId ?? 0}|${colorText}|${colorTextSecondary}|${colorTextTertiary}|${colorFillAlter}|${colorBorderSecondary}|${collapseBg}`
      const blockNodes = blockCacheRef.current
      if (blockNodes.key !== blockCacheKey) {
        blockNodes.key = blockCacheKey
        blockNodes.map = new WeakMap()
      }

      // Per-block "cross-block dependency": whether a thinking block is done = whether a
      // non-reasoning block appeared **after** it.
      // It flips as later blocks are appended, so it must go into the cache key (otherwise an old
      // thinking block hits the cache when new blocks arrive and stays at "thinking" instead of
      // switching to "thinking done" — the simulation's "incremental vs cold start" diff is what
      // caught this).
      // Computed in one reverse pass, replacing the previous per-block slice+some O(B²) scan.
      const hasContentAfterFlags = new Array<boolean>(mergedBlocks.length)
      let seenNonReasoning = false
      for (let i = mergedBlocks.length - 1; i >= 0; i -= 1) {
        hasContentAfterFlags[i] = seenNonReasoning
        if (mergedBlocks[i].type !== 'reasoning') seenNonReasoning = true
      }

      const renderBlock = (block: MessageBlock, blockIndex: number): React.ReactNode => {
        // Auto-retry after a failed model request (transition row: removed by useHarnessHandlers
        // when the retry succeeds and output resumes, or when the turn ends;
        // shown only while the message is in progress so historical messages have no leftovers)
        if (block.type === 'retrying' && block.retrying) {
          if (!message.loading) return null
          const { attempt, retries } = block.retrying
          return (
            <div
              key={blockIndex}
              style={{
                background: collapseBg,
                border: 'var(--ant-line-width) var(--ant-line-type) var(--ant-color-border)',
                marginBottom: '6px',
                borderRadius: '8px',
                padding: '9px 12px',
                display: 'flex',
                alignItems: 'center',
                gap: '8px'
              }}
            >
              <ShinyIcon icon={RiRefreshLine} size={16} baseColor={colorTextSecondary} />
              <TruncatedTooltipText
                text={t('harness.assistantMessage.retrying', { attempt, retries })}
                shinyBaseColor={colorTextSecondary}
                style={{ color: colorText, fontSize: '13px' }}
              />
            </div>
          )
        }
        // Summary compaction in progress (transitional: replaced by a historyCompacted result block
        // while streaming, hidden when the message ends on failure)
        if (block.type === 'historyCompacting' && message.loading) {
          return (
            <div
              key={blockIndex}
              style={{
                background: collapseBg,
                border: 'var(--ant-line-width) var(--ant-line-type) var(--ant-color-border)',
                marginBottom: '6px',
                borderRadius: '8px',
                padding: '9px 12px',
                display: 'flex',
                alignItems: 'center',
                gap: '8px'
              }}
            >
              <ShinyIcon icon={RiPictureInPicture2Line} size={16} baseColor={colorTextSecondary} />
              <TruncatedTooltipText
                text={t('harness.assistantMessage.compacting')}
                shinyBaseColor={colorTextSecondary}
                style={{ color: colorText, fontSize: '13px' }}
              />
            </div>
          )
        }
        // Earlier-conversation summary compaction (top of the message, right after injected memory;
        // a notice only, not expandable)
        if (block.type === 'historyCompacted' && block.compaction) {
          const c = block.compaction
          return (
            <div
              key={blockIndex}
              style={{
                background: collapseBg,
                border: 'var(--ant-line-width) var(--ant-line-type) var(--ant-color-border)',
                marginBottom: '6px',
                borderRadius: '8px',
                padding: '9px 12px',
                display: 'flex',
                alignItems: 'center',
                gap: '8px'
              }}
            >
              <RiPictureInPicture2Line
                size={16}
                style={{ color: colorTextSecondary, flexShrink: 0 }}
              />
              <TruncatedTooltipText
                text={t('harness.assistantMessage.compacted')}
                style={{ color: colorText, fontSize: '13px' }}
              />
              <span style={{ color: colorTextTertiary, fontSize: '13px', flexShrink: 0 }}>
                <Trans
                  i18nKey="harness.assistantMessage.compactedCounts"
                  values={{ compressed: c.compressedCount, retained: c.retainedCount }}
                  components={{ mono: <span style={{ fontFamily: MONO_FONT }} /> }}
                />
              </span>
            </div>
          )
        }
        // Hot memory injected this turn (top of the message, collapsed by default)
        if (block.type === 'memoryInjected' && block.memory) {
          const mem = block.memory
          const total = mem.user.length + mem.memory.length
          return (
            <Collapse
              styles={COLLAPSE_HEADER_CENTERED}
              key={blockIndex}
              items={[
                {
                  key: blockIndex,
                  label: (
                    <span className="flex items-center gap-2">
                      <RiBrain4Line size={14} style={{ color: colorTextSecondary }} />
                      <span style={{ color: colorTextSecondary }}>
                        <Trans
                          i18nKey="harness.assistantMessage.memoryInjected"
                          count={total}
                          components={{ mono: <span style={{ fontFamily: MONO_FONT }} /> }}
                        />
                        <span style={{ color: colorTextTertiary }}>
                          {mem.user.length > 0 ? (
                            <Trans
                              i18nKey="harness.assistantMessage.memoryInjectedUser"
                              values={{ user: mem.user.length, memory: mem.memory.length }}
                              components={{ mono: <span style={{ fontFamily: MONO_FONT }} /> }}
                            />
                          ) : (
                            <Trans
                              i18nKey="harness.assistantMessage.memoryInjectedProject"
                              values={{ count: mem.memory.length }}
                              components={{ mono: <span style={{ fontFamily: MONO_FONT }} /> }}
                            />
                          )}
                        </span>
                      </span>
                    </span>
                  ),
                  children: (
                    // Fixed display height + vertical scrollbar (so many entries or long text
                    // cannot blow the card up)
                    <div className="max-h-64 overflow-y-auto harness-scrollbar px-1.5 text-sm">
                      {mem.user.length > 0 ? (
                        <>
                          <div style={{ color: colorTextSecondary }} className="font-medium mb-1">
                            <Trans
                              i18nKey="harness.assistantMessage.userProfileBytes"
                              values={{ bytes: mem.usage.user }}
                              components={{ mono: <span style={{ fontFamily: MONO_FONT }} /> }}
                            />
                          </div>
                          <ul className="list-disc pl-4 mb-2" style={{ color: colorText }}>
                            {mem.user.map((entry, i) => (
                              <li key={i} className="mb-0.5 break-words">
                                {entry}
                              </li>
                            ))}
                          </ul>
                        </>
                      ) : null}
                      {mem.memory.length > 0 ? (
                        <>
                          <div style={{ color: colorTextSecondary }} className="font-medium mb-1">
                            <Trans
                              i18nKey="harness.assistantMessage.projectMemoryBytes"
                              values={{ bytes: mem.usage.memory }}
                              components={{ mono: <span style={{ fontFamily: MONO_FONT }} /> }}
                            />
                          </div>
                          <ul className="list-disc pl-4" style={{ color: colorText }}>
                            {mem.memory.map((entry, i) => (
                              <li key={i} className="mb-0.5 break-words">
                                {entry}
                              </li>
                            ))}
                          </ul>
                        </>
                      ) : null}
                    </div>
                  )
                }
              ]}
              defaultActiveKey={[]}
              size="small"
              style={{ marginBottom: '6px', background: collapseBg }}
              className="rounded-lg border-0"
            />
          )
        }
        if (block.type === 'reasoning' && block.reasoning) {
          // Any non-reasoning block appearing afterwards (text/tool), or the message ending
          // (done/aborted/error), counts as thinking done
          const hasContentAfter = hasContentAfterFlags[blockIndex] ?? false
          const thinkingDone = hasContentAfter || !message.loading
          const thinkingLabel = thinkingDone
            ? t('harness.assistantMessage.thinkingDone')
            : t('harness.assistantMessage.thinkingInProgress')
          const thinkingLabelNode = (
            <span style={{ color: colorTextTertiary }} className="text-xs">
              {thinkingDone ? (
                thinkingLabel
              ) : (
                <ShinyText baseColor={colorTextTertiary}>{thinkingLabel}</ShinyText>
              )}
            </span>
          )
          const extra = thinkingDone
            ? ({
                label: thinkingLabelNode
              } as const)
            : ({
                label: thinkingLabelNode,
                collapsible: 'disabled' as const
              } as const)
          return (
            <Collapse
              styles={COLLAPSE_HEADER_CENTERED}
              key={`${blockIndex}-${thinkingDone ? 'done' : 'thinking'}`}
              items={[
                {
                  key: blockIndex,
                  ...extra,
                  children: (
                    /* Thinking body box: fixed height + interruptible bottom-follow (see FoldBody).
                       No expand control (user, 2026-09-23: "the thinking content does not need it,
                       the expand-all below… that button is not needed"): long thinking scrolls
                       inside 256px and reading the full text is done by scrolling, so no button
                       sits under the box. */
                    <FoldBody
                      maxHeight={256}
                      expandable={false}
                      streaming={streamingFollow}
                      followSignal={followSignal}
                      className="text-sm px-1.5"
                      kind="thinking"
                      borderColor={colorBorderSecondary}
                    >
                      <StreamTextWindow
                        content={block.reasoning}
                        renderMarkdown={(text) => (
                          <MarkdownLoad content={text} isDarkMode={isDarkMode} />
                        )}
                      />
                    </FoldBody>
                  )
                }
              ]}
              expandIcon={
                thinkingDone
                  ? undefined
                  : () => <ShinyIcon icon={RiBrain4Line} size={14} baseColor={colorTextTertiary} />
              }
              defaultActiveKey={thinkingDone ? [] : [blockIndex]}
              size="small"
              style={{ marginBottom: '6px', background: collapseBg }}
              className="rounded-lg border-0"
            />
          )
        }
        if (block.type === 'text' && block.text) {
          return (
            <div key={blockIndex} style={{ color: colorText }} className="mb-2">
              {/* Long-text window: when the model pastes a whole file / output, a single text block
                  can be hundreds of thousands of characters; by default only the trailing part is
                  rendered to avoid re-parsing all markdown on every chunk batch */}
              <StreamTextWindow
                content={block.text}
                renderMarkdown={(text) => <MarkdownLoad content={text} isDarkMode={isDarkMode} />}
              />
            </div>
          )
        }
        if (block.type === 'tool' && block.tool) {
          /**
           * Todo lists (write_todos / read_todos) **do not go into the message body** (user,
           * 2026-09-25: "don't show this '0/9 completed · 1 in progress' checklist card on the page
           * any more").
           *
           * The plan is already visible elsewhere, so laying out another full table in the body is
           * duplication:
           *   - segment headers group by task (click the list icon right of the header to expand that
           *     segment's snapshot, see renderTaskChecklist);
           *   - the live task card above the input box (TaskProgressCard) shows the current topic's
           *     whole list with live status.
           *
           * Why previously only write_todos was hidden: during segmentation write_todos blocks were
           * registered in `writeIndices` and kept out of the segment body, while read_todos was not
           * registered and its card rendered anyway — once the segment before the first write_todos
           * was laid out flat (same-day "only task segments collapse"), it showed at the very top of
           * the message. Both are now skipped uniformly: no card is rendered and no generic tool
           * collapse row is emitted either (they are pure bookkeeping).
           */
          if (block.tool.name === 'write_todos' || block.tool.name === 'read_todos') return null
          const isPreparing = block.tool.status === 'preparing'
          const isExecuting =
            block.tool.status === 'executing' || (!block.tool.status && !block.tool.output)
          // Treat as in-progress only while the message is in progress, so the spinner does not
          // linger after abort/completion
          const inProgress = Boolean(message.loading) && (isPreparing || isExecuting)
          const phase: 'preparing' | 'executing' | undefined = inProgress
            ? isPreparing
              ? 'preparing'
              : 'executing'
            : undefined
          const toolName = block.tool.name || t('harness.assistantMessage.toolCallFallback')
          // Mnemon memory tool: in progress = the same glossy status card; completed = its
          // dedicated result card
          if (
            toolName.startsWith('mnemon_') &&
            (MEMORY_READ_TOOLS.includes(toolName) || MEMORY_WRITE_TOOLS.includes(toolName))
          ) {
            if (block.tool.status === 'completed') {
              return renderMemoryToolCard(block.tool, blockIndex)
            }
            if (phase) return renderMemoryInProgressCard(block.tool, blockIndex, false, phase)
          }
          // Delivered files (present): the final artifacts declared by the model; clicking opens
          // them on the right
          if (toolName === 'present' && block.tool.status === 'completed') {
            return renderPresentCard(block.tool, blockIndex, false)
          }
          // propose_action leaves no trace in the message stream (user decision, 2026-11-27):
          // confirmation only appears in the input prefill bar
          if (toolName === 'propose_action') {
            return null
          }
          // System tools: in-progress and completed share the same card (the gloss sweeps only
          // while running, then rests)
          if (CARD_TOOLS.has(toolName)) {
            if (phase) return renderToolCard(block.tool, blockIndex, false, phase)
            if (block.tool.card && block.tool.status === 'completed') {
              return renderToolCard(block.tool, blockIndex)
            }
          }
          // Other tools (including abnormal completed states with no card data): generic collapse,
          // glossy header while running + input/output details
          const toolLabel = getToolStatusLabel(t, toolName, phase)
          // The in-progress header shows the same icon as the tool's completed custom card;
          // MCP / mnemon fall back to a prefix; others show none
          const inProgressIcon = inProgress && toolIconFor(toolName)
          return (
            <Collapse
              styles={COLLAPSE_HEADER_CENTERED}
              key={blockIndex}
              items={[
                {
                  key: blockIndex,
                  label: inProgress ? (
                    <ShinyText baseColor={colorTextSecondary}>{toolLabel}</ShinyText>
                  ) : (
                    toolLabel
                  ),
                  collapsible: inProgress ? 'disabled' : undefined,
                  children: (
                    /* Fixed height + interruptible bottom-follow: tool output grows while running and
                       the user interrupts by scrolling up (the expand entry is provided by the tool
                       card itself, so no expand control is given here) */
                    <FoldBody
                      maxHeight={256}
                      expandable={false}
                      streaming={streamingFollow}
                      followSignal={followSignal}
                      className="px-1.5"
                      kind="tool"
                    >
                      <div style={{ color: colorTextSecondary }} className="font-medium mb-1">
                        {t('harness.assistantMessage.toolInput')}
                      </div>
                      <pre
                        style={{ background: codeBg }}
                        className="p-2 rounded text-sm overflow-x-auto"
                      >
                        {JSON.stringify(block.tool.input, null, 2)}
                      </pre>
                      <div style={{ color: colorTextSecondary }} className="font-medium mt-2 mb-1">
                        {t('harness.assistantMessage.toolOutput')}
                      </div>
                      {/* Plain-text output goes through ToolTextPreview: when very long (read_file
                          is capped at 2,000,000 characters) only the leading part is rendered, so
                          the renderer is not OOM-ed by text nodes */}
                      <ToolTextPreview
                        text={
                          typeof block.tool.output === 'string'
                            ? block.tool.output
                            : JSON.stringify(block.tool.output, null, 2)
                        }
                        codeBg={codeBg}
                      />
                    </FoldBody>
                  )
                }
              ]}
              expandIcon={
                inProgressIcon
                  ? () => (
                      <ShinyIcon icon={inProgressIcon} size={14} baseColor={colorTextSecondary} />
                    )
                  : undefined
              }
              defaultActiveKey={[]}
              size="small"
              style={{ marginBottom: '6px', background: collapseBg }}
              className="rounded-lg border-0"
            />
          )
        }
        if (block.type === 'subAgent' && block.subAgent) {
          const sa = block.subAgent
          // Lightweight card for background dispatch: name + short description + session id only
          // (no agent content/results — those are viewed in the top bar)
          if (sa.status === 'dispatched') {
            // The card's session id jumps straight to that subagent's streaming conversation view
            // (a second entry besides the top bar)
            const canOpenConversation = Boolean(sa.subagentId && subagentViewBridge)
            return (
              <div
                key={blockIndex}
                role={canOpenConversation ? 'button' : undefined}
                tabIndex={canOpenConversation ? 0 : undefined}
                title={
                  canOpenConversation ? t('harness.backgroundAgents.conversation.open') : undefined
                }
                onClick={
                  canOpenConversation
                    ? () => subagentViewBridge?.openSubagent(sa.subagentId as string)
                    : undefined
                }
                onKeyDown={
                  canOpenConversation
                    ? (event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') return
                        event.preventDefault()
                        subagentViewBridge?.openSubagent(sa.subagentId as string)
                      }
                    : undefined
                }
                style={{
                  background: collapseBg,
                  border: 'var(--ant-line-width) var(--ant-line-type) var(--ant-color-border)',
                  marginBottom: '6px',
                  borderRadius: '8px',
                  padding: '8px 12px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  cursor: canOpenConversation ? 'pointer' : undefined
                }}
              >
                <RiAiAgentLine size={16} style={{ color: colorTextSecondary, flexShrink: 0 }} />
                <span style={{ color: colorText, fontSize: 13, fontWeight: 500, flexShrink: 0 }}>
                  {sa.name}
                </span>
                <span style={{ color: colorTextSecondary, fontSize: 13, flexShrink: 0 }}>
                  {t('harness.assistantMessage.dispatched')}
                </span>
                {sa.taskDescription ? (
                  <TruncatedTooltipText
                    text={sa.taskDescription}
                    style={{ color: colorTextTertiary, fontSize: 13 }}
                  />
                ) : (
                  <span style={{ flex: 1 }} />
                )}
              </div>
            )
          }
          const isActive = sa.status === 'started' || sa.status === 'running'
          const isError = sa.status === 'error'
          const saLabel = isActive
            ? t('harness.assistantMessage.subAgentRunning', { name: sa.name })
            : isError
              ? t('harness.assistantMessage.subAgentError', { name: sa.name })
              : t('harness.assistantMessage.subAgentCompleted', { name: sa.name })
          const saIconColor = isError ? '#ef4444' : isActive ? '#1677ff' : '#52c41a'
          // Controlled folding (key = causeId, a unique id; falls back to position when absent)
          const saPanelKey = sa.causeId ?? `sa-${blockIndex}`
          const saOpen = isActive ? true : (saOpenOverride[saPanelKey] ?? false)

          // Recursively render the agent's nested child blocks (text / tool / reasoning / subAgent)
          const renderChildren = (children: MessageBlock[], depth = 0): React.ReactNode => {
            // Merge adjacent reasoning blocks: prevent the model from splitting reasoning into
            // token-level events, which would fill the screen with "thinking process"
            // Merge adjacent text blocks: keep streaming from splitting the body into fragments
            // such as "Good" / "," / "found"
            // Must "copy then merge": never rewrite original state objects during render (otherwise
            // the text duplicates itself on every render pass)
            const mergedChildren: MessageBlock[] = []
            for (const child of children) {
              if (child.type === 'reasoning') {
                const last = mergedChildren[mergedChildren.length - 1]
                if (last && last.type === 'reasoning') {
                  mergedChildren[mergedChildren.length - 1] = {
                    ...last,
                    reasoning: (last.reasoning || '') + (child.reasoning || '')
                  }
                  continue
                }
              }
              if (child.type === 'text') {
                const last = mergedChildren[mergedChildren.length - 1]
                if (last && last.type === 'text') {
                  mergedChildren[mergedChildren.length - 1] = {
                    ...last,
                    text: (last.text || '') + (child.text || '')
                  }
                  continue
                }
              }
              mergedChildren.push(child)
            }
            return mergedChildren.map((child, ci) => {
              if (child.type === 'reasoning' && child.reasoning) {
                return (
                  <Collapse
                    styles={COLLAPSE_HEADER_CENTERED}
                    key={ci}
                    items={[
                      {
                        key: ci,
                        label: (
                          <span style={{ color: colorTextTertiary }} className="text-xs">
                            {t('harness.assistantMessage.thinkingDone')}
                          </span>
                        ),
                        children: (
                          /* A subagent's thinking is also "thinking process": same fixed height +
                             interruptible follow; no expand control, consistent with top-level thinking */
                          <FoldBody
                            maxHeight={192}
                            expandable={false}
                            streaming={streamingFollow}
                            followSignal={followSignal}
                            className="text-xs px-1.5"
                            kind="thinking-nested"
                            borderColor={colorBorderSecondary}
                          >
                            {/* A subagent's reasoning also goes through the window: pasting a whole
                                file yields hundreds of thousands of characters */}
                            <StreamTextWindow
                              content={child.reasoning}
                              renderMarkdown={(text) => (
                                <MarkdownLoad content={text} isDarkMode={isDarkMode} />
                              )}
                            />
                          </FoldBody>
                        )
                      }
                    ]}
                    size="small"
                    style={{ marginBottom: '6px', background: collapseBg }}
                    className="rounded-lg border-0"
                  />
                )
              }
              if (child.type === 'text' && child.text) {
                return (
                  <div key={ci} style={{ color: colorText }} className="mb-1">
                    <StreamTextWindow
                      content={child.text}
                      renderMarkdown={(text) => (
                        <MarkdownLoad content={text} isDarkMode={isDarkMode} />
                      )}
                    />
                  </div>
                )
              }
              if (child.type === 'tool' && child.tool) {
                // Todo lists do not go into the body (including the subagent level, see the note in
                // renderBlockAt above): the plan is carried by the segment-header snapshot and the
                // live task card above the input box, leaving only the actual work in the body.
                if (child.tool.name === 'write_todos' || child.tool.name === 'read_todos') {
                  return null
                }
                const isPreparing = child.tool.status === 'preparing'
                const isExecuting =
                  child.tool.status === 'executing' || (!child.tool.status && !child.tool.output)
                const inProgress = Boolean(message.loading) && (isPreparing || isExecuting)
                const phase: 'preparing' | 'executing' | undefined = inProgress
                  ? isPreparing
                    ? 'preparing'
                    : 'executing'
                  : undefined
                const toolName = child.tool.name || t('harness.assistantMessage.toolCallFallback')
                // Mnemon memory tool (nested): in progress = glossy status card; completed =
                // dedicated result card
                if (
                  toolName.startsWith('mnemon_') &&
                  (MEMORY_READ_TOOLS.includes(toolName) || MEMORY_WRITE_TOOLS.includes(toolName))
                ) {
                  if (child.tool.status === 'completed') {
                    return renderMemoryToolCard(child.tool, ci, true)
                  }
                  if (phase) return renderMemoryInProgressCard(child.tool, ci, true, phase)
                }
                // Delivered files (present, nested): as above
                if (toolName === 'present' && child.tool.status === 'completed') {
                  return renderPresentCard(child.tool, ci, true)
                }
                // propose_action (nested): likewise leaves no trace in the message stream
                if (toolName === 'propose_action') {
                  return null
                }
                // System tools (nested): in-progress and completed share the same card (the gloss
                // sweeps only while running)
                if (CARD_TOOLS.has(toolName)) {
                  if (phase) return renderToolCard(child.tool, ci, true, phase)
                  if (child.tool.card && child.tool.status === 'completed') {
                    return renderToolCard(child.tool, ci, true)
                  }
                }
                // Other tools (including abnormal completed states with no card data): generic
                // collapse, glossy header while running + input/output details
                const toolLabel = getToolStatusLabel(t, toolName, phase)
                // The in-progress header shows the same icon as the tool's completed custom card;
                // MCP / mnemon fall back to a prefix; others show none
                const inProgressIcon = inProgress && toolIconFor(toolName)
                return (
                  <Collapse
                    styles={COLLAPSE_HEADER_CENTERED}
                    key={ci}
                    items={[
                      {
                        key: ci,
                        label: (
                          <span style={{ color: colorTextSecondary }} className="text-xs">
                            {inProgress ? (
                              <ShinyText baseColor={colorTextSecondary}>{toolLabel}</ShinyText>
                            ) : (
                              toolLabel
                            )}
                          </span>
                        ),
                        collapsible: inProgress ? 'disabled' : undefined,
                        children: (
                          <FoldBody
                            maxHeight={192}
                            expandable={false}
                            streaming={streamingFollow}
                            followSignal={followSignal}
                            className="ml-2 px-1.5"
                            kind="tool-nested"
                          >
                            <div
                              style={{ color: colorTextSecondary }}
                              className="font-medium mb-1 text-xs"
                            >
                              {t('harness.assistantMessage.toolInput')}
                            </div>
                            <pre
                              style={{ background: codeBg }}
                              className="p-2 rounded text-xs overflow-x-auto"
                            >
                              {JSON.stringify(child.tool.input, null, 2)}
                            </pre>
                            {child.tool.output ? (
                              <>
                                <div
                                  style={{ color: colorTextSecondary }}
                                  className="font-medium mt-2 mb-1 text-xs"
                                >
                                  {t('harness.assistantMessage.toolOutput')}
                                </div>
                                <ToolTextPreview
                                  text={
                                    typeof child.tool.output === 'string'
                                      ? child.tool.output
                                      : JSON.stringify(child.tool.output, null, 2)
                                  }
                                  codeBg={codeBg}
                                />
                              </>
                            ) : null}
                          </FoldBody>
                        )
                      }
                    ]}
                    expandIcon={
                      inProgressIcon
                        ? () => (
                            <ShinyIcon
                              icon={inProgressIcon}
                              size={12}
                              baseColor={colorTextSecondary}
                            />
                          )
                        : undefined
                    }
                    defaultActiveKey={[]}
                    size="small"
                    style={{ marginBottom: '4px', background: collapseBg }}
                    className="rounded-lg border-0"
                  />
                )
              }
              if (child.type === 'subAgent' && child.subAgent) {
                const childSa = child.subAgent
                const childIsActive = childSa.status === 'started' || childSa.status === 'running'
                const childIsError = childSa.status === 'error'
                const childSaLabel = childIsActive
                  ? t('harness.assistantMessage.subAgentRunning', { name: childSa.name })
                  : childIsError
                    ? t('harness.assistantMessage.subAgentError', { name: childSa.name })
                    : t('harness.assistantMessage.subAgentCompleted', { name: childSa.name })
                const childSaIconColor = childIsError
                  ? '#ef4444'
                  : childIsActive
                    ? '#1677ff'
                    : '#52c41a'
                // Nested fold is controlled (key = child conversation causeId, or parent id +
                // position fallback)
                const childSaPanelKey = childSa.causeId ?? `nsa:${sa.causeId ?? blockIndex}:c${ci}`
                const childSaOpen = childIsActive
                  ? true
                  : (saOpenOverride[childSaPanelKey] ?? false)
                return (
                  <Collapse
                    styles={COLLAPSE_HEADER_CENTERED}
                    // Use the array index as the key (fix: the previous `name-${isActive?'a':'d'}`
                    // forced a new key whenever the state flipped, remounting the Collapse and
                    // losing
                    // its expanded state; two delegations to a same-named subagent also produced
                    // duplicate keys, making React reuse the wrong element)
                    key={`nested-sa-${ci}`}
                    items={[
                      {
                        key: ci,
                        label: (
                          <span className="flex items-center gap-2">
                            {childIsActive ? (
                              <ShinyIcon
                                icon={RiAiAgentLine}
                                size={12}
                                baseColor={childSaIconColor}
                              />
                            ) : (
                              <RiAiAgentLine size={12} style={{ color: childSaIconColor }} />
                            )}
                            <span style={{ color: colorTextSecondary }} className="text-xs">
                              {childIsActive ? (
                                <ShinyText baseColor={colorTextSecondary}>{childSaLabel}</ShinyText>
                              ) : (
                                childSaLabel
                              )}
                            </span>
                          </span>
                        ),
                        collapsible: childIsActive ? 'disabled' : undefined,
                        children: (
                          <FoldBody
                            maxHeight={192}
                            expandable={false}
                            streaming={streamingFollow}
                            followSignal={followSignal}
                            className="pl-2 px-1.5"
                            kind="subagent-nested"
                          >
                            {childSa.taskDescription ? (
                              <div style={{ color: colorTextSecondary }} className="text-xs mb-1">
                                {childSa.taskDescription}
                              </div>
                            ) : null}
                            {child.children && child.children.length > 0 ? (
                              <>
                                {renderChildren(child.children, depth + 1)}
                                {childIsActive && !lastChildIsActiveTool(child.children) ? (
                                  <SilenceGeneratingHint
                                    loading
                                    hasStartedContent
                                    getLastChunkAt={getLastChunkAt}
                                    color={colorTextSecondary}
                                    size={12}
                                  />
                                ) : null}
                              </>
                            ) : childSa.error ? (
                              <div style={{ color: '#ef4444' }} className="text-xs">
                                {childSa.error}
                              </div>
                            ) : null}
                          </FoldBody>
                        )
                      }
                    ]}
                    activeKey={childSaOpen ? [ci] : []}
                    onChange={(keys) => {
                      if (!childIsActive) {
                        setSaOpenOverride((m) => ({
                          ...m,
                          [childSaPanelKey]: keys.includes(String(ci))
                        }))
                      }
                    }}
                    size="small"
                    style={{
                      marginBottom: '4px',
                      background: collapseBg,
                      marginLeft: 8 + depth * 8
                    }}
                    className="rounded-lg border-0"
                  />
                )
              }
              return null
            })
          }

          return (
            <Collapse
              styles={COLLAPSE_HEADER_CENTERED}
              // Use the array index as the key (fix: a changing key on state flips remounted the
              // Collapse and lost its expanded state; two delegations to a same-named subagent
              // produced duplicate keys, making React reuse the wrong element)
              key={`sa-${blockIndex}`}
              items={[
                {
                  key: blockIndex,
                  label: (
                    <span className="flex items-center gap-2">
                      {isActive ? (
                        <ShinyIcon icon={RiAiAgentLine} size={14} baseColor={saIconColor} />
                      ) : (
                        <RiAiAgentLine size={14} style={{ color: saIconColor }} />
                      )}
                      <span style={{ color: colorTextSecondary }}>
                        {isActive ? (
                          <ShinyText baseColor={colorTextSecondary}>{saLabel}</ShinyText>
                        ) : (
                          saLabel
                        )}
                      </span>
                    </span>
                  ),
                  collapsible: isActive ? 'disabled' : undefined,
                  children: (
                    <FoldBody
                      maxHeight={256}
                      expandable={false}
                      streaming={streamingFollow}
                      followSignal={followSignal}
                      className="pl-2 px-1.5"
                      kind="subagent"
                    >
                      {sa.taskDescription ? (
                        <div style={{ color: colorTextSecondary }} className="text-sm mb-2">
                          <MarkdownLoad content={sa.taskDescription} isDarkMode={isDarkMode} />
                        </div>
                      ) : null}
                      {block.children && block.children.length > 0 ? (
                        <>
                          {renderChildren(block.children)}
                          {/* Subagent stream silence: content already emitted but no new event past the
                              threshold (the model is generating tool arguments) and the last child
                              block is not an in-progress tool card → show "generating…" */}
                          {isActive && !lastChildIsActiveTool(block.children) ? (
                            <SilenceGeneratingHint
                              loading
                              hasStartedContent
                              getLastChunkAt={getLastChunkAt}
                              color={colorTextSecondary}
                              size={12}
                            />
                          ) : null}
                        </>
                      ) : isActive ? (
                        <div style={{ color: colorTextTertiary }} className="text-sm italic">
                          {t('harness.assistantMessage.subAgentExecuting')}
                        </div>
                      ) : sa.error ? (
                        <div style={{ color: '#ef4444' }} className="text-sm">
                          {sa.error}
                        </div>
                      ) : null}
                    </FoldBody>
                  )
                }
              ]}
              activeKey={saOpen ? [blockIndex] : []}
              onChange={(keys) => {
                // Folding is disabled while running (collapsible: disabled), so this only handles
                // manual expand/collapse after completion/error
                if (!isActive) {
                  setSaOpenOverride((m) => ({
                    ...m,
                    [saPanelKey]: keys.includes(String(blockIndex))
                  }))
                }
              }}
              size="small"
              style={{ marginBottom: '6px', background: collapseBg }}
              className="rounded-lg border-0"
            />
          )
        }
        return null
      }

      /** Render one block (through the block cache): block identity + cross-block derived values
       * make up the cache signature */
      const renderBlockAt = (blockIndex: number): React.ReactNode => {
        const block = mergedBlocks[blockIndex]
        // Cache signature: besides block identity it carries the derived "cross-block dependency"
        // value (currently only the thinking-done state).
        // Omitting it would hit a stale cache when new blocks are appended — the simulation diff
        // (incremental vs cold start) catches this kind of bug.
        const sig = `${blockIndex}|${hasContentAfterFlags[blockIndex] ? 1 : 0}`
        const hit = blockNodes.map.get(block)
        if (hit && hit.sig === sig) return hit.node
        const node = renderBlock(block, blockIndex)
        blockNodes.map.set(block, { sig, node })
        return node
      }

      /** Task checklist (shown only after clicking the list icon on the fold header): status glyphs +
       *  entries, taken from the segment's last write_todos snapshot */
      const renderTaskChecklist = (segment: TaskSegment): React.ReactNode => (
        <div
          data-task-checklist
          className="harness-scrollbar"
          style={{
            maxHeight: 220,
            overflowY: 'auto',
            margin: '0 0 8px',
            paddingLeft: 2,
            borderLeft: `2px solid ${colorBorderSecondary}`
          }}
        >
          {segment.snapshot.map((item, i) => {
            const itemDone = item.status === 'completed'
            const itemRunning = item.status === 'in_progress'
            return (
              <div key={i} className="flex items-start gap-2" style={{ padding: '3px 0 3px 10px' }}>
                {itemDone ? (
                  <RiCheckboxCircleLine
                    size={13}
                    // Completed = green (same semantics as the status dot on the segment header)
                    style={{ color: token.colorSuccess, marginTop: 3, flexShrink: 0 }}
                  />
                ) : (
                  <RiCheckboxBlankCircleLine
                    size={13}
                    style={{
                      color: itemRunning ? token.colorPrimary : colorBorderSecondary,
                      marginTop: 3,
                      flexShrink: 0
                    }}
                  />
                )}
                <span
                  style={{
                    fontSize: 12,
                    lineHeight: '18px',
                    color: itemDone ? colorTextTertiary : colorTextSecondary,
                    wordBreak: 'break-word'
                  }}
                >
                  {item.content}
                </span>
              </div>
            )
          })}
        </div>
      )

      /**
       * Render by task segment (2026-09-18: message content folds by task).
       *
       * - The fold looks exactly like any other collapsible content: antd Collapse (collapseBg +
       *   rounded-lg border-0 + size=small) with a small secondary label — no home-grown header;
       * - the body **no longer renders write_todos tool cards** (the task header already repeats
       *   them): the checklist is expanded on demand from the list icon right of the label;
       * - `destroyOnHidden` unmounts children when folded: render cost is proportional to the number
       *   of mounted blocks (measured on the simulation rig: 375 blocks 253~305KB per flush, 80
       *   blocks 77KB), which is the point of folding;
       * - segmentation is driven by write_todos snapshots in the stream (see buildTaskSegments) and
       *   needs no storage-layer change;
       * - default fold state: **while streaming** only completed segments fold while the running and
       *   last segments stay expanded (you have to see what is being done); **once a turn ends, or
       *   for historical messages loaded from the database, everything folds** (requirement:
       *   historical messages fold by default and blocks fold once finished). Note the last segment
       *   usually continues with the "final answer body" — that part is lifted out of the fold and
       *   always shown (see answerIndices), otherwise folding would hide the answer.
       * - **only task segments fold** (user, 2026-09-25: "only tasks fold"): the segment before the
       *   first write_todos no longer gets an "early exploration" fold shell and its content is laid
       *   out as is (see the comment at `if (!segment.task)` below).
       */
      const segments = buildTaskSegments(mergedBlocks, { streaming: Boolean(message.loading) })
      const lastSegIndex = segments.length - 1
      /**
       * Wrap-up phase: where the model wrapped up the checklist itself (the last `write_todos` has
       * at least one completed item and no in_progress). ≥0 means "the work is done and what flows
       * out next is the answer delivered to the user", so the trailing content can be rendered
       * outside the fold while still streaming (criterion: harnessHelpers.answerPhaseFrom).
       */
      const answerPhaseAt = answerPhaseFrom(mergedBlocks)
      /**
       * "Final answer" blocks to render outside the fold: **computed once for the whole message**;
       * the segment loop only intersects with its own range.
       *
       * It must be computed over the whole message, not over a per-segment index list: write_todos
       * blocks are not part of a segment's content indices, so a reverse scan inside a segment would
       * **step over the wrap-up write** and keep going backwards, counting the line about the
       * previous task as part of the answer (caught by fixtures C⑤/C⑦).
       */
      const answerBlockSet = ((): Set<number> => {
        const allBlockIndices = mergedBlocks.map((_, i) => i)
        if (!message.loading) {
          if (message.answer instanceof Set) return message.answer
          // The protocol layer says explicitly that there is no answer (aborted / tools and
          // thinking only)
          if (message.answer === null) return new Set<number>()
          // The main process gave no conclusion (older version / abnormal path): fall back to the
          // reverse scan
          return new Set(tailContentIndices(mergedBlocks, allBlockIndices))
        }
        // While streaming: lift only once the wrap-up phase is reached (the trailing part always
        // follows the wrap-up write)
        if (answerPhaseAt < 0) return new Set<number>()
        return new Set(tailContentIndices(mergedBlocks, allBlockIndices))
      })()

      /**
       * Segment shell: the fold looks exactly like "thinking process" and "subagent" (antd Collapse +
       * collapseBg + size=small).
       *
       * The segment body also goes through FoldBody (user, 2026-09-19: "this content needs folding
       * too") — an expanded segment is no longer a wall growing taller as the task runs, but
       * **fixed height + internal scrolling**; while streaming it follows the latest step at the
       * bottom, the user scrolling up interrupts it, and it resumes automatically when scrolled back
       * to the bottom; when content overflows a "show all" control appears outside the box. The
       * thinking box does not get this control (see the comment at the thinking body box): only
       * segment content keeps it.
       */
      const renderSegmentShell = (args: {
        segKey: string
        label: React.ReactNode
        collapsed: boolean
        children: React.ReactNode
        /** Content always shown outside the fold (the last segment's final answer body) */
        tail?: React.ReactNode
      }): React.ReactNode => (
        <React.Fragment key={args.segKey}>
          <Collapse
            styles={COLLAPSE_HEADER_CENTERED}
            items={[
              {
                key: args.segKey,
                label: args.label,
                children: (
                  <FoldBody
                    maxHeight={SEGMENT_BODY_MAX_HEIGHT}
                    streaming={streamingFollow}
                    followSignal={followSignal}
                    kind="segment"
                  >
                    {args.children}
                  </FoldBody>
                )
              }
            ]}
            activeKey={args.collapsed ? [] : [args.segKey]}
            onChange={(keys) =>
              setFoldOverride((prev) => ({ ...prev, [args.segKey]: !keys.includes(args.segKey) }))
            }
            destroyOnHidden
            size="small"
            style={{ marginBottom: args.tail ? '4px' : '6px', background: collapseBg }}
            className="task-segment-collapse rounded-lg border-0"
          />
          {args.tail}
        </React.Fragment>
      )

      /**
       * Shell for same-name tool groups (user, 2026-09-25: "consecutive identical tool calls should
       * fold together").
       *
       * The grouping rule is the pure function `buildToolRuns` (adjacent same name, ≥2 forms a group,
       * todo bookkeeping tools are transparent).
       * This only handles appearance and the default fold state, the same as segments / the thinking
       * box: antd Collapse + FoldBody (fixed height + internal scroll + "show all"), so expanding a
       * group of ten reads does not push the body into a wall either.
       *
       * The group header only carries "which tool + how many times + status dot": one click expands
       * the content, and paths from the cards are not repeated here.
       *
       * Default fold state: **do not fold while a call in the group is still running** (the same
       * "you have to see what is being done" rule — during streaming the last group is usually
       * open), everything else (whole group completed, historical messages) folds.
       *
       * **The header text matches the names inside the group** (user, 2026-11-27: "the name that
       * needs folding should be the same, both in the large font"): the header used to be hard-coded
       * as a 12px + secondary-color small label, while every tool fold header inside the group
       * inherits antd's `token.fontSize` (14px) and `token.colorText` — the same `get_weather` looked
       * small and grey in the header but large and white inside, so folded and expanded looked like
       * two different things. The header now takes the token's font size / line height and the body
       * text color, aligning item by item with the names inside the group: what you see folded is
       * this large text, and each row inside stays the same large text after expanding.
       */
      const renderToolRun = (entry: Extract<ToolRunEntry, { kind: 'run' }>): React.ReactNode => {
        const runKey = `toolrun-${entry.indices[0]}-${entry.name}`
        const members = entry.indices.map((i) => mergedBlocks[i])
        const activeNow =
          Boolean(message.loading) &&
          members.some((block) => {
            const status = block?.tool?.status
            return (
              status === 'preparing' || status === 'executing' || (!status && !block?.tool?.output)
            )
          })
        const allDone = members.every((block) => block?.tool?.status === 'completed')
        const collapsed = foldOverride[runKey] ?? !activeNow
        /**
         * Group header icon: **do not place `<RunIcon/>` when the tool name is unknown**.
         *
         * `TOOL_IN_PROGRESS_ICONS` only lists built-in tool names, while MCP (`mcp__…`) and Mnemon
         * (`mnemon_…`) are names only known at runtime, so they go through `toolIconFor`'s **prefix
         * fallback**; when still unrecognized no icon must be placed — rendering an undefined
         * component throws "Element type is invalid … Check the render method of `AssistantMessage`"
         * and blanks the whole message (this was hit once: the fixture contained only read_file /
         * grep, which all happen to be in the table, so this path was missed). Consistent with the
         * fallback at the per-card render site.
         */
        const RunIcon = toolIconFor(entry.name)
        const headLabel = (
          <span
            data-tool-run={entry.name}
            data-tool-run-count={entry.indices.length}
            className="flex items-center min-w-0"
            style={{ width: '100%', gap: 8 }}
          >
            {RunIcon ? (
              <RunIcon size={14} style={{ color: colorTextSecondary, flex: '0 0 auto' }} />
            ) : null}
            {/* The group name uses the same font size and color as the fold header names inside the
                group (user decision, 2026-11-27): size/line height come from antd's token and the
                color from the body text color — every fold header inside the group is styled this
                way by `resetComponent`, so a hard-coded 12px/secondary color here would look "small
                when folded, large when expanded". */}
            <span
              style={{
                flex: '1 1 auto',
                fontSize: token.fontSize,
                lineHeight: token.lineHeight,
                color: colorText,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                textAlign: 'left'
              }}
            >
              {entry.name}
            </span>
            {/* Status dot + count: dot and number are centered together inside the pill (see countPill).
                This cell is "how many times the same-name tool was called" in the fold header; the task
                segment header's "how many steps remain in this segment" shares the same pill and is
                told apart only by the header it sits in, so the number gets no `×` prefix */}
            {countPill(
              entry.indices.length,
              activeNow ? token.colorPrimary : allDone ? token.colorSuccess : colorBorderSecondary
            )}
          </span>
        )
        return (
          <Collapse
            key={runKey}
            styles={COLLAPSE_HEADER_CENTERED}
            items={[
              {
                key: runKey,
                label: headLabel,
                children: (
                  <FoldBody
                    maxHeight={SEGMENT_BODY_MAX_HEIGHT}
                    streaming={streamingFollow}
                    followSignal={followSignal}
                    kind="tool-run"
                  >
                    {entry.indices.map(renderBlockAt)}
                  </FoldBody>
                )
              }
            ]}
            activeKey={collapsed ? [] : [runKey]}
            onChange={(keys) =>
              setFoldOverride((prev) => ({ ...prev, [runKey]: !keys.includes(runKey) }))
            }
            destroyOnHidden
            size="small"
            style={{ marginBottom: '6px', background: collapseBg }}
            className="tool-run-collapse rounded-lg border-0"
          />
        )
      }

      /** Body block sequence: single blocks still go through the block cache, same-name tool groups
       * use the group shell */
      const renderBlockSequence = (indices: number[]): React.ReactNode =>
        buildToolRuns(mergedBlocks, indices).map((entry) =>
          entry.kind === 'run' ? renderToolRun(entry) : renderBlockAt(entry.index)
        )

      return segments.map((segment, segIndex) => {
        // Body blocks: skip write_todos (the checklist is handled separately), the rest still go
        // through the block cache
        const allIndices = segment.blockIndices.filter((i) => !segment.writeIndices.includes(i))
        /**
         * Lift the trailing "thinking + text" of the last segment outside the fold so it is always
         * shown.
         *
         * - Text (consecutive text blocks) = the final answer, which must be lifted, otherwise
         *   folding hides the answer;
         * - the **thinking blocks** right before it (consecutive reasoning blocks) are lifted too:
         *   they are the step that produced this answer, and leaving them in the fold would make the
         *   answer appear out of nowhere (requirement: thinking should accompany the trailing
         *   content). Tool cards break the backtracking — thinking separated by a tool is not
         *   continuous with the trailing answer, and forcing the lift would scramble the order;
         * - at least one text block must be lifted for this to apply: when the segment ends with
         *   thinking (e.g. the turn was aborted), nothing is lifted and the fold keeps it all, so a
         *   whole "message without an answer" is never moved outside;
         * - **no distinction on "is there a task"**: the exploration segment (before the first
         *   write_todos) is now always laid out flat, and ordinary Q&A has to be lifted the same way
         *   (caught on the simulation rig: when the lift was missed the ordinary answer body
         *   disappeared entirely).
         *
         * **Before the turn ends it is lifted only in the "wrap-up phase"** (the rule chosen on
         * 2026-09-25): while streaming, only when the model **wrapped up the checklist itself** (at
         * least one item completed in the last `write_todos` and no in_progress — in real sessions
         * the final answer follows right after that write) is the trailing "thinking + text"
         * rendered outside the fold as it streams; every other case (the sentence when each task
         * ends, thinking while a task is running) stays inside the task segment fold / the flat
         * exploration area, never moved out and never taken back. The criterion is `answerPhaseFrom`
         * (pure block data, it does not guess from loading).
         *
         * When the turn ends (done): freeze on the protocol-layer conclusion — use `message.answer`
         * when it is a `Set`; `undefined` (the main process gave no conclusion: older version /
         * abnormal path) falls back to the reverse scan; `null` (explicitly no answer) lifts
         * nothing. This fallback covers turns where "the model forgot to write the wrap-up
         * checklist" (there the final answer can only be fixed when the turn ends, because while
         * streaming no data signal separates the final answer from "the sentence for each task").
         */
        const answerIndices = allIndices.filter((i) => answerBlockSet.has(i))
        /**
         * Splitting must **filter by set**, never subtract `answerIndices.length`: the protocol-layer
         * answer boundary is a set of "the trailing N blocks", and once it is not contiguous with
         * this segment's indices (e.g. the answer spans segments, or the marker/block correspondence
         * drifts), subtracting lengths yields a negative length and swallows the whole segment.
         * Filtering both sides by the set only ever lifts too little, never cuts wrongly, whatever
         * the shape.
         */
        const answerSet = new Set(answerIndices)
        const visibleIndices = allIndices.filter((i) => !answerSet.has(i))
        // Consecutive same-name tool calls are merged into fold groups here (see
        // renderBlockSequence / buildToolRuns)
        const blocksNode = renderBlockSequence(visibleIndices)
        const answerNode = answerIndices.map(renderBlockAt)

        /**
         * Which files this segment changed (derived from the write_file / edit_file blocks in it).
         *
         * This is the answer to "are the changes still visible in the chat after folding": when the
         * segment body folds the cards are unmounted, but this header badge sits outside the fold —
         * the user sees at a glance "this segment touched 1 file and 3 places are still unreviewed",
         * and one click opens the diff view.
         *
         * Counts come from `pendingByPath` (the main process's pending review list); retained ones
         * are not counted again. Note the **path shapes differ**: `file_path` in a block is a virtual
         * path (`/frontend/README.md`), while the pending list contains real absolute paths
         * (`E:\...\frontend\README.md`), so a direct lookup finds nothing (this was hit: the badge
         * text turned empty). Both sides are therefore indexed by "normalized separators + lowercase
         * + last segment".
         */
        const pathKey = (raw: string): string =>
          raw.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
        const pathTail = (raw: string): string => {
          const key = pathKey(raw)
          const at = key.lastIndexOf('/')
          return at >= 0 ? key.slice(at + 1) : key
        }
        const pendingIndex = (() => {
          const byFull = new Map<string, number>()
          const byTail = new Map<string, number>()
          for (const [path, count] of pendingByPath ?? []) {
            const full = pathKey(path)
            byFull.set(full, count)
            const tail = pathTail(path)
            byTail.set(tail, (byTail.get(tail) ?? 0) + count)
          }
          return { byFull, byTail }
        })()
        const pendingFor = (path: string): number => {
          const full = pathKey(path)
          const direct = pendingIndex.byFull.get(full)
          if (direct !== undefined) return direct
          // When the virtual path (/frontend/README.md) does not match a real path, fall back to
          // the
          // file name: several files may share it, and over-reporting one place is acceptable (the
          // badge is only a hint, what opens is the real diff)
          return pendingIndex.byTail.get(pathTail(path)) ?? 0
        }
        const changedFiles = (() => {
          const paths: string[] = []
          for (const blockIndex of segment.blockIndices) {
            const block = mergedBlocks[blockIndex]
            if (block?.type !== 'tool') continue
            const name = block.tool?.name
            if (name !== 'write_file' && name !== 'edit_file') continue
            const input = (block.tool?.input ?? {}) as { file_path?: unknown }
            const path = typeof input.file_path === 'string' ? input.file_path : ''
            if (path && !paths.includes(path)) paths.push(path)
          }
          let pendingCount = 0
          for (const path of paths) pendingCount += pendingFor(path)
          return { paths, pendingCount }
        })()
        /** Segment-header change badge: appears only when there really are changes (ordinary Q&A
         * should not gain an extra decorative row) */
        const changedChip =
          changedFiles.paths.length > 0 ? (
            <button
              type="button"
              data-segment-changes={changedFiles.paths.length}
              data-segment-pending={changedFiles.pendingCount}
              onClick={(e) => {
                // Do not bubble to the Collapse label: clicking the badge means "go see the diff",
                // not "fold this segment"
                e.stopPropagation()
                const target = changedFiles.paths[changedFiles.paths.length - 1]
                if (target) onOpenChangedFile?.(target)
              }}
              disabled={!onOpenChangedFile}
              title={t('harness.assistantMessage.changedFilesTip', {
                files: changedFiles.paths.length,
                pending: changedFiles.pendingCount
              })}
              className="flex items-center border-none cursor-pointer"
              style={{
                flex: '0 0 auto',
                gap: 3,
                padding: '0 5px',
                height: 16,
                borderRadius: 9,
                background: 'transparent',
                color: changedFiles.pendingCount > 0 ? '#c98a2b' : colorTextTertiary
              }}
            >
              <RiPencilLine size={12} />
              <span style={{ fontSize: 11, lineHeight: '16px', whiteSpace: 'nowrap' }}>
                {changedFiles.pendingCount > 0
                  ? t('harness.assistantMessage.changedFiles', {
                      count: changedFiles.paths.length
                    })
                  : null}
              </span>
            </button>
          ) : null
        // ── The segment before planning (before the first write_todos) ────────────────
        // User, 2026-09-25: "**no need for this early exploration thing, i.e. do not fold the
        // content
        // before it. Only tasks fold**".
        //
        // So this segment's fold shell ("early exploration" label + step pill + change badge +
        // fixed
        // height content box) is removed as a whole and its content lies in the message as is:
        // thinking blocks are still a collapsible "thinking process" and tool cards have their own
        // folds, so laying it out flat is not a wall.
        //
        // The boundary therefore simplifies to one rule: **task segments fold, everything else
        // never
        // folds**. This also resolves the original reason for the change badge (user, 2026-09-23:
        // once a segment folds, all its edit cards are unmounted) — this segment no longer folds,
        // so
        // its cards are never unmounted. The only exception: when the segment has nothing
        // displayable (the whole message is just the answer body) — then no empty shell is left and
        // the answer is returned directly.
        if (!segment.task) {
          if (visibleIndices.length === 0) return answerNode
          return (
            <React.Fragment key={segment.key}>
              <div data-segment-plain={segment.key} style={{ marginBottom: '6px' }}>
                {blocksNode}
              </div>
              {answerNode}
            </React.Fragment>
          )
        }

        /**
         * While streaming: collapse segments that are **already completed and have content still
         * being written after them**; after the turn ends, or for historical messages, always fold.
         *
         * Note `segment.status === 'completed'` does not only mean "there is a next task segment" —
         * write_todos marking this segment's task completed counts too, so at the moment "the task is
         * done and the model is writing the summary" it folds at once, without waiting for the turn
         * to end (the 2026-09-22 report "this segment is still open after it finished" refers to
         * exactly this rule; the same-origin problem back then was in the now-deleted auto-collapse
         * of the exploration segment).
         *
         * **Last segment exception** (user, 2026-09-24: the answer must not be moved out of the fold
         * or taken back in): before the turn ends the answer can only stay inside the fold (the
         * boundary is not settled yet), so the **last segment carrying it must stay open**, otherwise
         * one fold hides the content — everything folds at once when done lands, fixing the answer
         * outside the fold.
         *
         * `foldOverride` still wins: segments the user folded/unfolded manually follow the user's
         * choice.
         */
        const defaultCollapsed = message.loading
          ? segment.status === 'completed' && segIndex !== lastSegIndex
          : true
        const collapsed = foldOverride[segment.key] ?? defaultCollapsed
        const done = segment.status === 'completed'
        const active = segment.status === 'in_progress'
        const listOpen = listOpenKeys.includes(segment.key)
        const taskLabel = (
          <span
            data-task-segment={segment.key}
            className="flex items-center min-w-0"
            style={{ width: '100%', gap: 8 }}
          >
            {/* The task name takes the remaining width and can truncate, so the status dot + count pill
                and the checklist button on the right stay flush right and a long task name cannot push
                the row out of the container.
                Deliberately **no shine animation**: shiny-text is a 1.5s infinite loop while a task
                often runs for minutes, so the whole row would blink from start to finish (users
                explicitly reported "it keeps blinking"); status is expressed by the dot + bold text. */}
            <span
              style={{
                flex: '1 1 auto',
                fontSize: 12,
                lineHeight: '18px',
                color: done ? colorTextTertiary : colorTextSecondary,
                fontWeight: active ? 600 : 400,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                textAlign: 'left'
              }}
            >
              {segment.task}
            </span>
            {/* Status dot + count: dot and number centered together inside the pill (see
                countPill) */}
            {countPill(
              visibleIndices.length,
              // Completed = green, running = primary color, not started = border grey (requirement:
              // completed tasks must show green)
              done ? token.colorSuccess : active ? token.colorPrimary : colorBorderSecondary
            )}
            {/* Change badge: once the segment body folds, the only thing left saying "what changed
                this round" */}
            {changedChip}
            {segment.snapshot.length > 0 ? (
              <button
                type="button"
                onClick={(e) => {
                  // Do not bubble to the Collapse label, otherwise toggling the list folds the
                  // whole segment as well
                  e.stopPropagation()
                  setListOpenKeys((prev) =>
                    prev.includes(segment.key)
                      ? prev.filter((k) => k !== segment.key)
                      : [...prev, segment.key]
                  )
                }}
                title={t('harness.assistantMessage.taskList')}
                className="flex items-center border-none cursor-pointer"
                style={{
                  flex: '0 0 auto',
                  padding: 0,
                  background: 'transparent',
                  color: listOpen ? token.colorPrimary : colorTextTertiary
                }}
              >
                <RiListCheck size={14} />
              </button>
            ) : null}
          </span>
        )

        return renderSegmentShell({
          segKey: segment.key,
          label: taskLabel,
          collapsed,
          children: (
            <>
              {listOpen ? renderTaskChecklist(segment) : null}
              {blocksNode}
            </>
          ),
          tail: answerNode
        })
      })
    }
    return (
      <div className="flex harness-message-body">
        <div className="w-full">
          {renderBlocks()}
          {/* Streaming silence hint: the body is already on screen but no new chunk arrived past the
              threshold (the model is still generating large arguments etc.).
              It carries its own wall clock, so a tick does not re-render the whole message. */}
          {showSilenceGenerating ? (
            <SilenceGeneratingHint
              loading
              hasStartedContent={hasStartedContent}
              getLastChunkAt={getLastChunkAt}
              color={colorTextSecondary}
            />
          ) : null}
          {/* Generating indicator while only the "injected memory" card is shown (hidden during
              compaction/retry to avoid duplicating the transition rows) */}
          {message.loading &&
          !message.content &&
          !message.reasoning_content &&
          (!message.toolCalls || message.toolCalls.length === 0) &&
          hasMemoryBlock &&
          !hasCompactingBlock &&
          !hasRetryingBlock ? (
            <div className="flex items-center gap-2 mt-1" style={{ color: colorTextSecondary }}>
              <ShinyIcon icon={RiSparkling2Line} size={14} baseColor={colorTextSecondary} />
              <ShinyText baseColor={colorTextSecondary}>
                <span style={{ fontSize: 13 }}>
                  {t('harness.assistantMessage.silentGenerating')}
                </span>
              </ShinyText>
            </div>
          ) : null}
          {/* Hide the action bar while content is streaming */}
          {!message.loading && (
            <MessageActions
              message={message}
              index={index}
              turnStartedAt={turnStartedAt}
              topicId={topicId}
              usage={usage}
              readOnly={readOnly}
              onBranch={onBranch}
              getCopyText={getCopyText}
              isCopied={isCopied}
              onCopy={onCopy}
              onDelete={onDelete}
            />
          )}
        </div>
      </div>
    )
  }
)

AssistantMessage.displayName = 'AssistantMessage'

export default AssistantMessage
