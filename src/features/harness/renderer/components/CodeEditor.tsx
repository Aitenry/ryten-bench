import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { Compartment, type Extension } from '@codemirror/state'
import { EditorView, keymap, type ViewUpdate } from '@codemirror/view'
import { useTranslation } from '@renderer/i18n'
import { loadLanguageExtension } from '../utils/fileLang'
import { editorTheme, type EditorPaletteInput } from '../utils/cmTheme'
import { editorPhrases } from '../utils/cmPhrases'
import { rytenFoldGutter } from '../utils/cmFoldGutter'
import EditorScrollbars from './EditorScrollbars'

/** 光标状态（底部状态条展示） */
export interface EditorCaret {
  /** 1 起的行号 */
  line: number
  /** 1 起的列号 */
  column: number
  /** 文档总行数 */
  lines: number
  /** 选中字符数（0 = 无选区） */
  selected: number
}

/** 切换页签时保留的阅读位置 */
export interface EditorRestoreState {
  scrollTop: number
  anchor: number
}

interface CodeEditorProps {
  /** 文档内容（受控） */
  value: string
  /** 文件路径（决定语法高亮；差异视图传真实文件路径） */
  filePath: string
  palette: EditorPaletteInput
  readOnly?: boolean
  /** 自动换行（窄面板里看长行用） */
  wrap?: boolean
  /** 额外扩展（差异视图的合并视图等） */
  extraExtensions?: Extension[]
  placeholder?: string
  onChange?: (value: string) => void
  /** Ctrl/Cmd+S */
  onSave?: () => void
  onCaret?: (caret: EditorCaret) => void
  onViewReady?: (view: EditorView) => void
  onUpdate?: (update: ViewUpdate) => void
  /** 挂载后恢复的滚动/光标位置 */
  restore?: EditorRestoreState | null
  /** 卸载前回调（用于把滚动/光标位置存回去） */
  onPersist?: (state: EditorRestoreState) => void
}

/**
 * 代码编辑器（CodeMirror 6，经 @uiw/react-codemirror 挂载）。
 *
 * 替换了原先的 Monaco：
 * - **按需分包**：语言语法是动态 import 的独立 chunk（Monaco 时代是 ~6MB 一次性下载求值）；
 * - **主题跟随应用**：浅/深色由 palette 决定，与面板底色、分隔线、滚动条一致；
 * - **中文界面**：查找面板、差异按钮等内置 UI 文案走 EditorState.phrases；
 * - **可扩展**：差异视图通过 extraExtensions 注入合并视图，不用另起一套编辑器。
 */
