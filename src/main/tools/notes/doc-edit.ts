/**
 * **Plain-text editing engine** for document bodies (no electron / database dependencies, unit
 * testable offline).
 *
 * Why it was split out: the model used to be able to only update the whole `content`, so changing
 * a single line rewrote the entire text, which easily damaged other parts and wasted context and
 * writes. This provides deterministic edits at three granularities — "lines / in-line column
 * ranges / text fragments" — and handles the following uniformly:
 * - **Lines and columns are 1-based and columns count Unicode code points** (Chinese text and
 *   emoji are never split by UTF-16 surrogate pairs);
 * - **EOL is preserved** (a CRLF original keeps CRLF; new text from the model is normalized first
 *   and then written back with the original EOL);
 * - **expectedOld / expectedRevision double check** (edit exactly what was read; refuse to write
 *   if someone else changed it first);
 * - **Atomic batch edits** (every patch is computed before anything is written, and any failure
 *   leaves no half-applied change).
 *
 * Line numbering semantics: `content.split('\n')`, so a document ending in `\n` has an empty last
 * line. For example, "a\nb\n" has 3 lines (the 3rd is empty) and "a\nb" has 2 lines.
 */

import { createHash } from 'node:crypto'

/** Line ending used by the original document (kept after edits) */
export type LineEnding = '\n' | '\r\n'

/** Parsed document: body always uses \n and is restored to eol on output */
export interface ParsedDocument {
  body: string
  eol: LineEnding
  lines: string[]
}

/** **Structured** errors thrown by the editing engine: the caller renders the text per UI language */
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
  /** Which patch entry (1-based); empty for non-patch errors */
  editIndex?: number

  constructor(code: DocEditErrorCode, details: Record<string, string | number> = {}) {
    super(code)
    this.name = 'DocEditError'
    this.code = code
    this.details = details
  }
}

/** Short revision: first 12 chars of the content hash, used to check "is this the same version I read" */
export function revisionOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 12)
}

/** Parse the body (keeps the original EOL choice; body is normalized to \n) */
export function parseDocument(content: string): ParsedDocument {
  const eol: LineEnding = content.includes('\r\n') ? '\r\n' : '\n'
  const body = eol === '\r\n' ? content.split('\r\n').join('\n') : content
  return { body, eol, lines: body.split('\n') }
}

/** Turn the internal body back into on-disk text */
export function serializeDocument(doc: ParsedDocument): string {
  return doc.eol === '\n' ? doc.body : doc.body.split('\n').join(doc.eol)
}

/** Number of document lines (an empty document still has at least 1 line) */
export function lineCountOf(content: string): number {
  return content.split('\n').length
}

/** New text from the model: normalized to \n first, then converted to the original EOL by serializeDocument */
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

/** expectedOld comparison tolerates one extra trailing newline from the model (everything else must match exactly) */
function normalizeExpected(text: string): string {
  const normalized = normalizeText(text)
  return normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized
}

/** Current content shown in error details (keeps the whole document out of the error message) */
function clip(text: string, max = 500): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

// ============================================================================
// Single-step edits
// ============================================================================

export interface ReplaceLinesOptions {
  startLine: number
  endLine: number
  /** New content (may be multiple lines); an empty string means delete these lines */
  newText: string
  /** Optional: what these lines must currently be (exact check), preventing an edit at a drifted line number */
  expectedOld?: string
}

/** Replace/delete a whole line range (1-based, inclusive) */
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
  /** 1-based; defaults to 1 */
  startColumn?: number
  /** 1-based, inclusive; defaults to end of line */
  endColumn?: number
  newText: string
  /** Optional: what the replaced characters must currently be */
  expectedOld?: string
}

/** Replace a character range within one line (columns count Unicode code points, inclusive) */
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
  /** Required when position=at/before/after (1-based) */
  line?: number
  /** Insert column for position=at (1-based, inserted before that character; defaults to line start, end of line = length+1) */
  column?: number
  newText: string
}

/** Insert text inside a line, before/after a line, or at the start/end of the document */
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
    // An empty range [column, column-1] is the insertion point; reuse range replacement so column
    // validation and EOL handling are shared
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

/** Delete a whole line range */
export function deleteLines(
  content: string,
  options: Omit<ReplaceLinesOptions, 'newText'>
): string {
  return replaceLines(content, { ...options, newText: '' })
}

/** Delete a character range inside a line */
export function deleteRange(
  content: string,
  options: Omit<ReplaceRangeOptions, 'newText'>
): string {
  return replaceRange(content, { ...options, newText: '' })
}

export interface ReplaceTextOptions {
  /** Source text to replace (literal; regex when regex=true) */
  oldText: string
  newText: string
  /** Replace all occurrences; mutually exclusive with occurrence */
  all?: boolean
  /** Replace only the Nth occurrence (1-based) */
  occurrence?: number
  /** Limit the search to lines startLine–endLine (optional) */
  startLine?: number
  endLine?: number
  regex?: boolean
  caseSensitive?: boolean
}

interface TextMatch {
  start: number
  end: number
}

/** Collect matches within the scope (literal or regex; case-insensitive runs through RegExp) */
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
    // Zero-width matches produce nothing replaceable: skip and advance to avoid an infinite loop
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
 * Replace a text fragment.
 *
 * When neither all nor occurrence is given it **must match exactly once**: multiple matches raise
 * ambiguous-match, forcing the model to state the location explicitly instead of silently changing
 * the first one.
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
// Batch edits
// ============================================================================

export type DocEdit =
  | ({ type: 'replace_lines' } & ReplaceLinesOptions)
  | ({ type: 'replace_text' } & ReplaceTextOptions)
  | ({ type: 'replace_range' } & ReplaceRangeOptions)
  | ({ type: 'insert' } & InsertOptions)
  | ({ type: 'delete_lines' } & Omit<ReplaceLinesOptions, 'newText'>)
  | ({ type: 'delete_range' } & Omit<ReplaceRangeOptions, 'newText'>)

function applySingleEdit(content: string, edit: DocEdit): string {
  // newText in a patch's JSON may be omitted by the model: a deletion must pass an explicit empty
  // string rather than relying on "not passed" silently deleting
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
 * Apply a batch of edits in order (line numbers refer to the document state **after the previous
 * edit**). Any failure throws immediately and the caller points at the location via editIndex;
 * since everything is computed in memory, as long as the caller writes nothing there is no
 * half-applied change.
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
// Search / diff summary
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

/** Character offset -> 1-based line/column (column by code point) */
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

/** Search the body by literal/regex, returning hit positions precise to line and column (code point) plus context */
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
  /** Line of the first difference in the old content (1-based) */
  startLine: number
  /** Line of the last difference in the old content; for a pure insertion it is startLine - 1 */
  endLine: number
  removed: number
  added: number
  /** Line where the difference starts in the new content (1-based) */
  newStartLine: number
  /** Line where the difference ends in the new content; for a pure deletion it is newStartLine - 1 */
  newEndLine: number
}

/**
 * Lightweight diff summary: only takes the changed middle segment using the "common prefix /
 * common suffix" approach. A single edit usually has one contiguous changed segment, which is
 * enough to produce "from line N, -n/+m" and a change preview; multi-step patches are shown by the
 * caller one summary per step.
 */
export function summarizeChange(before: string, after: string): ChangeSummary | null {
  if (before === after) return null
  // Treat an empty document as 0 lines in the diff: otherwise "from nothing to something" would be
  // counted as -1/+1
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

/** Change preview (old/new each at most maxLines lines and maxChars characters) */
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
