import React, { useState } from 'react'
import { Trans, useTranslation } from '@renderer/i18n'
import {
  RiArrowRightSLine,
  RiErrorWarningLine,
  RiFileEditLine,
  RiFileTextLine,
  RiPencilLine,
  RiTerminalBoxLine
} from '@remixicon/react'
import { ShinyIcon } from '@renderer/components/effects/ShinyText'
import { Image } from 'antd'

import { useWorkspaceBridge } from '../../../contexts/harness/workspace-bridge'
import { formatBytes, TOOL_CARD_ICONS, toolIconFor } from '../../../utils/harness/toolIcons'
import { MONO_FONT, TruncatedTooltipText } from './TruncatedTooltipText'
import type {
  ToolCall,
  ToolCard,
  ToolCardKind,
  ToolImageData
} from '../../../../../shared/harness/types'

/**
 * Result cards for built-in tools (read_file / write_file / edit_file / ls / glob / grep / execute).
 *
 * Difference from the old implementation (2026-09-19): the results of these tools **no longer go
 * through IPC/the database**; only this card stays in the chat. To see the content, click the card
 * — file tools open the real file in the right panel, ls locates the directory, and
 * glob/grep/execute open a result detail tab (the main process returns them on demand by
 * topicId+callId).
 *
 * So the card must explain "what this call did and how big the result is":
 * path/pattern/command on one line, line/byte/item/match count or exit code on the right, and the
 * reason on failure.
 *
 * Added 2026-09-23 (the user reported "I clearly edited a file but cannot find the edit card in
 * the chat"): **write/mutate cards must be identifiable at a glance** — previously they looked
 * like read_file ("eye + path") and scanning could not tell which card was a change.
 * Now write_file / edit_file use pencil-family icons + an amber accent (errors are still red) and
 * a 2px accent edge on the left, so mutate cards jump out while scanning.
 *
 * Added the same day (the user's words: "and after editing, the card needs to show the diff: +12
 * -6"): write/mutate cards gain a diff-size segment "+N −M" on the right (see DiffStat) — the
 * count/bytes say "what was done", the diff size says "how many lines actually changed in this
 * file"; both must be visible.
 */

export interface ToolCardStyle {
  isDarkMode: boolean
  colorText: string
  colorTextSecondary: string
  colorTextTertiary: string
  colorFillAlter: string
  colorBorderSecondary: string
}

/** Summary of the parameters that can be shown immediately while the tool is in progress (building parameters / executing) */
function inputSummary(name: string, input: Record<string, unknown> | undefined): string {
  const value = (key: string): string =>
    typeof input?.[key] === 'string' ? (input[key] as string) : ''
  switch (name) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
      return value('file_path')
    case 'ls':
      return value('path')
    case 'glob':
    case 'grep':
      return value('pattern')
    case 'execute':
      return value('command')
    default:
      return ''
  }
}

/** Human-readable byte count: see utils/toolIcons (shared by the card and the detail tab) */

/**
 * Accent color for write/mutate cards (2px left edge + icon).
 * Amber is the single global semantic color for "unsaved / pending" (the tab's unsaved dot and the
 * status bar's "disk changed" use it too), so mutate cards reuse it instead of teaching users a
 * new color.
 */
const MUTATE_COLOR = '#c98a2b'
/** Write/mutate tools: the completed state must be distinguishable from read_file at a glance (previously all used the same eye icon) */
const MUTATE_TOOLS = new Set(['write_file', 'edit_file', 'apply_patch'])