const CodeEditor: React.FC<CodeEditorProps> = ({
  value,
  filePath,
  palette,
  readOnly = false,
  wrap = false,
  extraExtensions,
  placeholder,
  onChange,
  onSave,
  onCaret,
  onViewReady,
  onUpdate,
  restore,
  onPersist
}) => {
  const { i18n } = useTranslation()
  const cmRef = useRef<ReactCodeMirrorRef>(null)
  const [language, setLanguage] = useState<Extension | null>(null)
  /** 编辑器实例：悬浮滚动条要读它的滚动几何（onCreateEditor 只会调一次，存 state 才能触发重渲染） */
  const [editorView, setEditorView] = useState<EditorView | null>(null)

  // 语言扩展异步加载（缓存命中的语言同步返回，不闪）
  useEffect(() => {
    let cancelled = false
    loadLanguageExtension(filePath).then((ext) => {
      if (!cancelled) setLanguage(ext)
    })
    return () => {
      cancelled = true
    }
  }, [filePath])

  // 用 ref 承接回调，避免回调身份变化导致扩展重建（编辑器重配）
  const handlers = useRef({ onSave, onCaret, onUpdate, onViewReady, onChange })
  handlers.current = { onSave, onCaret, onUpdate, onViewReady, onChange }

  const saveKeymap = useMemo(
    () =>
      keymap.of([
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            handlers.current.onSave?.()
            return true
          }
        }
      ]),
    []
  )

  /**
   * 折行开关走 Compartment：只重配这一个扩展，不触发整编辑器 reconfigure——
   * 整编辑器重配会把 history() 这类的字段重建，撤销历史就没了。
   */
  const wrapCompartment = useRef(new Compartment()).current

  const extensions = useMemo(() => {
    const list: Extension[] = [
      saveKeymap,
      editorPhrases(i18n.language),
      editorTheme(palette),
      // 折叠槽用 remixicon 图标（basicSetup 里同名开关已关掉，避免出现两条折叠槽）
      rytenFoldGutter,
      wrapCompartment.of(wrap ? EditorView.lineWrapping : [])
    ]
    if (extraExtensions) list.push(...extraExtensions)
    if (language) list.push(language)
    return list
    // palette 由调用方 useMemo 保持稳定：它一变就整编辑器重配（换深浅色时需要）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveKeymap, i18n.language, palette, language, extraExtensions, wrapCompartment])

  // 只重配折行 compartment（保留撤销历史与滚动位置）
  useEffect(() => {
    const view = cmRef.current?.view
    if (!view) return
    view.dispatch({
      effects: wrapCompartment.reconfigure(wrap ? EditorView.lineWrapping : [])
    })
  }, [wrap, wrapCompartment])

  const handleUpdate = useCallback((update: ViewUpdate) => {
    handlers.current.onUpdate?.(update)
    if (update.selectionSet || update.docChanged || update.focusChanged) {
      const { state } = update
      const head = state.selection.main.head
      const line = state.doc.lineAt(head)
      handlers.current.onCaret?.({
        line: line.number,
        column: head - line.from + 1,
        lines: state.doc.lines,
        selected: state.selection.ranges.reduce((sum, range) => sum + (range.to - range.from), 0)
      })
    }
  }, [])

  const handleCreate = useCallback(
    (view: EditorView) => {
      setEditorView(view)
      const restoreState = restore
      if (restoreState) {
        // 恢复阅读位置：先定位光标（会带来滚动），再按记录的 scrollTop 校正
        const pos = Math.min(restoreState.anchor, view.state.doc.length)
        view.dispatch({ selection: { anchor: pos } })
        view.scrollDOM.scrollTop = restoreState.scrollTop
      }
      handlers.current.onViewReady?.(view)
    },
    [restore]
  )

  // 卸载前保存阅读位置
  const persistRef = useRef(onPersist)
  persistRef.current = onPersist
  useEffect(() => {
    return () => {
      const view = cmRef.current?.view
      if (!view || !persistRef.current) return
      persistRef.current({
        scrollTop: view.scrollDOM.scrollTop,
        anchor: view.state.selection.main.head
      })
    }
  }, [])

  return (
    /* 外层只为悬浮滚动条提供定位上下文：编辑器本身仍然铺满 */
    <div className="relative h-full min-h-0">
      <CodeMirror
        ref={cmRef}
        className="cm-file-editor-host"
        height="100%"
        value={value}
        theme="none"
        extensions={extensions}
        editable={!readOnly}
        readOnly={readOnly}
        placeholder={placeholder}
        indentWithTab={!readOnly}
        basicSetup={{
          lineNumbers: true,
          // 折叠槽换成 remixicon 版本（见 utils/cmFoldGutter.ts），这里关掉自带的
          foldGutter: false,
          highlightActiveLine: true,
          highlightActiveLineGutter: true,
          highlightSelectionMatches: true,
          autocompletion: true,
          bracketMatching: true,
          closeBrackets: true,
          history: true,
          searchKeymap: true,
          tabSize: 2
        }}
        onCreateEditor={handleCreate}
        onUpdate={handleUpdate}
        onChange={(next) => handlers.current.onChange?.(next)}
        style={{ height: '100%', background: palette.background }}
      />
      <EditorScrollbars view={editorView} dark={palette.dark} />
    </div>
  )
}

export default CodeEditor
