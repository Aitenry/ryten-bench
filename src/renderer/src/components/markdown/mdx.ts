import { Node, mergeAttributes } from '@tiptap/core'
import type MarkdownIt from 'markdown-it'

/* ════════════════════════════════════════════════════════════
   MDX content adaptation: import/export statements and JSX (<Component>, <> fragments,
   {...} attribute expressions) are preserved verbatim when editing and saving, and are
   not mangled by markdown parsing
   - protectMdx: before parsing, replace MDX fragments with <pre data-mdx-src>…</pre>
     (markdown-it passes them through verbatim; on the PM side mdxBlock nodes take them
     over, and serialization restores the original text)
   - JSX fragments in html_inline → <span data-mdx-inline> (mdxInline atomic node)
   ════════════════════════════════════════════════════════════ */

const MAX_RUN_LINES = 500

/** Whether a line looks like an MDX construct: an import/export statement or a JSX tag */
export function isMdxLine(line: string): boolean {
  const t = line.trim()
  if (/^(?:import|export)(?:\s|[{*])/.test(t)) return true
  if (!t.startsWith('<')) return false
  return (
    /^<\/?\s*[A-Z]/.test(t) || // Capitalized component tag
    /^<\/?>\s*$/.test(t) || // <> fragment
    /<[a-zA-Z][\w.-]*[^>]*\{[^}]*\}/.test(t) // JSX attribute expression
  )
}

/** Net change in JSX tag nesting for one line (0 for self-closing or tag-less lines) */
function jsxBalance(line: string): number {
  let balance = 0
  const re = /<\/?[A-Za-z][A-Za-z0-9.-]*(?:\s[^<>]*?)?\/?>|<>|<\/>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) !== null) {
    const tag = m[0]
    if (tag === '</>') balance -= 1
    else if (tag === '<>') balance += 1
    else if (tag.startsWith('</')) balance -= 1
    else if (!tag.endsWith('/>')) balance += 1
  }
  return balance
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Replace MDX fragments in the source text with raw HTML <pre data-mdx-src>…</pre>;
 * markdown-it (html: true) passes it through verbatim, and PM parses it into mdxBlock nodes.
 * Code fences (```…```) are skipped — JSX inside them is code content.
 */
export function protectMdx(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  let i = 0
  let inFence = false

  while (i < lines.length) {
    const line = lines[i]

    if (/^\s*(```|~~~)/.test(line)) {
      out.push(line)
      inFence = !inFence
      i++
      continue
    }
    if (inFence) {
      out.push(line)
      i++
      continue
    }

    if (isMdxLine(line)) {
      const run: string[] = [line]
      let balance = jsxBalance(line)
      let j = i + 1
      if (balance > 0) {
        // Unclosed: keep collecting by tag balance (blank lines stay inside while unclosed)
        let guard = 0
        while (j < lines.length && guard < MAX_RUN_LINES) {
          const l = lines[j]
          if (/^\s*(```|~~~)/.test(l)) break
          if (l.trim() === '' && balance <= 0) break
          run.push(l)
          balance += jsxBalance(l)
          j++
          guard++
          if (balance <= 0) break
        }
      }
      out.push(`<pre data-mdx-src>${escapeHtml(run.join('\n'))}</pre>`)
      i = j
      continue
    }

    out.push(line)
    i++
  }
  return out.join('\n')
}

/** Whether rendered HTML looks like MDX (fallback guard for html_block / html_inline) */
export function looksLikeMdxHtml(raw: string): boolean {
  return (
    /^\s*<\/?[A-Z]/.test(raw) ||
    /^\s*<\/?>\s*$/.test(raw) ||
    /<[a-zA-Z][\w.-]*[^>]*\{[^}]*\}/.test(raw)
  )
}

/** markdown-it adapter: wraps protectMdx and guards html_block/html_inline */
export function setupMdxParse(md: MarkdownIt): void {
  // setup runs on every parse; guard against wrapping more than once
  const marker = md as unknown as { __rytenMdxProtected?: boolean }
  if (marker.__rytenMdxProtected) return
  marker.__rytenMdxProtected = true

  const render = md.render.bind(md)
  md.render = (src: string, env?: unknown) => render(protectMdx(src), env)

  const defaultHtmlBlock = md.renderer.rules.html_block
  md.renderer.rules.html_block = (tokens, idx, options, env, self) => {
    const raw = tokens[idx].content
    if (looksLikeMdxHtml(raw)) {
      return `<pre data-mdx-src>${escapeHtml(raw)}</pre>`
    }
    return defaultHtmlBlock
      ? defaultHtmlBlock(tokens, idx, options, env, self)
      : self.renderToken(tokens, idx, options)
  }

  const defaultHtmlInline = md.renderer.rules.html_inline
  md.renderer.rules.html_inline = (tokens, idx, options, env, self) => {
    const raw = tokens[idx].content
    if (looksLikeMdxHtml(raw)) {
      return `<span data-mdx-inline>${escapeHtml(raw)}</span>`
    }
    return defaultHtmlInline
      ? defaultHtmlInline(tokens, idx, options, env, self)
      : self.renderToken(tokens, idx, options)
  }
}

/* ──────────── Node definitions ──────────── */

/** Block-level MDX source (editable; serialization restores it verbatim) */
export const MdxBlock = Node.create({
  name: 'mdxBlock',
  group: 'block',
  content: 'text*',
  code: true,
  defining: true,
  selectable: true,

  parseHTML() {
    return [{ tag: 'pre[data-mdx-src]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['pre', mergeAttributes(HTMLAttributes, { 'data-mdx-src': '' }), ['code', 0]]
  },

  addStorage() {
    return {
      markdown: {
        serialize(state, node) {
          state.write(node.textContent)
          state.closeBlock(node)
        }
      }
    }
  }
})

/** Inline JSX fragment (atomic node; double-click replaces it as a whole) */
export const MdxInline = Node.create({
  name: 'mdxInline',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      src: { default: '' }
    }
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-mdx-inline]',
        getAttrs: (el) => ({ src: (el as HTMLElement).textContent ?? '' })
      }
    ]
  },

  renderHTML({ node, HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-mdx-inline': '' }), node.attrs.src]
  },

  addStorage() {
    return {
      markdown: {
        serialize(state, node) {
          state.write(node.attrs.src as string)
        }
      }
    }
  }
})
