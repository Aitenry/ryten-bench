import React, { useMemo, useState } from 'react'
import { Button } from 'antd'
import { useTranslation } from '@renderer/i18n'

/** 工具纯文本预览上限：超过 2 万字符只渲染开头一段 */
const PREVIEW_CHARS = 20_000
/** 展开「显示全部」后的滚动容器高度上限 */
const EXPANDED_MAX_HEIGHT = 320

interface ToolTextPreviewProps {
  text: string
  /** 代码底色（与同卡片内的输入块一致） */
  codeBg: string
}

/**
 * 工具输出的纯文本展示（渲染进程内存保护）。
 *
 * 背景：工具输出未经渲染层截断就直接进 DOM——`read_file` 单次最多 2,000,000 字符
 * （fs-backend 的 MAX_FILE_READ_CHARS），`execute` 单次 8,000 字符、通用工具上限
 * 500,000 字符（MAX_OUTPUT_CHARS）。一次几十上百个工具调用的长任务里，这些文本会以
 * 文本节点形式全部驻留在渲染进程（历史消息 + 流式正文同时在场），配上流式期间的高频
 * 重渲染，渲染进程被 Chromium 判内存超限杀掉（reason=oom / 0xE0000008）。
 *
 * 处理：折叠态只渲染开头 20,000 字符；「显示全部」按需挂载，且放进带高度上限的滚动
 * 容器。**只影响界面渲染，不改变消息状态与落库内容**——msg.blocks 里始终是完整文本，
 * 复制/落库链路不受影响。
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
