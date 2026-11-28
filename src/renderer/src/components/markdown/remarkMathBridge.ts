import { visit } from 'unist-util-visit'
import type { Root } from 'mdast'

/* ════════════════════════════════════════════════════════════
   KaTeX preview bridge: math/inlineMath nodes produced by remark-math have
   no matching handler in mdast-util-to-hast (they degrade to plain text),
   so convert them to raw HTML first (<span class="math math-inline"> /
   <div class="math math-display">); rehype-raw parses it and rehype-katex renders it
   ════════════════════════════════════════════════════════════ */

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export default function remarkMathBridge(): (tree: Root) => void {
  return (tree) => {
    visit(tree, (node, index, parent) => {
      if (index == null || !parent) return
      if (node.type !== 'math' && node.type !== 'inlineMath') return
      const value = String((node as { value?: string }).value ?? '')
      const html =
        node.type === 'math'
          ? `<div class="math math-display">${escapeHtml(value)}</div>`
          : `<span class="math math-inline">${escapeHtml(value)}</span>`
      parent.children[index] = { type: 'html', value: html } as never
    })
  }
}
