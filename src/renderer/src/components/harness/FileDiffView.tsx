import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Dropdown, Tooltip } from 'antd'
import dayjs from 'dayjs'
import {
  RiArrowDownLine,
  RiArrowUpLine,
  RiCheckLine,
  RiCloseLine,
  RiHistoryLine,
  RiAlertLine,
  RiArrowGoBackLine
} from '@remixicon/react'
import { type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import {
  acceptChunk,
  goToNextChunk,
  goToPreviousChunk,
  rejectChunk,
  unifiedMergeView
} from '@codemirror/merge'
import CodeEditor from './CodeEditor'
import { chunkActionGutter } from '../../utils/harness/cmChunkActions'
import { computeMergeStats } from '../../utils/harness/mergeStats'
import type { EditorPaletteInput } from '../../utils/harness/cmTheme'
import type { FileChangeView } from '../../types/harness/file-change'
import { useTranslation } from '@renderer/i18n'
import { harnessApi } from '../../api/harness'

/** Toolbar button: **icon only** (text lives in Tooltip/aria-label), sized to fit its content */
interface DiffToolbarButtonProps {
  title: string
  icon: React.ReactNode
  onClick?: () => void
  disabled?: boolean
  /** Semantic tone (keep = green, revert = red) */
  tone?: 'default' | 'accept' | 'reject'
  colorText: string
  colorTextSecondary: string
  colorBorderSecondary: string
  isDarkMode: boolean
  /** Extra trailing style (the group after the divider uses it to push the buttons over) */
  style?: React.CSSProperties
  testId?: string
}

const DiffToolbarButton: React.FC<DiffToolbarButtonProps> = ({
  title,
  icon,
  onClick,
  disabled,
  tone = 'default',
  colorText,
  colorTextSecondary,
  colorBorderSecondary,
  isDarkMode,
  style,
  testId
}) => {
  const toneStyle: React.CSSProperties =
    tone === 'accept'
      ? {
          borderColor: 'transparent',
          background: isDarkMode ? 'rgba(120,190,140,0.16)' : 'rgba(70,150,100,0.12)',
          color: isDarkMode ? '#9ecf8a' : '#2f6b4f'
        }
      : tone === 'reject'
        ? {
            borderColor: 'transparent',
            background: isDarkMode ? 'rgba(220,120,100,0.16)' : 'rgba(180,70,50,0.10)',
            color: isDarkMode ? '#e08a70' : '#a8442a'
          }
        : {}
  const baseColor = toneStyle.color ?? colorTextSecondary
  return (
    /* These buttons are only used in the diff view's **top action row** (keep/revert/previous/next),
       so tooltips open downward: upward tooltips would cover the editor toolbar and tab bar. */
    <Tooltip title={title} placement="bottom">
      <button
        type="button"
        data-diff-btn={testId}
        aria-label={title}
        title={title}
        disabled={disabled}
        onClick={onClick}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          width: 24,
          height: 22,
          padding: 0,
          borderRadius: 4,
          border: `1px solid ${colorBorderSecondary}`,
          background: 'transparent',
          color: colorTextSecondary,
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.45 : 1,
          ...toneStyle,
          ...style
        }}
        onMouseEnter={(e) => {
          if (disabled) return
          if (tone === 'default') {
            e.currentTarget.style.borderColor = colorText
            e.currentTarget.style.color = colorText
          } else {
            // Semantic-tone buttons already have a full background: hover only brightens the border, don't change the text color to something that can't be restored
            e.currentTarget.style.borderColor = baseColor
          }
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor =
            tone === 'default' ? colorBorderSecondary : 'transparent'
          e.currentTarget.style.color = baseColor
        }}
      >
        {icon}
      </button>
    </Tooltip>
  )
}

