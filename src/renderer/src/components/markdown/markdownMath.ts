import { Node, InputRule, mergeAttributes } from '@tiptap/core'
import type { NodeViewRendererProps } from '@tiptap/core'
import type MarkdownIt from 'markdown-it'
import type StateBlock from 'markdown-it/lib/rules_block/state_block'
import type StateInline from 'markdown-it/lib/rules_inline/state_inline'
import katex from 'katex'
import { i18n } from '@renderer/i18n'

/* ════════════════════════════════════════════════════════════
   KaTeX math adaptation ($...$ inline / $$...$$ block)
   - markdown-it plugin: $..$ → <span data-math>, $$..$$ → <div data-math-block>
   - mathInline / mathBlock are atom nodes (attrs.tex) the cursor cannot enter; clicking one
     pops up a textarea inside the NodeView for in-place editing, with live KaTeX rendering
   - serialization restores $..$ / $$..$$, a complete round trip with parsing
   ════════════════════════════════════════════════════════════ */

/* ──────────── markdown-it plugin ──────────── */

/** Block rule: $$...$$ (single or multiple lines; the closing line must be exactly $$) */
function mathBlockRule(
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean
): boolean {
  const start = state.bMarks[startLine] + state.tShift[startLine]
  const max = state.eMarks[startLine]
  if (state.src.charCodeAt(start) !== 0x24 /* $ */) return false
  if (state.src.charCodeAt(start + 1) !== 0x24) return false
  if (state.src.charCodeAt(start + 2) === 0x24) return false // $$$ is not supported

  const openLine = state.src.slice(start, max).trim()

  // Single-line form: $$content$$
  const single = /^\$\$(.+)\$\$$/.exec(openLine)
  if (single) {
    if (silent) return true
    const token = state.push('math_block', '', 0)
    token.content = single[1].trim()
    token.map = [startLine, startLine + 1]
    state.line = startLine + 1
    return true
  }

  // Multi-line form: the opening line must be exactly $$
  if (openLine !== '$$') return false

  let nextLine = startLine + 1
  const lines: string[] = []
  for (; nextLine < endLine; nextLine++) {
    const line = state.src.slice(state.bMarks[nextLine], state.eMarks[nextLine])
    if (/^\s*\$\$\s*$/.test(line)) break
    lines.push(line)
  }
  if (nextLine >= endLine) return false // not closed: leave it to plain text so nothing is swallowed

  if (silent) return true
  const token = state.push('math_block', '', 0)
  token.content = lines.join('\n').trim()
  token.map = [startLine, nextLine + 1]
  state.line = nextLine + 1
  return true
}

/** Inline rule: $...$ (skips $$, \$, and cases where whitespace sits right after the opening $ or before the closing one, so currency etc. is not matched by mistake) */
function mathInlineRule(state: StateInline, silent: boolean): boolean {
  const start = state.pos
  const src = state.src
  const len = state.posMax
  if (src.charCodeAt(start) !== 0x24) return false
  if (src.charCodeAt(start + 1) === 0x24) return false // $$ goes to the block rule
  if (
    start > 0 &&
    src.charCodeAt(start - 1) === 0x5c /* \ */ &&
    src.charCodeAt(start - 2) !== 0x5c
  ) {
    return false // \$ escape
  }
  if (start + 1 >= len || /\s/.test(src[start + 1])) return false // no whitespace allowed right after an opening $

  let pos = start + 1
  while (pos < len) {
    if (src.charCodeAt(pos) === 0x24) {
      if (src.charCodeAt(pos + 1) === 0x24) {
        pos += 2
        continue
      }
      if (pos > start + 1 && !/\s/.test(src[pos - 1])) {
        if (silent) return true
        const token = state.push('math_inline', 'math', 0)
        token.content = src.slice(start + 1, pos)
        state.pos = pos + 1
        return true
      }
    }
    pos++
  }
  return false
}

/** markdown-it plugin entry (md.use(mathPlugin)) */
export function mathPlugin(md: MarkdownIt): void {
  md.block.ruler.before('fence', 'math_block', mathBlockRule)
  md.inline.ruler.before('escape', 'math_inline', mathInlineRule)

  md.renderer.rules.math_block = (tokens, idx) =>
    `<div data-math-block>${md.utils.escapeHtml(tokens[idx].content)}</div>`
  md.renderer.rules.math_inline = (tokens, idx) =>
    `<span data-math>${md.utils.escapeHtml(tokens[idx].content)}</span>`
}

/* ──────────── KaTeX NodeView (click to pop up a textarea for in-place editing) ──────────── */

