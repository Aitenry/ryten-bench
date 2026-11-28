import { Extension } from '@tiptap/core'
import { Suggestion } from '@tiptap/suggestion'
import { ReactRenderer } from '@tiptap/react'
import type { Editor } from '@tiptap/react'
import type { ComponentType, MutableRefObject } from 'react'
import {
  RiText,
  RiListUnordered,
  RiListOrdered,
  RiCheckboxLine,
  RiDoubleQuotesL,
  RiCodeBoxLine,
  RiSeparator,
  RiTable2,
  RiFunctionLine,
  RiFunctionAddLine,
  RiFlowChart
} from '@remixicon/react'
import { i18n } from '@renderer/i18n'
import SlashMenuList from './SlashMenuList'
import type { SlashMenuListHandle, SlashMenuListProps } from './SlashMenuList'

/**
 * Slash menu theme colors (injected by the editor from antd tokens; the popup mounts on body
 * without theme context)
 */
export interface SlashMenuTheme {
  bg: string
  border: string
  text: string
  textSecondary: string
  textTertiary: string
  accent: string
  accentSoft: string
  hoverBg: string
}

/**
 * Label keys for slash menu entries. This is a non-component module (it has no t),
 * so title / description store **translation keys** rather than display text, and the
 * SlashMenuList component resolves them with t(); query filtering (filterItems) resolves
 * them through the global i18n instance. i18next keys are constrained by the resource
 * types, so they are narrowed to literal union types here.
 */
type SlashItemNameKey =
  | 'markdown.slash.paragraph'
  | 'markdown.slash.heading1'
  | 'markdown.slash.heading2'
  | 'markdown.slash.heading3'
  | 'markdown.slash.bulletList'
  | 'markdown.slash.orderedList'
  | 'markdown.slash.taskList'
  | 'markdown.slash.blockquote'
  | 'markdown.slash.codeBlock'
  | 'markdown.slash.inlineMath'
  | 'markdown.slash.blockMath'
  | 'markdown.slash.mermaid'
  | 'markdown.slash.table'
  | 'markdown.slash.horizontalRule'

type SlashItemDescKey =
  | 'markdown.slash.paragraphDescription'
  | 'markdown.slash.heading1Description'
  | 'markdown.slash.heading2Description'
  | 'markdown.slash.heading3Description'
  | 'markdown.slash.bulletListDescription'
  | 'markdown.slash.orderedListDescription'
  | 'markdown.slash.taskListDescription'
  | 'markdown.slash.blockquoteDescription'
  | 'markdown.slash.codeBlockDescription'
  | 'markdown.slash.inlineMathDescription'
  | 'markdown.slash.blockMathDescription'
  | 'markdown.slash.mermaidDescription'
  | 'markdown.slash.tableDescription'
  | 'markdown.slash.horizontalRuleDescription'

type SlashItemKeywordKey =
  | 'markdown.slash.keywords.paragraph'
  | 'markdown.slash.keywords.heading1'
  | 'markdown.slash.keywords.heading2'
  | 'markdown.slash.keywords.heading3'
  | 'markdown.slash.keywords.bulletList'
  | 'markdown.slash.keywords.orderedList'
  | 'markdown.slash.keywords.taskList'
  | 'markdown.slash.keywords.blockquote'
  | 'markdown.slash.keywords.codeBlock'
  | 'markdown.slash.keywords.inlineMath'
  | 'markdown.slash.keywords.blockMath'
  | 'markdown.slash.keywords.mermaid'
  | 'markdown.slash.keywords.table'
  | 'markdown.slash.keywords.horizontalRule'

export interface SlashMenuItemDef {
  key: string
  /** Translation key (resolved by t() in the renderer), not display-ready text */
  title: SlashItemNameKey
  /** Translation key (resolved by t() in the renderer), not display-ready text */
  description?: SlashItemDescKey
  /** Keyword translation key (space-separated, resolved by the renderer for the locale) */
  keywords?: SlashItemKeywordKey
  /** Text icon (e.g. H1), rendered in preference to Icon */
  iconText?: string
  /** remixicon icon component (size is number|string, matching RemixiconProps) */
  Icon?: ComponentType<{ size?: number | string }>
  run: (editor: Editor) => void
}

