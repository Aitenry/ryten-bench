import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Highlight from '@tiptap/extension-highlight'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import TiptapImage from '@tiptap/extension-image'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import Placeholder from '@tiptap/extension-placeholder'
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table'
import { Markdown } from 'tiptap-markdown'
import { common, createLowlight } from 'lowlight'
import { Extension, InputRule } from '@tiptap/core'
import { Fragment, type Node as PMNode } from '@tiptap/pm/model'
import type { Editor } from '@tiptap/react'
import type { Extensions } from '@tiptap/core'
import type MarkdownIt from 'markdown-it'
import { taskCheckboxPlugin } from './taskCheckboxPlugin'
import { MathInline, MathBlock, mathPlugin } from './markdownMath'
import { MdxBlock, MdxInline, setupMdxParse } from './mdx'
import { Mermaid } from './mermaid'

/* ────────────────────────────────────────────────────────────
   Underline / highlight have no standard Markdown syntax, so they serialize to
   <u>/<mark> HTML; with html mode enabled on the Markdown extension, markdown-it
   parses it back and the round trip is complete
   (the parseHTML of Underline/Highlight already matches the u / mark tags)
   ──────────────────────────────────────────────────────────── */
const MarkdownUnderline = Underline.extend({
  addStorage() {
    return {
      markdown: {
        serialize: { open: '<u>', close: '</u>' }
      }
    }
  }
})

const MarkdownHighlight = Highlight.extend({
  addStorage() {
    return {
      markdown: {
        serialize: { open: '<mark>', close: '</mark>' }
      }
    }
  }
})

/** Syntax highlighting language set (lowlight ships 37 common languages) */
const lowlight = createLowlight(common)

/**
 * Task list parse override: an in-house plugin (with mixed list splitting) replaces the
 * markdown-it-task-lists bundled with tiptap-markdown; serialization uses the default spec.
 */
const MarkdownTaskList = TaskList.extend({
  addStorage() {
    return {
      markdown: {
        parse: {
          setup(markdownit: MarkdownIt) {
            markdownit.use(taskCheckboxPlugin)
          },
          updateDOM(element: Element) {
            ;[...element.querySelectorAll('.contains-task-list')].forEach((list) => {
              list.setAttribute('data-type', 'taskList')
            })
          }
        }
      }
    }
  }
})

/**
 * taskList supports the tight attribute just like bulletList/orderedList, keeping task
 * lists compact when serialized (without blank-line separators).
 */
const MarkdownTightTaskLists = Extension.create({
  name: 'markdownTightTaskLists',
  addGlobalAttributes() {
    return [
      {
        types: ['taskList'],
        attributes: {
          tight: {
            default: true,
            parseHTML: (element: HTMLElement) =>
              element.getAttribute('data-tight') === 'true' || !element.querySelector('p'),
            renderHTML: (attributes: Record<string, unknown>) => ({
              class: attributes.tight ? 'tight' : null,
              'data-tight': attributes.tight ? 'true' : null
            })
          }
        }
      }
    ]
  }
})

/**
 * Typing "- [ ] " / "- [x] " converts the line into a task item.
 * TipTap v3 no longer bundles an input rule on TaskItem, so add one here: convert the
 * bulletList/listItem at the cursor into taskList/taskItem in place, and if the list has
 * other regular items, split it into sibling lists (leading part + task list + trailing part).
 * Note: the v3 input rule protocol requires the handler to modify state.tr and return null,
 * leaving dispatch to the inputRules plugin (this rule is exported for testing).
 */