/** Card shell: icon + primary text (single-line truncation + full text on hover) + right-side metadata + hover action hint */
const CardShell: React.FC<{
  style: ToolCardStyle
  isNested: boolean
  icon: React.ReactNode
  primary: string
  meta?: React.ReactNode
  /** Having an onClick means it can be opened: hovering changes the background and shows the right arrow */
  onClick?: () => void
  actionTitle?: string
  primaryColor?: string
  /** Tool name (written to a data attribute for offline fixtures to check "which tool cards actually rendered") */
  toolName?: string
  /** Whether this card is in the "in progress" state (fixtures count in-progress cards by data-tool-progress) */
  progress?: boolean
  /** Whether the primary text has a shiny sweep (only needed for in-progress cards: synchronized with the shine on the left icon) */
  shinyText?: boolean
  /** Write/mutate cards: 2px accent edge on the left (jumps out while scanning) */
  mutate?: boolean
}> = ({
  style,
  isNested,
  icon,
  primary,
  meta,
  onClick,
  actionTitle,
  primaryColor,
  toolName,
  progress = false,
  shinyText = false,
  mutate = false
}) => {
  const [hover, setHover] = useState(false)
  const bg = style.isDarkMode ? 'rgba(255,255,255,0.04)' : '#f9fafb'
  const hoverBg = style.isDarkMode ? 'rgba(255,255,255,0.08)' : '#f1f2f4'
  const fontSize = isNested ? '12px' : '13px'
  return (
    <div
      data-tool-card={toolName}
      data-tool-progress={progress ? '1' : undefined}
      data-tool-mutate={mutate ? '1' : '0'}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={onClick ? actionTitle : undefined}
      style={{
        background: hover && onClick ? hoverBg : bg,
        border: 'var(--ant-line-width) var(--ant-line-type) var(--ant-color-border)',
        // Only add the left accent edge: distinguishes mutate cards without changing the card's shape language
        borderLeft: mutate ? `2px solid ${MUTATE_COLOR}` : undefined,
        marginBottom: isNested ? '4px' : '6px',
        borderRadius: '8px',
        padding: '9px 12px',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        cursor: onClick ? 'pointer' : 'default',
        transition: 'background 0.15s'
      }}
    >
      {icon}
      <TruncatedTooltipText
        text={primary}
        /**
         * In-progress card: the primary text and the left icon share **the same shine** (same base
         * color, gloss sweeps in sync). The user reported on 2026-09-27 that "only the icon shows
         * the shine animation, while the text does not" — `shinyBaseColor` was not passed here, so
         * `TruncatedTooltipText` did not attach `.shiny-text` and the text stayed static.
         * Not passed for completed cards (`shinyText` defaults to false): a static card should not
         * keep flashing.
         */
        shinyBaseColor={shinyText ? style.colorTextSecondary : undefined}
        style={{ color: primaryColor ?? style.colorText, fontSize }}
      />
      {meta}
      {onClick ? (
        <RiArrowRightSLine
          size={isNested ? 14 : 16}
          style={{
            color: style.colorTextTertiary,
            opacity: hover ? 1 : 0,
            transition: 'opacity 0.15s',
            // The expand entry must not be squeezed flat by text/metadata (it collapses to a line under shrink pressure)
            flexShrink: 0
          }}
        />
      ) : null}
    </div>
  )
}

/**
 * Right-side metadata: numbers use a monospace face (same typography as the "task segment step
 * count pill").
 *
 * `shrinkable` (the user reported on 2026-09-27: "this content still overflows, no ellipsis
 * appears"): metadata with **uncontrolled length**, such as failure reasons, must be able to
 * shrink and show an ellipsis. Previously this was `flexShrink: 0` + `whiteSpace: nowrap` — it
 * could not narrow and had no ellipsis, so a long reason (a whole-sentence sandbox-blocked
 * explanation) pushed the card content out of the container and it was then cut off by the card's
 * `overflow: hidden`: the user saw "content overflows, no ellipsis". The native `title` keeps the
 * full text visible for the clipped part (the card's own `title` is the action hint for "open",
 * and both may coexist, separated by nesting elements).
 */
const Meta: React.FC<{
  isNested: boolean
  color: string
  /** true = allow shrinking + ellipsis (use it for content of uncontrolled length, such as failure reasons) */
  shrinkable?: boolean
  children: React.ReactNode
}> = ({ isNested, color, shrinkable = false, children }) => (
  <span
    data-tool-meta={shrinkable ? 'shrinkable' : 'fixed'}
    title={shrinkable ? String(children ?? '') : undefined}
    style={{
      color,
      fontSize: isNested ? '11px' : '12px',
      whiteSpace: 'nowrap',
      ...(shrinkable
        ? {
            // Below the content width, shrinking requires min-width: 0; truncation is handled by the ellipsis
            flex: '0 1 auto',
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }
        : { flexShrink: 0 })
    }}
  >
    {children}
  </span>
)

/**
 * Monospace wrapper for counters.
 *
 * It must explicitly render children: `<Trans components={{ mono: ... }}>` **clones** the
 * placeholder component and inserts the interpolated text as children, so a component that ignores
 * children swallows the number (verified: `const Mono = () => <span/>` → only the unit word remains
 * on the card and the number disappears).
 */
const Mono: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
  <span style={{ fontFamily: MONO_FONT }}>{children}</span>
)

/**
 * Semantic colors for diff size: additions green / deletions red (same as the diff view history
 * list and the file explorer badge). Dark mode uses brighter shades of the same hue family —
 * `#4a8f5b` / `#b3452f` turn into a muddy gray on a dark background, and these two shades are
 * exactly the values FileExplorer's change badge uses in dark mode.
 */
