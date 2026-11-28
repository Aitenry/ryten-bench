import React, { useState, useMemo, JSX } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeHighlight from 'rehype-highlight'
import rehypeSanitize from 'rehype-sanitize'
import rehypeRaw from 'rehype-raw'
import rehypeKatex from 'rehype-katex'
import { defaultSchema } from 'hast-util-sanitize'
import type { Pluggable, PluggableList } from 'unified'
import { visit } from 'unist-util-visit'
import remarkMdxSource from './remarkMdxSource'
import remarkMathBridge from './remarkMathBridge'
import MermaidDiagram from './MermaidDiagram'
import 'katex/dist/katex.min.css'
import { RiCheckLine, RiFileCopyLine } from '@remixicon/react'
import { extractTextFromChildren } from '@renderer/utils/markdown'
import { InlineCodeCopy } from '@renderer/components/markdown/MarkdownView'
import { useTranslation } from '@renderer/i18n'
import type { MarkdownViewProps } from '@renderer/types/components'

// Stable references — prevent ReactMarkdown from re-rendering the entire DOM tree
const remarkPlugins = [remarkGfm, remarkMath, remarkMathBridge, remarkMdxSource]

// sanitize runs before highlight/katex so KaTeX output and hljs class names are no longer
// stripped; the allowlist must let through the .math class names produced by remarkMathBridge
// (rehype-katex relies on them for matching)
const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...(defaultSchema.attributes ?? {}),
    code: [...(defaultSchema.attributes?.code ?? []), ['className', /^math/]],
    div: [...(defaultSchema.attributes?.div ?? []), ['className', /^math/]],
    span: [...(defaultSchema.attributes?.span ?? []), ['className', /^math/]]
  }
}

/** Syntax highlighting limit for very long code blocks (characters): beyond it the highlighter is skipped and only plain text is rendered */
const MAX_HIGHLIGHT_CHARS = 20_000

/** Recursively concatenate the plain text of hast nodes (only used to measure code block length, never emitted) */
function hastText(node: unknown): string {
  const n = node as { type?: string; value?: string; children?: unknown[] } | null | undefined
  if (!n) return ''
  if (n.type === 'text') return n.value ?? ''
  if (!Array.isArray(n.children)) return ''
  let out = ''
  for (const child of n.children) out += hastText(child)
  return out
}

/**
 * Degrade very long code blocks to plain text (renderer memory/CPU protection).
 *
 * Background: the model often pastes whole tool outputs or file contents into a reply, and
 * dozens to hundreds of code blocks in one streaming reply are not rare. rehype-highlight runs
 * highlight.js for every code block that has a language; on long text the tokenized result is a
 * huge hast tree that React then expands into a large DOM. Combined with the frequent full
 * re-renders during streaming (the entire markdown is re-parsed for every batch of chunks), that
 * is enough to push the renderer process past its memory limit and get it killed
 * (reason=oom / 0xE0000008).
 *
 * Handling: add a `no-highlight` class to code nodes longer than MAX_HIGHLIGHT_CHARS, and
 * rehype-highlight skips them on sight (no error, no content change); the text still renders in
 * full, just without colors.
 */
function rehypeSkipHugeHighlight(): (tree: unknown) => void {
  const tooLong = (node: unknown): boolean => hastText(node).length > MAX_HIGHLIGHT_CHARS
  return (tree: unknown): void => {
    // Guard: this function is a transformer, so unified can only call it with the tree while
    // running the pipeline. If it is mistakenly used as an attacher (i.e. written as
    // rehypeSkipHugeHighlight() and passed into rehypePlugins), unified calls it without
    // arguments during freeze, tree is undefined, and visit() immediately throws
    // "Cannot use 'in' operator to search for 'children' in undefined"; the whole markdown
    // render tree is then caught by ErrorBoundary and the UI goes blank. Exit early here,
    // degrading to "no downgrade".
    if (!tree || typeof tree !== 'object') {
      console.warn('[MarkdownLoad] rehypeSkipHugeHighlight must be passed as an attacher (no parentheses)')
      return
    }
    visit(tree as never, 'element', (node: never, _index: never, parent: never) => {
      const el = node as {
        tagName?: string
        properties?: Record<string, unknown>
      }
      const up = parent as { tagName?: string } | undefined
      // Same scope as rehype-highlight: only handle <pre><code> code blocks
      if (el.tagName !== 'code' || up?.tagName !== 'pre') return
      if (el.properties?.className && String(el.properties.className).includes('no-highlight')) {
        return
      }
      if (!tooLong(el)) return
      const className = Array.isArray(el.properties?.className)
        ? [...(el.properties?.className as string[]), 'no-highlight']
        : ['no-highlight']
      el.properties = { ...(el.properties ?? {}), className }
    })
  }
}

