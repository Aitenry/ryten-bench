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
import { getLanguageLabel, getLanguageId } from '../utils/fileLang'
import { getFileIcon } from '../utils/fileIcons'
import type { EditorPaletteInput } from '../utils/cmTheme'
import type { FileChangeView } from '../types/file-change'
import { useTranslation } from '@renderer/i18n'

export interface OpenFile {
  path: string
  name: string
  content: string
  isDirty: boolean
  /** 只读页签（工具结果详情；或工作区之外的记忆文件）——不参与保存、不显示未保存圆点 */
  readOnly?: boolean
  /** 工具结果详情页签：有值时渲染 ToolDetailView 而不是编辑器 */
  tool?: ToolDetailTab
  /** 视图模式：差异（审查模型改动）/ 编辑 */
  view?: 'edit' | 'diff'
  /** 差异视图当前展示的改动 id */
  changeId?: number | null
  /** 页签处于未保存状态时磁盘被改动过（不覆盖用户输入，只提示） */
  diskChanged?: boolean
  /** Markdown 页签是否改用「源码」视图（缺省是所见即所得） */
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
  /** 各文件待审查的改动（正序：最早在前） */
  pendingByPath: Map<string, FileChangeView[]>
  onCloseFile: (filePath: string) => void
  onSelectFile: (filePath: string) => void
  onContentChange: (filePath: string, content: string) => void
  onSaveFile: (filePath: string) => void
  /** 切换编辑 / 差异视图 */
  onChangeView: (filePath: string, view: 'edit' | 'diff') => void
  /** 差异视图里选择查看哪一次改动 */
  onSelectChange: (filePath: string, changeId: number) => void
  onKeepChanges: (ids: number[]) => void
  onRevertChange: (id: number) => void
  onApplyReview: (filePath: string, content: string) => void
  /** 从磁盘重新读取（外部改动后手动刷新） */
  onReloadFile: (filePath: string) => void
  /** Markdown 页签切换「所见即所得 / 源码」 */
  onSetMarkdownSource: (filePath: string, source: boolean) => void
}

/** Width reserved for the "more" dropdown button. */
const MORE_BTN_WIDTH = 38