const DIFF_ADDED_COLOR = { light: '#4a8f5b', dark: '#9ecf8a' }
const DIFF_REMOVED_COLOR = { light: '#b3452f', dark: '#e08a70' }

/**
 * Diff size "+N −M" on write/mutate cards.
 *
 * The user asked on 2026-09-23 (verbatim): "and after editing, the card needs to show the diff: +12 -6".
 *
 * It is **not the same thing** as the existing number on the card, and both are needed:
 *  - "N replacements" = how many spots this call replaced (edit_file's return value semantics);
 *  - "+N −M" = how many lines actually changed in this file (the same numbers as the change log
 *    and the diff view; computed by the main process's line-diff).
 * When a single replace_all changes 3 spots but touches 40 lines, the spot count alone makes it
 * look like a small change.
 *
 * When the numbers are missing (cards persisted in old data, failed writes) or both are 0 (content
 * actually unchanged), **the whole block is not rendered**: better a shorter line than a "+0 −0"
 * that makes no sense.
 */
const DiffStat: React.FC<{ added?: number; removed?: number; isDarkMode: boolean }> = ({
  added,
  removed,
  isDarkMode
}) => {
  if (typeof added !== 'number' || typeof removed !== 'number' || added + removed === 0) return null
  return (
    <span data-diff-stat style={{ fontFamily: MONO_FONT, marginLeft: 6 }}>
      <span style={{ color: isDarkMode ? DIFF_ADDED_COLOR.dark : DIFF_ADDED_COLOR.light }}>
        +{added}
      </span>
      <span
        style={{
          color: isDarkMode ? DIFF_REMOVED_COLOR.dark : DIFF_REMOVED_COLOR.light,
          marginLeft: 4
        }}
      >
        −{removed}
      </span>
    </span>
  )
}

/** Right-side card metadata (describes "how big the result is" per tool semantics) */
const ToolCardMeta: React.FC<{
  tool: ToolCall
  card: ToolCard
  isNested: boolean
  color: string
  isDarkMode: boolean
}> = ({ tool, card, isNested, color, isDarkMode }) => {
  const { t } = useTranslation()
  // Failure with a reason: the reason takes priority (egress text explains the problem better
  // than "exit 1"). Failures without a message (e.g. a non-zero execute exit) fall through to the
  // per-tool metadata below — the exit code must not be lost.
  // Failure reasons have uncontrolled length (a whole-sentence sandbox-blocked explanation) and
  // must be shrinkable with an ellipsis (see Meta's shrinkable).
  if (card.status === 'error' && card.message) {
    return (
      <Meta isNested={isNested} color={color} shrinkable>
        {card.message}
      </Meta>
    )
  }
  switch (tool.name) {
    case 'read_file': {
      const lines = card.range
        ? t('harness.assistantMessage.toolLineRange', {
            start: card.range.start,
            end: card.range.end,
            total: card.range.total
          })
        : card.lines !== undefined
          ? t('harness.assistantMessage.toolLines', { count: card.lines })
          : undefined
      return (
        <Meta isNested={isNested} color={color}>
          {lines}
          {card.truncated ? t('harness.assistantMessage.toolTruncated') : ''}
        </Meta>
      )
    }
    case 'write_file':
      // The `card.message` fallback (failed but no byte count projected) has uncontrolled length and must be shrinkable like a failure reason
      return (
        <Meta isNested={isNested} color={color} shrinkable={card.bytes === undefined}>
          {card.bytes !== undefined ? formatBytes(card.bytes) : card.message}
          <DiffStat added={card.added} removed={card.removed} isDarkMode={isDarkMode} />
        </Meta>
      )
    case 'edit_file':
      return (
        <Meta isNested={isNested} color={color} shrinkable={card.count === undefined}>
          {card.count !== undefined ? (
            <Trans
              i18nKey="harness.assistantMessage.toolReplacements"
              count={card.count}
              components={{ mono: <Mono /> }}
            />
          ) : (
            card.message
          )}
          <DiffStat added={card.added} removed={card.removed} isDarkMode={isDarkMode} />
        </Meta>
      )
    case 'ls':
      return (
        <Meta isNested={isNested} color={color}>
          <Trans
            i18nKey="harness.assistantMessage.itemCount"
            count={card.count ?? 0}
            components={{ mono: <Mono /> }}
          />
        </Meta>
      )
    case 'glob':
      return (
        <Meta isNested={isNested} color={color}>
          <Trans
            i18nKey="harness.assistantMessage.itemCount"
            count={card.count ?? 0}
            components={{ mono: <Mono /> }}
          />
        </Meta>
      )
    case 'grep':
      return (
        <Meta isNested={isNested} color={color}>
          <Trans
            i18nKey="harness.assistantMessage.matchCount"
            count={card.count ?? 0}
            components={{ mono: <Mono /> }}
          />
          {card.fileCount !== undefined
            ? ` · ${t('harness.assistantMessage.toolFileCount', { count: card.fileCount })}`
            : ''}
        </Meta>
      )
    case 'execute':
      // Background run: no exit code, show the job id (status/logs are in the "background jobs" entry in the top bar)
      if (card.jobId) {
        return (
          <Meta isNested={isNested} color={color}>
            {t('harness.assistantMessage.toolBackgroundJob', { id: card.jobId })}
          </Meta>
        )
      }
      return (
        <Meta isNested={isNested} color={card.exitCode ? '#ef4444' : color}>
          {card.exitCode !== undefined
            ? t('harness.assistantMessage.toolExitCode', { code: card.exitCode })
            : undefined}
        </Meta>
      )
    default:
      return null
  }
}