const rehypePlugins: PluggableList = [
  rehypeRaw,
  [rehypeSanitize, sanitizeSchema] as unknown as Pluggable,
  // Pass the attacher itself: **do not write rehypeSkipHugeHighlight()**.
  // With parentheses you get a transformer, which unified sees as an attacher, calls without
  // arguments during the freeze phase (tree === undefined) and throws, taking down the whole
  // markdown render.
  rehypeSkipHugeHighlight,
  rehypeHighlight,
  // strict:'ignore': the model often writes Chinese inside $...$ math mode, and KaTeX's default
  // strict='warn' logs a console warning per character (hundreds per render, flooding the logs);
  // ignore degrades silently.
  [rehypeKatex, { strict: 'ignore' }]
]

// Context to tell code component whether it's inside a <pre> (code block) or standalone (inline)
const IsPreContext = React.createContext(false)

// Copy button component
const CopyButton = ({
  text,
  isDarkMode
}: {
  text: string
  isDarkMode?: boolean
}): React.ReactNode => {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }

  return (
    <button
      onClick={handleCopy}
      style={{ top: 9, right: 9 }}
      className={`absolute p-2 rounded-lg transition-all ${
        isDarkMode
          ? 'bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white'
          : 'bg-gray-200 hover:bg-gray-300 text-gray-600 hover:text-gray-900'
      }`}
      title={copied ? t('markdown.copy.copied') : t('markdown.copy.code')}
    >
      {copied ? <RiCheckLine size={16} /> : <RiFileCopyLine size={16} />}
    </button>
  )
}

