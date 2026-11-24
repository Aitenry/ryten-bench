/**
 * 文档正文的**纯文本编辑引擎**（零 electron / 数据库依赖，可离线单测）。
 *
 * 为什么单独抽出：模型过去只能整篇 `update content`，一次改一行也要重写全文，
 * 既容易把别处内容改坏，也浪费上下文/写放大。这里提供"行 / 行内列区间 / 文本片段"
 * 三种粒度的确定性编辑，并统一处理：
 * - **行号 1 起、列号 1 起、列按 Unicode 码点计**（中文、emoji 不会被 UTF-16 代理对切坏）；
 * - **EOL 保持**（原文是 CRLF 就继续写 CRLF，模型给的新文本统一归一后再按原文 EOL 落盘）；
 * - **expectedOld / expectedRevision 双重校验**（读到什么就改什么，别人先改过就拒绝写入）；
 * - **原子批量编辑**（patch 全部算完才落盘，任何一处失败都不产生半截修改）。
 *
 * 行号语义：`content.split('\n')`，所以以 `\n` 结尾的文档最后一行为空行。
 * 例如 "a\nb\n" 共 3 行（第 3 行为空），"a\nb" 共 2 行。
 */

import { createHash } from 'node:crypto'

/** 原文档使用的换行符（编辑后保持） */
export type LineEnding = '\n' | '\r\n'

/** 解析后的文档：body 一律用 \n，输出时再还原 eol */
export interface ParsedDocument {
  body: string
  eol: LineEnding
  lines: string[]
}

/** 编辑引擎抛出的**结构化**错误：文案由调用方按界面语言渲染 */
export type DocEditErrorCode =
  | 'line-out-of-range'
  | 'range-out-of-range'
  | 'column-out-of-range'
  | 'expected-old-mismatch-lines'
  | 'expected-old-mismatch-range'
  | 'empty-query'
  | 'no-match'
  | 'ambiguous-match'
  | 'occurrence-out-of-range'
  | 'invalid-regex'
  | 'empty-edit'
  | 'missing-new-text'
  | 'unknown-edit-type'
  | 'patch-empty'

export class DocEditError extends Error {
  readonly code: DocEditErrorCode
  readonly details: Record<string, string | number>
  /** patch 中第几处（1 起）；非 patch 错误为空 */
  editIndex?: number

  constructor(code: DocEditErrorCode, details: Record<string, string | number> = {}) {
    super(code)
    this.name = 'DocEditError'
    this.code = code
    this.details = details
  }
}

/** 短修订号：内容哈希前 12 位，用于「读到的是不是同一版」校验 */
export function revisionOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 12)
}

/** 解析正文（保留原文 EOL 选择，body 统一为 \n） */
export function parseDocument(content: string): ParsedDocument {
  const eol: LineEnding = content.includes('\r\n') ? '\r\n' : '\n'
  const body = eol === '\r\n' ? content.split('\r\n').join('\n') : content
  return { body, eol, lines: body.split('\n') }
}

/** 把内部 body 还原成落盘文本 */
export function serializeDocument(doc: ParsedDocument): string {
  return doc.eol === '\n' ? doc.body : doc.body.split('\n').join(doc.eol)
}

/** 文档行数（空文档也至少有 1 行） */
export function lineCountOf(content: string): number {
  return content.split('\n').length
}

/** 模型给的新文本：先统一成 \n，最终由 serializeDocument 换成原文 EOL */
function normalizeText(text: string): string {
  return text.split('\r\n').join('\n')
}

function setLines(doc: ParsedDocument, lines: string[]): void {
  doc.lines = lines
  doc.body = lines.join('\n')
}

function assertLine(doc: ParsedDocument, line: number): void {
  if (!Number.isInteger(line) || line < 1 || line > doc.lines.length) {
    throw new DocEditError('line-out-of-range', { line, lineCount: doc.lines.length })
  }
}

function assertLineRange(doc: ParsedDocument, startLine: number, endLine: number): void {
  if (
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine ||
    endLine > doc.lines.length
  ) {
    throw new DocEditError('range-out-of-range', {
      startLine,
      endLine,
      lineCount: doc.lines.length
    })
  }
}

/** expectedOld 比较时容忍模型多带的一个结尾换行（其余必须逐字一致） */
function normalizeExpected(text: string): string {
  const normalized = normalizeText(text)
  return normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized
}