/**
 * 文件编辑器：页签栏 + 工具条 + 编辑器/差异视图 + 状态条。
 *
 * 编辑器内核已从 Monaco 换成 CodeMirror 6（见 CodeEditor），差异视图走 @codemirror/merge。
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

  /** 当前展示的改动（差异视图）：显式选中的那条，缺省用最新一条待审查改动 */
  const activeChange = useMemo<FileChangeView | null>(() => {
    if (!activeFile || pendingOfActive.length === 0) return null
    const explicit = pendingOfActive.find((c) => c.id === activeFile.changeId)
    if (explicit) return explicit
    const pending = pendingOfActive.filter((c) => c.status === 'pending')
    return pending.length > 0 ? pending[pending.length - 1] : pendingOfActive[0]
  }, [activeFile, pendingOfActive])

  const viewMode: 'edit' | 'diff' = activeFile?.view === 'diff' && activeChange ? 'diff' : 'edit'
  /** Markdown 页签默认所见即所得（富文本），可切到源码 */
  const isMarkdown =
    activeFile && !activeFile.tool ? getLanguageId(activeFile.path) === 'markdown' : false
  const markdownPreview = Boolean(isMarkdown && !activeFile?.markdownSource && !activeReadOnly)

  const [wrap, setWrap] = useState(() => localStorage.getItem('workspace-editor-wrap') === '1')
  const [caret, setCaret] = useState<EditorCaret | null>(null)
  /** 每个文件的阅读位置（切换页签后回到原处） */
  const restoreRef = useRef<Map<string, EditorRestoreState>>(new Map())

  /**
   * 状态条自适应：面板变窄时**按优先级隐藏分段**，绝不让文字换行。
   *
   * 之前的做法是让各段自己挤（span 默认 white-space:normal），面板一窄文字就折成两行，
   * 而状态条是固定 22px 高 —— 第二行直接被吞掉，看起来就是「内容不见了」。
   * 现在：所有分段 shrink-0 + nowrap（永不换行），宽度不够时按下面的顺序依次让位，
   * 最后留下「行列 + 保存状态」这两条最关键的。
   */
  const statusBarRef = useRef<HTMLDivElement>(null)
  const statusSegEls = useRef<Map<string, HTMLElement>>(new Map())
  /** 各分段的自然宽度缓存（隐藏后量不到宽度，所以只在可见时更新缓存） */
  const statusNaturalWidth = useRef<Map<string, number>>(new Map())
  const [hiddenSegments, setHiddenSegments] = useState<Set<string>>(new Set())

  const statusSegRef = useCallback(
    (key: string) => (el: HTMLElement | null) => {
      if (el) statusSegEls.current.set(key, el)
      else statusSegEls.current.delete(key)
    },
    []
  )

  /** 让位顺序：越靠前越先被隐藏（chars 与 caret 同级，二者只会出现一个） */
  const STATUS_DROP_ORDER = ['selection', 'chars', 'lines', 'language', 'pending']
  const STATUS_STICKY = ['caret', 'state']

  /** 被判定放不下的分段：整体隐藏（不换行、不截半） */
  const segStyle = useCallback(
    (key: string): React.CSSProperties | undefined =>
      hiddenSegments.has(key) ? { display: 'none' } : undefined,
    [hiddenSegments]
  )

  /**
   * 工具条自适应。
   *
   * 这里曾有「窄了就把按钮收成纯图标」的 compactToolbar 逻辑；用户 2026-09-22 直接要求
   * 「上面的所有按钮不要显示文字，只要图标即可」——按钮本来就只画图标了，那套状态机
   * 失去对象（保留它反而会在窄面板下把按钮整段藏掉）。现在只留状态条的让位逻辑。
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

    // 1) 先按自然宽度算出「全部显示」需要多宽
    const widthOf = (key: string): number => {
      const el = statusSegEls.current.get(key)
      const measured = el ? el.offsetWidth : 0
      if (measured > 0) statusNaturalWidth.current.set(key, measured)
      return statusNaturalWidth.current.get(key) ?? 0
    }

    const keys = [...statusSegEls.current.keys()]
    /**
     * 弹性元素（`flex-1` 占位符）不算「分段」：它按定义收缩到 0。
     *
     * 旧实现把它当成一个固定分段（`gap * shown.length`，其中额外 +1 就是它），
     * 于是每多显示一个分段就多算一个 gap——实测 300px 面板下明明只剩 170px
     * 的固定内容，却被算成 220px 而开始隐藏分段（用户看到的「拖动时内容挤在一起」）。
     */
    const isFlex = (key: string): boolean => {
      const el = statusSegEls.current.get(key)
      return el ? parseFloat(window.getComputedStyle(el).flexGrow || '0') > 0 : false
    }
    const totalOf = (hidden: Set<string>): number => {
      const shown = keys.filter((k) => !hidden.has(k))
      if (shown.length === 0) return 0
      // 每个可见元素之间一个 gap：分段数 + 弹性元素数 − 1
      const gapCount = Math.max(0, shown.length - 1)
      return shown.reduce((sum, k) => sum + widthOf(k), 0) + gap * gapCount
    }

    // 2) 不够宽就按让位顺序依次隐藏（关键分段不参与让位）
    const next = new Set<string>()
    let guard = 0
    while (totalOf(next) > available && guard++ < keys.length + 1) {
      const candidate = STATUS_DROP_ORDER.find(
        (k) => keys.includes(k) && !next.has(k) && !isFlex(k)
      )
      if (!candidate) break
      next.add(candidate)
    }
    // 内容仍放不下（面板极窄）：连非关键分段一起收掉，只留 sticky
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

  // 状态条尺寸或内容变化时重算（ResizeObserver 覆盖窗口与分栏拖拽）
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

  // 切换页签时清空光标状态（新文件的第一次 update 会重新填上）
  useEffect(() => {
    setCaret(null)
  }, [activeFilePath, viewMode])

  /**
   * 页签样式对齐参考设计（VS Code Dark+ 的页签条）：
   * - 条底 `#252526`、非活动页签 `#2d2d2d`、活动页签与编辑器同底 `#1e1e1e`；
   * - 活动页签顶部一条 2px 强调色（这是「当前文件」最醒目的标识）；
   * - 方角、页签之间一条发丝分隔线；关闭按钮只在活动/悬停时出现（样式见下方 style 块）。
   */
  const tabStripBg = isDarkMode ? '#252526' : '#f3f3f3'
  const tabInactiveBg = isDarkMode ? '#2d2d2d' : '#ececec'
  const tabDivider = isDarkMode ? '#252526' : '#e0e0e0'

  const tabBaseStyle = (isActive: boolean): React.CSSProperties => ({
    height: 35,
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
        /* Markdown 所见即所得：面板比首页窄得多，收掉文档编辑器的居中留白，
           工具栏允许换行（否则窄面板下按钮被挤出去） */
        .workspace-md-editor .tiptap-editor-body {
          max-width: none;
          padding: 14px 18px 48px;
        }
        .workspace-md-editor .tiptap-toolbar {
          flex-wrap: wrap;
          row-gap: 2px;
        }
        /* 页签关闭按钮：非活动页签默认隐藏，悬停或活动时才出现（VS Code 的做法） */
        .file-tab .file-tab-close {
          opacity: 0;
          transition: opacity 0.12s;
        }
        .file-tab:hover .file-tab-close,
        .file-tab[data-tab-active='1'] .file-tab-close {
          opacity: 1;
        }
        /* 编辑器区域：滚动条只属于编辑器本身，宿主与面板都不滚 */
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
          height: 35,
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
              {/* 待审查改动角标：点开这个页签会直接进差异视图 */}
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

      {/* 工具条：路径 + 视图切换 + 折行 + 重新载入。
          这一排按钮贴着页签栏下沿，提示统一朝**下**弹（placement="bottom"）：
          朝上（antd 默认）会盖住上面的页签文字，朝下压在正文上沿、不遮任何操作入口。 */}
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
          {/* Markdown：所见即所得 / 源码 切换（差异视图固定用源码，diff 需要原文）。
              按钮**只有图标**（用户 2026-09-22：「上面的所有按钮不要显示文字，只要图标即可」），
              文案在 Tooltip 里。 */}
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

      {/* 工具结果详情页签（ls / glob / grep / execute）：不走编辑器，按工具语义就地渲染 */}
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
        /* Markdown 所见即所得：复用首页文档编辑器（TipTap v3 + tiptap-markdown），
           工具栏随面板宽度自适应；差异视图仍走源码（diff 必须比对原文） */
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

      {/* 状态条：行列 / 行数 / 语言 / 保存状态（对齐编辑器应有的信息密度） */}
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
            /* 富文本视图没有行/列光标概念，改报字数 */
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