interface FileDiffViewProps {
  /** Real file path (language highlighting + history lookup) */
  filePath: string
  /** Change currently displayed */
  change: FileChangeView
  /** All pending changes for this file (ascending: oldest first) */
  pending: FileChangeView[]
  /** Current document of the diff editor (= tab content; per-chunk decisions modify it) */
  value: string
  isDarkMode: boolean
  palette: EditorPaletteInput
  colorText: string
  colorTextSecondary: string
  colorTextTertiary: string
  colorBorderSecondary: string
  isDirty: boolean
  /** Per-chunk accept/reject / direct editing of the diff document */
  onChange: (value: string) => void
  /** Ctrl+S: persist the review result (write the file + mark as kept) */
  onApplyReview: (content: string) => void
  /** Keep (clear pending-review marks) */
  onKeep: (ids: number[]) => void
  /** Revert to before a given change */
  onRevert: (id: number) => void
  /** Switch the history view to a given change */
  onSelectChange: (id: number) => void
}

/**
 * Labels for change source / review status.
 * Uses switch instead of building string keys: i18n keys are literal union types, so keys built
 * from template strings do not type-check. Defined inside the component to capture t via closure
 * (i18next's t type carries overloads; annotating it as a separate function parameter blows up inference).
 */
function useChangeLabels(): {
  sourceLabel: (source: FileChangeView['source']) => string
  statusLabel: (status: FileChangeView['status']) => string
} {
  const { t } = useTranslation()
  const sourceLabel = (source: FileChangeView['source']): string => {
    switch (source) {
      case 'write_file':
        return t('harness.fileDiff.sourceWrite')
      case 'edit_file':
        return t('harness.fileDiff.sourceEdit')
      case 'execute':
        return t('harness.fileDiff.sourceExecute')
      case 'external':
        return t('harness.fileDiff.sourceExternal')
      default:
        return t('harness.fileDiff.sourceReview')
    }
  }
  const statusLabel = (status: FileChangeView['status']): string => {
    switch (status) {
      case 'pending':
        return t('harness.fileDiff.statusPending')
      case 'kept':
        return t('harness.fileDiff.statusKept')
      case 'reverted':
        return t('harness.fileDiff.statusReverted')
      default:
        return t('harness.fileDiff.statusObsolete')
    }
  }
  return { sourceLabel, statusLabel }
}

/**
 * File diff view (review panel for model changes).
 *
 * Uses the unified merge view from @codemirror/merge: the current document = the file as it is
 * (editable), and the pre-change content is shown inline as original (deleted lines inlined as
 * chunks, added lines highlighted).
 *
 * Three review granularities:
 * 1. **Whole change**: the toolbar's "keep all / revert all changes" (goes through the main process, writes back the pre-change snapshot);
 * 2. **Single chunk**: with the cursor on a chunk, "keep this / revert this" (CodeMirror's acceptChunk/rejectChunk);
 * 3. **Free editing**: edit directly in the diff and press Ctrl+S to persist it as the "review result" (automatically marked as kept).
 */
