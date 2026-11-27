/**
 * `str_replace_editor` 的纯文本逻辑（无 electron / fs 依赖，可离线测试）。
 *
 * 对照 DSH 的 `@deepseek-ai/dsh-tool-str-replace-editor`：
 * - `view`：按行号展示文件（可选行区间），超长只展示开头并标注；
 * - `str_replace`：唯一字面替换（0 处 / 多处都算失败，提示模型给出更长上下文）；
 * - `insert`：在第 N 行之后插入（0 = 插到文件开头）。
 *
 * 所有函数只处理字符串，文件读写与权限/改动记账由 fs-backend 的工具层负责。
 */

/** view 最多展示的行数（与 read_file 的 2000 行默认一致） */
export const MAX_VIEW_LINES = 2_000

export type StrReplaceFailure = 'not-found' | 'not-unique'

export type StrReplaceResult =
  | { ok: true; content: string; replacements: number }
  | { ok: false; failure: StrReplaceFailure }

export type InsertResult =
  | { ok: true; content: string }
  | { ok: false; failure: 'invalid-line' }

export interface ViewResult {
  text: string
  /** 是否因为行数上限被截断 */
  truncated: boolean
  /** 文件总行数 */
  totalLines: number
}

/** 把文本拆成行（保留结尾空行语义：末尾换行不算多一行内容） */
function splitLines(content: string): string[] {
  if (content === '') return []
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** 行号 + 内容（行号右对齐，方便模型引用） */
function numbered(lines: string[], startLine: number): string {
  const width = String(startLine + lines.length - 1).length
  return lines
    .map((line, index) => `${String(startLine + index).padStart(width, ' ')}  ${line}`)
    .join('\n')
}

/**
 * `view` 输出：`1 第一行` 形式（1 基）。
 *
 * @param range 可选的闭区间 [start, end]（1 基）；非法区间返回整份文件的开头部分
 */
export function formatView(content: string, range?: [number, number]): ViewResult {
  const lines = splitLines(content)
  const totalLines = lines.length
  let start = 1
  let end = totalLines
  if (range) {
    const [rawStart, rawEnd] = range
    const startValid = Number.isInteger(rawStart) && rawStart >= 1
    const endValid = Number.isInteger(rawEnd) && rawEnd >= 1
    if (startValid && endValid && rawStart <= rawEnd) {
      start = Math.min(rawStart, Math.max(1, totalLines))
      end = Math.min(rawEnd, Math.max(1, totalLines))
    }
  }
  const slice = lines.slice(start - 1, end)
  const truncated = slice.length > MAX_VIEW_LINES
  const shown = truncated ? slice.slice(0, MAX_VIEW_LINES) : slice
  const header = truncated
    ? `(${totalLines} lines total; showing lines ${start}-${start + MAX_VIEW_LINES - 1})\n`
    : ''
  return {
    text: header + numbered(shown, start),
    truncated,
    totalLines
  }
}

/**
 * 唯一字面替换。
 *
 * 与 edit_file 的区别只在返回结构：这里是纯函数，工具层据此给出更精确的失败文案。
 */
export function applyStrReplace(
  content: string,
  oldStr: string,
  newStr: string
): StrReplaceResult {
  if (!oldStr) return { ok: false, failure: 'not-found' }
  const first = content.indexOf(oldStr)
  if (first < 0) return { ok: false, failure: 'not-found' }
  const second = content.indexOf(oldStr, first + oldStr.length)
  if (second >= 0) return { ok: false, failure: 'not-unique' }
  return {
    ok: true,
    content: content.slice(0, first) + newStr + content.slice(first + oldStr.length),
    replacements: 1
  }
}

/**
 * 在第 `insertLine` 行之后插入文本（0 = 文件开头；行号超出末尾则追加到末尾）。
 *
 * 插入内容自带换行时原样保留；插入点不在 [0, 行数] 范围返回失败。
 */
export function applyInsert(content: string, insertLine: number, newStr: string): InsertResult {
  if (!Number.isInteger(insertLine) || insertLine < 0) {
    return { ok: false, failure: 'invalid-line' }
  }
  const lines = splitLines(content)
  if (insertLine > lines.length) return { ok: false, failure: 'invalid-line' }
  const insertLines = newStr.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  // 去掉末尾因结尾换行产生的空元素：保持「插入一段」而不是「多一个空行」
  if (insertLines.length > 1 && insertLines[insertLines.length - 1] === '') insertLines.pop()
  const result = [
    ...lines.slice(0, insertLine),
    ...insertLines,
    ...lines.slice(insertLine)
  ]
  return { ok: true, content: `${result.join('\n')}\n` }
}