export const taskItemTypingRule = new InputRule({
  find: /^\s*\[( |x)\]\s$/,
  handler: ({ state, range, match }) => {
    const schema = state.schema
    const tr = state.tr
    /* Delete the "[ ] " text first; later nodes are read from the updated document */
    tr.delete(range.from, range.to)
    const $pos = tr.doc.resolve(range.from)

    let liDepth = -1
    let listDepth = -1
    for (let d = $pos.depth; d > 0; d--) {
      const name = $pos.node(d).type.name
      if (name === 'listItem') liDepth = d
      else if (name === 'bulletList') listDepth = d
    }
    if (liDepth < 0 || listDepth < 0) return null

    const liNode = $pos.node(liDepth)
    const listNode = $pos.node(listDepth)
    const liStart = $pos.before(liDepth)
    const listStart = $pos.before(listDepth)
    const listEnd = $pos.after(listDepth)

    const taskItem = schema.nodes.taskItem.create(
      { checked: match[1] === 'x' },
      liNode.content,
      liNode.marks
    )
    const taskList = schema.nodes.taskList.create(null, taskItem)

    if (listNode.childCount === 1) {
      tr.replaceWith(listStart, listEnd, taskList)
    } else {
      /* Split the before/after items by child index (note that Fragment.cut works with a
         character offset, so it cannot be used directly) */
      const index = tr.doc.resolve(liStart).index()
      const beforeNodes: PMNode[] = []
      const afterNodes: PMNode[] = []
      listNode.content.forEach((child, _offset, i) => {
        if (i < index) beforeNodes.push(child)
        else if (i > index) afterNodes.push(child)
      })
      const before = Fragment.fromArray(beforeNodes)
      const after = Fragment.fromArray(afterNodes)
      const parts: PMNode[] = []
      if (before.size > 0) {
        parts.push(schema.nodes.bulletList.create(listNode.attrs, before, listNode.marks))
      }
      parts.push(taskList)
      if (after.size > 0) {
        parts.push(schema.nodes.bulletList.create(listNode.attrs, after, listNode.marks))
      }
      tr.replaceWith(listStart, listEnd, Fragment.fromArray(parts))
    }
    /* v3 input rule protocol: the handler modifies state.tr and returns undefined, and the plugin dispatches it */
    return undefined
  }
})

const MarkdownTaskItemTyping = Extension.create({
  name: 'markdownTaskItemTyping',
  addInputRules() {
    return [taskItemTypingRule]
  }
})

/**
 * Content adaptation during Markdown parsing: KaTeX math ($..$ / $$..$$) and MDX source
 * protection. The setup hook is called by tiptap-markdown before every parse.
 */
const MarkdownContentExtras = Extension.create({
  name: 'markdownContentExtras',
  addStorage() {
    return {
      markdown: {
        parse: {
          setup(md: MarkdownIt) {
            setupMdxParse(md)
            md.use(mathPlugin)
          }
        }
      }
    }
  }
})

/** Build the extension set for the WYSIWYG Markdown editor */
export function buildMarkdownEditorExtensions(placeholder: string): Extensions {
  return [
    /* Custom block/inline nodes must be registered before CodeBlockLowlight (pre code):
       parseDOM matches in schema order, so pre[data-mermaid] / pre[data-mdx-src] are hit first */
    Mermaid,
    MdxBlock,
    MdxInline,
    MathInline,
    MathBlock,
    MarkdownContentExtras,
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4] },
      // Code blocks use CodeBlockLowlight (with syntax highlighting)
      codeBlock: false,
      // StarterKit bundles Link/Underline: Link is configured directly;
      // Underline needs custom markdown serialization (<u> round trip),
      // so the built-in instance is disabled in favor of MarkdownUnderline below
      link: {
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        HTMLAttributes: { rel: 'noopener noreferrer' }
      },
      underline: false
    }),
    MarkdownUnderline,
    MarkdownHighlight,
    MarkdownTightTaskLists,
    MarkdownTaskList,
    MarkdownTaskItemTyping,
    TaskItem.configure({ nested: true }),
    TiptapImage.configure({ inline: false, allowBase64: true }),
    CodeBlockLowlight.configure({ lowlight, defaultLanguage: null }),
    Table.configure({ resizable: true }),
    TableRow,
    TableHeader,
    TableCell,
    Placeholder.configure({ placeholder }),
    Markdown.configure({
      html: true,
      tightLists: true,
      bulletListMarker: '-',
      // GFM autolink: parse bare URLs as links (consistent with the Link extension's autolink)
      linkify: true,
      breaks: false,
      transformPastedText: true,
      transformCopiedText: false
    })
  ]
}

/** Serialize the current document as Markdown (falls back to plain text on failure so nothing throws) */
export function getMarkdownSafe(editor: Editor): string {
  try {
    const storage = editor.storage as { markdown?: { getMarkdown?: () => string } }
    const md = storage.markdown?.getMarkdown?.()
    if (typeof md === 'string') return md
  } catch (error) {
    console.error('Failed to serialize markdown:', error)
  }
  return editor.getText({ blockSeparator: '\n' })
}
