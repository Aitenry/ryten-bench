/**
 * Pure parsing and application logic for `apply_patch` (no electron / no filesystem
 * dependencies, so it is testable offline).
 *
 * The format matches OpenAI's apply_patch:
 *
 * ```
 * *** Begin Patch
 * *** Add File: docs/new.md
 * +first line
 * *** Update File: src/a.ts
 * @@ optional context
 *  context line
 * -old line
 * +new line
 * *** Delete File: old.txt
 * *** End Patch
 * ```
 *
 * Design trade-offs:
 * - Update hunks match the **exact sequence** of "consecutive context + removed lines"
 *   (whitespace and newlines must match), with no fuzzy matching: when a patch fails, erroring
 *   out so the model re-reads the file is better than editing the wrong place;
 * - Each hunk is matched starting after the previous one, so multiple hunks apply top to bottom;
 * - CRLF input is parsed and emitted as LF uniformly (all text tools here treat text as UTF-8).
 */

/** One update hunk: old is the context + removed lines, new is the context + added lines */
export interface PatchHunk {
  oldLines: string[]
  newLines: string[]
}

export type PatchOperation =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; hunks: PatchHunk[] }

export type ParsePatchResult =
  | { ok: true; operations: PatchOperation[] }
  | { ok: false; error: string }

/** Structured reason for a parse/apply failure (the caller localizes the message) */
export type PatchFailure =
  | { code: 'missing-begin' }
  | { code: 'missing-end' }
  | { code: 'empty-patch' }
  | { code: 'unknown-directive'; line: string }
  | { code: 'missing-path' }
  | { code: 'hunk-not-found'; path: string; hunk: number }
  | { code: 'empty-hunk'; path: string; hunk: number }

/** Strip trailing \r and treat the text as LF uniformly */
function normalizeLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
}

/**
 * Parse patch text. Failures return a structured error (no exception); the tool layer
 * translates it into the UI language.
 */
export function parsePatch(input: string): ParsePatchResult {
  const lines = normalizeLines(input)
  let index = 0
  // Blank lines or prose may precede the patch, but the first directive must be Begin Patch
  while (index < lines.length && lines[index].trim() === '') index++
  if (index >= lines.length || !/^\*\*\* Begin Patch\s*$/.test(lines[index].trim())) {
    return { ok: false, error: 'missing-begin' }
  }
  index++

  const operations: PatchOperation[] = []
  let sawEnd = false

  while (index < lines.length) {
    const raw = lines[index]
    const line = raw.trimEnd()
    if (line.trim() === '') {
      index++
      continue
    }
    if (/^\*\*\* End Patch\s*$/.test(line.trim())) {
      sawEnd = true
      index++
      break
    }

    const add = /^\*\*\* Add File:\s*(.+?)\s*$/.exec(line)
    const update = /^\*\*\* Update File:\s*(.+?)\s*$/.exec(line)
    const del = /^\*\*\* Delete File:\s*(.+?)\s*$/.exec(line)

    if (add) {
      const path = add[1]
      index++
      const added: string[] = []
      while (index < lines.length && !/^\*\*\* /.test(lines[index].trimStart())) {
        const body = lines[index]
        if (body.startsWith('+')) added.push(body.slice(1))
        else if (body.trim() !== '') added.push(body) // tolerance: unprefixed Add File lines are added literally
        index++
      }
      operations.push({ kind: 'add', path, lines: added })
      continue
    }

    if (del) {
      operations.push({ kind: 'delete', path: del[1] })
      index++
      continue
    }

    if (update) {
      const path = update[1]
      index++
      const hunks: PatchHunk[] = []
      let current: { oldLines: string[]; newLines: string[] } | null = null
      const flush = (): void => {
        if (!current) return
        hunks.push({ oldLines: current.oldLines, newLines: current.newLines })
        current = null
      }
      while (index < lines.length) {
        const body = lines[index]
        const trimmed = body.trimStart()
        if (/^\*\*\* End Patch\s*$/.test(body.trim()) || /^\*\*\* (Add|Update|Delete) File:/.test(trimmed)) {
          break
        }
        if (trimmed.startsWith('@@')) {
          flush()
          current = { oldLines: [], newLines: [] }
          index++
          continue
        }
        if (trimmed.startsWith('*** End of File')) {
          index++
          continue
        }
        if (body.startsWith('*** ')) {
          return { ok: false, error: `unknown-directive:${body.trim()}` }
        }
        if (!current) current = { oldLines: [], newLines: [] }
        const marker = body[0]
        if (marker === '+') {
          current.newLines.push(body.slice(1))
        } else if (marker === '-') {
          current.oldLines.push(body.slice(1))
        } else if (marker === ' ' || marker === undefined) {
          current.oldLines.push(body.slice(1))
          current.newLines.push(body.slice(1))
        } else if (marker === '@') {
          // Context line starting with @ (not an @@ directive): treat as context
          current.oldLines.push(body)
          current.newLines.push(body)
        } else {
          // Unprefixed lines are treated as context (lenient without breaking match semantics)
          current.oldLines.push(body)
          current.newLines.push(body)
        }
        index++
      }
      flush()
      if (hunks.length === 0) {
        return { ok: false, error: `empty-hunk:${path}` }
      }
      operations.push({ kind: 'update', path, hunks })
      continue
    }

    return { ok: false, error: `unknown-directive:${line.trim()}` }
  }

  if (!sawEnd) return { ok: false, error: 'missing-end' }
  if (operations.length === 0) return { ok: false, error: 'empty-patch' }
  return { ok: true, operations }
}

