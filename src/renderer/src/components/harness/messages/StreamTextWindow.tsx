import React, { useMemo, useState } from 'react'
import { Button } from 'antd'
import { useTranslation } from '@renderer/i18n'

/** 超过该长度的 markdown 块默认只渲染尾部窗口 */
const WINDOW_TRIGGER_CHARS = 20_000
/** 渲染窗口长度（字符） */
const WINDOW_CHARS = 20_000

interface StreamTextWindowProps {
  content: string
  /** 渲染 markdown 的函数（避免与 MarkdownLoad 形成循环依赖，由调用方包一层） */
  renderMarkdown: (text: string) => React.ReactNode
}

/** 统计 ``` / ~~~ 围栏数量（只看行首，够用的近似） */
const countFences = (text: string): number => (text.match(/^ {0,3}(?:```|~~~)/gm) ?? []).length

/**
 * 把切点吸附到行首，并在切开围栏时补一个配平围栏。
 *
 * 只截字符不补围栏的话，窗口起点落在 ``` 代码块内部时，渲染出来的是「一段没有开栏的
 * 代码」——缩进被当正文、整块排版崩掉；补一个同型围栏让窗口自身语法闭合。
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
 * markdown 长文本块的渲染窗口（渲染进程内存/CPU 保护）。
 *
 * 背景：模型把整份文件/命令输出直接写进回复正文时，单个 text 块可以有几十万字符。
 * MarkdownLoad 每批 chunk 都要把整段重新解析（react-markdown 的 memo 只挡「props 不变」
 * 的重渲染，挡不住内容增长），一次长回复的下半程等于反复解析几百 KB 文本 + 语法高亮，
 * 是渲染进程 OOM 的另一个来源。
 *
 * 处理：正文超过 {@link WINDOW_TRIGGER_CHARS} 时默认只渲染**最后**
 * {@link WINDOW_CHARS} 字符（流式时最新内容就在尾部，同时天然避开「重开围栏导致样式
 * 失效」的问题），上方给出行数与字符数提示；点「显示全部」才渲染完整正文。
 * 只影响渲染，消息状态与落库内容始终是完整文本。
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