/* ──────────── Menu item definitions ──────────── */
/* Keywords also use translation keys: both Chinese and English keywords follow the UI
   language instead of being hardcoded */

export const SLASH_ITEMS: SlashMenuItemDef[] = [
  {
    key: 'paragraph',
    title: 'markdown.slash.paragraph',
    description: 'markdown.slash.paragraphDescription',
    keywords: 'markdown.slash.keywords.paragraph',
    Icon: RiText,
    run: (editor) => editor.chain().focus().setParagraph().run()
  },
  {
    key: 'h1',
    title: 'markdown.slash.heading1',
    description: 'markdown.slash.heading1Description',
    keywords: 'markdown.slash.keywords.heading1',
    iconText: 'H1',
    run: (editor) => editor.chain().focus().setHeading({ level: 1 }).run()
  },
  {
    key: 'h2',
    title: 'markdown.slash.heading2',
    description: 'markdown.slash.heading2Description',
    keywords: 'markdown.slash.keywords.heading2',
    iconText: 'H2',
    run: (editor) => editor.chain().focus().setHeading({ level: 2 }).run()
  },
  {
    key: 'h3',
    title: 'markdown.slash.heading3',
    description: 'markdown.slash.heading3Description',
    keywords: 'markdown.slash.keywords.heading3',
    iconText: 'H3',
    run: (editor) => editor.chain().focus().setHeading({ level: 3 }).run()
  },
  {
    key: 'bulletList',
    title: 'markdown.slash.bulletList',
    description: 'markdown.slash.bulletListDescription',
    keywords: 'markdown.slash.keywords.bulletList',
    Icon: RiListUnordered,
    run: (editor) => editor.chain().focus().toggleBulletList().run()
  },
  {
    key: 'orderedList',
    title: 'markdown.slash.orderedList',
    description: 'markdown.slash.orderedListDescription',
    keywords: 'markdown.slash.keywords.orderedList',
    Icon: RiListOrdered,
    run: (editor) => editor.chain().focus().toggleOrderedList().run()
  },
  {
    key: 'taskList',
    title: 'markdown.slash.taskList',
    description: 'markdown.slash.taskListDescription',
    keywords: 'markdown.slash.keywords.taskList',
    Icon: RiCheckboxLine,
    run: (editor) => editor.chain().focus().toggleTaskList().run()
  },
  {
    key: 'blockquote',
    title: 'markdown.slash.blockquote',
    description: 'markdown.slash.blockquoteDescription',
    keywords: 'markdown.slash.keywords.blockquote',
    Icon: RiDoubleQuotesL,
    run: (editor) => editor.chain().focus().toggleBlockquote().run()
  },
  {
    key: 'codeBlock',
    title: 'markdown.slash.codeBlock',
    description: 'markdown.slash.codeBlockDescription',
    keywords: 'markdown.slash.keywords.codeBlock',
    Icon: RiCodeBoxLine,
    run: (editor) => editor.chain().focus().toggleCodeBlock().run()
  },
  {
    key: 'inlineMath',
    title: 'markdown.slash.inlineMath',
    description: 'markdown.slash.inlineMathDescription',
    keywords: 'markdown.slash.keywords.inlineMath',
    Icon: RiFunctionLine,
    run: (editor) => editor.chain().focus().insertContent({ type: 'mathInline' }).run()
  },
  {
    key: 'blockMath',
    title: 'markdown.slash.blockMath',
    description: 'markdown.slash.blockMathDescription',
    keywords: 'markdown.slash.keywords.blockMath',
    Icon: RiFunctionAddLine,
    run: (editor) => editor.chain().focus().insertContent({ type: 'mathBlock' }).run()
  },
  {
    key: 'mermaid',
    title: 'markdown.slash.mermaid',
    description: 'markdown.slash.mermaidDescription',
    keywords: 'markdown.slash.keywords.mermaid',
    Icon: RiFlowChart,
    run: (editor) =>
      editor
        .chain()
        .focus()
        .insertContent({
          type: 'mermaid',
          attrs: { code: i18n.t('markdown.slash.mermaidTemplate') }
        })
        .run()
  },
  {
    key: 'table',
    title: 'markdown.slash.table',
    description: 'markdown.slash.tableDescription',
    keywords: 'markdown.slash.keywords.table',
    Icon: RiTable2,
    run: (editor) =>
      editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
  },
  {
    key: 'hr',
    title: 'markdown.slash.horizontalRule',
    description: 'markdown.slash.horizontalRuleDescription',
    keywords: 'markdown.slash.keywords.horizontalRule',
    Icon: RiSeparator,
    run: (editor) => editor.chain().focus().setHorizontalRule().run()
  }
]

