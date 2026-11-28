/**
 * Tool result fact registry (callId → structured facts).
 *
 * Why this side channel is needed: built-in file tools return results **to the model as plain
 * text** (read_file returns the raw file, execute returns JSON, write/edit tools return localized
 * confirmation text), and that text carries no reliable structured signal — failure reasons depend
 * on the UI language, and replacement counts/byte counts only exist as local variables inside the
 * tool functions. But the frontend's custom cards need these facts: failures show a reason, writes
 * show bytes, edits show replacement counts, reads show the total line count.
 *
 * So tools register the facts into this table at execution time (key = this call's toolCallId,
 * injected by agent.ts into `config.configurable.toolCallId`), and the stream producers take them
 * by callId and compose the card. The table is in-process and bounded (prevents long-session
 * leaks); taking an entry deletes it, and a missing entry affects no behavior.
 */

export interface ToolResultFacts {
  /**
   * Failure reason (the tool's return value is localized text; the structured signal lives only
   * here)
   */
  error?: string
  /** write_file: number of bytes written */
  bytes?: number
  /** edit_file: number of replacements */
  replacements?: number
  /**
   * write_file / edit_file: number of lines added / removed by this write (diff size).
   *
   * **Same source** as the change log (the file_change table): both are computed once by
   * changeStats in workspace/line-diff.ts (the tool registers the facts and also passes them to
   * the record layer), so the card's "+N −M", the explorer badge and the diff view statistics
   * always tell the same story.
   */
  added?: number
  removed?: number
  /** read_file: total number of file lines */
  lines?: number
  /** read_file: whether the output was truncated by the inline limit */
  truncated?: boolean
  /** read_file: line range when reading with offset/limit (1-based, inclusive) */
  range?: { start: number; end: number; total: number }
  /** read_image: this result is an image (the card renders a thumbnail/gallery from it) */
  image?: boolean
  /** read_image: image MIME type and pixel dimensions (omitted when they cannot be parsed) */
  mimeType?: string
  width?: number
  height?: number
  /** apply_patch: number of files touched by this patch */
  files?: number
}

/**
 * Registry capacity cap: the oldest entries are dropped when exceeded (normal streams never
 * reach it)
 */
const MAX_ENTRIES = 512

const factsByCallId = new Map<string, ToolResultFacts>()

/** Register (merge) the result facts of one tool call; silently ignored when callId is missing */
export function recordToolFacts(callId: string | undefined, patch: ToolResultFacts): void {
  if (!callId) return
  const prev = factsByCallId.get(callId)
  if (prev) {
    factsByCallId.delete(callId)
    factsByCallId.set(callId, { ...prev, ...patch })
  } else {
    factsByCallId.set(callId, patch)
  }
  while (factsByCallId.size > MAX_ENTRIES) {
    const oldest = factsByCallId.keys().next()
    if (oldest.done) break
    factsByCallId.delete(oldest.value)
  }
}

/** Read (without deleting) the result facts of one tool call */
export function peekToolFacts(callId: string | undefined): ToolResultFacts | undefined {
  return callId ? factsByCallId.get(callId) : undefined
}

/** Take and delete (called when a tool call wraps up, preventing accumulation in long sessions) */
export function takeToolFacts(callId: string | undefined): ToolResultFacts | undefined {
  if (!callId) return undefined
  const facts = factsByCallId.get(callId)
  if (facts) factsByCallId.delete(callId)
  return facts
}

/** Test helper: clear the registry */
export function clearToolFacts(): void {
  factsByCallId.clear()
}
