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

// sanitize 先于 highlight/katex：KaTeX 输出与 hljs 类名不再被剥掉；
// 白名单需放行 remarkMathBridge 生成的 .math 类名（rehype-katex 依赖它匹配）
const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...(defaultSchema.attributes ?? {}),
    code: [...(defaultSchema.attributes?.code ?? []), ['className', /^math/]],
    div: [...(defaultSchema.attributes?.div ?? []), ['className', /^math/]],
    span: [...(defaultSchema.attributes?.span ?? []), ['className', /^math/]]
  }
}

/** 超长代码块的语法高亮上限（字符）：超过则跳过 highlighter，只做纯文本渲染 */
const MAX_HIGHLIGHT_CHARS = 20_000

/** 递归拼接 hast 节点的纯文本（只用于量代码块长度，不参与输出） */
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
 * 超长代码块降级为纯文本（渲染进程内存/CPU 保护）。
 *
 * 背景：模型经常在回复里整段贴出工具输出或文件内容，一次流式回复里几十上百个代码块
 * 并不罕见。rehype-highlight 对每个带语言的代码块跑一次 highlight.js，长文本下分词
 * 结果是一棵巨大的 hast 树，随后又被 React 展开成大段 DOM；叠加流式期间的高频全量
 * 重渲染（每批 chunk 重新解析整段 markdown），足以把渲染进程推到内存超限被杀
 * （reason=oom / 0xE0000008）。
 *
 * 处理：给超过 MAX_HIGHLIGHT_CHARS 的 code 节点加 `no-highlight` 类，rehype-highlight
 * 见到该类直接跳过（不抛错、不改内容），文本仍完整渲染，只是没有配色。
 */
function rehypeSkipHugeHighlight(): (tree: unknown) => void {
  const tooLong = (node: unknown): boolean => hastText(node).length > MAX_HIGHLIGHT_CHARS
  return (tree: unknown): void => {
    // 兜底：本函数是 transformer，只能由 unified 在管线里带着 tree 调用。
    // 若被误当 attacher 使用（即写成 rehypeSkipHugeHighlight() 传进 rehypePlugins），
    // unified 会在 freeze 阶段无参调用它，tree 为 undefined，visit() 内部随即抛
    // "Cannot use 'in' operator to search for 'children' in undefined"，整棵 markdown
    // 渲染树会被 ErrorBoundary 兜住，界面直接白掉。这里直接退出，退化成「不做降级」。
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
      // 与 rehype-highlight 的处理范围一致：只处理 <pre><code> 代码块
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
  // 传 attacher 本身：**不要写成 rehypeSkipHugeHighlight()**。
  // 加括号拿到的是 transformer，在 unified 眼里它会被当成 attacher，freeze 阶段被无参
  // 调用（tree === undefined）并抛错，整个 markdown 渲染随之崩掉。
  rehypeSkipHugeHighlight,
  rehypeHighlight,
  // strict:'ignore'：模型常把中文写进 $...$ 数学模式，KaTeX 默认 strict='warn' 会为每个
  // 字符刷一条 console.warning（一次渲染数百条，灌爆日志）；ignore 静默降级渲染。
  [rehypeKatex, { strict: 'ignore' }]
]

// Context to tell code component whether it's inside a <pre> (code block) or standalone (inline)
const IsPreContext = React.createContext(false)

// 复制按钮组件
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
    /* 防横向溢出：根容器兜底断词；内联代码（如 Nav/Footer/... 含斜杠长串）在超宽时断行，
       代码块（pre code）保持原样不换行（pre 自带 overflow-x） */
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
        // Mermaid 代码块 → 渲染为图表
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
