import React, { useMemo, useState } from 'react'
import { Button } from 'antd'
import { useTranslation } from '@renderer/i18n'

/** Markdown blocks longer than this render only the tail window by default */
const WINDOW_TRIGGER_CHARS = 20_000
/** Render window length (characters) */
const WINDOW_CHARS = 20_000

interface StreamTextWindowProps {
  content: string
  /** Function that renders markdown (avoids a circular dependency with MarkdownLoad; wrapped by the caller) */
  renderMarkdown: (text: string) => React.ReactNode
}

/** Count ``` / ~~~ fences (line starts only, a sufficient approximation) */
const countFences = (text: string): number => (text.match(/^ {0,3}(?:```|~~~)/gm) ?? []).length

/**
 * Snap the cut point to a line start and add a balancing fence when the cut falls inside a fence.
 *
 * Truncating characters without adding a fence would render "a code block without an opening
 * fence" when the window starts inside a ``` code block — the indentation would be treated as body
 * text and the whole block's layout would collapse; adding a fence of the same kind closes the
 * window's syntax on its own.
 */
function balancedSlice(content: string, start: number): string {
  let from = content.indexOf('\n', start)
  from = from === -1 ? start : from + 1
  let slice = content.slice(from)
  if (countFences(slice) % 2 === 1) {
    const kind = /^ {0,3}(```|~~~)/m.exec(slice)?.[1] ?? '```'
    slice = `${kind}\n${slice}`
  }
  return slice
}

/**
 * Render window for long markdown text blocks (renderer memory/CPU protection).
 *
 * Background: when the model writes an entire file or command output straight into the reply body,
 * a single text block can be hundreds of thousands of characters. MarkdownLoad re-parses the whole
 * text for every chunk batch (react-markdown's memo only prevents re-renders with unchanged props,
 * not growing content), so the second half of a long reply means repeatedly parsing hundreds of KB
 * plus syntax highlighting — another source of renderer OOM.
 *
 * Handling: when the body exceeds {@link WINDOW_TRIGGER_CHARS}, render only the **last**
 * {@link WINDOW_CHARS} characters by default (the newest content is at the tail while streaming,
 * which also naturally avoids the "reopened fence breaks the styles" problem), with a line and
 * character count hint above; "show all" renders the full body. Rendering only — message state and
 * persisted content always stay complete.
 */
const StreamTextWindow: React.FC<StreamTextWindowProps> = ({ content, renderMarkdown }) => {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)

  const isLong = content.length > WINDOW_TRIGGER_CHARS
  const text = useMemo(() => {
    if (!isLong || expanded) return content
    return balancedSlice(content, content.length - WINDOW_CHARS)
  }, [content, isLong, expanded])

  const hidden = content.length - text.length

  return (
    <>
      {isLong ? (
        <div className="flex items-center justify-between gap-3 mb-1">
          <span style={{ color: 'var(--ant-color-text-tertiary)', fontSize: 12 }}>
            {expanded
              ? t('harness.assistantMessage.toolOutputTotal', { total: content.length })
              : t('harness.assistantMessage.longTextTail', { hidden })}
          </span>
          <Button
            type="link"
            size="small"
            style={{ padding: 0, height: 'auto', fontSize: 12 }}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded
              ? t('harness.assistantMessage.toolOutputCollapse')
              : t('harness.assistantMessage.toolOutputExpand')}
          </Button>
        </div>
      ) : null}
      {renderMarkdown(text)}
    </>
  )
}

export default StreamTextWindow
