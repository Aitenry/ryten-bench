import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { Compartment, type Extension } from '@codemirror/state'
import { EditorView, keymap, type ViewUpdate } from '@codemirror/view'
import { useTranslation } from '@renderer/i18n'
import { loadLanguageExtension } from '../../utils/harness/fileLang'
import { editorTheme, type EditorPaletteInput } from '../../utils/harness/cmTheme'
import { editorPhrases } from '../../utils/harness/cmPhrases'
import { rytenFoldGutter } from '../../utils/harness/cmFoldGutter'
import EditorScrollbars from './EditorScrollbars'

/** Caret state (shown in the status bar at the bottom) */
export interface EditorCaret {
  /** 1-based line number */
  line: number
  /** 1-based column number */
  column: number
  /** Total number of lines in the document */
  lines: number
  /** Number of selected characters (0 = no selection) */
  selected: number
}

/** Reading position kept when switching tabs */
export interface EditorRestoreState {
  scrollTop: number
  anchor: number
}

interface CodeEditorProps {
  /** Document content (controlled) */
  value: string
  /** File path (determines syntax highlighting; the diff view passes the real file path) */
  filePath: string
  palette: EditorPaletteInput
  readOnly?: boolean
  /** Soft wrap (for long lines in narrow panels) */
  wrap?: boolean
  /** Extra extensions (e.g. the diff view's merge view) */
  extraExtensions?: Extension[]
  placeholder?: string
  onChange?: (value: string) => void
  /** Ctrl/Cmd+S */
  onSave?: () => void
  onCaret?: (caret: EditorCaret) => void
  onViewReady?: (view: EditorView) => void
  onUpdate?: (update: ViewUpdate) => void
  /** Scroll/caret position restored after mount */
  restore?: EditorRestoreState | null
  /** Called before unmount (to persist the scroll/caret position) */
  onPersist?: (state: EditorRestoreState) => void
}

/**
 * Code editor (CodeMirror 6, mounted through @uiw/react-codemirror).
 *
 * Replaces the previous Monaco editor:
 * - **On-demand chunks**: language grammars are dynamic imports in separate chunks (previously
 *   ~6MB was downloaded and evaluated up front);
 * - **Theme follows the app**: light/dark is decided by palette, consistent with the panel
 *   background, separators and scrollbars;
 * - **Localized built-in UI**: copy for the search panel, diff buttons, etc. goes through
 *   EditorState.phrases;
 * - **Extensible**: the diff view injects a merge view via extraExtensions instead of running a
 *   separate editor.
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
  /** Editor instance: the floating scrollbars need its scroll geometry (onCreateEditor only fires once, so storing state triggers a re-render) */
  const [editorView, setEditorView] = useState<EditorView | null>(null)

  // Load the language extension asynchronously (cached languages resolve synchronously, no flicker)
  useEffect(() => {
    let cancelled = false
    loadLanguageExtension(filePath).then((ext) => {
      if (!cancelled) setLanguage(ext)
    })
    return () => {
      cancelled = true
    }
  }, [filePath])

  // Hold callbacks in a ref so changing callback identity doesn't rebuild extensions (editor reconfiguration)
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
   * The wrap toggle goes through a Compartment: only that one extension is reconfigured, without
   * reconfiguring the whole editor — a full reconfiguration rebuilds fields like history() and
   * loses the undo history.
   */
  const wrapCompartment = useRef(new Compartment()).current

  const extensions = useMemo(() => {
    const list: Extension[] = [
      saveKeymap,
      editorPhrases(i18n.language),
      editorTheme(palette),
      // Use the remixicon fold gutter (the same-named option in basicSetup is disabled to avoid two fold gutters)
      rytenFoldGutter,
      wrapCompartment.of(wrap ? EditorView.lineWrapping : [])
    ]
    if (extraExtensions) list.push(...extraExtensions)
    if (language) list.push(language)
    return list
    // palette is kept stable by the caller's useMemo: when it changes the whole editor is reconfigured (needed for theme switches)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveKeymap, i18n.language, palette, language, extraExtensions, wrapCompartment])

  // Reconfigure only the wrap compartment (keeps undo history and scroll position)
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
        // Restore the reading position: place the caret first (which scrolls), then correct to the recorded scrollTop
        const pos = Math.min(restoreState.anchor, view.state.doc.length)
        view.dispatch({ selection: { anchor: pos } })
        view.scrollDOM.scrollTop = restoreState.scrollTop
      }
      handlers.current.onViewReady?.(view)
    },
    [restore]
  )

  // Save the reading position before unmount
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
    /* The outer element only provides a positioning context for the floating scrollbars: the editor itself still fills it */
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
          // Fold gutter is replaced by the remixicon version (see utils/cmFoldGutter.ts); disable the built-in one here
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
