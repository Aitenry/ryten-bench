import { tool, type StructuredToolInterface } from '../../ai/tools'
import { z } from 'zod'
import * as fs from 'fs'
import * as path from 'path'
import logger from 'electron-log'
import { mainFormat, mainPlural } from '../../i18n'
import { getFsToolTexts } from '../../i18n/tool-results-fs'
import { recordToolFacts } from './tool-result-facts'
import { MAX_IMAGE_BYTES, readImageFile, toolMedia, type ImageMimeType } from './image-tool'
import { normalizeImageDataUrl } from './image-encode'
import { applyHunks, parsePatch } from './apply-patch'
import { applyInsert, applyStrReplace, formatView } from './str-replace-core'
import { DEFAULT_MAX_DOCUMENT_CHARS, extractDocument } from './document-extract'
import { recordFileChange } from '../../workspace/file-history'
import { changeStats } from '../../workspace/line-diff'
import { beginToolWriteWindow, endToolWriteWindow } from '../../workspace/watcher'
import { isReallyInsideRoot } from '../../workspace/selected-roots'
import { permissionGate } from './permission-gate'
import { isPermissionMode } from './permission'
import { runConfinedShell, sandboxDenialText, sandboxUnavailableText } from '../../sandbox/exec'
import type { SandboxMode } from '../../sandbox/types'
import { jobsRegistry } from './jobs'
import { AnsiStripper, stripAnsi } from './terminal-core'
import {
  MAX_EXEC_CHARS,
  MAX_FILE_CHARS,
  MAX_FILE_READ_CHARS,
  MAX_OUTPUT_CHARS,
  MAX_SCAN_ENTRIES
} from './tool-limits'

/**
 * Virtual filesystem toolset.
 *
 * Mount rules (virtual path → real path):
 * - '/memories/' → memoryPath (memory directory)
 * - '/'          → workspacePath (AI workspace; not mounted when unset)
 *
 * Design notes:
 * - Tools are built per call with no shared state (isolation);
 * - Out-of-bounds virtual paths are rejected outright (capability attenuation);
 * - grep/glob catch EPERM and return an empty result.
 *
 * Output limits (MAX_FILE_CHARS / MAX_EXEC_CHARS, etc.) live in tool-limits.ts:
 * the frontend projection (service/tool-presentation.ts) uses the same constants to decide
 * whether a result was truncated.
 */

/** EPERM / EACCES - error codes for access-denied failures */
const ACCESS_DENIED_CODES = new Set(['EPERM', 'EACCES'])

/**
 * Escalated-retry parameters (sandbox_permissions / justification).
 *
 * Why declare them in the schema instead of leaving it to the model: parameters must reach the
 * tool layer (zod strips undeclared keys) so the gate can recognize an escalated retry. There is
 * exactly one **valid use**: retrying the exact call the sandbox just denied with them attached
 * (validated by parseEscalation in permission.ts): the target mode must be strictly wider and a
 * justification is required, otherwise no approval dialog appears.
 */
const sandboxPermissionField = {
  sandbox_permissions: z
    .enum(['read-only', 'workspace-write', 'danger-full-access'])
    .optional()
    .describe(
      'Only valid as a one-shot retry of an operation the sandbox just denied: the narrowest wider sandbox mode that would let this exact call through. Requires justification; the user is asked to approve it once.'
    ),
  justification: z
    .string()
    .optional()
    .describe(
      'One-sentence reason for the escalated retry. Required whenever sandbox_permissions is set.'
    )
}

/**
 * Read this call's toolCallId from the tool run config (agent.ts injects `configurable.toolCallId`).
 * Tools register structured facts (line counts/bytes/replacements/failure reason) for frontend
 * cards through this: the tool's return value is **text for the model** with no reliable structure.
 */
function callIdOf(config: unknown): string | undefined {
  const cfg = config as { configurable?: Record<string, unknown> } | undefined
  const id = cfg?.configurable?.toolCallId
  return typeof id === 'string' ? id : undefined
}

/** Attribution for this call (session id + tool call id), used by change records and command windows */
function runContextOf(config: unknown): { callId?: string; topicId?: number } {
  const cfg = config as { configurable?: Record<string, unknown> } | undefined
  const topicId = cfg?.configurable?.topicId
  return {
    callId: callIdOf(config),
    topicId: typeof topicId === 'number' ? topicId : undefined
  }
}

/**
 * Which sandbox mode this execution should use.
 *
 * Prefer `configurable.sandboxMode` injected by the permission gate (that is the mode actually
 * in effect for this call, wider after an escalated retry). Fall back to the topic's current mode
 * when absent — **never default to full access**, or one injection bug disables the sandbox.
 */
function sandboxModeOf(config: unknown, topicId?: number): SandboxMode {
  const cfg = config as { configurable?: Record<string, unknown> } | undefined
  const injected = cfg?.configurable?.sandboxMode
  if (isPermissionMode(injected)) return injected
  return permissionGate.modeFor(topicId ?? 0)
}

/** Single-run time limit for execute (ms) and its termination note */
const EXEC_TIMEOUT_MS = 30_000

/**
 * Retained-output cap for background execute jobs (characters).
 *
 * Foreground execute keeps only 8K (`MAX_EXEC_CHARS`, straight into model context); background
 * job logs are read incrementally on demand and must survive longer (dev-server startup logs,
 * build progress), but a chatty process must not eat memory forever. Output past the cap is
 * dropped and a note is appended.
 */
const MAX_BACKGROUND_OUTPUT_CHARS = 200_000

/** Max background job label length (the task list is display-only; the full command is in the call args) */
const BACKGROUND_JOB_LABEL_CHARS = 160

/** Collapse a command to one line and truncate it into a job label (multi-line heredocs must not stretch the task list) */
function backgroundJobLabel(command: string): string {
  const oneLine = command.replace(/\s+/g, ' ').trim()
  return oneLine.length > BACKGROUND_JOB_LABEL_CHARS
    ? `${oneLine.slice(0, BACKGROUND_JOB_LABEL_CHARS)}…`
    : oneLine
}

/**
 * Start a background command and return the job id immediately (does not wait for it to end).
 *
 * Three differences from foreground execute:
 * 1. **It does not use the tool cancel signal**: the job must outlive the turn/tool call and
 *    gets its own AbortController, aborted only by job_kill / Stop / topic deletion / app exit;
 * 2. **No timeout**: commands like dev servers never exit on their own (`timeoutMs: 0`);
 * 3. **It does not occupy the command write window**: the watcher attributes writes inside a
 *    window to the most recent call, so a long-running background process would otherwise claim
 *    later user and tool changes; workspace watching still broadcasts refreshes, it just does
 *    not record them as this execute's changes.
 *
 * Output is appended to the job registry in chunks: the model can read it incrementally with
 * job_output and the UI can peek at it; output past `MAX_BACKGROUND_OUTPUT_CHARS` is dropped.
 */