function createMathNodeView(displayMode: boolean) {
  return (props: NodeViewRendererProps) => {
    const dom = document.createElement(displayMode ? 'div' : 'span')
    dom.className = displayMode ? 'tiptap-math tiptap-math-block' : 'tiptap-math'

    const outputEl = document.createElement('span')
    outputEl.className = 'tiptap-math-output'

    dom.append(outputEl)

    let editing = false
    let destroyed = false
    let textarea: HTMLTextAreaElement | null = null

    const renderOutput = (): void => {
      const tex = (props.node.attrs.tex as string) ?? ''
      outputEl.classList.remove('tiptap-math-empty', 'tiptap-math-error')
      try {
        if (!tex.trim()) {
          outputEl.textContent = displayMode ? '$$' : '$ $'
          outputEl.classList.add('tiptap-math-empty')
        } else {
          katex.render(tex, outputEl, { displayMode, throwOnError: false, strict: 'ignore' })
        }
      } catch {
        outputEl.textContent = tex || '$$'
        outputEl.classList.add('tiptap-math-error')
      }
    }
    renderOutput()

    const commit = (): void => {
      if (!editing || destroyed) return
      const next = textarea?.value ?? ''
      const tex = next.trim()
      editing = false
      textarea?.remove()
      textarea = null
      dom.classList.remove('tiptap-math-editing')
      // Restore the rendered output (hidden by enterEdit, otherwise the formula disappears after commit)
      outputEl.style.display = ''
      const pos = props.getPos()
      if (pos != null && tex !== props.node.attrs.tex) {
        props.editor
          .chain()
          .focus()
          .command(({ tr }) => {
            tr.setNodeMarkup(pos, undefined, { tex })
            return true
          })
          .run()
      } else {
        renderOutput()
      }
    }

    const cancel = (): void => {
      if (!editing || destroyed) return
      editing = false
      textarea?.remove()
      textarea = null
      dom.classList.remove('tiptap-math-editing')
      outputEl.style.display = ''
      renderOutput()
    }

    const enterEdit = (): void => {
      if (editing || destroyed) return
      const tex = (props.node.attrs.tex as string) ?? ''
      editing = true
      dom.classList.add('tiptap-math-editing')
      outputEl.style.display = 'none'
      textarea = document.createElement('textarea')
      textarea.className = 'tiptap-math-textarea'
      textarea.value = tex
      textarea.rows = displayMode ? 2 : 1
      textarea.spellcheck = false
      textarea.placeholder = i18n.t('markdown.math.placeholder')
      textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          cancel()
        } else if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          e.stopPropagation()
          commit()
        }
      })
      textarea.addEventListener('blur', (e) => {
        // Do not commit when focus merely moves inside the node (e.g. clicking the textarea
        // itself), to avoid a false trigger
        const related = (e as FocusEvent).relatedTarget as globalThis.Node | null
        if (related && dom.contains(related)) return
        commit()
      })
      dom.append(textarea)
      textarea.focus()
      textarea.select()
    }

    dom.addEventListener('mousedown', (e) => {
      // Intercept in view mode (so PM/the browser do not grab focus before editing starts);
      // let it through in edit mode so the textarea can place the cursor normally
      if (!editing) e.preventDefault()
    })
    dom.addEventListener('click', (e) => {
      if (editing || destroyed) return
      e.preventDefault()
      enterEdit()
    })

    return {
      dom,
      update(node) {
        props.node = node
        if (!editing) renderOutput()
        return true
      },
      // Intercept PM events while editing (textarea input is handled by the textarea itself)
      stopEvent() {
        return editing
      },
      destroy() {
        destroyed = true
      }
    }
  }
}

/* ──────────── Node definitions ──────────── */

export const MathInline = Node.create({
  name: 'mathInline',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return { tex: { default: '' } }
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-math]',
        getAttrs: (el) => ({ tex: (el as HTMLElement).textContent ?? '' })
      }
    ]
  },

  renderHTML({ node, HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-math': '' }), node.attrs.tex]
  },

  addStorage() {
    return {
      markdown: {
        serialize(state, node) {
          state.write(`$${node.attrs.tex as string}$`)
        }
      }
    }
  },

  addNodeView() {
    return createMathNodeView(false)
  },

  addInputRules() {
    return [
      new InputRule({
        // Inline $x$ + space (the lookbehind does not consume the leading character, so the space is not removed with it)
        find: /(?<=^|[^$])\$([^$\n]+?)\$\s$/,
        handler: ({ state, range, match }) => {
          const tr = state.tr
          tr.delete(range.from, range.to)
          tr.insert(range.from, state.schema.nodes.mathInline.create({ tex: match[1] }))
          return undefined
        }
      })
    ]
  }
})

export const MathBlock = Node.create({
  name: 'mathBlock',
  group: 'block',
  atom: true,
  selectable: true,

  addAttributes() {
    return { tex: { default: '' } }
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-math-block]',
        getAttrs: (el) => ({ tex: (el as HTMLElement).textContent ?? '' })
      }
    ]
  },

  renderHTML({ node, HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-math-block': '' }), node.attrs.tex]
  },

  addStorage() {
    return {
      markdown: {
        serialize(state, node) {
          state.write(`$$\n${((node.attrs.tex as string) ?? '').trim()}\n$$`)
          state.closeBlock(node)
        }
      }
    }
  },

  addNodeView() {
    return createMathNodeView(true)
  },

  addInputRules() {
    return [
      new InputRule({
        // Typing $$content$$ at the start of a line converts it into a block formula immediately
        find: /^\$\$([^$\n]*)\$\$$/,
        handler: ({ state, range, match }) => {
          const tr = state.tr
          tr.delete(range.from, range.to)
          tr.insert(range.from, state.schema.nodes.mathBlock.create({ tex: match[1] ?? '' }))
          return undefined
        }
      })
    ]
  }
})