/** Completed-state card: click behavior depends on tool semantics */
export const ToolResultCard: React.FC<{
  tool: ToolCall
  /** Current topic id (result details are fetched by topicId + callId) */
  topicId: number | null
  isNested?: boolean
  style: ToolCardStyle
}> = ({ tool, topicId, isNested = false, style }) => {
  const { t } = useTranslation()
  const bridge = useWorkspaceBridge()
  const card = tool.card
  if (!card) return null

  const size = isNested ? 14 : 16
  const kind: ToolCardKind = card.kind ?? (tool.name === 'execute' ? 'command' : 'file')
  /**
   * Write/mutate cards: switch the icon and color to the "I changed this file" set.
   * Previously they fell into the `kind === 'file'` branch and shared the same eye icon + secondary
   * color as read_file, so **you could not tell which card was a change** in the chat — the user's
   * words were exactly "I clearly edited a file but cannot find the edit card".
   */
  const isMutate = MUTATE_TOOLS.has(tool.name) && card.status !== 'error'
  const MutateIcon = tool.name === 'write_file' ? RiFileEditLine : RiPencilLine
  const Icon =
    card.status === 'error' ? RiErrorWarningLine : isMutate ? MutateIcon : TOOL_CARD_ICONS[kind]
  const iconColor =
    card.status === 'error' ? '#ef4444' : isMutate ? MUTATE_COLOR : style.colorTextSecondary
  /** Primary text: path / pattern / command */
  const primary =
    kind === 'command'
      ? card.command || ''
      : kind === 'search'
        ? card.pattern || ''
        : card.path || ''

  const callId = tool.id
  const canDetail = Boolean(card.detail && callId && topicId != null)

  let onClick: (() => void) | undefined
  let actionTitle: string | undefined
  if (kind === 'file' && card.path && bridge) {
    onClick = () => bridge.openFile(card.path as string)
    actionTitle = t('harness.assistantMessage.toolOpenFile')
  } else if (kind === 'dir' && card.path && bridge) {
    // Directories: prefer locating in the file explorer (sibling contents visible at a glance);
    // fall back to the result detail tab when outside the workspace (e.g. /memories/...)
    onClick = () => {
      if (!bridge.revealPath(card.path as string) && canDetail) {
        bridge.openToolDetail({
          topicId: topicId as number,
          callId: callId as string,
          kind,
          title: primary
        })
      }
    }
    actionTitle = t('harness.assistantMessage.toolRevealDir')
  } else if (canDetail && bridge) {
    onClick = () =>
      bridge.openToolDetail({
        topicId: topicId as number,
        callId: callId as string,
        kind,
        title: primary,
        exitCode: card.exitCode
      })
    actionTitle = t('harness.assistantMessage.toolViewDetail')
  }

  return (
    <CardShell
      style={style}
      isNested={isNested}
      icon={<Icon size={size} style={{ color: iconColor, flexShrink: 0 }} />}
      primary={primary}
      meta={
        <ToolCardMeta
          tool={tool}
          card={card}
          isNested={isNested}
          color={style.colorTextTertiary}
          isDarkMode={style.isDarkMode}
        />
      }
      onClick={onClick}
      actionTitle={actionTitle}
      toolName={tool.name}
      mutate={isMutate}
    />
  )
}