function startBackgroundCommand(params: {
  command: string
  mode: SandboxMode
  workspacePath: string
  topicId: number
}): string {
  const { command, mode, workspacePath, topicId } = params
  const tr = getFsToolTexts()
  // Command output is byte-stream slices: frames are concatenated as-is (no newline inserted as with subagent text)
  const job = jobsRegistry.start(topicId, 'exec', backgroundJobLabel(command), undefined, {
    frameSeparator: ''
  })
  const controller = new AbortController()
  jobsRegistry.attachCancel(job.id, () => controller.abort())

  void (async () => {
    let captured = 0
    let truncated = false
    /**
     * Command output is often colored even without a TTY (picocolors enables colors on win32
     * unconditionally), and those escapes used to be stored verbatim: the tray showed "…[32m"
     * mojibake and `job_output` fed the model escape noise. Strip them as the bytes stream in —
     * the stripper keeps state across chunks, so a sequence split between two reads is removed
     * too.
     */
    const ansi = new AnsiStripper()
    const onOutput = (chunk: string): void => {
      if (captured >= MAX_BACKGROUND_OUTPUT_CHARS) {
        truncated = true
        return
      }
      const text = ansi.push(chunk)
      const room = MAX_BACKGROUND_OUTPUT_CHARS - captured
      const kept = text.length > room ? text.slice(0, room) : text
      captured += kept.length
      if (kept) job.appendOutput(kept)
      if (kept.length < text.length) truncated = true
    }

    try {
      const result = await runConfinedShell({
        command,
        mode,
        workspaceRoot: workspacePath,
        maxChars: MAX_EXEC_CHARS,
        // Background commands have no default time limit: stopping is up to the user (top bar / job_kill) or topic deletion
        timeoutMs: 0,
        signal: controller.signal,
        onOutput
      })

      if (result.unavailable) {
        // The command never ran: keep this distinct from "command failed"; detail is shown with the job
        job.settle(
          'failed',
          undefined,
          sandboxUnavailableText(
            mainFormat(tr.exec.sandboxUnavailable, { reason: result.unavailable })
          )
        )
        return
      }
      if (result.runnerFailure) {
        job.settle(
          'failed',
          undefined,
          mainFormat(tr.exec.sandboxRunnerFailed, {
            detail: result.runnerFailure.slice(0, 400)
          })
        )
        return
      }
      if (truncated) job.appendOutput(`\n${tr.exec.backgroundTruncated}`)
      // User pressed Stop: check the cancel signal before "normal exit" and settle as killed, not failed
      if (controller.signal.aborted) {
        job.settle('killed')
        return
      }
      if (result.timedOut) job.appendOutput(`\n${tr.exec.timedOut}`)
      if (result.denied) {
        job.appendOutput(
          `\n${sandboxDenialText(mode, mainFormat(tr.exec.sandboxDenied, { mode }))}`
        )
      }
      const exitCode = result.exitCode ?? 1
      job.appendOutput(`\n${mainFormat(tr.exec.backgroundExitCode, { code: exitCode })}`)
      job.settle(result.denied || result.timedOut || exitCode !== 0 ? 'failed' : 'completed')
    } catch (error) {
      job.settle(
        'failed',
        undefined,
        mainFormat(tr.exec.backgroundFailed, { message: (error as Error).message })
      )
    }
  })()

  return job.id
}

interface FsMount {
  /** Virtual prefix, e.g. '/' or '/memories/' */
  prefix: string
  /** Real root directory */
  root: string
}

export interface FsBackendOptions {
  /** AI workspace directory (mounted as virtual '/') */
  workspacePath?: string
  /** Memory directory (mounted as virtual '/memories/') */
  memoryPath?: string
  /** Current workspace ID (file history is per workspace; changes are not recorded when unset) */
  workspaceId?: number
  /**
   * Whether the model routed for this turn declares image input support (models-profile's
   * supports_image_input).
   *
   * Three-state semantics: `false` (explicitly unsupported or undeclared) makes `read_image`
   * refuse at execution time; `true` allows it; `undefined` (model info unavailable at runtime,
   * e.g. offline tests/subagents) also allows it and lets the provider fail, so the tool never
   * gets locked out accidentally.
   */
  supportsImageInput?: boolean
}

/**
 * Write accounting inside the workspace (the single entry point for traceable / revertible changes).
 *
 * Only writes inside the workspace mount are recorded: '/memories/...' is the memory directory,
 * model-private data that does not take part in file-change review. Recording failures never
 * affect the tool result.
 */
async function recordWorkspaceWrite(args: {
  options: FsBackendOptions
  config: unknown
  realPath: string
  before: string | null
  after: string | null
  source: 'write_file' | 'edit_file'
  /**
   * Diff size of this change (+N −M).
   *
   * Computed by the tool and passed in instead of re-diffing in the recording layer: the same
   * numbers must appear on the **change record** (explorer badge / history list / diff fallback)
   * and the **chat card**; computing twice yields two potentially conflicting values (the
   * definition itself lives in workspace/line-diff.ts).
   */
  stats: { added: number; removed: number }
}): Promise<void> {
  const root = args.options.workspacePath
  const workspaceId = args.options.workspaceId
  if (!root || !workspaceId) return
  const relative = path.relative(root, args.realPath)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return
  const { callId, topicId } = runContextOf(args.config)
  try {
    await recordFileChange({
      workspaceId,
      workspaceRoot: root,
      realPath: args.realPath,
      before: args.before,
      after: args.after,
      source: args.source,
      topicId,
      callId,
      stats: args.stats
    })
  } catch (err) {
    logger.warn('[FsBackend] Failed to record file change:', err)
  }
}

/** Read the pre-change content; null when missing/unreadable (= this is a new file) */
function readBeforeOrNull(filePath: string): string | null {
  try {
    if (!fs.statSync(filePath).isFile()) return null
    return fs.readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }
}

/** Build the mount table from options (the IPC layer reuses the same mapping to read virtual paths) */
export function buildFsMounts(options: FsBackendOptions): FsMount[] {
  const mounts: FsMount[] = []
  if (options.workspacePath) {
    mounts.push({ prefix: '/', root: options.workspacePath })
  }
  if (options.memoryPath) {
    mounts.push({ prefix: '/memories/', root: options.memoryPath })
  }
  return mounts
}

/**
 * Resolve a virtual path to a real path from outside the tool layer (IPC: "open file with the
 * system app"). Same mounts and the same boundary checks as the fs tools — a renderer-supplied
 * path can never reach outside the workspace / memory roots.
 */