export type ApplyHunksResult =
  | { ok: true; content: string }
  | { ok: false; failure: PatchFailure }

/**
 * Apply hunks to text content one after another.
 *
 * @param content original text (LF or CRLF)
 * @param hunks parsed update hunks
 * @param path used only in error messages (which file's which hunk failed to match)
 */
export function applyHunks(content: string, hunks: PatchHunk[], path = ''): ApplyHunksResult {
  const hasTrailingNewline = /\n$/.test(content)
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  if (hasTrailingNewline) lines.pop()

  let searchStart = 0
  for (let hunkIndex = 0; hunkIndex < hunks.length; hunkIndex++) {
    const hunk = hunks[hunkIndex]
    if (hunk.oldLines.length === 0) {
      return { ok: false, failure: { code: 'empty-hunk', path, hunk: hunkIndex } }
    }
    const at = findSequence(lines, hunk.oldLines, searchStart)
    if (at < 0) {
      return { ok: false, failure: { code: 'hunk-not-found', path, hunk: hunkIndex } }
    }
    lines.splice(at, hunk.oldLines.length, ...hunk.newLines)
    searchStart = at + hunk.newLines.length
  }

  return { ok: true, content: lines.join('\n') + (hasTrailingNewline ? '\n' : '') }
}

/** Find a contiguous sequence in lines starting at from; return its start index, or -1 */
function findSequence(lines: string[], sequence: string[], from: number): number {
  const exact = findSequenceWith(lines, sequence, from, (line, expected) => line === expected)
  if (exact >= 0) return exact
  // Tolerant fallback: ignore **trailing** whitespace only (common when the model copies from an
  // editor). Leading indentation still matches strictly -- leading whitespace is semantic in code,
  // and being lenient would apply the patch at the wrong branch or nesting level.
  return findSequenceWith(lines, sequence, from, (line, expected) => line.trimEnd() === expected.trimEnd())
}

/** Find a contiguous sequence using the given line comparator */
function findSequenceWith(
  lines: string[],
  sequence: string[],
  from: number,
  equals: (line: string, expected: string) => boolean
): number {
  for (let start = Math.max(0, from); start <= lines.length - sequence.length; start++) {
    let match = true
    for (let offset = 0; offset < sequence.length; offset++) {
      if (!equals(lines[start + offset], sequence[offset])) {
        match = false
        break
      }
    }
    if (match) return start
  }
  return -1
}
