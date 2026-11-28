import React, { useCallback, useEffect, useState } from 'react'
import { SkeletonTextLines } from '@renderer/components/system/Skeleton'
import { RiArrowRightSLine, RiFileLine, RiFolder3Line, RiTerminalBoxLine } from '@remixicon/react'
import { Trans, useTranslation } from '@renderer/i18n'

import { useWorkspaceBridge } from '../../contexts/harness/workspace-bridge'
import { MONO_FONT, TruncatedTooltipText } from './messages/TruncatedTooltipText'
import type { ToolCardKind } from '../../../../shared/harness/types'
import { harnessApi } from '../../api/harness'

/**
 * Tool result detail tab (right side panel).
 *
 * Results of built-in tools (ls / glob / grep / execute) do not go through IPC or the database;
 * they are stored separately in the main process by (topicId, callId) (see
 * runtime/tool-output-store.ts). Only when the user opens a card is this raw text fetched back and
 * parsed in place into a readable view according to the tool semantics:
 *  - execute → terminal-style output (exit code + monospace body)
 *  - grep    → list of matching lines (path:line + content, click to open the file)
 *  - glob    → list of paths (click to open the file)
 *  - ls      → directory entries (click to open the file)
 *
 * When parsing fails (legacy data or a format change) the plain text is shown verbatim; content is
 * never swallowed.
 */

export interface ToolDetailTab {
  /** Unique tab key: `tool:<topicId>:<callId>` */
  key: string
  /** Tab name (shown in the tab bar) */
  name: string
  topicId: number
  callId: string
  kind: ToolCardKind
  /** In-tab title (command / pattern / directory path) */
  title: string
  exitCode?: number
}

interface ToolDetailStyle {
  isDarkMode: boolean
  colorText: string
  colorTextSecondary: string
  colorTextTertiary: string
}

/** Hairline (same as the panel's other dividers) */
const hairline = (style: ToolDetailStyle): string => (style.isDarkMode ? '#1e1e1e' : '#e4e4e4')
/** Very faint divider/hover background */
const faintFill = (style: ToolDetailStyle): string =>
  style.isDarkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)'

interface GrepMatch {
  path?: unknown
  line?: unknown
  content?: unknown
}

/** Directory entry / path list row: click to open the file (when a bridge exists) */
const ListRow: React.FC<{
  style: ToolDetailStyle
  label: string
  meta?: React.ReactNode
  isDir?: boolean
  onClick?: () => void
  mono?: boolean
}> = ({ style, label, meta, isDir, onClick, mono }) => {
  const [hover, setHover] = useState(false)
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 10px',
        borderRadius: 6,
        background: hover && onClick ? faintFill(style) : 'transparent',
        cursor: onClick ? 'pointer' : 'default'
      }}
    >
      {isDir !== undefined ? (
        isDir ? (
          <RiFolder3Line size={14} style={{ color: '#dcb67a', flexShrink: 0 }} />
        ) : (
          <RiFileLine size={14} style={{ color: style.colorTextTertiary, flexShrink: 0 }} />
        )
      ) : null}
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 12.5,
          color: style.colorTextSecondary,
          fontFamily: mono ? MONO_FONT : undefined
        }}
        className="truncate"
        title={label}
      >
        {label}
      </span>
      {meta}
      {onClick ? (
        <RiArrowRightSLine
          size={14}
          style={{
            color: style.colorTextTertiary,
            opacity: hover ? 1 : 0,
            transition: 'opacity 0.15s',
            flexShrink: 0
          }}
        />
      ) : null}
    </div>
  )
}

