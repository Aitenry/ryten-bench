import type { ToolCard } from './types'
import { MAX_EXEC_CHARS, MAX_FILE_CHARS } from '../../runtime/harness/tool-limits'
import type { ToolResultFacts } from '../../runtime/harness/tool-result-facts'

/**
 * Frontend projection of built-in tool results — decides which parts of a tool call leave the main process.
 *
 * Background (the motivation for this refactor): results of the built-in file/command tools (read_file /
 * write_file / edit_file / ls / glob / grep / execute) used to be sent to the renderer **verbatim** and
 * stored verbatim, while in chat these tools use custom cards (showing only path/command/count) — meaning a
 * multi-KB read_file body, a whole-file write_file input, or hundreds of grep matches were fully transferred
 * and written to the database, yet **nobody ever looked at them**. A tool-heavy turn could wastefully move
 * several MB.
 *
 * Current policy:
 *  - metadata the card needs → `card` (path, count, line count, bytes, exit code, failure reason);
 *  - content that needs viewing → click the card to open the real file in the right-side panel (file tools)
 *    or the result details tab (ls / glob / grep / execute; details are stored separately in
 *    runtime/tool-output-store);
 *  - therefore `input` keeps only the fields the card needs (large inputs such as write_file content and
 *    edit_file old_string/new_string are dropped entirely), and `output` is always empty.
 *
 * Safety net: **when no card can be built, keep a short slice of output** (≤ FALLBACK_CHARS). Otherwise, once
 * an unexpected call shape shows up (e.g. the model misspells an argument name), the frontend would see an
 * empty block with neither a card nor content — better to transfer 2KB extra than let errors vanish from the
 * UI.
 *
 * This module stays dependency-free (types and constants only), so offline regression scripts can import it
 * directly for verification.
 */

/** Max output kept when no card can be built (chars) */
export const FALLBACK_OUTPUT_CHARS = 2_000
/** Max card summary text length (chars) */
const MESSAGE_CHARS = 200
/** Tools whose result details are stored separately: viewed in the right-side panel after opening the card */
const DETAIL_TOOLS = new Set(['ls', 'glob', 'grep', 'execute'])
/** Tools that take part in projection (other tools are sent through unchanged) */
export const PROJECTED_TOOLS = new Set([
  'read_file',
  'read_image',
  'write_file',
  'edit_file',
  'apply_patch',
  'ls',
  'glob',
  'grep',
  'execute'
])

export interface ToolProjection {
  /** Input used for sending/persistence (already trimmed to what the card needs) */
  input: Record<string, unknown>
  /** Output used for sending/persistence (always an empty string for built-in tools; a short fallback slice is kept when there is no card) */
  output: string
  /** Card data */
  card?: ToolCard
  /** Raw result details to store separately (ls / glob / grep / execute) */
  detailText?: string
}

/** Use only non-empty strings */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Single-line summary: collapse whitespace + truncate (cards show one line only) */
function clampLine(text: string | undefined, max = MESSAGE_CHARS): string | undefined {
  if (!text) return undefined
  const oneLine = text.replace(/\s+/g, ' ').trim()
  if (!oneLine) return undefined
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

/** Pick fields by allowlist (dropping undefined) */
function pick(input: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of keys) {
    const value = input?.[key]
    if (value !== undefined && value !== null) out[key] = value
  }
  return out
}

/** Safe JSON parse (returns null on failure) */
function parseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * Trim tool **input** (shared by the running and completed states).
 *
 * write_file's `content` may be an entire file (hundreds of KB to MB); edit_file's
 * `old_string`/`new_string` may likewise be sizeable code blocks. The frontend card only needs the
 * path, so these large fields must be dropped before they enter IPC.
 */