/* ──────────── Query filtering ──────────── */

const normalize = (s: string): string => s.toLowerCase().replace(/\s+/g, '')

const filterItems = (query: string): SlashMenuItemDef[] => {
  const q = normalize(query)
  if (!q) return SLASH_ITEMS
  return SLASH_ITEMS.filter((item) => {
    /* Label keys are resolved for the current language during filtering: users search by the
       words they see in the UI */
    const haystack = [
      i18n.t(item.title),
      item.description ? i18n.t(item.description) : '',
      item.keywords ? i18n.t(item.keywords) : ''
    ]
      .map(normalize)
      .join(' ')
    return haystack.includes(q)
  })
}

/* ──────────── Extension factory ──────────── */

/**
 * Slash block menu: typing "/" at the start of a paragraph opens the block insertion menu.
 * @tiptap/suggestion v3 returns a native PM plugin, registered via addProseMirrorPlugins.
 */
export function buildSlashMenuExtension(themeRef: MutableRefObject<SlashMenuTheme>): Extension {
  return Extension.create({
    name: 'slashMenu',
    addProseMirrorPlugins() {
      const editor = this.editor
      return [
        Suggestion<SlashMenuItemDef, SlashMenuItemDef>({
          editor,
          char: '/',
          startOfLine: true,
          decorationClass: 'slash-decoration',
          /* Do not trigger inside code blocks */
          allow: ({ state, range }) => {
            const parent = state.doc.resolve(range.from).parent
            return !parent.type.spec.code
          },
          items: ({ query }) => filterItems(query),
          command: ({ editor: ed, range, props }) => {
            ed.chain().focus().deleteRange(range).run()
            props.run(ed)
          },
          render: () => {
            let component: ReactRenderer<SlashMenuListHandle, SlashMenuListProps> | null = null
            let unmount: (() => void) | null = null

            return {
              onStart: (props) => {
                component = new ReactRenderer(SlashMenuList, {
                  props: {
                    items: props.items,
                    theme: themeRef.current,
                    command: (item) => props.command(item)
                  },
                  editor: props.editor
                })
                /* Mount and let the host handle positioning (anchored to the cursor,
                   follows scrolling) */
                unmount = props.mount(component.element, {})
                component.element.classList.add('slash-menu-wrap')
              },
              onUpdate: (props) => {
                /* Must sync the new command closure: the range grows with the query text */
                component?.updateProps({
                  items: props.items,
                  theme: themeRef.current,
                  command: (item) => props.command(item)
                })
              },
              onKeyDown: (props) => {
                if (props.event.key === 'Escape') return false
                return component?.ref?.onKeyDown(props.event) ?? false
              },
              onExit: () => {
                unmount?.()
                unmount = null
                component?.destroy()
                component = null
              }
            }
          }
        })
      ]
    }
  })
}
