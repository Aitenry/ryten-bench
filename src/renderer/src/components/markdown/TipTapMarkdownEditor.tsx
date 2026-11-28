import React, { useCallback, useEffect, useRef, useState } from 'react'
import { theme, Dropdown, Tooltip } from 'antd'
import type { GlobalToken } from 'antd'
import { useEditor, EditorContent, useEditorState, type Editor } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import { NodeSelection } from '@tiptap/pm/state'
import {
  RiArrowGoBackLine,
  RiArrowGoForwardLine,
  RiArrowDropDownLine,
  RiBold,
  RiItalic,
  RiUnderline,
  RiStrikethrough,
  RiCodeLine,
  RiMarkPenLine,
  RiLink,
  RiLinkUnlinkM,
  RiDoubleQuotesL,
  RiListUnordered,
  RiListOrdered,
  RiCheckboxLine,
  RiCodeBoxLine,
  RiSeparator,
  RiFormatClear
} from '@remixicon/react'
import { buildMarkdownEditorExtensions, getMarkdownSafe } from './markdownExtensions'
import { buildSlashMenuExtension } from './slash-menu'
import type { SlashMenuTheme } from './slash-menu'
import { useTranslation, Trans } from '@renderer/i18n'
import 'katex/dist/katex.min.css'
import './tiptap-content.css'

/**
 * Monospace font stack (used only for digits/Latin characters, same stack as the route
 * skeleton and the model settings page).
 * Monospace families lack Chinese glyphs, so Chinese text inside them would fall back
 * to SimSun in Chromium; that is why Chinese is never wrapped in it.
 */
const MONO_FONT = "'JetBrains Mono', 'Cascadia Code', Consolas, 'Courier New', monospace"

export interface TipTapMarkdownEditorProps {
  /** Markdown source text (synced into the editor when updated externally) */
  value?: string
  /** Called on every content change (Markdown text) */
  onChange?: (markdown: string) => void
  /** Ctrl+S save callback */
  onSave?: (markdown: string) => void
  placeholder?: string
  readOnly?: boolean
  /**
   * Called when the editor instance is ready (used for outline extraction and other
   * external wiring)
   */
  onReady?: (editor: Editor) => void
  /** Ref to the body scroll container (used for outline scroll sync) */
  scrollRef?: React.RefObject<HTMLDivElement | null>
  autofocus?: boolean | 'end'
  showToolbar?: boolean
  className?: string
}

/* ──────────── Image file → dataURL (compressed to limit size) ──────────── */

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('read file failed'))
    reader.readAsDataURL(file)
  })
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('load image failed'))
    img.src = src
  })
}

const MAX_IMAGE_SIZE = 1600

/**
 * Image compression strategy:
 * - GIF: kept as-is (canvas can only capture the first frame, so no compression)
 * - PNG (screenshots): downscaled proportionally only when too wide, kept as PNG for sharp text
 * - JPEG/WebP etc.: downscaled proportionally when too wide, then converted to JPEG q0.85
 */
async function compressImageFile(file: File): Promise<string | null> {
  try {
    if (file.type === 'image/gif') {
      return await readFileAsDataUrl(file)
    }
    const raw = await readFileAsDataUrl(file)
    const img = await loadImage(raw)
    let { width, height } = img
    const ratio = Math.min(1, MAX_IMAGE_SIZE / Math.max(width, height))
    if (ratio >= 1) {
      return file.type === 'image/png' ? raw : compressToJpeg(img, width, height)
    }
    width = Math.round(width * ratio)
    height = Math.round(height * ratio)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return raw
    ctx.drawImage(img, 0, 0, width, height)
    if (file.type === 'image/png') {
      return canvas.toDataURL('image/png')
    }
    return canvas.toDataURL('image/jpeg', 0.85)
  } catch (error) {
    console.error('Failed to compress image:', error)
    return null
  }
}

function compressToJpeg(img: HTMLImageElement, width: number, height: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return img.src
  ctx.drawImage(img, 0, 0)
  return canvas.toDataURL('image/jpeg', 0.85)
}