/** 错误详情里展示的当前内容（避免把整篇文档塞进错误信息） */
function clip(text: string, max = 500): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

// ============================================================================
// 单步编辑
// ============================================================================

export interface ReplaceLinesOptions {
  startLine: number
  endLine: number
  /** 新内容（可多行）；空串表示删除这些行 */
  newText: string
  /** 可选：这段行当前必须是什么（逐字校验），防止行号漂移改错位置 */
  expectedOld?: string
}

/** 替换/删除整行区间（1 起、闭区间） */
export function replaceLines(content: string, options: ReplaceLinesOptions): string {
  const doc = parseDocument(content)
  const { startLine, endLine, newText, expectedOld } = options
  assertLineRange(doc, startLine, endLine)

  const oldText = doc.lines.slice(startLine - 1, endLine).join('\n')
  if (expectedOld !== undefined && normalizeExpected(expectedOld) !== oldText) {
    throw new DocEditError('expected-old-mismatch-lines', {
      startLine,
      endLine,
      actual: clip(oldText)
    })
  }

  const normalized = normalizeText(newText)
  if (normalized === '') {
    doc.lines.splice(startLine - 1, endLine - startLine + 1)
  } else {
    doc.lines.splice(startLine - 1, endLine - startLine + 1, ...normalized.split('\n'))
  }
  setLines(doc, doc.lines)
  return serializeDocument(doc)
}

export interface ReplaceRangeOptions {
  line: number
  /** 1 起；省略表示 1 */
  startColumn?: number
  /** 1 起、闭区间；省略表示行尾 */
  endColumn?: number
  newText: string
  /** 可选：被替换的那段字符当前必须是什么 */
  expectedOld?: string
}

/** 替换一行内部的字符区间（列号按 Unicode 码点，闭区间） */
export function replaceRange(content: string, options: ReplaceRangeOptions): string {
  const doc = parseDocument(content)
  const { line, newText, expectedOld } = options
  assertLine(doc, line)

  const chars = Array.from(doc.lines[line - 1] ?? '')
  const length = chars.length
  const startColumn = options.startColumn ?? 1
  const endColumn = options.endColumn ?? length
  const valid =
    Number.isInteger(startColumn) &&
    Number.isInteger(endColumn) &&
    startColumn >= 1 &&
    startColumn <= length + 1 &&
    endColumn >= startColumn - 1 &&
    endColumn <= length
  if (!valid) {
    throw new DocEditError('column-out-of-range', {
      line,
      length,
      startColumn,
      endColumn
    })
  }

  const current = chars.slice(startColumn - 1, endColumn).join('')
  if (expectedOld !== undefined && expectedOld !== current) {
    throw new DocEditError('expected-old-mismatch-range', {
      line,
      startColumn,
      endColumn,
      actual: clip(current)
    })
  }

  const before = chars.slice(0, startColumn - 1).join('')
  const after = chars.slice(endColumn).join('')
  const replacement = normalizeText(newText).split('\n')
  replacement[0] = before + (replacement[0] ?? '')
  replacement[replacement.length - 1] = (replacement[replacement.length - 1] ?? '') + after
  doc.lines.splice(line - 1, 1, ...replacement)
  setLines(doc, doc.lines)
  return serializeDocument(doc)
}

export type InsertPosition = 'at' | 'before' | 'after' | 'start' | 'end'

export interface InsertOptions {
  position?: InsertPosition
  /** position=at/before/after 时必填（1 起） */
  line?: number
  /** position=at 时的插入列（1 起，插在该字符之前；省略=行首，行尾=length+1） */
  column?: number
  newText: string
}