export function projectToolInput(
  name: string,
  input: Record<string, unknown> | undefined
): Record<string, unknown> {
  const raw = input ?? {}
  switch (name) {
    case 'read_file':
      return pick(raw, ['file_path', 'offset', 'limit'])
    case 'read_image':
      return pick(raw, ['file_path'])
    case 'write_file': {
      // content is the whole file body: keep only its length for the card, the body never enters IPC/storage
      const out = pick(raw, ['file_path'])
      if (typeof raw.content === 'string')
        out.content_bytes = Buffer.byteLength(raw.content, 'utf-8')
      return out
    }
    case 'edit_file': {
      const out = pick(raw, ['file_path', 'replace_all'])
      if (typeof raw.old_string === 'string')
        out.old_string_bytes = Buffer.byteLength(raw.old_string, 'utf-8')
      if (typeof raw.new_string === 'string')
        out.new_string_bytes = Buffer.byteLength(raw.new_string, 'utf-8')
      return out
    }
    case 'apply_patch': {
      // The patch body may be long: keep only its byte count for the card, the body never enters IPC/storage
      const out: Record<string, unknown> = {}
      if (typeof raw.input === 'string') out.patch_bytes = Buffer.byteLength(raw.input, 'utf-8')
      return out
    }
    case 'ls':
      return pick(raw, ['path'])
    case 'glob':
      return pick(raw, ['pattern', 'path'])
    case 'grep':
      return pick(raw, ['pattern', 'path', 'glob'])
    case 'execute':
      return pick(raw, ['command'])
    default:
      return raw
  }
}

/**
 * Build the full projection for one tool call (completed state).
 *
 * @param name    Tool name
 * @param input   Arguments supplied by the model
 * @param output  Raw text returned by the tool (the copy the model sees)
 * @param facts   Structured facts recorded during execution (failure reason/bytes/replacements/lines), see tool-result-facts
 */