export function resolveVirtualFilePath(
  options: FsBackendOptions,
  virtualPath: string
): { realPath: string } | { error: string } {
  return resolveVirtualPath(virtualPath, buildFsMounts(options))
}

/** Resolve a virtual path to a real path; returns an error when out of bounds or unmounted */
function resolveVirtualPath(
  vp: string,
  mounts: FsMount[]
): { realPath: string } | { error: string } {
  const tr = getFsToolTexts()
  if (!vp) return { error: tr.path.empty }

  // Normalize to POSIX separators
  let normalized = vp.replace(/\\/g, '/')
  // Reject Windows absolute paths (e.g. E:\...) outright to prevent drive scanning
  if (/^[a-zA-Z]:\//.test(normalized)) {
    return { error: mainFormat(tr.path.absolute, { path: vp }) }
  }
  if (!normalized.startsWith('/')) {
    normalized = '/' + normalized
  }
  // Strip trailing slashes (except for the root path)
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1)
  }

  // Match mounts by longest prefix first
  const mountsSorted = [...mounts].sort((a, b) => b.prefix.length - a.prefix.length)
  for (const mount of mountsSorted) {
    if (normalized === mount.prefix.slice(0, -1) || normalized.startsWith(mount.prefix)) {
      const rel = normalized.slice(mount.prefix.length).replace(/^\//, '')
      const realPath = path.join(mount.root, ...(rel ? rel.split('/') : []))
      // Second check: ensure the resolved path is still inside the mount root (blocks ../ escapes)
      const relative = path.relative(mount.root, realPath)
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        return { error: mainFormat(tr.path.escapesMount, { path: vp }) }
      }
      // Third check (symlinks, audit item S06): if the workspace contains a symlink/junction
      // pointing outside the root, the string comparison above still passes but I/O lands
      // outside; compare with realpath too.
      if (!isReallyInsideRoot(realPath, mount.root)) {
        return { error: mainFormat(tr.path.escapesMount, { path: vp }) }
      }
      return { realPath }
    }
  }

  return { error: mainFormat(tr.path.notMounted, { path: vp }) }
}

/** Uniform tool-output formatting (strings as-is; objects JSON-serialized; hard-cap truncation, spill policy handles inline preview) */
function formatOutput(output: unknown): string {
  if (output == null) return 'OK'
  const text = typeof output === 'string' ? output : JSON.stringify(output)
  if (text.length > MAX_OUTPUT_CHARS) {
    const tr = getFsToolTexts()
    const note = mainFormat(tr.output.truncated, { total: text.length })
    return `${text.slice(0, MAX_OUTPUT_CHARS)}\n...${note}`
  }
  return text
}

/** Simple glob to regex (supports *, **, ?) */
function globToRegExp(pattern: string): RegExp {
  const GLOBSTAR = '__GLOBSTAR__'
  let re = pattern
    .replace(/\*\*/g, GLOBSTAR) // temporary placeholder
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(new RegExp(GLOBSTAR, 'g'), '.*')
  // A bare filename pattern also matches the end of a path
  if (!re.includes('/')) {
    re = `(?:^|/)${re}$`
  } else {
    re = `^${re}$`
  }
  return new RegExp(re)
}

/** Recursively collect relative paths under a directory (bounded) */
function walkDir(root: string, relDir: string, out: string[], cap = MAX_SCAN_ENTRIES): void {
  if (out.length >= cap) return
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(path.join(root, relDir), { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (out.length >= cap) return
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      out.push(rel + '/')
      walkDir(root, rel, out, cap)
    } else if (entry.isFile()) {
      out.push(rel)
    }
  }
}

/**
 * Scale or re-encode an image within pixel/byte budgets (Electron nativeImage).
 *
 * Actual decoding/encoding lives in `image-encode.ts` (the same rules as user-uploaded
 * attachments); here we only adapt the return shape for read_image (with a virtual path and
 * ImageMimeType).
 */
function normalizeImageForContext(image: {
  dataUrl: string
  mimeType: ImageMimeType
  bytes: number
  dimensions?: { width: number; height: number }
}): {
  dataUrl: string
  mimeType: ImageMimeType
  bytes: number
  dimensions?: { width: number; height: number }
  normalized: boolean
} {
  const normalized = normalizeImageDataUrl(image.dataUrl)
  const dimensions =
    normalized.width && normalized.height
      ? { width: normalized.width, height: normalized.height }
      : image.dimensions
  return {
    dataUrl: normalized.dataUrl,
    mimeType: normalized.mimeType as ImageMimeType,
    bytes: normalized.bytes || image.bytes,
    dimensions,
    normalized: normalized.normalized
  }
}

/** Per-file size cap for read_document (before Office files are decompressed; decompression bombs fail inside the extractor) */
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024

/**
 * Document text extraction tool (docx / xlsx / pptx / plain text).
 *
 * `read_file` reads UTF-8 only, so Office files are invisible to the model; this extracts text
 * by extension, puts a structural summary (sheet/slide counts) in the header, and caps body text
 * at 20k characters (adjustable with max_chars).
 */
function buildReadDocumentTool(
  resolve: (virtualPath: string) => { realPath: string } | { error: string }
): StructuredToolInterface {
  const tr = getFsToolTexts()
  return tool(
    async ({ file_path, max_chars }, config) => {
      const callId = callIdOf(config)
      const resolved = resolve(file_path)
      if ('error' in resolved) {
        recordToolFacts(callId, { error: resolved.error })
        return resolved.error
      }
      try {
        const stat = fs.statSync(resolved.realPath)
        if (!stat.isFile()) {
          const message = mainFormat(tr.read.notFile, { path: file_path })
          recordToolFacts(callId, { error: message })
          return message
        }
        if (stat.size > MAX_DOCUMENT_BYTES) {
          const message = mainFormat(tr.readDocument.tooLarge, {
            path: file_path,
            bytes: stat.size.toLocaleString(),
            limit: MAX_DOCUMENT_BYTES.toLocaleString()
          })
          recordToolFacts(callId, { error: message })
          return message
        }
        const buffer = fs.readFileSync(resolved.realPath)
        const extracted = await extractDocument({
          fileName: file_path,
          buffer,
          maxChars: max_chars ?? DEFAULT_MAX_DOCUMENT_CHARS
        })
        if (!extracted.ok) {
          const message =
            extracted.reason === 'empty'
              ? mainFormat(tr.readDocument.empty, { path: file_path })
              : extracted.reason === 'failed'
                ? mainFormat(tr.readDocument.failed, {
                    message: extracted.message ?? tr.readDocument.unsupported
                  })
                : mainFormat(tr.readDocument.unsupported, { path: file_path })
          recordToolFacts(callId, { error: message })
          return message
        }
        recordToolFacts(callId, {
          bytes: stat.size,
          lines: extracted.text.split('\n').length,
          truncated: extracted.truncated
        })
        const meta = extracted.meta.length > 0 ? `\n${extracted.meta.join('\n')}` : ''
        const header = mainFormat(tr.readDocument.header, {
          path: file_path,
          kind: extracted.kind,
          bytes: stat.size.toLocaleString(),
          meta
        })
        const note = extracted.truncated
          ? mainFormat(tr.readDocument.truncated, {
              total: extracted.totalChars.toLocaleString()
            })
          : ''
        return `${header}\n\n${extracted.text}${note}`
      } catch (err) {
        const message = mainFormat(tr.readDocument.failed, {
          message: (err as Error).message
        })
        recordToolFacts(callId, { error: message })
        return message
      }
    },
    {
      name: 'read_document',
      isConcurrencySafe: () => true,
      timeoutMs: 60_000,
      description:
        'Extract the text of a document from the virtual filesystem: .docx (Word, plain text), .xlsx (every sheet as tab-separated rows), .pptx (text per slide), or plain-text formats (.csv/.tsv/.md/.txt/.json/.yaml/.log). PDF is not supported. Large documents are truncated; pass max_chars to widen the limit (default 20000).',
      schema: z.object({
        file_path: z
          .string()
          .describe('Virtual path of the document, e.g. /uploads/report.docx'),
        max_chars: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Maximum characters of extracted text (default 20000)')
      })
    }
  )
}

