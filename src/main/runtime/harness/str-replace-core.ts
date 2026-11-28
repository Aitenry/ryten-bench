/**
 * Pure text logic for `str_replace_editor` (no electron / fs dependency, offline-testable).
 *
 * - `view`: show the file by line numbers (optionally a line range); when too long, only the start
 *   is shown and marked;
 * - `str_replace`: unique literal replacement (0 or multiple matches both fail, telling the model
 *   to provide more context);
 * - `insert`: insert after line N (0 = insert at the start of the file).
 *
 * All functions deal with strings only; file I/O plus permission/change bookkeeping are the tool
 * layer's job (fs-backend).
 */

/** Max lines shown by view (matches read_file's default of 2000 lines) */
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
  /** Whether it was truncated by the line cap */
  truncated: boolean
  /** Total number of lines in the file */
  totalLines: number
}

/** Split text into lines (keeps trailing semantics: a final newline does not add a content line) */
function splitLines(content: string): string[] {
  if (content === '') return []
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Line number + content (line numbers right-aligned so the model can cite them) */
function numbered(lines: string[], startLine: number): string {
  const width = String(startLine + lines.length - 1).length
  return lines
    .map((line, index) => `${String(startLine + index).padStart(width, ' ')}  ${line}`)
    .join('\n')
}

/**
 * `view` output: `1 first line` form (1-based).
 *
 * @param range optional inclusive range [start, end] (1-based); an invalid range returns the start
 *   of the whole file
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
 * Unique literal replacement.
 *
 * The only difference from edit_file is the return shape: here it is a pure function, so the tool
 * layer can give more precise failure text.
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
 * Insert text after line `insertLine` (0 = start of file; a line beyond the end appends).
 *
 * Inserted content keeps its own newlines as-is; an insert point outside [0, line count] fails.
 */
export function applyInsert(content: string, insertLine: number, newStr: string): InsertResult {
  if (!Number.isInteger(insertLine) || insertLine < 0) {
    return { ok: false, failure: 'invalid-line' }
  }
  const lines = splitLines(content)
  if (insertLine > lines.length) return { ok: false, failure: 'invalid-line' }
  const insertLines = newStr.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  // Drop the trailing empty element produced by the final newline: insert "a block", not "an
  // extra blank line"
  if (insertLines.length > 1 && insertLines[insertLines.length - 1] === '') insertLines.pop()
  const result = [
    ...lines.slice(0, insertLine),
    ...insertLines,
    ...lines.slice(insertLine)
  ]
  return { ok: true, content: `${result.join('\n')}\n` }
}