function normalizeUrl(url: string): string {
  const trimmed = url.trim()
  if (!trimmed) return ''
  if (/^(https?:\/\/|mailto:|tel:|#|\/)/i.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

/* ──────────── Main component ──────────── */

const TipTapMarkdownEditor: React.FC<TipTapMarkdownEditorProps> = ({
  value = '',
  onChange,
  onSave,
  placeholder,
  readOnly = false,
  onReady,
  scrollRef,
  autofocus = false,
  showToolbar = true,
  className
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const editorRef = useRef<Editor | null>(null)
  const lastMdRef = useRef(value)

  /* The default placeholder comes from a translation key; the editor is created on mount only
     (empty deps) and is not rebuilt after a language switch, so a ref holds the placeholder for
     the current language. NodeViews read it from the same ref so their text does not stay in the
     old language. */
  const placeholderRef = useRef('')
  placeholderRef.current = placeholder ?? t('markdown.editor.placeholder')

  /* Slash menu theme (the popup mounts on body, so tokens are passed in through a ref for it
     to read) */
  const slashThemeRef = useRef<SlashMenuTheme>({
    bg: token.colorBgElevated,
    border: token.colorBorderSecondary,
    text: token.colorText,
    textSecondary: token.colorTextSecondary,
    textTertiary: token.colorTextTertiary,
    accent: token.colorPrimary,
    accentSoft: token.colorPrimaryBg,
    hoverBg: token.colorFillTertiary
  })
  slashThemeRef.current = {
    bg: token.colorBgElevated,
    border: token.colorBorderSecondary,
    text: token.colorText,
    textSecondary: token.colorTextSecondary,
    textTertiary: token.colorTextTertiary,
    accent: token.colorPrimary,
    accentSoft: token.colorPrimaryBg,
    hoverBg: token.colorFillTertiary
  }

  /* Callbacks go through refs to avoid rebuilding the editor */
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave

  /* Link edit popup state */
  const [linkPop, setLinkPop] = useState<{ top: number; left: number; value: string } | null>(null)
  const linkInputRef = useRef<HTMLInputElement | null>(null)

  const insertImageAt = useCallback((dataUrl: string, pos?: number) => {
    const ed = editorRef.current
    if (!ed || ed.isDestroyed) return
    const insertPos = pos ?? ed.state.selection.from
    ed.chain()
      .focus()
      .insertContentAt(insertPos, { type: 'image', attrs: { src: dataUrl } })
      .run()
  }, [])

  const editor = useEditor({
    extensions: [
      ...buildMarkdownEditorExtensions(placeholderRef.current),
      ...(readOnly ? [] : [buildSlashMenuExtension(slashThemeRef)])
    ],
    content: value,
    editable: !readOnly,
    autofocus: autofocus === true ? true : autofocus === 'end' ? 'end' : false,
    editorProps: {
      attributes: {
        class: 'tiptap-editor',
        // The document body is plain-text editing, so disable the browser's spell/grammar squiggles
        spellcheck: 'false',
        autocorrect: 'off',
        autocapitalize: 'off'
      },
      handleKeyDown: (_view, event) => {
        // Ctrl/Cmd + K: open the link popup
        if (
          (event.metaKey || event.ctrlKey) &&
          !event.shiftKey &&
          event.key.toLowerCase() === 'k'
        ) {
          event.preventDefault()
          openLinkPop()
          return true
        }
        return false
      },
      handlePaste: (view, event) => {
        const files = event.clipboardData?.files
        const images = files ? Array.from(files).filter((f) => f.type.startsWith('image/')) : []
        if (images.length === 0) return false
        // Pasted screenshots/images: compress, then insert as a dataURL
        event.preventDefault()
        const pos = view.state.selection.from
        void (async () => {
          let p = pos
          for (const file of images) {
            const dataUrl = await compressImageFile(file)
            if (dataUrl) {
              insertImageAt(dataUrl, p)
              p += 1
            }
          }
        })()
        return true
      },
      handleDrop: (view, event, _slice, moved) => {
        if (moved) return false
        const files = event.dataTransfer?.files
        const images = files ? Array.from(files).filter((f) => f.type.startsWith('image/')) : []
        if (images.length === 0) return false
        event.preventDefault()
        const coords = view.posAtCoords({ left: event.clientX, top: event.clientY })
        const pos = coords?.pos ?? view.state.selection.from
        void (async () => {
          let p = pos
          for (const file of images) {
            const dataUrl = await compressImageFile(file)
            if (dataUrl) {
              insertImageAt(dataUrl, p)
              p += 1
            }
          }
        })()
        return true
      }
    },
    onUpdate: ({ editor: ed }) => {
      const md = getMarkdownSafe(ed)
      lastMdRef.current = md
      onChangeRef.current?.(md)
    }
  })
  editorRef.current = editor

  /* Sync when the external value changes (switching documents when a modal reuses the same
     instance) */
  useEffect(() => {
    const ed = editorRef.current
    if (!ed || ed.isDestroyed) return
    const current = getMarkdownSafe(ed)
    if (value !== current) {
      lastMdRef.current = value
      ed.commands.setContent(value, { emitUpdate: false })
    }
  }, [value])

  /* Ready callback */
  useEffect(() => {
    if (editor && onReady) onReady(editor)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor])

  /* ── Open the link popup ── */
  const openLinkPop = useCallback(() => {
    const ed = editorRef.current
    if (!ed) return
    const sel = window.getSelection()
    const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null
    if (!range) return
    const rect = range.getBoundingClientRect()
    const href = (ed.getAttributes('link').href as string | undefined) ?? ''
    // Use the selection content when there is one, otherwise default to the current link
    const top = Math.min(rect.bottom + 8, window.innerHeight - 72)
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - 320))
    setLinkPop({ top: Math.max(top, 8), left, value: href })
  }, [])

  const applyLink = useCallback((url: string) => {
    const ed = editorRef.current
    setLinkPop(null)
    if (!ed || ed.isDestroyed) return
    const normalized = normalizeUrl(url)
    const chain = ed.chain().focus()
    if (!normalized) {
      chain.extendMarkRange('link').unsetLink().run()
    } else if (ed.state.selection.empty) {
      chain.extendMarkRange('link').setLink({ href: normalized }).run()
    } else {
      chain.setLink({ href: normalized }).run()
    }
  }, [])

  /* Close when clicking outside the popup */
  useEffect(() => {
    if (!linkPop) return
    const handler = (e: MouseEvent): void => {
      const target = e.target as HTMLElement
      if (!target.closest('.tiptap-link-pop')) setLinkPop(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [linkPop])

  /* ── Ctrl+S save ── */
  useEffect(() => {
    if (readOnly) return
    const handler = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        const ed = editorRef.current
        if (ed && !ed.isDestroyed) onSaveRef.current?.(getMarkdownSafe(ed))
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [readOnly])

  /* ── Theme CSS variables ── */
  const cssVars = {
    '--ed-text': token.colorText,
    '--ed-text-secondary': token.colorTextSecondary,
    '--ed-text-tertiary': token.colorTextTertiary,
    '--ed-border': token.colorBorderSecondary,
    '--ed-accent': token.colorPrimary,
    '--ed-accent-soft': token.colorPrimaryBg,
    '--ed-hover-bg': token.colorFillTertiary,
    '--ed-toolbar-bg': token.colorBgContainer,
    '--ed-quote-bg': token.colorFillQuaternary,
    '--ed-code-inline-bg': token.colorFillTertiary,
    '--ed-code-inline-text': token.colorText,
    '--ed-code-bg': token.colorFillQuaternary,
    '--ed-code-border': token.colorBorderSecondary,
    '--ed-code-text': token.colorText,
    '--ed-mark-bg': token.colorWarningBg,
    '--ed-selection-bg': token.colorPrimaryBg,
    '--ed-th-bg': token.colorFillQuaternary,
    '--ed-bubble-bg': token.colorBgElevated,
    '--ed-input-bg': token.colorBgContainer
  } as React.CSSProperties

  return (
    <div className={`tiptap-editor-root ${className ?? ''}`} style={cssVars}>
      {editor && !readOnly && showToolbar && (
        <EditorToolbar editor={editor} token={token} onLinkClick={openLinkPop} />
      )}
      <div className="tiptap-editor-scroll custom-scrollbar" ref={scrollRef}>
        <div className="tiptap-editor-body">
          <EditorContent editor={editor} />
        </div>
      </div>

      {editor && !readOnly && (
        <BubbleMenu
          editor={editor}
          className="tiptap-bubble-menu"
          options={{ placement: 'top', offset: 8 }}
          shouldShow={({ state }) => {
            const { selection } = state
            // Hide the text-format toolbar when an atomic node such as Mermaid/KaTeX is
            // selected (NodeSelection)
            if (selection instanceof NodeSelection) return false
            return Boolean(selection && !selection.empty)
          }}
        >
          <BubbleButtons editor={editor} onLinkClick={openLinkPop} />
        </BubbleMenu>
      )}

      {linkPop && (
        <div className="tiptap-link-pop" style={{ top: linkPop.top, left: linkPop.left }}>
          <input
            ref={linkInputRef}
            autoFocus
            defaultValue={linkPop.value}
            placeholder={t('markdown.editor.linkPlaceholder')}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applyLink(e.currentTarget.value)
              if (e.key === 'Escape') setLinkPop(null)
            }}
          />
          <button
            className="link-apply"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (linkInputRef.current) applyLink(linkInputRef.current.value)
            }}
          >
            {t('common.action.confirm')}
          </button>
          <button
            className="link-cancel"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setLinkPop(null)}
          >
            {t('common.action.cancel')}
          </button>
        </div>
      )}
    </div>
  )
}

/* ──────────── Toolbar ──────────── */

interface EditorToolbarProps {
  editor: Editor
  token: GlobalToken
  onLinkClick: () => void
}

/**
 * Label keys for the toolbar heading dropdown (i18next keys are resource-typed, so they are
 * narrowed to literals)
 */
type ToolbarHeadingLabelKey =
  | 'markdown.toolbar.paragraph'
  | 'markdown.toolbar.heading1'
  | 'markdown.toolbar.heading2'
  | 'markdown.toolbar.heading3'
  | 'markdown.toolbar.heading4'

const EditorToolbar: React.FC<EditorToolbarProps> = ({ editor, onLinkClick }) => {
  const { t } = useTranslation()
  const state = useEditorState({
    editor,
    selector: ({ editor: ed }) =>
      ed
        ? {
            canUndo: ed.can().undo(),
            canRedo: ed.can().redo(),
            bold: ed.isActive('bold'),
            italic: ed.isActive('italic'),
            underline: ed.isActive('underline'),
            strike: ed.isActive('strike'),
            code: ed.isActive('code'),
            highlight: ed.isActive('highlight'),
            link: ed.isActive('link'),
            blockquote: ed.isActive('blockquote'),
            bulletList: ed.isActive('bulletList'),
            orderedList: ed.isActive('orderedList'),
            taskList: ed.isActive('taskList'),
            codeBlock: ed.isActive('codeBlock'),
            heading: ([1, 2, 3, 4] as const).find((l) => ed.isActive('heading', { level: l })) ?? 0,
            chars: ed.state.doc.textContent.replace(/\s/g, '').length
          }
        : null
  })

  if (!state) return null

  const prevent = (e: React.MouseEvent): void => e.preventDefault()

  const btn = (
    title: string,
    icon: React.ReactNode,
    action: () => void,
    active = false,
    disabled = false
  ): React.ReactNode => (
    /* The toolbar sits flush against the top edge of the editor, so tooltips always open downward:
       upward would cover the row of buttons/tabs above (reported by the user on 2026-09-26) */
    <Tooltip title={title} key={title} placement="bottom">
      <button
        className={`tiptap-toolbar-btn${active ? ' tiptap-toolbar-btn-active' : ''}`}
        onMouseDown={prevent}
        onClick={action}
        disabled={disabled}
      >
        {icon}
      </button>
    </Tooltip>
  )

  const headingItems: { key: string; label: string }[] = [
    { key: 'p', label: t('markdown.toolbar.paragraph') },
    { key: 'h1', label: t('markdown.toolbar.heading1') },
    { key: 'h2', label: t('markdown.toolbar.heading2') },
    { key: 'h3', label: t('markdown.toolbar.heading3') },
    { key: 'h4', label: t('markdown.toolbar.heading4') }
  ]

  /* Current label of the heading dropdown: uses the same source as the dropdown options to
     avoid drift between the two */
  const headingLabelKeys: Record<number, ToolbarHeadingLabelKey> = {
    1: 'markdown.toolbar.heading1',
    2: 'markdown.toolbar.heading2',
    3: 'markdown.toolbar.heading3',
    4: 'markdown.toolbar.heading4'
  }

  return (
    <div className="tiptap-toolbar">
      {btn(
        t('markdown.toolbar.undo'),
        <RiArrowGoBackLine size={15} />,
        () => editor.chain().focus().undo().run(),
        false,
        !state.canUndo
      )}
      {btn(
        t('markdown.toolbar.redo'),
        <RiArrowGoForwardLine size={15} />,
        () => editor.chain().focus().redo().run(),
        false,
        !state.canRedo
      )}
      <div className="tiptap-toolbar-divider" />
      <Dropdown
        trigger={['click']}
        menu={{
          items: headingItems,
          selectable: true,
          selectedKeys: [state.heading ? `h${state.heading}` : 'p'],
          onClick: ({ key }) => {
            if (key === 'p') {
              editor.chain().focus().setParagraph().run()
            } else {
              editor
                .chain()
                .focus()
                .toggleHeading({ level: Number(key.slice(1)) as 1 | 2 | 3 | 4 })
                .run()
            }
          }
        }}
      >
        <button className="tiptap-toolbar-btn" onMouseDown={prevent}>
          {state.heading ? t(headingLabelKeys[state.heading]) : t('markdown.toolbar.paragraph')}
          <RiArrowDropDownLine size={14} style={{ marginLeft: 1 }} />
        </button>
      </Dropdown>
      <div className="tiptap-toolbar-divider" />
      {btn(
        t('markdown.toolbar.bold'),
        <RiBold size={15} />,
        () => editor.chain().focus().toggleBold().run(),
        state.bold
      )}
      {btn(
        t('markdown.toolbar.italic'),
        <RiItalic size={15} />,
        () => editor.chain().focus().toggleItalic().run(),
        state.italic
      )}
      {btn(
        t('markdown.toolbar.underline'),
        <RiUnderline size={15} />,
        () => editor.chain().focus().toggleUnderline().run(),
        state.underline
      )}
      {btn(
        t('markdown.toolbar.strike'),
        <RiStrikethrough size={15} />,
        () => editor.chain().focus().toggleStrike().run(),
        state.strike
      )}
      {btn(
        t('markdown.toolbar.inlineCode'),
        <RiCodeLine size={15} />,
        () => editor.chain().focus().toggleCode().run(),
        state.code
      )}
      {btn(
        t('markdown.toolbar.highlight'),
        <RiMarkPenLine size={15} />,
        () => editor.chain().focus().toggleHighlight().run(),
        state.highlight
      )}
      <div className="tiptap-toolbar-divider" />
      {btn(t('markdown.toolbar.link'), <RiLink size={15} />, onLinkClick, state.link)}
      {state.link &&
        btn(t('markdown.toolbar.unlink'), <RiLinkUnlinkM size={15} />, () =>
          editor.chain().focus().extendMarkRange('link').unsetLink().run()
        )}
      {btn(
        t('markdown.toolbar.blockquote'),
        <RiDoubleQuotesL size={15} />,
        () => editor.chain().focus().toggleBlockquote().run(),
        state.blockquote
      )}
      {btn(
        t('markdown.toolbar.bulletList'),
        <RiListUnordered size={15} />,
        () => editor.chain().focus().toggleBulletList().run(),
        state.bulletList
      )}
      {btn(
        t('markdown.toolbar.orderedList'),
        <RiListOrdered size={15} />,
        () => editor.chain().focus().toggleOrderedList().run(),
        state.orderedList
      )}
      {btn(
        t('markdown.toolbar.taskList'),
        <RiCheckboxLine size={15} />,
        () => editor.chain().focus().toggleTaskList().run(),
        state.taskList
      )}
      {btn(
        t('markdown.toolbar.codeBlock'),
        <RiCodeBoxLine size={15} />,
        () => editor.chain().focus().toggleCodeBlock().run(),
        state.codeBlock
      )}
      {btn(t('markdown.toolbar.horizontalRule'), <RiSeparator size={15} />, () =>
        editor.chain().focus().setHorizontalRule().run()
      )}
      <div className="tiptap-toolbar-spacer" />
      <span className="tiptap-toolbar-label">
        {/*
          Digits use the monospace font, Chinese uses the default UI font (see the font rules
          at the top of the file)
        */}
        <Trans
          i18nKey="markdown.editor.charCount"
          count={state.chars}
          components={{ mono: <span style={{ fontFamily: MONO_FONT }} /> }}
        />
      </span>
    </div>
  )
}

/* ──────────── Bubble menu (floats on text selection) ──────────── */

interface BubbleButtonsProps {
  editor: Editor
  onLinkClick: () => void
}

const BubbleButtons: React.FC<BubbleButtonsProps> = ({ editor, onLinkClick }) => {
  const { t } = useTranslation()
  const state = useEditorState({
    editor,
    selector: ({ editor: ed }) =>
      ed
        ? {
            bold: ed.isActive('bold'),
            italic: ed.isActive('italic'),
            underline: ed.isActive('underline'),
            strike: ed.isActive('strike'),
            code: ed.isActive('code'),
            highlight: ed.isActive('highlight'),
            link: ed.isActive('link')
          }
        : null
  })

  if (!state) return null

  const prevent = (e: React.MouseEvent): void => e.preventDefault()
  const btn = (
    title: string,
    icon: React.ReactNode,
    action: () => void,
    active = false
  ): React.ReactNode => (
    <Tooltip title={title} key={title} placement="bottom">
      <button
        className={`tiptap-toolbar-btn${active ? ' tiptap-toolbar-btn-active' : ''}`}
        onMouseDown={prevent}
        onClick={action}
      >
        {icon}
      </button>
    </Tooltip>
  )

  return (
    <>
      {btn(
        t('markdown.toolbar.boldShort'),
        <RiBold size={14} />,
        () => editor.chain().focus().toggleBold().run(),
        state.bold
      )}
      {btn(
        t('markdown.toolbar.italicShort'),
        <RiItalic size={14} />,
        () => editor.chain().focus().toggleItalic().run(),
        state.italic
      )}
      {btn(
        t('markdown.toolbar.underlineShort'),
        <RiUnderline size={14} />,
        () => editor.chain().focus().toggleUnderline().run(),
        state.underline
      )}
      {btn(
        t('markdown.toolbar.strike'),
        <RiStrikethrough size={14} />,
        () => editor.chain().focus().toggleStrike().run(),
        state.strike
      )}
      {btn(
        t('markdown.toolbar.inlineCode'),
        <RiCodeLine size={14} />,
        () => editor.chain().focus().toggleCode().run(),
        state.code
      )}
      {btn(
        t('markdown.toolbar.highlight'),
        <RiMarkPenLine size={14} />,
        () => editor.chain().focus().toggleHighlight().run(),
        state.highlight
      )}
      {btn(t('markdown.toolbar.link'), <RiLink size={14} />, onLinkClick, state.link)}
      {btn(t('markdown.toolbar.clearFormat'), <RiFormatClear size={14} />, () =>
        editor.chain().focus().unsetAllMarks().clearNodes().run()
      )}
    </>
  )
}

export default TipTapMarkdownEditor