const MarkdownLoad = React.memo(
  ({ content, isDarkMode = false }: MarkdownViewProps): JSX.Element => {
    // Memoize dynamic styles — only recompute when isDarkMode changes
    const dynamicStyles = useMemo(
      () => `
    .markdown-body > *:first-child { margin-top: 0; }
    .markdown-body h1 { font-size: 2em; font-weight: 700; margin: 1em 0 0.5em; }
    .markdown-body h2 { font-size: 1.5em; font-weight: 600; margin: 1em 0 0.5em; }
    .markdown-body h3 { font-size: 1.25em; font-weight: 600; margin: 1em 0 0.5em; }
    .markdown-body h4 { font-size: 1.125em; font-weight: 600; margin: 1em 0 0.5em; }
    .markdown-body h5 { font-size: 1em; font-weight: 600; margin: 1em 0 0.5em; }
    .markdown-body h6 { font-size: 0.875em; font-weight: 600; margin: 1em 0 0.5em; }
    .markdown-body p { margin: 1em 0; line-height: 1.7; }
    .markdown-body ul { margin: 1em 0; padding-left: 1.75em; list-style-type: disc; }
    .markdown-body ol { margin: 1em 0; padding-left: 1.75em; list-style-type: decimal; }
    .markdown-body li { margin: 0.375em 0; line-height: 1.7; }
    .markdown-body ul ul, .markdown-body ul ol,
    .markdown-body ol ul, .markdown-body ol ol { margin: 0.5em 0; padding-left: 1.5em; }
    .markdown-body ul ul { list-style-type: circle; }
    .markdown-body ul ul ul { list-style-type: square; }
    .markdown-body ol ol { list-style-type: lower-alpha; }
    .markdown-body ol ol ol { list-style-type: lower-roman; }
    .markdown-body code { padding: 0.2em 0.4em; border-radius: 4px; font-size: 0.9em; }
    .markdown-body pre { padding: 1em; border-radius: 8px; overflow-x: auto; margin: 1em 0; }
    .markdown-body pre code { padding: 0; background: transparent; }
    .markdown-body blockquote { border-left: 4px solid; padding-left: 1em; margin: 1em 0; font-style: italic; }
    .markdown-body table { width: 100%; border-collapse: collapse; margin: 1em 0; }
    .markdown-body th, .markdown-body td { padding: 0.75em; border: 1px solid; text-align: left; }
    /* Horizontal overflow guard: the root container breaks words as a fallback; inline code
       (e.g. long slash-separated strings such as Nav/Footer/...) wraps when too wide, while
       code blocks (pre code) keep the original no-wrap (pre has its own overflow-x) */
    .markdown-body { overflow-wrap: break-word; }
    .markdown-body a { overflow-wrap: anywhere; }
    .markdown-body code { overflow-wrap: anywhere; }
    .markdown-body pre code { overflow-wrap: normal; white-space: pre; }
    .markdown-body code {
      background: ${isDarkMode ? '#374151' : '#f3f4f6'};
      color: ${isDarkMode ? '#e5e7eb' : '#374151'};
    }
    .markdown-body pre {
      background: ${isDarkMode ? '#1f2937' : '#f8f8f8'};
    }
    .markdown-body pre code {
      background: transparent;
      color: ${isDarkMode ? '#f3f4f6' : '#1f2937'};
    }
    .markdown-body blockquote { border-color: ${isDarkMode ? '#4b5563' : '#d1d5db'}; }
    .markdown-body th, .markdown-body td { border-color: ${isDarkMode ? '#4b5563' : '#d1d5db'}; }
  `,
      [isDarkMode]
    )

    // Memoize components — prevent ReactMarkdown from full re-render when only isDarkMode is stable
    const components: Components = useMemo(() => {
      function ABlock(props: React.ComponentPropsWithoutRef<'a'>): React.ReactNode {
        return <a {...props} target="_blank" rel="noopener noreferrer" />
      }

      function CodeBlock({
        children,
        className,
        ...props
      }: React.ComponentPropsWithoutRef<'code'>): React.ReactNode {
        const insidePre = React.useContext(IsPreContext)
        const text = extractTextFromChildren(children)
        const isInline = !insidePre && !className?.includes('language-')
        if (isInline) {
          return (
            <InlineCodeCopy text={text}>
              <code className={className} {...props}>
                {children}
              </code>
            </InlineCodeCopy>
          )
        }
        return (
          <code className={className} {...props}>
            {children}
          </code>
        )
      }

      function PreBlock({
        children,
        ...props
      }: React.ComponentPropsWithoutRef<'pre'>): React.ReactNode {
        const codeText = extractTextFromChildren(children)
        // Mermaid code block → render as a diagram
        const codeChild = React.Children.toArray(children).find((c): c is React.ReactElement =>
          React.isValidElement(c)
        )
        const codeClass =
          ((codeChild?.props as { className?: string } | undefined)?.className as
            string | undefined) ?? ''
        if (codeClass.includes('language-mermaid')) {
          return <MermaidDiagram code={codeText} isDarkMode={isDarkMode} />
        }
        return (
          <div className="relative">
            <IsPreContext.Provider value={true}>
              <pre {...props}>{children}</pre>
            </IsPreContext.Provider>
            <CopyButton text={codeText} isDarkMode={isDarkMode} />
          </div>
        )
      }

      function TableBlock({
        children,
        ...props
      }: React.ComponentPropsWithoutRef<'table'>): React.ReactNode {
        return (
          <div className="overflow-x-auto my-4">
            <table {...props} className="min-w-full">
              {children}
            </table>
          </div>
        )
      }

      return {
        a: ABlock,
        code: CodeBlock,
        pre: PreBlock,
        table: TableBlock
      }
    }, [isDarkMode])

    return (
      <>
        <style>{dynamicStyles}</style>
        <div className={`markdown-body ${isDarkMode ? 'text-gray-100' : 'text-gray-700'}`}>
          <ReactMarkdown
            remarkPlugins={remarkPlugins}
            rehypePlugins={rehypePlugins}
            components={components}
          >
            {content}
          </ReactMarkdown>
        </div>
      </>
    )
  }
)

MarkdownLoad.displayName = 'MarkdownLoad'

export default MarkdownLoad