/** 在行内、某行前后或文档首尾插入文本 */
export function insertText(content: string, options: InsertOptions): string {
  const doc = parseDocument(content)
  const normalized = normalizeText(options.newText)
  if (normalized === '') throw new DocEditError('empty-edit')
  const position = options.position ?? 'at'

  if (position === 'at') {
    if (options.line === undefined) {
      throw new DocEditError('line-out-of-range', {
        line: 'undefined',
        lineCount: doc.lines.length
      })
    }
    assertLine(doc, options.line)
    const column = options.column ?? 1
    // 空区间 [column, column-1] 即插入点；复用区间替换统一列校验与 EOL 处理
    return replaceRange(content, {
      line: options.line,
      startColumn: column,
      endColumn: column - 1,
      newText: options.newText
    })
  }

  if (position === 'start') {
    const body =
      normalized.endsWith('\n') || doc.body === ''
        ? normalized + doc.body
        : `${normalized}\n${doc.body}`
    doc.lines = body.split('\n')
    setLines(doc, doc.lines)
    return serializeDocument(doc)
  }

  if (position === 'end') {
    const body =
      doc.body === '' || doc.body.endsWith('\n')
        ? doc.body + normalized
        : `${doc.body}\n${normalized}`
    doc.lines = body.split('\n')
    setLines(doc, doc.lines)
    return serializeDocument(doc)
  }

  if (options.line === undefined) {
    throw new DocEditError('line-out-of-range', { line: 'undefined', lineCount: doc.lines.length })
  }
  assertLine(doc, options.line)
  const textLines = normalized.split('\n')
  if (position === 'before') {
    doc.lines.splice(options.line - 1, 0, ...textLines)
  } else {
    doc.lines.splice(options.line, 0, ...textLines)
  }
  setLines(doc, doc.lines)
  return serializeDocument(doc)
}

/** 删除整行区间 */
export function deleteLines(
  content: string,
  options: Omit<ReplaceLinesOptions, 'newText'>
): string {
  return replaceLines(content, { ...options, newText: '' })
}

/** 删除行内字符区间 */
export function deleteRange(
  content: string,
  options: Omit<ReplaceRangeOptions, 'newText'>
): string {
  return replaceRange(content, { ...options, newText: '' })
}

export interface ReplaceTextOptions {
  /** 要替换的原文（字面量；regex=true 时按正则） */
  oldText: string
  newText: string
  /** 替换全部；与 occurrence 二选一 */
  all?: boolean
  /** 只替换第几处（1 起） */
  occurrence?: number
  /** 限定在第 startLine–endLine 行内查找（可选） */
  startLine?: number
  endLine?: number
  regex?: boolean
  caseSensitive?: boolean
}

interface TextMatch {
  start: number
  end: number
}

/** 收集 scope 内的匹配（字面量或正则，忽略大小写时统一走 RegExp） */
function collectMatches(scope: string, options: ReplaceTextOptions): TextMatch[] {
  const matches: TextMatch[] = []
  const regex =
    options.regex || options.caseSensitive === false || options.caseSensitive === undefined
  if (!regex) {
    let from = 0
    while (from <= scope.length) {
      const index = scope.indexOf(options.oldText, from)
      if (index === -1) break
      matches.push({ start: index, end: index + options.oldText.length })
      from = index + options.oldText.length
      if (options.oldText.length === 0) break
    }
    return matches
  }

  const source = options.regex
    ? options.oldText
    : options.oldText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let re: RegExp
  try {
    re = new RegExp(source, options.caseSensitive ? 'g' : 'gi')
  } catch (err) {
    throw new DocEditError('invalid-regex', {
      message: err instanceof Error ? err.message : String(err)
    })
  }
  let match: RegExpExecArray | null
  while ((match = re.exec(scope)) !== null) {
    // 零宽匹配不产生可替换内容，跳过并推进，避免死循环
    if (match[0].length === 0) {
      re.lastIndex += 1
      continue
    }
    matches.push({ start: match.index, end: match.index + match[0].length })
    if (matches.length > 10_000) break
  }
  return matches
}

/**
 * 替换文本片段。
 *
 * 未指定 all / occurrence 时**必须唯一命中**：多处命中会报 ambiguous-match，
 * 让模型明确指定位置，而不是悄悄改掉第一处。
 */
export function replaceText(content: string, options: ReplaceTextOptions): string {
  if (options.oldText === '') throw new DocEditError('empty-query')
  const doc = parseDocument(content)

  const startLine = options.startLine ?? 1
  const endLine = options.endLine ?? doc.lines.length
  assertLineRange(doc, startLine, endLine)
  const beforeLines = doc.lines.slice(0, startLine - 1)
  const scope = doc.lines.slice(startLine - 1, endLine).join('\n')
  const afterLines = doc.lines.slice(endLine)

  const matches = collectMatches(scope, options)
  if (matches.length === 0) {
    throw new DocEditError('no-match', { query: clip(options.oldText, 120) })
  }

  let targets: TextMatch[]
  if (options.all) {
    targets = matches
  } else if (options.occurrence !== undefined) {
    if (
      !Number.isInteger(options.occurrence) ||
      options.occurrence < 1 ||
      options.occurrence > matches.length
    ) {
      throw new DocEditError('occurrence-out-of-range', {
        occurrence: options.occurrence,
        count: matches.length
      })
    }
    targets = [matches[options.occurrence - 1]]
  } else if (matches.length === 1) {
    targets = [matches[0]]
  } else {
    throw new DocEditError('ambiguous-match', {
      count: matches.length,
      query: clip(options.oldText, 120)
    })
  }

  const replacement = normalizeText(options.newText)
  let nextScope = scope
  for (const target of [...targets].sort((a, b) => b.start - a.start)) {
    nextScope = nextScope.slice(0, target.start) + replacement + nextScope.slice(target.end)
  }

  const nextLines = [...beforeLines, ...nextScope.split('\n'), ...afterLines]
  setLines(doc, nextLines)
  return serializeDocument(doc)
}

