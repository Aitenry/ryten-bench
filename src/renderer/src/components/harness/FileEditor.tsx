import React, { useMemo, useCallback, useState, useRef, useLayoutEffect, useEffect } from 'react'
import { Dropdown, Tooltip, theme as antdTheme } from 'antd'
import {
  RiCloseLine,
  RiArrowDownSLine,
  RiArrowGoBackLine,
  RiCheckLine,
  RiContrastLine,
  RiFileWarningLine,
  RiMarkdownLine,
  RiTextWrap,
  RiCodeSSlashLine
} from '@remixicon/react'
import CodeEditor, { type EditorCaret, type EditorRestoreState } from './CodeEditor'
import FileDiffView from './FileDiffView'
import ToolDetailView, { type ToolDetailTab } from './ToolDetailView'
import TipTapMarkdownEditor from '@renderer/components/markdown/TipTapMarkdownEditor'
import { getLanguageLabel, getLanguageId } from '../../utils/harness/fileLang'
import { getFileIcon } from '../../utils/harness/fileIcons'
import type { EditorPaletteInput } from '../../utils/harness/cmTheme'
import type { FileChangeView } from '../../types/harness/file-change'
import { useTranslation } from '@renderer/i18n'

export interface OpenFile {
  path: string
  name: string
  content: string
  isDirty: boolean
  /** Read-only tab (tool result details; or memory files outside the workspace) — not saved, no unsaved dot */
  readOnly?: boolean
  /** Tool result details tab: when set, renders ToolDetailView instead of the editor */
  tool?: ToolDetailTab
  /** View mode: diff (review model changes) / edit */
  view?: 'edit' | 'diff'
  /** Id of the change currently shown in the diff view */
  changeId?: number | null
  /** Disk changed while the tab has unsaved edits (user input is not overwritten, only hinted) */
  diskChanged?: boolean
  /** Whether the Markdown tab uses the "source" view (default is WYSIWYG) */
  markdownSource?: boolean
}

interface FileEditorProps {
  openFiles: OpenFile[]
  activeFilePath: string | null
  isDarkMode: boolean
  colorBgContainer: string
  colorText: string
  colorTextSecondary: string
  colorTextTertiary: string
  /** Pending changes per file (ascending: oldest first) */
  pendingByPath: Map<string, FileChangeView[]>
  onCloseFile: (filePath: string) => void
  onSelectFile: (filePath: string) => void
  onContentChange: (filePath: string, content: string) => void
  onSaveFile: (filePath: string) => void
  /** Switch between edit / diff view */
  onChangeView: (filePath: string, view: 'edit' | 'diff') => void
  /** Choose which change to inspect in the diff view */
  onSelectChange: (filePath: string, changeId: number) => void
  onKeepChanges: (ids: number[]) => void
  onRevertChange: (id: number) => void
  onApplyReview: (filePath: string, content: string) => void
  /** Re-read from disk (manual refresh after an external change) */
  onReloadFile: (filePath: string) => void
  /** Toggle the Markdown tab between WYSIWYG / source */
  onSetMarkdownSource: (filePath: string, source: boolean) => void
}

/** Width reserved for the "more" dropdown button. */
const MORE_BTN_WIDTH = 38

/**
 * File editor: tab bar + toolbar + editor/diff view + status bar.
 *
 * The editor core is CodeMirror 6 (see CodeEditor); the diff view uses @codemirror/merge.
 */
