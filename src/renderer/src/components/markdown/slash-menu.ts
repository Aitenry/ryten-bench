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

/** Slash 菜单主题色（由编辑器注入 antd token，弹层挂载在 body 上无主题上下文） */
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
 * 斜杠菜单条目的文案键。本模块是非组件模块（不持有 t），
 * 因此 title / description 存**词条键**而不是中文文案，由渲染组件
 * SlashMenuList 用 t() 求值；查询过滤（filterItems）用全局 i18n 解析。
 * i18next 的键受资源类型约束，故在此收窄成字面量联合类型。
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
  /** 词条键（由渲染层 t() 求值），不是可直接展示的文案 */
  title: SlashItemNameKey
  /** 词条键（由渲染层 t() 求值），不是可直接展示的文案 */
  description?: SlashItemDescKey
  /** 检索词词条键（空格分隔，由渲染层按当前语言解析） */
  keywords?: SlashItemKeywordKey
  /** 文字图标（如 H1），优先于 Icon 渲染 */
  iconText?: string
  /** remixicon 图标组件（size 为 number|string，与 RemixiconProps 一致） */
  Icon?: ComponentType<{ size?: number | string }>
  run: (editor: Editor) => void
}

/* ──────────── 菜单项定义 ──────────── */
/* 检索词也走词条：中文/英文关键词都随界面语言取，不在代码里写死 */

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

/* ──────────── 查询过滤 ──────────── */

const normalize = (s: string): string => s.toLowerCase().replace(/\s+/g, '')

const filterItems = (query: string): SlashMenuItemDef[] => {
  const q = normalize(query)
  if (!q) return SLASH_ITEMS
  return SLASH_ITEMS.filter((item) => {
    /* 文案键在过滤时按当前语言解析：用户按界面上看到的词搜索 */
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

/* ──────────── 扩展工厂 ──────────── */

/**
 * Slash 块菜单：在段落开头输入 "/" 弹出块插入菜单（Notion/思源交互）。
 * @tiptap/suggestion v3 返回原生 PM 插件，经 addProseMirrorPlugins 注册。
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
          /* 代码块内不触发 */
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
                /* 挂载并托管定位（锚定光标，跟随滚动） */
                unmount = props.mount(component.element, {})
                component.element.classList.add('slash-menu-wrap')
              },
              onUpdate: (props) => {
                /* 必须同步新的 command 闭包：range 会随查询文本增长 */
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