// ============================================================================
// 批量编辑
// ============================================================================

export type DocEdit =
  | ({ type: 'replace_lines' } & ReplaceLinesOptions)
  | ({ type: 'replace_text' } & ReplaceTextOptions)
  | ({ type: 'replace_range' } & ReplaceRangeOptions)
  | ({ type: 'insert' } & InsertOptions)
  | ({ type: 'delete_lines' } & Omit<ReplaceLinesOptions, 'newText'>)
  | ({ type: 'delete_range' } & Omit<ReplaceRangeOptions, 'newText'>)

function applySingleEdit(content: string, edit: DocEdit): string {
  // patch 的 JSON 里 newText 可能被模型漏掉：删除必须显式传空串，不能靠「没传」静默删
  if (
    edit.type === 'replace_lines' ||
    edit.type === 'replace_text' ||
    edit.type === 'replace_range' ||
    edit.type === 'insert'
  ) {
    if (typeof (edit as { newText?: unknown }).newText !== 'string') {
      throw new DocEditError('missing-new-text', { type: edit.type })
    }
  }
  switch (edit.type) {
    case 'replace_lines':
      return replaceLines(content, edit)
    case 'replace_text':
      return replaceText(content, edit)
    case 'replace_range':
      return replaceRange(content, edit)
    case 'insert':
      return insertText(content, edit)
    case 'delete_lines':
      return deleteLines(content, edit)
    case 'delete_range':
      return deleteRange(content, edit)
    default:
      throw new DocEditError('unknown-edit-type', {
        type: String((edit as { type?: unknown }).type)
      })
  }
}

/**
 * 按顺序应用一批编辑（行号指**上一处编辑之后**的文档状态）。
 * 任意一处失败立即抛出，调用方据 editIndex 指出位置；由于全程只在内存中演算，
 * 调用方不落盘就不会产生半截修改。
 */
export function applyEdits(content: string, edits: DocEdit[]): string {
  if (edits.length === 0) throw new DocEditError('patch-empty')
  let next = content
  for (let i = 0; i < edits.length; i++) {
    try {
      next = applySingleEdit(next, edits[i])
    } catch (err) {
      if (err instanceof DocEditError) err.editIndex = i + 1
      throw err
    }
  }
  return next
}

// ============================================================================
// 查找 / 差异摘要
// ============================================================================

export interface FindOptions {
  query: string
  regex?: boolean
  caseSensitive?: boolean
  maxMatches?: number
  contextLines?: number
}

export interface FindMatch {
  start: number
  end: number
  line: number
  column: number
  endLine: number
  endColumn: number
  text: string
  snippet: string
}

export interface FindResult {
  matches: FindMatch[]
  total: number
  truncated: boolean
  revision: string
  lineCount: number
}

function lineStartsOf(body: string): number[] {
  const starts = [0]
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\n') starts.push(i + 1)
  }
  return starts
}

/** 字符偏移 → 1 起的行/列（列按码点） */
function positionAt(
  body: string,
  starts: number[],
  offset: number
): { line: number; column: number } {
  let low = 0
  let high = starts.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    if (starts[mid] <= offset) low = mid + 1
    else high = mid - 1
  }
  const lineIndex = Math.max(0, high)
  const lineStart = starts[lineIndex] ?? 0
  return {
    line: lineIndex + 1,
    column: Array.from(body.slice(lineStart, offset)).length + 1
  }
}