export function buildToolProjection(params: {
  name: string
  input: Record<string, unknown> | undefined
  output: string
  facts?: ToolResultFacts
}): ToolProjection {
  const { name, output, facts } = params
  const input = projectToolInput(name, params.input)
  const error = str(facts?.error)

  /** Fallback: no card → keep a short slice of output so content does not vanish */
  const fallback = (): ToolProjection => ({
    input,
    output: output.length > FALLBACK_OUTPUT_CHARS ? output.slice(0, FALLBACK_OUTPUT_CHARS) : output,
    card: error ? { status: 'error', message: clampLine(error) } : undefined
  })

  switch (name) {
    case 'read_file': {
      const path = str(params.input?.file_path)
      if (!path) return fallback()
      // Truncation check: a normal read body does not exceed MAX_FILE_CHARS; when truncated the output
      // necessarily exceeds it (it is "first N chars + omission notice"). If facts.truncated is set, trust it.
      const truncated = facts?.truncated ?? output.length > MAX_FILE_CHARS
      const card: ToolCard = {
        kind: 'file',
        path,
        status: error ? 'error' : 'ok',
        message: clampLine(error),
        chars: output.length,
        truncated,
        lines: facts?.lines,
        range: facts?.range
      }
      return { input, output: '', card }
    }

    case 'write_file': {
      const path = str(params.input?.file_path)
      if (!path) return fallback()
      // write_file's return value is a very short localized confirmation text (path and byte count); keeping it
      // costs nothing and is the only record of what this write actually did
      const card: ToolCard = {
        kind: 'file',
        path,
        status: error ? 'error' : 'ok',
        message: error ? clampLine(error) : clampLine(output),
        bytes:
          facts?.bytes ??
          (typeof input.content_bytes === 'number' ? input.content_bytes : undefined),
        added: facts?.added,
        removed: facts?.removed
      }
      return { input, output: error ? '' : output, card }
    }

    case 'edit_file': {
      const path = str(params.input?.file_path)
      if (!path) return fallback()
      const card: ToolCard = {
        kind: 'file',
        path,
        status: error ? 'error' : 'ok',
        message: error ? clampLine(error) : clampLine(output),
        count: facts?.replacements,
        // Replacement count + diff size: one says "how many places changed", the other "how many lines actually changed"
        added: facts?.added,
        removed: facts?.removed
      }
      return { input, output: error ? '' : output, card }
    }

    case 'read_image': {
      const path = str(params.input?.file_path)
      if (!path) return fallback()
      const card: ToolCard = {
        kind: 'file',
        path,
        status: error ? 'error' : 'ok',
        message: clampLine(error ?? output),
        bytes: facts?.bytes
      }
      return { input, output: error ? '' : output, card }
    }

    case 'apply_patch': {
      // On success the output is "patch applied (N files)" plus a per-file summary: one-line card summary + diff size
      const card: ToolCard = {
        kind: 'file',
        status: error ? 'error' : 'ok',
        message: error ? clampLine(error) : clampLine(output),
        files: facts?.files,
        added: facts?.added,
        removed: facts?.removed,
        bytes: typeof input.patch_bytes === 'number' ? input.patch_bytes : undefined
      }
      return { input, output: error ? '' : output, card }
    }

    case 'ls': {
      const path = str(params.input?.path) ?? '/'
      const parsed = parseJson(output)
      const files = Array.isArray(parsed?.files) ? (parsed.files as string[]).length : 0
      const dirs = Array.isArray(parsed?.dirs) ? (parsed.dirs as string[]).length : 0
      if (!parsed && !error) return fallback()
      const card: ToolCard = {
        kind: 'dir',
        path,
        status: error ? 'error' : 'ok',
        message: error ? clampLine(error) : undefined,
        files,
        dirs,
        count: files + dirs,
        detail: !error
      }
      return { input, output: '', card, detailText: error ? undefined : output }
    }

    case 'glob': {
      const pattern = str(params.input?.pattern)
      const parsed = parseJson(output)
      const files = Array.isArray(parsed?.files) ? (parsed.files as unknown[]).length : undefined
      if (!parsed && !error) return fallback()
      const card: ToolCard = {
        kind: 'search',
        pattern,
        path: str(params.input?.path),
        status: error ? 'error' : 'ok',
        message: error ? clampLine(error) : undefined,
        files,
        count: files,
        detail: !error
      }
      return { input, output: '', card, detailText: error ? undefined : output }
    }

    case 'grep': {
      const pattern = str(params.input?.pattern)
      const parsed = parseJson(output)
      const matches = Array.isArray(parsed?.matches)
        ? (parsed.matches as { path?: unknown }[])
        : undefined
      if (!parsed && !error) return fallback()
      const fileSet = new Set<string>()
      for (const match of matches ?? []) {
        const p = str(match?.path)
        if (p) fileSet.add(p)
      }
      const card: ToolCard = {
        kind: 'search',
        pattern,
        path: str(params.input?.path),
        status: error ? 'error' : 'ok',
        message: error ? clampLine(error) : undefined,
        count: matches?.length,
        fileCount: matches ? fileSet.size : undefined,
        detail: !error
      }
      return { input, output: '', card, detailText: error ? undefined : output }
    }

    case 'execute': {
      const command = str(params.input?.command)
      if (!command) return fallback()
      const parsed = parseJson(output)
      const exitCode = typeof parsed?.exitCode === 'number' ? parsed.exitCode : undefined
      if (error) {
        return {
          input,
          output: '',
          card: { kind: 'command', command, status: 'error', message: clampLine(error) }
        }
      }
      if (!parsed) return fallback()
      // Background run: the tool returns a jobId immediately with no exit code/stdout; the card shows
      // "background · job id", while the real status and logs live under Background Jobs in the top bar
      // (the card is not updated with the job, to avoid drift after persistence)
      if (typeof parsed.jobId === 'string') {
        return {
          input,
          output: '',
          card: {
            kind: 'command',
            command,
            status: 'ok',
            jobId: parsed.jobId,
            background: true,
            detail: true
          },
          detailText: output
        }
      }
      const stdout = typeof parsed.stdout === 'string' ? parsed.stdout : ''
      const card: ToolCard = {
        kind: 'command',
        command,
        status: exitCode !== undefined && exitCode !== 0 ? 'error' : 'ok',
        exitCode,
        chars: stdout.length,
        // When command output is truncated by MAX_EXEC_CHARS, a localized omission notice is appended; length is enough to tell
        truncated: stdout.length > MAX_EXEC_CHARS,
        detail: true
      }
      return { input, output: '', card, detailText: output }
    }

    default:
      // Non-built-in tools (mnemon_* / manage_* etc.): sent through and persisted unchanged;
      // they have their own count limits and the frontend parses their JSON to render dedicated cards
      return { input, output }
  }
}

/** Whether a tool call needs its result details stored separately */
export function needsDetailStore(name: string): boolean {
  return DETAIL_TOOLS.has(name)
}