const ToolDetailView: React.FC<{ tab: ToolDetailTab; style: ToolDetailStyle }> = ({
  tab,
  style
}) => {
  const { t } = useTranslation()
  const bridge = useWorkspaceBridge()
  const [loading, setLoading] = useState(true)
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setText(null)
    void (async () => {
      try {
        const api = harnessApi
        const result = await api.harness.getToolOutput(tab.topicId, tab.callId)
        if (cancelled) return
        if (result == null) {
          setError(t('harness.toolDetail.unavailable'))
        } else {
          setText(result)
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [tab.topicId, tab.callId, t])

  const openPath = useCallback(
    (virtualPath: string) => {
      bridge?.openFile(virtualPath)
    },
    [bridge]
  )

  const header = (
    <div
      className="flex items-center gap-2 px-3 shrink-0"
      style={{
        height: 34,
        borderBottom: `1px solid ${style.isDarkMode ? '#1e1e1e' : '#e4e4e4'}`,
        background: style.isDarkMode ? '#252526' : '#f3f3f3'
      }}
    >
      <RiTerminalBoxLine size={14} style={{ color: style.colorTextTertiary, flexShrink: 0 }} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <TruncatedTooltipText
          text={tab.title || tab.name}
          style={{
            color: style.colorTextSecondary,
            fontSize: 12,
            fontFamily: tab.kind === 'command' ? MONO_FONT : undefined
          }}
        />
      </span>
      {tab.kind === 'command' && tab.exitCode !== undefined ? (
        <span
          style={{
            flexShrink: 0,
            fontSize: 11,
            fontFamily: MONO_FONT,
            padding: '0 6px',
            borderRadius: 9,
            color: tab.exitCode === 0 ? style.colorTextTertiary : '#ef4444',
            border: `1px solid ${hairline(style)}`
          }}
        >
          {t('harness.toolDetail.exitCode', { code: tab.exitCode })}
        </span>
      ) : null}
    </div>
  )

  const body = (): React.ReactNode => {
    if (loading) {
      /* Output is monospace text, so lay the skeleton out per line; colors follow this panel's own dark skin rather than antd tokens */
      return (
        <div className="p-3 h-full">
          <SkeletonTextLines lines={12} dark={style.isDarkMode} />
        </div>
      )
    }
    if (error) {
      return (
        <div className="p-4 text-xs" style={{ color: style.colorTextTertiary }}>
          {error}
        </div>
      )
    }

    let parsed: Record<string, unknown> | null = null
    try {
      const value: unknown = JSON.parse(text ?? '')
      if (value && typeof value === 'object') parsed = value as Record<string, unknown>
    } catch {
      parsed = null
    }

    // Fallback when parsing fails: show verbatim (monospace, scrollable, preserves newlines)
    if (!parsed) {
      return (
        <pre
          className="harness-scrollbar"
          style={{
            margin: 0,
            padding: 12,
            fontSize: 12,
            lineHeight: 1.6,
            fontFamily: MONO_FONT,
            color: style.colorText,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word'
          }}
        >
          {text}
        </pre>
      )
    }

    // ── execute: terminal-style output ──
    if (tab.kind === 'command') {
      const stdout = typeof parsed.stdout === 'string' ? parsed.stdout : ''
      return (
        <pre
          className="harness-scrollbar"
          style={{
            margin: 0,
            padding: 12,
            fontSize: 12,
            lineHeight: 1.6,
            fontFamily: MONO_FONT,
            color: style.colorText,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word'
          }}
        >
          {stdout || t('harness.toolDetail.emptyOutput')}
        </pre>
      )
    }

    // ── grep: matching line list ──
    if (Array.isArray(parsed.matches)) {
      const matches = parsed.matches as GrepMatch[]
      if (matches.length === 0) {
        return (
          <div className="p-4 text-xs" style={{ color: style.colorTextTertiary }}>
            {t('harness.toolDetail.emptyResult')}
          </div>
        )
      }
      return (
        <div className="py-1">
          {matches.map((match, i) => {
            const filePath = typeof match.path === 'string' ? match.path : ''
            const line = typeof match.line === 'number' ? match.line : undefined
            const content = typeof match.content === 'string' ? match.content : ''
            return (
              <div
                key={i}
                className="flex items-start gap-2 px-3 py-[3px]"
                style={{ borderTop: i === 0 ? 'none' : `1px solid ${faintFill(style)}` }}
              >
                <button
                  type="button"
                  onClick={() => filePath && openPath(filePath)}
                  style={{
                    flex: '0 0 auto',
                    maxWidth: '45%',
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    cursor: filePath ? 'pointer' : 'default',
                    textAlign: 'left',
                    fontFamily: MONO_FONT,
                    fontSize: 11.5,
                    color: style.colorTextTertiary
                  }}
                  className="truncate"
                  title={line !== undefined ? `${filePath}:${line}` : filePath}
                >
                  {filePath}
                  {line !== undefined ? `:${line}` : ''}
                </button>
                <span
                  className="flex-1 min-w-0 truncate"
                  style={{
                    fontFamily: MONO_FONT,
                    fontSize: 12,
                    color: style.colorText
                  }}
                  title={content}
                >
                  {content}
                </span>
              </div>
            )
          })}
        </div>
      )
    }

    // ── ls: directory entries (files/dirs are names and must be joined with path to be openable)──
    // Check dirs first: ls output also contains files, and checking files first would misread
    // glob's path list as "file names under a directory" and join the path a second time
    if (Array.isArray(parsed.dirs)) {
      const dirs = Array.isArray(parsed.dirs) ? (parsed.dirs as string[]) : []
      const files = Array.isArray(parsed.files) ? (parsed.files as string[]) : []
      const base = typeof parsed.path === 'string' ? parsed.path : tab.title || '/'
      const join = (name: string): string =>
        `${base.replace(/\/+$/, '')}/${name}`.replace(/^\/+/, '/')
      if (dirs.length === 0 && files.length === 0) {
        return (
          <div className="p-4 text-xs" style={{ color: style.colorTextTertiary }}>
            {t('harness.toolDetail.emptyResult')}
          </div>
        )
      }
      return (
        <div className="py-1">
          {dirs.map((name) => (
            <ListRow key={`d-${name}`} style={style} label={name} isDir mono={false} />
          ))}
          {files.map((name) => (
            <ListRow
              key={`f-${name}`}
              style={style}
              label={name}
              isDir={false}
              onClick={() => openPath(join(name))}
            />
          ))}
        </div>
      )
    }

    // ── glob: path list (entries ending with / are directories) ──
    if (Array.isArray(parsed.files)) {
      const files = parsed.files as string[]
      if (files.length === 0) {
        return (
          <div className="p-4 text-xs" style={{ color: style.colorTextTertiary }}>
            {t('harness.toolDetail.emptyResult')}
          </div>
        )
      }
      return (
        <div className="py-1">
          {files.map((filePath) => {
            const isDir = filePath.endsWith('/')
            return (
              <ListRow
                key={filePath}
                style={style}
                label={filePath}
                isDir={isDir}
                onClick={isDir ? undefined : () => openPath(filePath)}
              />
            )
          })}
        </div>
      )
    }

    // Fallback: show unknown structures verbatim
    return (
      <pre
        className="harness-scrollbar"
        style={{
          margin: 0,
          padding: 12,
          fontSize: 12,
          fontFamily: MONO_FONT,
          color: style.colorText,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word'
        }}
      >
        {text}
      </pre>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {header}
      <div className="flex-1 overflow-auto harness-scrollbar">
        {body()}
        {tab.kind === 'command' ? (
          <div
            className="px-3 py-2 text-[11px]"
            style={{ color: style.colorTextTertiary, borderTop: `1px solid ${faintFill(style)}` }}
          >
            <Trans i18nKey="harness.toolDetail.outputFooter" />
          </div>
        ) : null}
      </div>
    </div>
  )
}

export default ToolDetailView