const FileDiffView: React.FC<FileDiffViewProps> = ({
  filePath,
  change,
  pending,
  value,
  isDarkMode,
  palette,
  colorText,
  colorTextSecondary,
  colorTextTertiary,
  colorBorderSecondary,
  isDirty,
  onChange,
  onApplyReview,
  onKeep,
  onRevert,
  onSelectChange
}) => {
  const { t } = useTranslation()
  const { sourceLabel, statusLabel } = useChangeLabels()
  const viewRef = useRef<EditorView | null>(null)
  /**
   * Accept/reject by position (used by the change-gutter buttons).
   *
   * Uses refs instead of passing callbacks into the extension: chunkActionGutter's extension is
   * built in useMemo, so a changed callback identity would reconfigure the whole editor (losing
   * undo history and scroll position). The extension therefore always calls the same function,
   * which reads the latest view internally.
   */
  const acceptAtRef = useRef<(pos: number) => void>(() => {})
  const rejectAtRef = useRef<(pos: number) => void>(() => {})
  acceptAtRef.current = (pos: number): void => {
    const view = viewRef.current
    if (!view) return
    acceptChunk(view, pos)
    view.focus()
  }
  rejectAtRef.current = (pos: number): void => {
    const view = viewRef.current
    if (!view) return
    rejectChunk(view, pos)
    view.focus()
  }
  const [original, setOriginal] = useState<string | null>(null)
  /** Content after the model wrote it (= current disk state): tells whether the user made any per-chunk decisions in the diff */
  const [modelContent, setModelContent] = useState<string | null>(null)
  const [stats, setStats] = useState<{ chunks: number; added: number; removed: number } | null>(
    null
  )
  const [history, setHistory] = useState<FileChangeView[]>([])

  /** Stats label (left of the toolbar): changes with the diff result; the adaptive toolbar uses it to compute space */
  const statsText = stats
    ? t('harness.fileDiff.stats', {
        count: stats.chunks,
        added: stats.added,
        removed: stats.removed
      })
    : ''

  const isPending = change.status === 'pending'
  const latestPendingId = pending.length > 0 ? pending[pending.length - 1].id : null
  // Only the latest pending change may be edited in the diff:
  // deciding on an older change would drag the file back to an old state, implicitly reverting later changes
  const canEdit = isPending && change.id === latestPendingId && change.hasBefore
  /** The diff document matches the disk exactly (the user has not decided on any chunk yet) */
  const docMatchesDisk = modelContent === null || value === modelContent

  // Load the pre-change body (the diff's left/top side) + the post-change body (to tell whether decisions were made)
  useEffect(() => {
    let cancelled = false
    setOriginal(null)
    setModelContent(null)
    if (!change.hasBefore) {
      setOriginal('')
      return
    }
    const api = harnessApi
    void api.workspace.changeContent(change.id).then((content) => {
      if (cancelled) return
      setOriginal(content?.before ?? '')
      setModelContent(content?.after ?? null)
    })
    return () => {
      cancelled = true
    }
  }, [change.id, change.hasBefore])

  const refreshHistory = useCallback(() => {
    const api = harnessApi
    void api.workspace.fileChanges(filePath).then(setHistory)
  }, [filePath])

  useEffect(() => {
    refreshHistory()
  }, [refreshHistory, change.id, pending.length])

  /**
   * Adaptive toolbar: **buttons are icon-only** (per the 2026-09-22 requirement, "don't show text
   * on any of the buttons above, icons are enough"), and when the panel narrows whole segments
   * yield by priority so buttons are never squeezed out of sight.
   *
   * Two bad outcomes we hit:
   * ① with text, six buttons were ≈ 460px wide and a 450px panel overflowed horizontally
   *    (measured scrollWidth/clientWidth gap of 231px), pushing icons outside the panel;
   * ② the outer `overflow-hidden` clips the overflow, which makes `scrollWidth-clientWidth`
   *    **unreliable** (only 9px left after clipping), so we compute "sum of natural content
   *    widths vs container width" ourselves instead of relying on scrollWidth.
   *
   * Yield order (least critical dropped first): source label → stats text → unsaved hint → history entry.
   * Keep / revert / previous / next always stay in the toolbar — they are this panel's primary actions.
   */
  const toolbarRef = useRef<HTMLDivElement>(null)
  const groupRef = useRef<HTMLDivElement>(null)
  const [compact, setCompact] = useState<{ source: boolean; history: boolean; stats: boolean }>({
    source: true,
    history: true,
    stats: true
  })

  useLayoutEffect(() => {
    const bar = toolbarRef.current
    if (!bar) return

    const recompute = (): void => {
      const available = bar.clientWidth
      if (available <= 0) return
      // Natural width of the button group (including the divider): flexShrink is 0, so this is the real demand
      const groupWidth = groupRef.current ? groupRef.current.scrollWidth : 0
      // Trailing padding + group gaps: better to over-count a few pixels than to oscillate around the threshold
      const reserved = 24 + 8
      const slack = available - groupWidth - reserved
      setCompact((prev) => {
        const next = {
          // Source text (edit_file and the like) is least critical: drop it first
          source: slack >= 64,
          stats: slack >= 120,
          history: slack >= 96
        }
        if (
          prev.source === next.source &&
          prev.stats === next.stats &&
          prev.history === next.history
        ) {
          return prev
        }
        return next
      })
    }

    recompute()
    const ro = new ResizeObserver(recompute)
    ro.observe(bar)
    return () => ro.disconnect()
  }, [history.length, isDirty, statsText, canEdit, isPending])

  /**
   * Compute diff size (chunk count / added lines / removed lines).
   *
   * With a merge view the values are derived from CodeMirror's own chunk results; when there is no
   * body to compare against (new files, writes captured during command execution) it falls back
   * to **the change record's own stats** — the algorithm and edge cases live in utils/mergeStats.ts
   * (the two "cannot compute diff" returns were measured on the real editor).
   */
  const refreshStats = useCallback(
    (view: EditorView) => {
      const next = computeMergeStats(view.state, original, change)
      setStats((prev) =>
        prev &&
        prev.chunks === next.chunks &&
        prev.added === next.added &&
        prev.removed === next.removed
          ? prev
          : next
      )
    },
    [original, change]
  )

  useEffect(() => {
    if (viewRef.current) refreshStats(viewRef.current)
  }, [refreshStats, value])

  /** Merge view extensions (rebuilt when original changes / editability changes) */
  const mergeExtensions = useMemo<Extension[] | undefined>(() => {
    if (original === null || !change.hasBefore) return undefined
    return [
      unifiedMergeView({
        original,
        highlightChanges: true,
        gutter: true,
        syntaxHighlightDeletions: true,
        allowInlineDiffs: true,
        collapseUnchanged: { margin: 4, minSize: 8 },
        /**
         * The built-in mergeControls inject two **text** buttons ("keep / revert") inside deleted
         * chunks; they scroll with the chunk and sit on the right edge of the body. Set to false:
         * accept/reject buttons are drawn by chunkActionGutter in the change gutter (icons, one
         * group per chunk — see utils/cmChunkActions.ts).
         */
        mergeControls: false
      }),
      // Per-chunk accept/reject buttons in the line-number gutter: only the latest pending change is decidable; historical changes are read-only
      ...(canEdit
        ? [
            chunkActionGutter({
              acceptLabel: t('harness.fileDiff.acceptChunkTip'),
              rejectLabel: t('harness.fileDiff.rejectChunkTip'),
              onAccept: (pos) => acceptAtRef.current(pos),
              onReject: (pos) => rejectAtRef.current(pos)
            })
          ]
        : [])
    ]
  }, [original, change.hasBefore, canEdit, t])

  const runChunkCommand = useCallback((command: 'accept' | 'reject' | 'next' | 'prev') => {
    const view = viewRef.current
    if (!view) return
    if (command === 'accept') acceptChunk(view)
    else if (command === 'reject') rejectChunk(view)
    else if (command === 'next') goToNextChunk(view)
    else goToPreviousChunk(view)
    view.focus()
  }, [])

  const handleViewReady = useCallback(
    (view: EditorView) => {
      viewRef.current = view
      refreshStats(view)
    },
    [refreshStats]
  )

  const pendingIds = pending.map((item) => item.id)

  /**
   * "Keep all": which content is actually kept?
   * - The user made no decisions in the diff → the disk content is final, only clear the pending-review marks;
   * - The user decided per chunk / edited manually → persist the visible content first (applyReview), otherwise those decisions are lost.
   */
  const handleKeepAll = useCallback(() => {
    if (canEdit && !docMatchesDisk) {
      onApplyReview(value)
      return
    }
    onKeep(pendingIds)
  }, [canEdit, docMatchesDisk, onApplyReview, onKeep, pendingIds, value])

  const historyPanel = (
    <div
      className="rounded-lg overflow-hidden shadow-lg"
      style={{
        width: 320,
        background: isDarkMode ? '#252526' : '#ffffff',
        border: `1px solid ${colorBorderSecondary}`
      }}
    >
      <div
        className="px-3 py-2 text-[11px] tracking-wide"
        style={{ color: colorTextTertiary, borderBottom: `1px solid ${colorBorderSecondary}` }}
      >
        {t('harness.fileDiff.historyTitle')}
      </div>
      <div className="max-h-[280px] overflow-y-auto history-scrollbar">
        {history.length === 0 ? (
          <div className="px-3 py-4 text-xs" style={{ color: colorTextTertiary }}>
            {t('harness.fileDiff.historyEmpty')}
          </div>
        ) : (
          history.map((item) => {
            const active = item.id === change.id
            return (
              <div
                key={item.id}
                className="px-3 py-2 cursor-pointer"
                style={{
                  background: active
                    ? isDarkMode
                      ? 'rgba(255,255,255,0.06)'
                      : 'rgba(0,0,0,0.04)'
                    : 'transparent'
                }}
                onClick={() => onSelectChange(item.id)}
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs" style={{ color: colorText }}>
                    {sourceLabel(item.source)}
                  </span>
                  <span
                    className="text-[11px] tabular-nums"
                    style={{ color: colorTextTertiary, marginLeft: 'auto' }}
                  >
                    {item.createdAt ? dayjs(item.createdAt).format('MM-DD HH:mm:ss') : ''}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-[11px] tabular-nums" style={{ color: '#4a8f5b' }}>
                    +{item.added}
                  </span>
                  <span className="text-[11px] tabular-nums" style={{ color: '#b3452f' }}>
                    −{item.removed}
                  </span>
                  <span className="text-[11px]" style={{ color: colorTextTertiary }}>
                    {statusLabel(item.status)}
                  </span>
                  {item.status === 'pending' && item.id !== change.id && (
                    <span
                      className="text-[11px] cursor-pointer"
                      style={{ color: colorTextTertiary, marginLeft: 'auto' }}
                      onClick={(e) => {
                        e.stopPropagation()
                        onKeep([item.id])
                      }}
                    >
                      {t('harness.fileDiff.keepOne')}
                    </span>
                  )}
                  {item.hasBefore && (item.status === 'pending' || item.status === 'kept') && (
                    <span
                      className="text-[11px] cursor-pointer"
                      style={{
                        color: colorTextTertiary,
                        marginLeft: item.status === 'pending' && item.id !== change.id ? 8 : 'auto'
                      }}
                      onClick={(e) => {
                        e.stopPropagation()
                        onRevert(item.id)
                      }}
                    >
                      {t('harness.fileDiff.revertToHere')}
                    </span>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )

  /** Shared props for semantic-tone buttons (palette and theme needed by the icon button component) */
  const buttonProps = {
    colorText,
    colorTextSecondary,
    colorBorderSecondary,
    isDarkMode
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Review toolbar: **icons only** (per the 2026-09-22 requirement); all text lives in Tooltips.
          When the panel narrows, text segments are dropped by priority (see the compact note above);
          the button group is never compressed. */}
      <div
        ref={toolbarRef}
        data-testid="file-diff-toolbar"
        className="flex items-center gap-2 px-3 shrink-0 overflow-hidden whitespace-nowrap"
        style={{ height: 32, borderBottom: `1px solid ${colorBorderSecondary}` }}
      >
        {compact.stats && (
          <span
            data-diff-stats
            className="text-[11.5px] tabular-nums shrink-0"
            style={{ color: colorTextSecondary }}
          >
            {statsText}
          </span>
        )}
        {compact.source && (
          <span className="text-[11.5px] shrink-0" style={{ color: colorTextTertiary }}>
            {sourceLabel(change.source)}
          </span>
        )}
        {isDirty && (
          <span className="text-[11.5px] shrink-0" style={{ color: '#c98a2b' }}>
            {t('harness.fileDiff.unsaved')}
          </span>
        )}
        <div className="flex-1" />

        {/* Button group: flexShrink=0, and its natural width is measured as a whole (the toolbarRef adaptivity uses it) */}
        <div ref={groupRef} className="flex items-center gap-1.5 shrink-0">
          <DiffToolbarButton
            {...buttonProps}
            testId="prev"
            title={t('harness.fileDiff.prevChunk')}
            icon={<RiArrowUpLine size={13} />}
            onClick={() => runChunkCommand('prev')}
          />
          <DiffToolbarButton
            {...buttonProps}
            testId="next"
            title={t('harness.fileDiff.nextChunk')}
            icon={<RiArrowDownLine size={13} />}
            onClick={() => runChunkCommand('next')}
          />
          {canEdit && (
            <>
              <DiffToolbarButton
                {...buttonProps}
                testId="accept"
                title={t('harness.fileDiff.acceptChunkTip')}
                icon={<RiCheckLine size={13} />}
                onClick={() => runChunkCommand('accept')}
              />
              <DiffToolbarButton
                {...buttonProps}
                testId="reject"
                title={t('harness.fileDiff.rejectChunkTip')}
                icon={<RiCloseLine size={13} />}
                onClick={() => runChunkCommand('reject')}
              />
            </>
          )}

          <span style={{ width: 1, height: 16, background: colorBorderSecondary, flexShrink: 0 }} />

          {isPending && (
            <>
              <DiffToolbarButton
                {...buttonProps}
                testId="keep-all"
                tone="accept"
                title={
                  docMatchesDisk
                    ? t('harness.fileDiff.keepAllTip')
                    : t('harness.fileDiff.keepMixedTip')
                }
                icon={<RiCheckLine size={13} />}
                onClick={handleKeepAll}
              />
              <DiffToolbarButton
                {...buttonProps}
                testId="revert-all"
                tone="reject"
                title={t('harness.fileDiff.revertAllTip')}
                icon={<RiArrowGoBackLine size={13} />}
                disabled={!pending[0]?.hasBefore}
                onClick={() => pending.length > 0 && onRevert(pending[0].id)}
              />
            </>
          )}

          {compact.history && (
            <Dropdown
              dropdownRender={() => historyPanel}
              trigger={['click']}
              placement="bottomRight"
            >
              <span style={{ display: 'inline-flex' }}>
                <DiffToolbarButton
                  {...buttonProps}
                  testId="history"
                  title={t('harness.fileDiff.history', { count: history.length })}
                  icon={<RiHistoryLine size={13} />}
                />
              </span>
            </Dropdown>
          )}
        </div>
      </div>

      {/* No snapshot (command execution / external change): state plainly that it cannot be rolled back */}
      {!change.hasBefore && (
        <div
          className="flex items-center gap-2 px-3 shrink-0 text-[11.5px]"
          style={{
            height: 28,
            color: colorTextSecondary,
            background: isDarkMode ? 'rgba(220,160,80,0.10)' : 'rgba(210,150,60,0.10)',
            borderBottom: `1px solid ${colorBorderSecondary}`
          }}
        >
          <RiAlertLine size={13} style={{ color: isDarkMode ? '#d9b06a' : '#8a5a1e' }} />
          {t('harness.fileDiff.noSnapshot')}
        </div>
      )}

      {isPending && change.id !== latestPendingId && (
        <div
          className="flex items-center gap-2 px-3 shrink-0 text-[11.5px]"
          style={{
            height: 28,
            color: colorTextSecondary,
            background: isDarkMode ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)',
            borderBottom: `1px solid ${colorBorderSecondary}`
          }}
        >
          {t('harness.fileDiff.historicalHint')}
        </div>
      )}

      <div className="flex-1 min-h-0">
        {original === null ? (
          <div
            className="flex items-center justify-center h-full text-xs"
            style={{ color: colorTextTertiary }}
          >
            {t('harness.fileEditor.loading')}
          </div>
        ) : (
          <CodeEditor
            key={`${change.id}:${change.hasBefore ? 'snap' : 'nosnap'}`}
            filePath={filePath}
            value={value}
            palette={palette}
            readOnly={!canEdit}
            wrap={false}
            extraExtensions={mergeExtensions}
            onChange={onChange}
            onSave={() => canEdit && onApplyReview(value)}
            onViewReady={handleViewReady}
            onUpdate={(update) => {
              if (update.docChanged || update.selectionSet) refreshStats(update.view)
            }}
          />
        )}
      </div>
    </div>
  )
}

export default FileDiffView