const FileEditor: React.FC<FileEditorProps> = ({
  openFiles,
  activeFilePath,
  isDarkMode,
  colorBgContainer,
  colorText,
  colorTextSecondary,
  colorTextTertiary,
  pendingByPath,
  onCloseFile,
  onSelectFile,
  onContentChange,
  onSaveFile,
  onChangeView,
  onSelectChange,
  onKeepChanges,
  onRevertChange,
  onApplyReview,
  onReloadFile,
  onSetMarkdownSource
}) => {
  const { t } = useTranslation()
  const { token } = antdTheme.useToken()
  const colorBorderSecondary = token.colorBorderSecondary
  const activeFile = openFiles.find((f) => f.path === activeFilePath) || null
  const activeReadOnly = Boolean(activeFile?.readOnly || activeFile?.tool)
  const pendingOfActive = activeFile ? (pendingByPath.get(activeFile.path) ?? []) : []

  /** Change currently displayed (diff view): the explicitly selected one, otherwise the latest pending change */
  const activeChange = useMemo<FileChangeView | null>(() => {
    if (!activeFile || pendingOfActive.length === 0) return null
    const explicit = pendingOfActive.find((c) => c.id === activeFile.changeId)
    if (explicit) return explicit
    const pending = pendingOfActive.filter((c) => c.status === 'pending')
    return pending.length > 0 ? pending[pending.length - 1] : pendingOfActive[0]
  }, [activeFile, pendingOfActive])

  const viewMode: 'edit' | 'diff' = activeFile?.view === 'diff' && activeChange ? 'diff' : 'edit'
  /** Markdown tabs default to WYSIWYG (rich text) and can switch to source */
  const isMarkdown =
    activeFile && !activeFile.tool ? getLanguageId(activeFile.path) === 'markdown' : false
  const markdownPreview = Boolean(isMarkdown && !activeFile?.markdownSource && !activeReadOnly)

  const [wrap, setWrap] = useState(() => localStorage.getItem('workspace-editor-wrap') === '1')
  const [caret, setCaret] = useState<EditorCaret | null>(null)
  /** Reading position per file (return there after switching tabs) */
  const restoreRef = useRef<Map<string, EditorRestoreState>>(new Map())

  /**
   * Adaptive status bar: when the panel narrows, **segments are hidden by priority**; text never wraps.
   *
   * The old approach let each segment squeeze itself (spans default to white-space:normal), so a
   * narrow panel wrapped text onto two lines while the status bar has a fixed 22px height — the
   * second line was simply swallowed, which looked like "the content disappeared".
   * Now: every segment is shrink-0 + nowrap (never wraps); when width runs out they yield in the
   * order below, finally leaving the two most critical ones: "line/column + save state".
   */
  const statusBarRef = useRef<HTMLDivElement>(null)
  const statusSegEls = useRef<Map<string, HTMLElement>>(new Map())
  /** Cached natural width per segment (hidden segments cannot be measured, so the cache is only updated while visible) */
  const statusNaturalWidth = useRef<Map<string, number>>(new Map())
  const [hiddenSegments, setHiddenSegments] = useState<Set<string>>(new Set())

  const statusSegRef = useCallback(
    (key: string) => (el: HTMLElement | null) => {
      if (el) statusSegEls.current.set(key, el)
      else statusSegEls.current.delete(key)
    },
    []
  )

  /** Yield order: earlier entries are hidden first (chars and caret are peers — only one appears at a time) */
  const STATUS_DROP_ORDER = ['selection', 'chars', 'lines', 'language', 'pending']
  const STATUS_STICKY = ['caret', 'state']

  /** Segments that don't fit: hidden entirely (no wrapping, no half truncation) */
  const segStyle = useCallback(
    (key: string): React.CSSProperties | undefined =>
      hiddenSegments.has(key) ? { display: 'none' } : undefined,
    [hiddenSegments]
  )

  /**
   * Adaptive toolbar.
   *
   * There used to be compactToolbar logic that collapsed buttons to icon-only when narrow; the
   * 2026-09-22 requirement was simply "don't show text on any of the buttons above, icons are
   * enough" — the buttons are icon-only anyway, so that state machine lost its purpose (keeping
   * it would actually hide the whole button group on narrow panels). Only the status-bar yield
   * logic remains.
   */
  const toolbarRef = useRef<HTMLDivElement>(null)

  const recomputeStatusFit = useCallback(() => {
    const bar = statusBarRef.current
    if (!bar) return
    const styles = window.getComputedStyle(bar)
    const padX = parseFloat(styles.paddingLeft || '0') + parseFloat(styles.paddingRight || '0')
    const gap = parseFloat(styles.columnGap || styles.gap || '0') || 0
    const available = bar.clientWidth - padX
    if (available <= 0) return

    // 1) First compute how wide "show everything" needs to be, based on natural widths
    const widthOf = (key: string): number => {
      const el = statusSegEls.current.get(key)
      const measured = el ? el.offsetWidth : 0
      if (measured > 0) statusNaturalWidth.current.set(key, measured)
      return statusNaturalWidth.current.get(key) ?? 0
    }

    const keys = [...statusSegEls.current.keys()]
    /**
     * Flexible elements (the `flex-1` spacer) do not count as "segments": by definition they shrink to 0.
     *
     * The old implementation treated it as a fixed segment (`gap * shown.length`, where the extra
     * +1 was it), so every additional visible segment added an extra gap — measured on a 300px
     * panel, with only 170px of actual fixed content it computed 220px and started hiding
     * segments (the "content squishes together while dragging" the user saw).
     */
    const isFlex = (key: string): boolean => {
      const el = statusSegEls.current.get(key)
      return el ? parseFloat(window.getComputedStyle(el).flexGrow || '0') > 0 : false
    }
    const totalOf = (hidden: Set<string>): number => {
      const shown = keys.filter((k) => !hidden.has(k))
      if (shown.length === 0) return 0
      // One gap between each visible element: segment count + flexible element count − 1
      const gapCount = Math.max(0, shown.length - 1)
      return shown.reduce((sum, k) => sum + widthOf(k), 0) + gap * gapCount
    }

    // 2) If too narrow, hide in yield order (critical segments never yield)
    const next = new Set<string>()
    let guard = 0
    while (totalOf(next) > available && guard++ < keys.length + 1) {
      const candidate = STATUS_DROP_ORDER.find(
        (k) => keys.includes(k) && !next.has(k) && !isFlex(k)
      )
      if (!candidate) break
      next.add(candidate)
    }
    // Still doesn't fit (extremely narrow panel): drop non-critical segments too, leaving only the sticky ones
    let guard2 = 0
    while (totalOf(next) > available && guard2++ < keys.length + 1) {
      const candidate = keys.find((k) => !next.has(k) && !STATUS_STICKY.includes(k) && !isFlex(k))
      if (!candidate) break
      next.add(candidate)
    }

    setHiddenSegments((prev) => {
      if (prev.size === next.size && [...prev].every((k) => next.has(k))) return prev
      return next
    })
  }, [])

  // Recompute when the status bar size or content changes (ResizeObserver covers window and split-pane drags)
  useLayoutEffect(() => {
    const bar = statusBarRef.current
    if (!bar) {
      if (hiddenSegments.size > 0) setHiddenSegments(new Set())
    } else {
      recomputeStatusFit()
    }
    const ro = new ResizeObserver(() => recomputeStatusFit())
    if (bar) ro.observe(bar)
    return () => ro.disconnect()
  }, [recomputeStatusFit, hiddenSegments.size, activeFilePath, caret, activeFile?.isDirty])

  const palette = useMemo<EditorPaletteInput>(
    () => ({
      dark: isDarkMode,
      background: colorBgContainer,
      foreground: colorText,
      muted: colorTextTertiary,
      border: colorBorderSecondary,
      accent: token.colorPrimary
    }),
    [
      isDarkMode,
      colorBgContainer,
      colorText,
      colorTextTertiary,
      colorBorderSecondary,
      token.colorPrimary
    ]
  )

  const toggleWrap = useCallback(() => {
    setWrap((prev) => {
      const next = !prev
      localStorage.setItem('workspace-editor-wrap', next ? '1' : '0')
      return next
    })
  }, [])

  // --- Tab overflow management ---
  const tabBarRef = useRef<HTMLDivElement>(null)
  const tabElemsRef = useRef<Map<string, HTMLDivElement>>(new Map())
  const [visibleCount, setVisibleCount] = useState(openFiles.length)

  useLayoutEffect(() => {
    const el = tabBarRef.current
    if (!el) return

    const calc = (): void => {
      const containerWidth = el.clientWidth
      const map = tabElemsRef.current

      // Pass 1: without "more" button, how many tabs fit?
      // Use cumulative offsetWidth instead of offsetLeft for reliable measurement
      let used = 0
      let count = openFiles.length
      for (let i = 0; i < openFiles.length; i++) {
        const tab = map.get(openFiles[i].path)
        used += tab ? tab.offsetWidth : 180
        if (used > containerWidth) {
          count = Math.max(1, i)
          break
        }
      }

      // Pass 2: if overflow, the "more" button takes space, recalc
      if (count < openFiles.length) {
        used = MORE_BTN_WIDTH
        for (let i = 0; i < openFiles.length; i++) {
          const tab = map.get(openFiles[i].path)
          used += tab ? tab.offsetWidth : 180
          if (used > containerWidth) {
            count = Math.max(1, i)
            break
          }
          count = i + 1
        }
      }

      setVisibleCount(count)
    }

    calc()
    const ro = new ResizeObserver(calc)
    ro.observe(el)
    return () => ro.disconnect()
  }, [openFiles])

  const visibleFiles = openFiles.slice(0, visibleCount)
  const overflowFiles = openFiles.slice(visibleCount)

  // Clear caret state when switching tabs (the new file's first update fills it back in)
  useEffect(() => {
    setCaret(null)
  }, [activeFilePath, viewMode])

  /**
   * Tab styling follows the VS Code Dark+ tab strip:
   * - strip background `#252526`, inactive tabs `#2d2d2d`, active tab shares the editor background `#1e1e1e`;
   * - a 2px accent line on top of the active tab (the most visible "current file" marker);
   * - square corners, a hairline divider between tabs; the close button appears only on active/hover (styles in the style block below).
   */
  const tabStripBg = isDarkMode ? '#252526' : '#f3f3f3'
  const tabInactiveBg = isDarkMode ? '#2d2d2d' : '#ececec'
  const tabDivider = isDarkMode ? '#252526' : '#e0e0e0'

  const tabBaseStyle = (isActive: boolean): React.CSSProperties => ({
    height: 33,
    maxWidth: 180,
    paddingLeft: 10,
    paddingRight: 24,
    color: isActive ? colorText : colorTextSecondary,
    background: isActive ? colorBgContainer : tabInactiveBg,
    borderTop: isActive ? `2px solid ${token.colorPrimary}` : '2px solid transparent',
    borderRight: `1px solid ${isActive ? tabStripBg : tabDivider}`,
    borderLeft: 'none',
    borderRadius: 0
  })

  const closeBtnStyle: React.CSSProperties = {
    position: 'absolute',
    right: 6,
    top: '50%',
    transform: 'translateY(-50%)',
    padding: '2px',
    borderRadius: 3,
    background: 'transparent',
    border: 'none',
    cursor: 'pointer'
  }

  // No files open → render nothing
  if (openFiles.length === 0) return null

  const dropdownItems = overflowFiles.map((f) => {
    const isActive = f.path === activeFilePath
    const count = pendingByPath.get(f.path)?.filter((c) => c.status === 'pending').length ?? 0
    return {
      key: f.path,
      className: isActive ? 'dropdown-file-item-active' : '',
      style: isActive
        ? {
            background: isDarkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'
          }
        : undefined,
      label: (
        <div className="flex items-center justify-between gap-2" style={{ minWidth: 160 }}>
          <span
            className="truncate text-xs"
            style={{
              maxWidth: 130,
              color: isActive ? colorText : colorTextSecondary,
              fontWeight: isActive ? 500 : 400
            }}
          >
            {f.name}
            {count > 0 && <span style={{ color: '#4a8f5b', marginLeft: 4 }}>+{count}</span>}
            {f.isDirty && (
              <span
                style={{
                  display: 'inline-block',
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: isDarkMode ? '#fcc419' : '#e67700',
                  marginLeft: 4,
                  verticalAlign: 'middle'
                }}
              />
            )}
          </span>
          <RiCloseLine
            size={14}
            style={{ color: colorTextTertiary, cursor: 'pointer', flexShrink: 0 }}
            onClick={(e) => {
              e.stopPropagation()
              onCloseFile(f.path)
            }}
          />
        </div>
      )
    }
  })

  const toolbarBtn = (active = false): React.CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    flexShrink: 0,
    height: 22,
    padding: '0 7px',
    fontSize: 11.5,
    borderRadius: 4,
    cursor: 'pointer',
    border: `1px solid ${active ? token.colorPrimary : 'transparent'}`,
    background: active
      ? isDarkMode
        ? 'rgba(255,255,255,0.06)'
        : 'rgba(0,0,0,0.04)'
      : 'transparent',
    color: active ? colorText : colorTextSecondary
  })

  const relPath = activeFile
    ? activeFile.path.replace(/\\/g, '/').split('/').slice(-3).join('/')
    : ''

  return (
    <div className="flex flex-col h-full overflow-hidden" style={{ background: colorBgContainer }}>
      <style>{`
        .file-overflow-dropdown .ant-dropdown-menu {
          display: grid;
          gap: 4px;
        }
        .file-overflow-dropdown .ant-dropdown-menu-item {
          border-radius: 4px;
        }
        /* Markdown WYSIWYG: the panel is much narrower than the home page, so drop the document
           editor's centered padding and let the toolbar wrap (otherwise buttons get pushed out in narrow panels) */
        .workspace-md-editor .tiptap-editor-body {
          max-width: none;
          padding: 14px 18px 48px;
        }
        .workspace-md-editor .tiptap-toolbar {
          flex-wrap: wrap;
          row-gap: 2px;
        }
        /* Tab close button: hidden on inactive tabs by default, shown on hover or when active (VS Code's approach) */
        .file-tab .file-tab-close {
          opacity: 0;
          transition: opacity 0.12s;
        }
        .file-tab:hover .file-tab-close,
        .file-tab[data-tab-active='1'] .file-tab-close {
          opacity: 1;
        }
        /* Editor area: the scrollbars belong to the editor itself; neither the host nor the panel scrolls */
        .cm-file-editor-host {
          height: 100%;
          overflow: hidden;
        }
        .cm-file-editor-host .cm-editor {
          height: 100%;
        }
      `}</style>
      {/* Tab bar */}
      <div
        ref={tabBarRef}
        data-testid="file-tabbar"
        className="flex items-stretch shrink-0 overflow-hidden relative"
        style={{
          height: 33,
          background: tabStripBg,
          borderBottom: `1px solid ${isDarkMode ? '#1e1e1e' : '#e4e4e4'}`
        }}
      >
        {visibleFiles.map((file) => {
          const isActive = file.path === activeFilePath
          const pendingCount =
            pendingByPath.get(file.path)?.filter((c) => c.status === 'pending').length ?? 0
          return (
            <div
              key={file.path}
              ref={(el) => {
                if (el) tabElemsRef.current.set(file.path, el)
                else tabElemsRef.current.delete(file.path)
              }}
              data-tab-active={isActive ? '1' : '0'}
              className="file-tab flex items-center gap-1.5 cursor-pointer select-none shrink-0 text-[13px] relative"
              style={tabBaseStyle(isActive)}
              onClick={() => onSelectFile(file.path)}
              title={file.path}
            >
              {(() => {
                const { Icon, color } = getFileIcon(file.path, isDarkMode)
                return <Icon size={14} style={{ color, flexShrink: 0 }} />
              })()}
              <span className="truncate flex-1 min-w-0">{file.name}</span>
              {/* Pending-change badge: opening this tab goes straight to the diff view */}
              {pendingCount > 0 && (
                <span
                  className="shrink-0 tabular-nums"
                  style={{
                    fontSize: 10,
                    lineHeight: '14px',
                    padding: '0 4px',
                    borderRadius: 7,
                    color: isDarkMode ? '#9ecf8a' : '#2f6b4f',
                    background: isDarkMode ? 'rgba(120,190,140,0.16)' : 'rgba(70,150,100,0.14)'
                  }}
                >
                  {pendingCount}
                </span>
              )}
              {file.isDirty && (
                <span
                  className="shrink-0"
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    background: isDarkMode ? '#fcc419' : '#e67700'
                  }}
                />
              )}
              <button
                className="file-tab-close"
                style={closeBtnStyle}
                onClick={(e) => {
                  e.stopPropagation()
                  onCloseFile(file.path)
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = isDarkMode
                    ? 'rgba(255,255,255,0.15)'
                    : 'rgba(0,0,0,0.1)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                }}
              >
                <RiCloseLine
                  size={15}
                  style={{ color: isDarkMode ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.4)' }}
                />
              </button>
            </div>
          )
        })}

        {overflowFiles.length > 0 && (
          <Dropdown
            menu={{
              items: dropdownItems,
              onClick: ({ key }) => {
                const file = overflowFiles.find((f) => f.path === key)
                if (file) onSelectFile(file.path)
              }
            }}
            trigger={['click']}
            placement="bottomRight"
            classNames={{ root: 'file-overflow-dropdown' }}
          >
            <div
              className="flex items-center justify-center shrink-0 cursor-pointer"
              style={{
                width: MORE_BTN_WIDTH,
                height: 34,
                color: colorTextSecondary,
                borderLeft: `1px solid ${isDarkMode ? '#1e1e1e' : '#e4e4e4'}`
              }}
            >
              <RiArrowDownSLine size={16} />
            </div>
          </Dropdown>
        )}
      </div>

      {/* Toolbar: path + view switch + wrap + reload.
          This row of buttons sits right under the tab bar, so tooltips all open **downward**
          (placement="bottom"): upward (antd's default) would cover the tab text above, while
          downward covers the top edge of the body and hides no action entry. */}
      {activeFile && !activeFile.tool && (
        <div
          ref={toolbarRef}
          data-testid="file-toolbar"
          className="flex items-center gap-1.5 px-2 shrink-0 overflow-hidden whitespace-nowrap"
          style={{
            height: 28,
            borderBottom: `1px solid ${colorBorderSecondary}`,
            background: isDarkMode ? 'rgba(255,255,255,0.015)' : 'rgba(0,0,0,0.010)'
          }}
        >
          <span
            className="text-[11.5px] truncate"
            style={{ color: colorTextTertiary, direction: 'rtl', textAlign: 'left' }}
            title={activeFile.path}
          >
            {relPath}
          </span>
          <div className="flex-1" />
          {activeFile.diskChanged && (
            <Tooltip title={t('harness.fileEditor.diskChangedTip')} placement="bottom">
              <span className="flex items-center gap-1 text-[11.5px]" style={{ color: '#c98a2b' }}>
                <RiFileWarningLine size={13} />
                {t('harness.fileEditor.diskChanged')}
              </span>
            </Tooltip>
          )}
          {/* Markdown: WYSIWYG / source switch (the diff view always uses source, since a diff must compare the raw text).
              Buttons are **icon only** (per the 2026-09-22 requirement "don't show text on any of the buttons above,
              icons are enough"); the text lives in the Tooltip. */}
          {isMarkdown && viewMode === 'edit' && !activeReadOnly && (
            <div className="flex items-center">
              <Tooltip title={t('harness.fileEditor.mdRichTip')} placement="bottom">
                <button
                  style={toolbarBtn(!activeFile.markdownSource)}
                  onClick={() => onSetMarkdownSource(activeFile.path, false)}
                >
                  <RiMarkdownLine size={13} />
                </button>
              </Tooltip>
              <Tooltip title={t('harness.fileEditor.mdSourceTip')} placement="bottom">
                <button
                  style={toolbarBtn(Boolean(activeFile.markdownSource))}
                  onClick={() => onSetMarkdownSource(activeFile.path, true)}
                >
                  <RiCodeSSlashLine size={13} />
                </button>
              </Tooltip>
            </div>
          )}
          {pendingOfActive.some((c) => c.status === 'pending') && (
            <div className="flex items-center">
              <Tooltip title={t('harness.fileEditor.modeEdit')} placement="bottom">
                <button
                  style={toolbarBtn(viewMode === 'edit')}
                  onClick={() => onChangeView(activeFile.path, 'edit')}
                >
                  <RiCodeSSlashLine size={13} />
                </button>
              </Tooltip>
              <Tooltip title={t('harness.fileEditor.modeDiff')} placement="bottom">
                <button
                  style={toolbarBtn(viewMode === 'diff')}
                  onClick={() => onChangeView(activeFile.path, 'diff')}
                >
                  <RiContrastLine size={13} />
                </button>
              </Tooltip>
            </div>
          )}
          {!activeReadOnly && (
            <Tooltip title={t('harness.fileEditor.reloadTip')} placement="bottom">
              <button style={toolbarBtn(false)} onClick={() => onReloadFile(activeFile.path)}>
                <RiArrowGoBackLine size={13} />
              </button>
            </Tooltip>
          )}
          <Tooltip title={t('harness.fileEditor.wrapTip')} placement="bottom">
            <button style={toolbarBtn(wrap)} onClick={toggleWrap}>
              <RiTextWrap size={13} />
            </button>
          </Tooltip>
        </div>
      )}

      {/* Tool result details tab (ls / glob / grep / execute): doesn't use the editor, renders in place by tool semantics */}
      {activeFile?.tool ? (
        <div className="flex-1 min-h-0">
          <ToolDetailView
            tab={activeFile.tool}
            style={{ isDarkMode, colorText, colorTextSecondary, colorTextTertiary }}
          />
        </div>
      ) : activeFile && viewMode === 'diff' && activeChange ? (
        <div className="flex-1 min-h-0">
          <FileDiffView
            filePath={activeFile.path}
            change={activeChange}
            pending={pendingOfActive}
            value={activeFile.content}
            isDarkMode={isDarkMode}
            palette={palette}
            colorText={colorText}
            colorTextSecondary={colorTextSecondary}
            colorTextTertiary={colorTextTertiary}
            colorBorderSecondary={colorBorderSecondary}
            isDirty={activeFile.isDirty}
            onChange={(value) => onContentChange(activeFile.path, value)}
            onApplyReview={(content) => onApplyReview(activeFile.path, content)}
            onKeep={onKeepChanges}
            onRevert={onRevertChange}
            onSelectChange={(id) => onSelectChange(activeFile.path, id)}
          />
        </div>
      ) : activeFile && markdownPreview ? (
        /* Markdown WYSIWYG: reuses the home page's document editor (TipTap v3 + tiptap-markdown);
           the toolbar adapts to the panel width. The diff view still uses source (a diff must compare the raw text) */
        <div className="flex-1 min-h-0 workspace-md-editor">
          <TipTapMarkdownEditor
            key={activeFile.path}
            value={activeFile.content}
            onChange={(markdown) => onContentChange(activeFile.path, markdown)}
            onSave={(markdown) => {
              onContentChange(activeFile.path, markdown)
              onSaveFile(activeFile.path)
            }}
            placeholder={t('harness.fileEditor.mdPlaceholder')}
            showToolbar
          />
        </div>
      ) : (
        <div className="flex-1 min-h-0">
          {activeFile && (
            <CodeEditor
              key={activeFile.path}
              filePath={activeFile.path}
              value={activeFile.content}
              palette={palette}
              readOnly={activeReadOnly}
              wrap={wrap}
              onChange={(value) => {
                if (!activeReadOnly) onContentChange(activeFile.path, value)
              }}
              onSave={() => onSaveFile(activeFile.path)}
              onCaret={setCaret}
              restore={restoreRef.current.get(activeFile.path) ?? null}
              onPersist={(state) => restoreRef.current.set(activeFile.path, state)}
            />
          )}
        </div>
      )}

      {/* Status bar: line/column / line count / language / save state (matching the information density an editor should have) */}
      {activeFile && !activeFile.tool && (
        <div
          ref={statusBarRef}
          data-testid="file-status-bar"
          className="flex items-center gap-3 px-3 shrink-0 text-[11px] tabular-nums whitespace-nowrap overflow-hidden"
          style={{
            height: 22,
            color: colorTextTertiary,
            borderTop: `1px solid ${colorBorderSecondary}`
          }}
        >
          {markdownPreview ? (
            /* The rich-text view has no line/column caret concept, so report the character count instead */
            <span
              data-seg="chars"
              ref={statusSegRef('chars')}
              className="shrink-0"
              style={segStyle('chars')}
            >
              {t('harness.fileEditor.chars', { count: activeFile.content.length })}
            </span>
          ) : (
            <>
              <span
                data-seg="caret"
                ref={statusSegRef('caret')}
                className="shrink-0"
                style={segStyle('caret')}
              >
                {t('harness.fileEditor.caret', {
                  line: caret?.line ?? 1,
                  column: caret?.column ?? 1
                })}
              </span>
              {caret && caret.selected > 0 && (
                <span
                  data-seg="selection"
                  ref={statusSegRef('selection')}
                  className="shrink-0"
                  style={segStyle('selection')}
                >
                  {t('harness.fileEditor.selected', { count: caret.selected })}
                </span>
              )}
              <span
                data-seg="lines"
                ref={statusSegRef('lines')}
                className="shrink-0"
                style={segStyle('lines')}
              >
                {t('harness.fileEditor.lines', { count: caret?.lines ?? 0 })}
              </span>
            </>
          )}
          <span
            data-seg="language"
            ref={statusSegRef('language')}
            className="shrink-0"
            style={segStyle('language')}
          >
            {getLanguageLabel(activeFile.path)}
          </span>
          <div className="flex-1" data-seg="spacer" />
          {pendingOfActive.some((c) => c.status === 'pending') && (
            <span
              data-seg="pending"
              ref={statusSegRef('pending')}
              className="shrink-0 flex items-center gap-1"
              style={{ color: '#2f6b4f', ...segStyle('pending') }}
            >
              <RiCheckLine size={12} />
              {t('harness.fileEditor.pendingReview', {
                count: pendingOfActive.filter((c) => c.status === 'pending').length
              })}
            </span>
          )}
          <span
            data-seg="state"
            ref={statusSegRef('state')}
            className="shrink-0"
            style={segStyle('state')}
          >
            {activeReadOnly
              ? t('harness.fileEditor.readOnly')
              : activeFile.isDirty
                ? t('harness.fileEditor.modified')
                : t('harness.fileEditor.saved')}
          </span>
        </div>
      )}
    </div>
  )
}

export default FileEditor