/** In-progress card (building parameters / executing): same shape, only a status suffix + glossy sweep */
export const ToolProgressCard: React.FC<{
  tool: ToolCall
  progress: 'preparing' | 'executing'
  isNested?: boolean
  style: ToolCardStyle
}> = ({ tool, progress, isNested = false, style }) => {
  const { t } = useTranslation()
  const size = isNested ? 14 : 16
  const summary = inputSummary(tool.name, tool.input as Record<string, unknown> | undefined)
  const status =
    progress === 'preparing'
      ? ` · ${t('harness.assistantMessage.toolPreparing')}`
      : ` · ${t('harness.assistantMessage.toolExecuting')}`
  // Tools whose names are only known at runtime, such as MCP / mnemon, fall back by prefix; if still unrecognized, use the terminal icon (same as the old behavior)
  const Icon = toolIconFor(tool.name) || RiTerminalBoxLine
  return (
    <CardShell
      style={style}
      isNested={isNested}
      progress
      shinyText
      toolName={tool.name}
      icon={<ShinyIcon icon={Icon} size={size} baseColor={style.colorTextSecondary} />}
      primary={`${summary || tool.name || t('harness.assistantMessage.toolCallFallback')}${status}`}
      primaryColor={style.colorText}
    />
  )
}
/**
 * Tool result image strip (read_image / other media tools): thumbnail + click for a large preview.
 *
 * The images come from the data URLs persisted in the tool result (conversation blocks), so
 * historical messages and sessions after a restart can display them directly without depending on
 * the original files on disk (which may have been moved or deleted).
 */
export const ToolImageStrip: React.FC<{
  images: ToolImageData[]
  isNested?: boolean
  style: ToolCardStyle
}> = ({ images, isNested = false, style }) => {
  if (!images || images.length === 0) return null
  const size = isNested ? 72 : 108
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 8,
        margin: isNested ? '4px 0 6px 20px' : '6px 0 8px 22px'
      }}
    >
      {images.map((image, index) => (
        <Image
          key={`${image.path}-${index}`}
          src={image.dataUrl}
          alt={image.path}
          width={size}
          height={size}
          style={{
            objectFit: 'cover',
            borderRadius: 8,
            border: `1px solid ${style.colorBorderSecondary}`,
            background: style.colorFillAlter
          }}
          preview={{
            src: image.dataUrl,
            mask: <span style={{ fontSize: 12 }}>{image.path}</span>
          }}
        />
      ))}
    </div>
  )
}

/**
 * `present` card: the delivery file list declared by the model; clicking opens the file directly in
 * the right panel.
 *
 * The list comes from the tool **input** (not the output text): the input is persisted with the
 * conversation blocks, so the card can be restored after a historical reload; the output is only
 * the confirmation text for the model and does not participate in rendering.
 */
/**
 * Action card (propose_action): clickable buttons below the answer.
 *
 * On click it hands the reply (defaulting to label) to the conversation send logic through the
 * `harness-propose-action` event — the same path as sending a message manually (queued if
 * generating). After clicking, the card is disabled in place and shows the selected text.
 */
export const PresentedFilesCard: React.FC<{
  tool: ToolCall
  isNested?: boolean
  style: ToolCardStyle
}> = ({ tool, isNested = false, style }) => {
  const { t } = useTranslation()
  const bridge = useWorkspaceBridge()
  const rawFiles = (tool.input as { files?: unknown } | undefined)?.files
  const files = Array.isArray(rawFiles)
    ? (rawFiles as Array<{ path?: unknown; description?: unknown }>).filter(
        (file) => typeof file?.path === 'string' && file.path.length > 0
      )
    : []
  if (files.length === 0) return null

  return (
    <div
      style={{
        margin: isNested ? '4px 0 6px 20px' : '6px 0 8px 22px',
        border: `1px solid ${style.colorBorderSecondary}`,
        borderRadius: 10,
        background: style.colorFillAlter,
        padding: '8px 10px'
      }}
    >
      <div style={{ fontSize: 12, color: style.colorTextSecondary, marginBottom: 6 }}>
        {t('harness.assistantMessage.deliveredFiles')}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {files.map((file, index) => (
          <button
            key={`${String(file.path)}-${index}`}
            type="button"
            onClick={() => bridge?.openFile(file.path as string)}
            title={file.path as string}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '3px 4px',
              background: 'transparent',
              border: 'none',
              cursor: bridge ? 'pointer' : 'default',
              textAlign: 'left',
              color: style.colorText,
              fontSize: 13,
              minWidth: 0
            }}
          >
            <RiFileTextLine size={14} style={{ color: style.colorTextSecondary, flexShrink: 0 }} />
            <span
              style={{
                fontFamily: MONO_FONT,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis'
              }}
            >
              {file.path as string}
            </span>
            {typeof file.description === 'string' && file.description ? (
              <span
                style={{
                  color: style.colorTextTertiary,
                  fontSize: 12,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis'
                }}
              >
                — {file.description}
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  )
}
