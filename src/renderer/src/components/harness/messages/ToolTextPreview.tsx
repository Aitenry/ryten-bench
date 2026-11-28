import React, { useMemo, useState } from 'react'
import { Button } from 'antd'
import { useTranslation } from '@renderer/i18n'

/** Plain-text preview cap for tool output: only the first part is rendered beyond 20,000 characters */
const PREVIEW_CHARS = 20_000
/** Height cap of the scroll container after expanding "show all" */
const EXPANDED_MAX_HEIGHT = 320

interface ToolTextPreviewProps {
  text: string
  /** Code background color (same as the input block in the same card) */
  codeBg: string
}

/**
 * Plain-text display of tool output (renderer memory protection).
 *
 * Background: tool output went straight into the DOM without truncation at the render layer —
 * `read_file` returns up to 2,000,000 characters per call (fs-backend's MAX_FILE_READ_CHARS),
 * `execute` 8,000 characters per call, and generic tools are capped at 500,000 characters
 * (MAX_OUTPUT_CHARS). In a long task with dozens or hundreds of tool calls, all this text stays
 * resident in the renderer as text nodes (historical messages and streaming body present at the
 * same time), and combined with the high-frequency re-rendering while streaming, Chromium kills
 * the renderer for exceeding memory limits (reason=oom / 0xE0000008).
 *
 * Handling: the collapsed state renders only the first 20,000 characters; "show all" mounts on
 * demand inside a scroll container with a height cap. **Rendering only — it never changes message
 * state or persisted content**: msg.blocks always holds the full text, and the copy/persist paths
 * are unaffected.
 */
const ToolTextPreview: React.FC<ToolTextPreviewProps> = ({ text, codeBg }) => {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)

  const isLong = text.length > PREVIEW_CHARS
  const hidden = useMemo(() => Math.max(0, text.length - PREVIEW_CHARS), [text.length])

  if (!isLong) {
    return (
      <pre
        style={{ background: codeBg }}
        className="p-2 rounded text-sm overflow-x-auto whitespace-pre-wrap"
      >
        {text}
      </pre>
    )
  }

  return (
    <>
      {expanded ? (
        <div
          className="p-2 rounded text-sm overflow-y-auto harness-scrollbar"
          style={{
            background: codeBg,
            maxHeight: EXPANDED_MAX_HEIGHT,
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere'
          }}
        >
          {text}
        </div>
      ) : (
        <pre
          style={{ background: codeBg }}
          className="p-2 rounded text-sm overflow-x-auto whitespace-pre-wrap"
        >
          {text.slice(0, PREVIEW_CHARS)}
        </pre>
      )}
      <div className="flex items-center justify-between gap-3 py-1.5">
        <span style={{ color: 'var(--ant-color-text-tertiary)', fontSize: 12 }}>
          {expanded
            ? t('harness.assistantMessage.toolOutputTotal', { total: text.length })
            : t('harness.assistantMessage.toolOutputHidden', { hidden })}
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
    </>
  )
}

export default ToolTextPreview