function buildSnippet(
  body: string,
  startLine: number,
  endLine: number,
  contextLines: number
): string {
  const lines = body.split('\n')
  const from = Math.max(1, startLine - contextLines)
  const to = Math.min(lines.length, endLine + contextLines)
  const width = String(to).length
  const out: string[] = []
  for (let line = from; line <= to; line++) {
    const text = lines[line - 1] ?? ''
    const clipped = text.length > 800 ? `${text.slice(0, 800)}…` : text
    out.push(`${String(line).padStart(width)}| ${clipped}`)
  }
  return out.join('\n')
}

/** 在正文中按字面量/正则查找，返回精确到行、列（码点）的命中位置与上下文 */
export function findInContent(content: string, options: FindOptions): FindResult {
  if (options.query === '') throw new DocEditError('empty-query')
  const parsed = parseDocument(content)
  const body = parsed.body
  const starts = lineStartsOf(body)
  const raw = collectMatches(body, {
    oldText: options.query,
    newText: '',
    regex: options.regex,
    caseSensitive: options.caseSensitive
  })
  const maxMatches = Math.max(1, options.maxMatches ?? 20)
  const contextLines = Math.max(0, options.contextLines ?? 1)
  const matches: FindMatch[] = []
  for (const match of raw.slice(0, maxMatches)) {
    const start = positionAt(body, starts, match.start)
    const end = positionAt(body, starts, Math.max(match.start, match.end - 1))
    matches.push({
      start: match.start,
      end: match.end,
      line: start.line,
      column: start.column,
      endLine: end.line,
      endColumn: end.column,
      text: body.slice(match.start, match.end),
      snippet: buildSnippet(body, start.line, end.line, contextLines)
    })
  }
  return {
    matches,
    total: raw.length,
    truncated: raw.length > matches.length,
    revision: revisionOf(content),
    lineCount: parsed.lines.length
  }
}

export interface ChangeSummary {
  /** 旧内容中第一处差异的行（1 起） */
  startLine: number
  /** 旧内容中最后一处差异的行；纯插入时为 startLine - 1 */
  endLine: number
  removed: number
  added: number
  /** 新内容中差异起始行（1 起） */
  newStartLine: number
  /** 新内容中差异结束行；纯删除时为 newStartLine - 1 */
  newEndLine: number
}

/**
 * 轻量差异摘要：只按「公共前缀 / 公共后缀」取中间变化段。
 * 一次编辑通常只有一个连续改动段，足够生成「第几行起 -n/+m」和变更预览；
 * 多段 patch 由调用方按每步摘要分别展示。
 */
export function summarizeChange(before: string, after: string): ChangeSummary | null {
  if (before === after) return null
  // 空文档按 0 行参与差异计算：否则「从无到有」会被算成 -1/+1
  const beforeLines = before === '' ? [] : parseDocument(before).lines
  const afterLines = after === '' ? [] : parseDocument(after).lines

  let prefix = 0
  const maxPrefix = Math.min(beforeLines.length, afterLines.length)
  while (prefix < maxPrefix && beforeLines[prefix] === afterLines[prefix]) prefix++

  let suffix = 0
  const maxSuffix = Math.min(beforeLines.length, afterLines.length) - prefix
  while (
    suffix < maxSuffix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix++
  }

  const removed = beforeLines.length - prefix - suffix
  const added = afterLines.length - prefix - suffix
  return {
    startLine: prefix + 1,
    endLine: beforeLines.length - suffix,
    removed,
    added,
    newStartLine: prefix + 1,
    newEndLine: afterLines.length - suffix
  }
}

/** 变更预览（旧/新各最多 maxLines 行、maxChars 字符） */
export function previewChange(
  before: string,
  after: string,
  options: { maxLines?: number; maxChars?: number } = {}
): { oldText: string; newText: string; oldStart: number; newStart: number } | null {
  const summary = summarizeChange(before, after)
  if (!summary) return null
  const maxLines = options.maxLines ?? 8
  const maxChars = options.maxChars ?? 800
  const beforeLines = parseDocument(before).lines
  const afterLines = parseDocument(after).lines

  const oldLines = beforeLines.slice(summary.startLine - 1, summary.endLine).slice(0, maxLines)
  const newLines = afterLines.slice(summary.newStartLine - 1, summary.newEndLine).slice(0, maxLines)
  const clipLines = (lines: string[]): string => {
    let text = lines.join('\n')
    if (text.length > maxChars) text = `${text.slice(0, maxChars)}…`
    return text
  }
  return {
    oldText: clipLines(oldLines),
    newText: clipLines(newLines),
    oldStart: summary.startLine,
    newStart: summary.newStartLine
  }
}