/**
 * Build the filesystem toolset. Returns an empty array when nothing is mounted (the component stays inactive).
 */
export function buildFsTools(options: FsBackendOptions): StructuredToolInterface[] {
  const mounts: FsMount[] = buildFsMounts(options)
  if (mounts.length === 0) return []

  const tr = getFsToolTexts()
  const resolve = (vp: string): { realPath: string } | { error: string } =>
    resolveVirtualPath(vp, mounts)

  const tools: StructuredToolInterface[] = [
    tool(
      async ({ file_path, offset, limit }, config) => {
        const callId = callIdOf(config)
        const resolved = resolve(file_path)
        if ('error' in resolved) {
          recordToolFacts(callId, { error: resolved.error })
          return resolved.error
        }
        try {
          const stat = fs.statSync(resolved.realPath)
          if (!stat.isFile()) {
            const notFile = mainFormat(tr.read.notFile, { path: file_path })
            recordToolFacts(callId, { error: notFile })
            return notFile
          }
          let content = fs.readFileSync(resolved.realPath, 'utf-8')
          // Memory guard: keep only the first 2M characters of larger files
          const oversized = content.length > MAX_FILE_READ_CHARS
          if (oversized) {
            content = content.slice(0, MAX_FILE_READ_CHARS)
          }
          // Line-range read (offset is 1-based): read just the requested slice of a large file
          if (offset != null || limit != null) {
            const startLine = Math.max(1, offset ?? 1)
            const lines = content.split('\n')
            const endLine = limit != null ? startLine + limit - 1 : lines.length
            const sliced = lines.slice(startLine - 1, endLine)
            const shownEnd = Math.min(endLine, lines.length)
            const lineNote = mainFormat(
              oversized ? tr.read.lineRangeOversized : tr.read.lineRange,
              { start: startLine, end: shownEnd, total: lines.length }
            )
            // Structured facts: the card shows "N lines total · read start-end"
            recordToolFacts(callId, {
              lines: lines.length,
              truncated: oversized,
              range: { start: startLine, end: shownEnd, total: lines.length }
            })
            return lineNote + sliced.join('\n')
          }
          // Inline read cap: the excess never enters model context (read has its own bound and
          // skips the spill policy — use offset/limit or grep to read large files on demand)
          if (content.length > MAX_FILE_CHARS) {
            const note = mainFormat(tr.read.truncated, {
              total: content.length.toLocaleString()
            })
            recordToolFacts(callId, {
              lines: content.split('\n').length,
              truncated: true
            })
            return `${content.slice(0, MAX_FILE_CHARS)}\n...${note}`
          }
          recordToolFacts(callId, {
            lines: content.split('\n').length,
            truncated: oversized
          })
          return content
        } catch (err) {
          const failed = mainFormat(tr.read.failed, { message: (err as Error).message })
          recordToolFacts(callId, { error: failed })
          return failed
        }
      },
      {
        name: 'read_file',
        isConcurrencySafe: () => true,
        description:
          'Read a file (UTF-8) from the virtual filesystem. Paths are virtual and must start with "/", e.g. /uploads/report.txt or /memories/_global/memories/AGENTS.md. When a file exceeds the inline limit, the result starts with a spill locator for the full content: use offset/limit to read a line range of that file, or grep to locate what you need.',
        schema: z.object({
          file_path: z.string().describe('Virtual path of the file to read'),
          offset: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              'Start line number (1-based); use to read one part of a large file on demand'
            ),
          limit: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('Number of lines to read, used together with offset')
        })
      }
    ),

    /**
     * Read an image from disk and hand the image itself to the model.
     *
     * Division of labor with read_file: text goes to read_file, binary images come here. The
     * result is a "text + image" tool result (ToolMediaResult), not plain text: the runtime treats
     * text as the tool result and sends the image as the following user message, so no provider
     * needs changes (tool messages in the OpenAI-compatible protocol cannot carry images).
     */
    tool(
      async ({ file_path }, config) => {
        const callId = callIdOf(config)
        // Vision gate: refuse at the execution boundary when the model profile explicitly
        // declares no image input. Done before reading bytes so a doomed call does not read the file.
        if (options.supportsImageInput === false) {
          const refused = tr.readImage.modelUnsupported
          recordToolFacts(callId, { error: refused })
          return refused
        }
        const resolved = resolve(file_path)
        if ('error' in resolved) {
          recordToolFacts(callId, { error: resolved.error })
          return resolved.error
        }
        const result = readImageFile(resolved.realPath)
        if (!result.ok) {
          const text =
            result.code === 'not-file'
              ? mainFormat(tr.readImage.notFile, { path: file_path })
              : result.code === 'too-large'
                ? mainFormat(tr.readImage.tooLarge, {
                    bytes: (result.bytes ?? 0).toLocaleString(),
                    limit: MAX_IMAGE_BYTES.toLocaleString()
                  })
                : result.code === 'unsupported'
                  ? mainFormat(tr.readImage.unsupported, { path: file_path })
                  : mainFormat(tr.readImage.failed, { message: result.message })
          recordToolFacts(callId, { error: text })
          return text
        }
        // Normalize: scale or re-encode large images/byte sizes before context (falls back to the original on failure)
        const normalized = normalizeImageForContext(result)
        const note = normalized.normalized ? tr.readImage.normalizedNote : ''
        const text = (
          normalized.dimensions
            ? mainFormat(tr.readImage.ok, {
                path: file_path,
                mime: normalized.mimeType,
                width: normalized.dimensions.width,
                height: normalized.dimensions.height,
                bytes: normalized.bytes.toLocaleString()
              })
            : mainFormat(tr.readImage.okNoDimensions, {
                path: file_path,
                mime: normalized.mimeType,
                bytes: normalized.bytes.toLocaleString()
              })
        ) + note
        recordToolFacts(callId, {
          image: true,
          bytes: normalized.bytes,
          mimeType: normalized.mimeType,
          width: normalized.dimensions?.width,
          height: normalized.dimensions?.height
        })
        return toolMedia(text, [
          { dataUrl: normalized.dataUrl, path: file_path, mimeType: normalized.mimeType }
        ])
      },
      {
        name: 'read_image',
        isConcurrencySafe: () => true,
        description:
          'Read a PNG / JPEG / WebP / GIF image from the virtual filesystem and put the image itself into the conversation, so you can actually look at a screenshot, diagram, chart or photo instead of guessing from its name. Requires a vision-capable model; the default cap is 10 MB per image. The image is attached right after this tool result.',
        schema: z.object({
          file_path: z
            .string()
            .describe('Virtual path of the image file, e.g. /uploads/screenshot.png')
        })
      }
    ),

    buildReadDocumentTool(resolve),

    tool(
      async ({ file_path, content }, config) => {
        const callId = callIdOf(config)
        const resolved = resolve(file_path)
        if ('error' in resolved) {
          recordToolFacts(callId, { error: resolved.error })
          return resolved.error
        }
        try {
          // Async write (a synchronous write would block the main-process event loop)
          await fs.promises.mkdir(path.dirname(resolved.realPath), { recursive: true })
          // Pre-change content (for the diff view and undo); null for new files
          const before = readBeforeOrNull(resolved.realPath)
          await fs.promises.writeFile(resolved.realPath, content, 'utf-8')
          const bytes = Buffer.byteLength(content, 'utf-8')
          recordToolFacts(callId, { bytes })
          // The "+N −M" on the card uses the same numbers as the change record (stats of recordWorkspaceWrite)
          const stats = changeStats(before, content)
          recordToolFacts(callId, { added: stats.added, removed: stats.removed })
          // Accounting completes before returning: when the renderer hears "file changed", disk already has the new content
          await recordWorkspaceWrite({
            options,
            config,
            realPath: resolved.realPath,
            before,
            after: content,
            source: 'write_file',
            stats
          })
          return mainFormat(tr.write.written, { path: file_path, bytes })
        } catch (err) {
          const failed = mainFormat(tr.write.failed, { message: (err as Error).message })
          recordToolFacts(callId, { error: failed })
          return failed
        }
      },
      {
        name: 'write_file',
        description:
          'Write a file in the virtual filesystem, overwriting it if it already exists. Missing parent directories are created automatically.',
        schema: z.object({
          file_path: z.string().describe('Virtual path of the file to write'),
          content: z.string().describe('Full file content'),
          ...sandboxPermissionField
        })
      }
    ),

    tool(
      async ({ file_path, old_string, new_string, replace_all }, config) => {
        const callId = callIdOf(config)
        // An empty old_string makes the non-overlapping count loop below never terminate:
        // indexOf('', idx) always equals idx, so idx = found + 0 never advances. A synchronous
        // infinite loop would freeze the main-process event loop, so reject it at the entry.
        if (!old_string) {
          recordToolFacts(callId, { error: tr.edit.emptyOldString })
          return tr.edit.emptyOldString
        }
        const resolved = resolve(file_path)
        if ('error' in resolved) {
          recordToolFacts(callId, { error: resolved.error })
          return resolved.error
        }
        try {
          const current = fs.readFileSync(resolved.realPath, 'utf-8')
          // Non-overlapping count
          let count = 0
          let idx = 0
          while (true) {
            const found = current.indexOf(old_string, idx)
            if (found === -1) break
            count++
            idx = found + old_string.length
          }
          if (count === 0) {
            recordToolFacts(callId, { error: tr.edit.noMatch })
            return tr.edit.noMatch
          }
          if (count > 1 && !replace_all) {
            const multiple = mainPlural(tr.edit.occurrences_one, tr.edit.occurrences_other, count)
            recordToolFacts(callId, { error: multiple })
            return multiple
          }
          const updated = replace_all
            ? current.split(old_string).join(new_string)
            : current.replace(old_string, new_string)
          fs.writeFileSync(resolved.realPath, updated, 'utf-8')
          recordToolFacts(callId, { replacements: count })
          // "N occurrences" counts replacements while "+N −M" counts lines actually changed:
          // one replace_all may touch 3 places but 40 lines, so both numbers belong on the card (see changeStats)
          const stats = changeStats(current, updated)
          recordToolFacts(callId, { added: stats.added, removed: stats.removed })
          await recordWorkspaceWrite({
            options,
            config,
            realPath: resolved.realPath,
            before: current,
            after: updated,
            source: 'edit_file',
            stats
          })
          return mainFormat(mainPlural(tr.edit.updated_one, tr.edit.updated_other, count), {
            path: file_path
          })
        } catch (err) {
          const failed = mainFormat(tr.edit.failed, { message: (err as Error).message })
          recordToolFacts(callId, { error: failed })
          return failed
        }
      },
      {
        name: 'edit_file',
        description:
          'Edit a file in the virtual filesystem by replacing old_string with new_string. old_string must match the file content exactly and be unique; when it occurs more than once, either provide a longer unique context or set replace_all to true. Prefer this over write_file for targeted changes.',
        schema: z.object({
          file_path: z.string().describe('Virtual path of the file to edit'),
          old_string: z
            .string()
            .min(1, 'old_string must not be empty')
            .describe(
              'Exact text to find and replace (must match the file content character for character)'
            ),
          new_string: z.string().describe('Replacement text'),
          replace_all: z
            .boolean()
            .optional()
            .describe(
              'When true, replace every occurrence; defaults to false (a unique match is required)'
            ),
          ...sandboxPermissionField
        })
      }
    ),

    /**
     * Multi-file patch (apply_patch format).
     *
     * Two-phase execution: read and apply all operations in memory first, validating hunk by
     * hunk; any failure abandons everything (not a byte is written). Only after all pass are files
     * written, with per-file change records (revertible from the diff view).
     */
    tool(
      async ({ input }, config) => {
        const callId = callIdOf(config)
        const parsed = parsePatch(input)
        if (!parsed.ok) {
          const message = mainFormat(tr.applyPatch.parseFailed, { code: parsed.error })
          recordToolFacts(callId, { error: message })
          return message
        }

        interface PlannedChange {
          path: string
          realPath: string
          before: string | null
          after: string | null
          /** Reuse the existing source enum (DB has a CHECK constraint): additions are write_file, updates/deletes are edit_file */
          source: 'write_file' | 'edit_file'
        }
        const planned: PlannedChange[] = []
        const summaries: string[] = []

        for (const operation of parsed.operations) {
          const resolved = resolve(operation.path)
          if ('error' in resolved) {
            recordToolFacts(callId, { error: resolved.error })
            return resolved.error
          }

          if (operation.kind === 'add') {
            if (fs.existsSync(resolved.realPath)) {
              const message = mainFormat(tr.applyPatch.addExists, { path: operation.path })
              recordToolFacts(callId, { error: message })
              return message
            }
            const after = operation.lines.length > 0 ? `${operation.lines.join('\n')}\n` : ''
            planned.push({
              path: operation.path,
              realPath: resolved.realPath,
              before: null,
              after,
              source: 'write_file'
            })
            summaries.push(
              mainFormat(tr.applyPatch.summaryAdd, {
                path: operation.path,
                lines: operation.lines.length
              })
            )
            continue
          }

          if (operation.kind === 'delete') {
            if (!fs.existsSync(resolved.realPath)) {
              const message = mainFormat(tr.applyPatch.deleteMissing, { path: operation.path })
              recordToolFacts(callId, { error: message })
              return message
            }
            planned.push({
              path: operation.path,
              realPath: resolved.realPath,
              before: fs.readFileSync(resolved.realPath, 'utf-8'),
              after: null,
              source: 'edit_file'
            })
            summaries.push(mainFormat(tr.applyPatch.summaryDelete, { path: operation.path }))
            continue
          }

          // update
          if (!fs.existsSync(resolved.realPath)) {
            const message = mainFormat(tr.applyPatch.updateMissing, { path: operation.path })
            recordToolFacts(callId, { error: message })
            return message
          }
          const before = fs.readFileSync(resolved.realPath, 'utf-8')
          const applied = applyHunks(before, operation.hunks, operation.path)
          if (!applied.ok) {
            const failure = applied.failure
            const hunk = 'hunk' in failure ? failure.hunk + 1 : 1
            const message =
              failure.code === 'empty-hunk'
                ? mainFormat(tr.applyPatch.emptyHunk, { path: operation.path, hunk })
                : mainFormat(tr.applyPatch.hunkNotFound, { path: operation.path, hunk })
            recordToolFacts(callId, { error: message })
            return message
          }
          const stats = changeStats(before, applied.content)
          planned.push({
            path: operation.path,
            realPath: resolved.realPath,
            before,
            after: applied.content,
            source: 'edit_file'
          })
          summaries.push(
            mainFormat(tr.applyPatch.summaryUpdate, {
              path: operation.path,
              added: stats.added,
              removed: stats.removed
            })
          )
        }

        try {
          for (const change of planned) {
            if (change.after === null) {
              fs.unlinkSync(change.realPath)
            } else {
              fs.mkdirSync(path.dirname(change.realPath), { recursive: true })
              fs.writeFileSync(change.realPath, change.after, 'utf-8')
            }
          }
        } catch (err) {
          const message = mainFormat(tr.applyPatch.failed, { message: (err as Error).message })
          recordToolFacts(callId, { error: message })
          return message
        }

        let added = 0
        let removed = 0
        for (const change of planned) {
          const stats = changeStats(change.before, change.after)
          added += stats.added
          removed += stats.removed
          await recordWorkspaceWrite({
            options,
            config,
            realPath: change.realPath,
            before: change.before,
            after: change.after,
            source: change.source,
            stats
          })
        }
        recordToolFacts(callId, { added, removed, files: planned.length })
        return mainFormat(tr.applyPatch.applied, {
          files: planned.length,
          summary: summaries.join('\n')
        })
      },
      {
        name: 'apply_patch',
        description:
          'Apply one multi-file patch in a single call. Format: "*** Begin Patch" then "*** Add File: path" (+lines), "*** Update File: path" (hunks of " context", "-old", "+new" lines, optionally split by "@@"), or "*** Delete File: path", and finally "*** End Patch". Update hunks match context and removed lines exactly (whitespace-sensitive); if any hunk does not match, nothing is written and the error names the file and hunk. Prefer this over several edit_file calls when the changes belong together.',
        schema: z.object({
          input: z
            .string()
            .describe('Full patch text, including the *** Begin Patch / *** End Patch markers')
        })
      }
    ),

    /**
     * Text editor with four commands:
     * `view` (line-numbered) / `create` (new file, fails if it exists) / `str_replace` (unique literal replace) /
     * `insert` (insert after line N). Writes also go through file-change review.
     */
    tool(
      async (
        { command, path: filePath, file_text, insert_line, new_str, old_str, view_range },
        config
      ) => {
        const callId = callIdOf(config)
        const resolved = resolve(filePath)
        if ('error' in resolved) {
          recordToolFacts(callId, { error: resolved.error })
          return resolved.error
        }
        const realPath = resolved.realPath
        try {
          if (command === 'view') {
            if (!fs.existsSync(realPath)) {
              const message = mainFormat(tr.strEditor.missing, { path: filePath })
              recordToolFacts(callId, { error: message })
              return message
            }
            const content = fs.readFileSync(realPath, 'utf-8')
            const view = formatView(content, view_range as [number, number] | undefined)
            recordToolFacts(callId, { lines: view.totalLines, truncated: view.truncated })
            return view.text || tr.strEditor.viewEmpty
          }

          if (command === 'create') {
            if (fs.existsSync(realPath)) {
              const message = mainFormat(tr.strEditor.exists, { path: filePath })
              recordToolFacts(callId, { error: message })
              return message
            }
            const content = file_text ?? ''
            fs.mkdirSync(path.dirname(realPath), { recursive: true })
            fs.writeFileSync(realPath, content, 'utf-8')
            const stats = changeStats(null, content)
            recordToolFacts(callId, {
              bytes: Buffer.byteLength(content, 'utf-8'),
              added: stats.added,
              removed: stats.removed
            })
            await recordWorkspaceWrite({
              options,
              config,
              realPath,
              before: null,
              after: content,
              source: 'write_file',
              stats
            })
            return mainFormat(tr.strEditor.created, {
              path: filePath,
              lines: content.split('\n').length
            })
          }

          if (!fs.existsSync(realPath)) {
            const message = mainFormat(tr.strEditor.missing, { path: filePath })
            recordToolFacts(callId, { error: message })
            return message
          }
          const current = fs.readFileSync(realPath, 'utf-8')
          let next: string
          let summary: string

          if (command === 'str_replace') {
            const result = applyStrReplace(current, old_str ?? '', new_str ?? '')
            if (!result.ok) {
              const message =
                result.failure === 'not-unique' ? tr.strEditor.notUnique : tr.strEditor.notFound
              recordToolFacts(callId, { error: message })
              return message
            }
            next = result.content
            summary = mainFormat(tr.strEditor.replaced, {
              path: filePath,
              total: next.split('\n').length
            })
          } else {
            const maxLine = current.split('\n').length
            const result = applyInsert(current, insert_line ?? 0, new_str ?? '')
            if (!result.ok) {
              const message = mainFormat(tr.strEditor.invalidLine, { max: maxLine })
              recordToolFacts(callId, { error: message })
              return message
            }
            next = result.content
            summary = mainFormat(tr.strEditor.inserted, {
              path: filePath,
              line: insert_line ?? 0,
              total: next.split('\n').length
            })
          }

          fs.writeFileSync(realPath, next, 'utf-8')
          const stats = changeStats(current, next)
          recordToolFacts(callId, { added: stats.added, removed: stats.removed })
          await recordWorkspaceWrite({
            options,
            config,
            realPath,
            before: current,
            after: next,
            source: 'edit_file',
            stats
          })
          return summary
        } catch (err) {
          const message = mainFormat(tr.strEditor.failed, { message: (err as Error).message })
          recordToolFacts(callId, { error: message })
          return message
        }
      },
      {
        name: 'str_replace_editor',
        description:
          'Text editor with four commands: view (line-numbered content, optional view_range), create (fails if the file exists; needs file_text), str_replace (old_str must occur exactly once; needs old_str + new_str) and insert (insert new_str after line insert_line, where 0 inserts at the top). Use view before a replace when the old content is not fresh.',
        schema: z.object({
          command: z.enum(['view', 'create', 'str_replace', 'insert']),
          path: z.string().describe('Virtual path of the file, e.g. /src/a.ts'),
          file_text: z.string().optional().describe('create: full file content'),
          insert_line: z
            .number()
            .int()
            .optional()
            .describe('insert: line number to insert after (0 inserts at the top)'),
          new_str: z.string().optional().describe('str_replace/insert: the new text'),
          old_str: z
            .string()
            .optional()
            .describe('str_replace: the exact, unique text to replace'),
          view_range: z
            .array(z.number().int())
            .length(2)
            .optional()
            .describe('view: optional [start, end] line range (1-based, inclusive)'),
          ...sandboxPermissionField
        })
      }
    ),

    tool(
      async ({ path: dirPath }, config) => {
        const callId = callIdOf(config)
        const resolved = resolve(dirPath ?? '/')
        if ('error' in resolved) {
          recordToolFacts(callId, { error: resolved.error })
          return resolved.error
        }
        try {
          const entries = fs.readdirSync(resolved.realPath, { withFileTypes: true })
          const files: string[] = []
          const dirs: string[] = []
          for (const entry of entries) {
            if (entry.isDirectory()) dirs.push(entry.name)
            else if (entry.isFile()) files.push(entry.name)
          }
          return JSON.stringify({ path: dirPath ?? '/', files, dirs })
        } catch (err) {
          const failed = mainFormat(tr.ls.failed, { message: (err as Error).message })
          recordToolFacts(callId, { error: failed })
          return failed
        }
      },
      {
        name: 'ls',
        isConcurrencySafe: () => true,
        description:
          'List the files and subdirectories directly inside a virtual filesystem directory (one level, not recursive). Use glob to match paths recursively by pattern.',
        schema: z.object({
          path: z
            .string()
            .optional()
            .describe('Virtual path of the directory, defaults to the root /')
        })
      }
    ),

    tool(
      async ({ pattern, path: searchPath }, config) => {
        const callId = callIdOf(config)
        const resolved = resolve(searchPath ?? '/')
        if ('error' in resolved) {
          recordToolFacts(callId, { error: resolved.error })
          return resolved.error
        }
        try {
          const regex = globToRegExp(pattern)
          const relPaths: string[] = []
          walkDir(resolved.realPath, '', relPaths)
          const matches = relPaths.filter((rel) => regex.test(rel)).slice(0, 200)
          return JSON.stringify({ pattern, files: matches })
        } catch (err) {
          const code = (err as NodeJS.ErrnoException)?.code
          if (typeof code === 'string' && ACCESS_DENIED_CODES.has(code)) {
            logger.warn(`[FsBackend] glob "${pattern}" blocked by ${code}`)
            return JSON.stringify({ pattern, files: [] })
          }
          const failed = mainFormat(tr.glob.failed, { message: (err as Error).message })
          recordToolFacts(callId, { error: failed })
          return failed
        }
      },
      {
        name: 'glob',
        isConcurrencySafe: () => true,
        description:
          'Find files and directories by path pattern in the virtual filesystem. Patterns support *, ** and ? (e.g. **/*.md) and are matched against paths, not file contents; use grep to search inside files.',
        schema: z.object({
          pattern: z.string().describe('Glob pattern, e.g. **/*.md'),
          path: z
            .string()
            .optional()
            .describe('Virtual path of the directory to start from, defaults to the root /')
        })
      }
    ),

    tool(
      async ({ pattern, path: searchPath, glob: fileGlob }, config) => {
        const callId = callIdOf(config)
        const resolved = resolve(searchPath ?? '/')
        if ('error' in resolved) {
          recordToolFacts(callId, { error: resolved.error })
          return resolved.error
        }
        try {
          const regex = new RegExp(pattern)
          const fileRegex = fileGlob ? globToRegExp(fileGlob) : null
          const relPaths: string[] = []
          walkDir(resolved.realPath, '', relPaths)
          const matches: { path: string; line: number; content: string }[] = []
          for (const rel of relPaths) {
            if (rel.endsWith('/')) continue
            if (fileRegex && !fileRegex.test(rel)) continue
            if (matches.length >= 100) break
            try {
              const abs = path.join(resolved.realPath, rel)
              const stat = fs.statSync(abs)
              if (stat.size > 1024 * 1024) continue // skip files over 1MB
              const lines = fs.readFileSync(abs, 'utf-8').split('\n')
              for (let i = 0; i < lines.length; i++) {
                if (regex.test(lines[i])) {
                  matches.push({ path: '/' + rel, line: i + 1, content: lines[i].slice(0, 200) })
                  if (matches.length >= 100) break
                }
              }
            } catch {
              // Skip files that fail individually (EPERM etc.)
            }
          }
          return JSON.stringify({ matches })
        } catch (err) {
          const code = (err as NodeJS.ErrnoException)?.code
          if (typeof code === 'string' && ACCESS_DENIED_CODES.has(code)) {
            logger.warn(`[FsBackend] grep "${pattern}" blocked by ${code}`)
            return JSON.stringify({ matches: [] })
          }
          const failed = mainFormat(tr.glob.failed, { message: (err as Error).message })
          recordToolFacts(callId, { error: failed })
          return failed
        }
      },
      {
        name: 'grep',
        isConcurrencySafe: () => true,
        description:
          'Search file contents in the virtual filesystem and return matching lines with their paths and line numbers. The pattern is a regular expression matched against each line; use glob to narrow which files are searched.',
        schema: z.object({
          pattern: z
            .string()
            .describe('Regular expression matched against each line of file content'),
          path: z
            .string()
            .optional()
            .describe('Virtual path of the directory to start from, defaults to the root /'),
          glob: z.string().optional().describe('Optional glob filter for the file paths to search')
        })
      }
    )
  ]

  // execute is enabled only when a workspace directory exists (command execution is a side effect outside the system boundary, so it must be enabled explicitly)
  if (options.workspacePath) {
    tools.push(
      tool(
        async ({ command, run_in_background }, config) => {
          const { callId, topicId } = runContextOf(config)
          const mode = sandboxModeOf(config, topicId)

          /**
           * Background run: return the job id immediately so the model can keep working or
           * summarizing without blocking the turn.
           *
           * The job belongs to the current topic (the top bar filters by topicId): without a topic
           * context (e.g. a subagent graph) it is rejected — a job on topic 0 is neither visible
           * nor manageable, which is worse than an explicit error.
           */
          if (run_in_background) {
            if (topicId == null || topicId <= 0) {
              const text = tr.exec.backgroundNoTopic
              recordToolFacts(callId, { error: text })
              return text
            }
            const jobId = startBackgroundCommand({
              command,
              mode,
              workspacePath: options.workspacePath as string,
              topicId
            })
            return JSON.stringify({
              jobId,
              background: true,
              status: 'running',
              command,
              note: mainFormat(tr.exec.backgroundStarted, { id: jobId })
            })
          }

          // Command write window: file changes captured by the disk watcher during it go to this call
          // (a command has no exact before/after snapshot, so record truthfully "changed by the command, not revertible")
          beginToolWriteWindow({ topicId, callId })
          try {
            // Actually runs inside the sandbox (mode → OS isolation primitive; refuse to run when no backend is available, see sandbox/exec.ts)
            const result = await runConfinedShell({
              command,
              mode,
              workspaceRoot: options.workspacePath,
              maxChars: MAX_EXEC_CHARS,
              timeoutMs: EXEC_TIMEOUT_MS,
              signal: config?.signal
            })

            if (result.unavailable) {
              // Fail closed: the command did not run, and the model must know this is not a command failure but a missing sandbox
              const text = sandboxUnavailableText(
                mainFormat(tr.exec.sandboxUnavailable, { reason: result.unavailable })
              )
              recordToolFacts(callId, { error: text })
              return text
            }
            if (result.runnerFailure) {
              const text = mainFormat(tr.exec.sandboxRunnerFailed, {
                detail: result.runnerFailure.slice(0, 400)
              })
              recordToolFacts(callId, { error: text })
              return text
            }

            // Strip color/cursor escapes: a piped child still colors its output on win32, and the
            // model must see readable text, not "\u001b[32m" noise
            let text = stripAnsi(result.output)
            if (result.timedOut) {
              text += (text ? '\n' : '') + tr.exec.timedOut
            }
            if (result.denied) {
              // The sandbox denied a write: attach the protocol marker and escalation hint (the model can request one manual escalation)
              text = sandboxDenialText(
                mode,
                `${mainFormat(tr.exec.sandboxDenied, { mode })}${text ? `\n${text}` : ''}`
              )
            }
            if (text.length > MAX_EXEC_CHARS) {
              text = `${text.slice(0, MAX_EXEC_CHARS)}\n...${tr.exec.truncated}`
            }
            return JSON.stringify({ exitCode: result.exitCode ?? 1, stdout: text })
          } finally {
            // Command exited: close the window (writes in the following 1.5s grace period still count for it, see watcher.ts)
            endToolWriteWindow(callId)
          }
        },
        {
          name: 'execute',
          description:
            'Run a shell command (Windows) with the workspace directory as the working directory, returning stdout/stderr and the exit code. The command runs inside an OS-level sandbox: under "workspace-write" it may write inside the workspace (and its private temp directory) but every write outside is denied by the operating system, and under "read-only" no write is possible at all. A denied write returns a [sandbox: ...] marker plus an escalation hint. Set run_in_background=true for long-running processes (dev servers, watchers, builds that never exit): the call returns immediately with a job id instead of blocking the turn; read its output incrementally with job_output(job_id=..., wait=...) and stop it with job_kill(job_id=...). Prefer `read_file`, `write_file`, `ls`, `glob` and `grep` for file and directory work.',
          schema: z.object({
            command: z.string().describe('Shell command to execute'),
            run_in_background: z
              .boolean()
              .optional()
              .describe(
                'Run the command as a background job and return immediately with a job id (default false: wait for the command to exit, up to 30 s). Use this for long-running processes that never exit on their own; continue working without waiting, use job_output to read new output and job_kill to stop it.'
              ),
            ...sandboxPermissionField
          })
        }
      )
    )
  }

  return tools
}

/**
 * Read a text file under a virtual path (used when the renderer opens a file from a tool card).
 *
 * Difference from workspace-read-file: that channel allows only workspace paths (a plain file
 * browser's boundary), while tool-card paths may be memory mounts (/memories/...). This reuses
 * the same mount resolution; the boundary is still "must be inside some mounted root directory".
 *
 * @returns the file content, or { error } when the path is invalid or reading fails
 */
export function readVirtualTextFile(
  options: FsBackendOptions,
  virtualPath: string
): { content: string } | { error: string } {
  const mounts = buildFsMounts(options)
  if (mounts.length === 0) {
    return { error: mainFormat(getFsToolTexts().path.notMounted, { path: virtualPath }) }
  }
  const resolved = resolveVirtualPath(virtualPath, mounts)
  if ('error' in resolved) return resolved
  try {
    const stat = fs.statSync(resolved.realPath)
    if (!stat.isFile()) {
      return { error: mainFormat(getFsToolTexts().read.notFile, { path: virtualPath }) }
    }
    return { content: fs.readFileSync(resolved.realPath, 'utf-8') }
  } catch (err) {
    return { error: (err as Error).message }
  }
}

/** Output formatting reused by other modules (e.g. final subagent output) */
export { formatOutput }
