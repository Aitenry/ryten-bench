/**
 * **Pure logic core** of the persistent terminal (no electron / no child process, offline
 * testable).
 *
 * This layer only decides how to turn a command into chunkable text, how to split the output
 * stream at the completion marker, and how to cache and read it with bounds; the actual process
 * and session management lives in `terminal-sessions.ts`. The pure logic is kept separate so
 * these error-prone edges (a half line across chunks, ANSI escapes, output floods, binary
 * garbage) can be pinned down by unit tests without starting a shell.
 */

/** Maximum characters per command (prevents writing an oversized script in one go) */
export const MAX_COMMAND_CHARS = 8_000
/** Output cap for one `terminal_read` / one result returned to the model */
export const MAX_OUTPUT_CHARS_PER_READ = 50_000
/** Ring buffer cap for a session's unread output (bytes ≈ characters) */
export const RING_CAPACITY_CHARS = 256 * 1024

/** Kind of shell a session uses */
export type TerminalShell = 'pwsh' | 'cmd' | 'sh'

/** Full description needed to start one kind of shell */
export interface ShellSpec {
  kind: TerminalShell
  /** Executable (use the full .exe name on Windows to avoid PATH resolution ambiguity) */
  command: string
  args: string[]
  /** Commands injected right after the session starts (suppress the prompt, etc.) */
  initCommands: string[]
  /** Line separator: CRLF for cmd, LF elsewhere */
  newline: '\n' | '\r\n'
}

/**
 * Choose a shell: on Windows prefer PowerShell 7+ (if installed), otherwise cmd; on POSIX use
 * bash.
 *
 * `pwshAvailable` is probed by the session layer (one `spawn` of `pwsh -v`); this function only
 * makes the pure decision, which keeps it testable.
 */
export function resolveShell(platform: string, pwshAvailable: boolean): ShellSpec {
  if (platform === 'win32') {
    if (pwshAvailable) {
      return {
        kind: 'pwsh',
        command: 'pwsh.exe',
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'],
        initCommands: ["function prompt { '' }"],
        newline: '\r\n'
      }
    }
    return {
      kind: 'cmd',
      command: 'cmd.exe',
      args: ['/q', '/k'],
      initCommands: ['@echo off', 'prompt $S'],
      newline: '\r\n'
    }
  }
  return {
    kind: 'sh',
    command: '/bin/bash',
    args: ['--noprofile', '--norc'],
    initCommands: ["PS1=''"],
    newline: '\n'
  }
}

/** Build a command's completion marker (random per round to avoid colliding with command output) */
export function createSentinel(nonce: string): string {
  const safe = nonce.replace(/[^a-zA-Z0-9]/g, '').slice(0, 32) || 'x'
  return `__RB_DONE_${safe}__`
}

/**
 * Assemble one user command into the write string of "command + completion marker".
 *
 * The completion marker occupies its own line: whether the command succeeds or fails (even with
 * a syntax error) it eventually executes the `echo`, and the read side uses that to detect the
 * end of the round; exit codes cannot be used — a persistent shell has no "exit code of this
 * command".
 */
export function buildCommandLine(command: string, sentinel: string, shell: ShellSpec): string {
  const body = command.replace(/\r\n/g, '\n').replace(/\n$/, '')
  return `${body}${shell.newline}echo ${sentinel}${shell.newline}`
}

/** Normalize a command: reject empty/too-long/NUL-containing ones; keep multi-line commands (run line by line) */
export function normalizeCommand(
  raw: string
): { ok: true; command: string } | { ok: false; reason: 'empty' | 'too-long' | 'nul' } {
  if (typeof raw !== 'string' || raw.trim().length === 0) return { ok: false, reason: 'empty' }
  if (raw.includes('\u0000')) return { ok: false, reason: 'nul' }
  // Trim only whitespace at the very end of the whole command (including newlines); leave
  // **inline** whitespace alone — it may be part of a string literal
  const command = raw.replace(/\r\n/g, '\n').replace(/\s+$/, '')
  if (command.length > MAX_COMMAND_CHARS) return { ok: false, reason: 'too-long' }
  return { ok: true, command }
}

/** Strip ANSI escapes (colors, cursor control, OSC titles, etc.) while keeping readable text */
export function stripAnsi(text: string): string {
  // ANSI escape sequences necessarily consist of control characters such as ESC(0x1b)/BEL(0x07),
  // so `no-control-regex` is a false positive here: an inline disable is more precise than
  // relaxing the global rule.
  /* eslint-disable no-control-regex */
  return text
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[@-Z\\-_]/g, '')
  /* eslint-enable no-control-regex */
}

/**
 * Find the completion marker line in a buffer.
 *
 * Only an **exact whole-line match** counts (a trailing `\r` is allowed): marker text that
 * happens to appear in command output does not cause a false split.
 * Returns the output before the marker and the remainder after it (the next command's output).
 */
export function splitAtSentinel(
  buffer: string,
  sentinel: string
): { output: string; rest: string } | null {
  const marker = `${sentinel}`
  const lines = buffer.split('\n')
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].replace(/\r$/, '') !== marker) continue
    return {
      output: lines.slice(0, index).join('\n'),
      rest: lines.slice(index + 1).join('\n')
    }
  }
  return null
}

/**
 * Roughly decide whether output looks binary.
 *
 * Dumping build artifacts/archives into the context wastes budget and means nothing; output is
 * treated as binary when control characters (other than newline/CR/tab) exceed 30% or a NUL
 * appears.
 */
export function looksBinary(text: string): boolean {
  if (!text) return false
  const sample = text.slice(0, 4096)
  let control = 0
  for (const char of sample) {
    const code = char.codePointAt(0) ?? 0
    if (code === 0) return true
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) control += 1
  }
  return control / sample.length > 0.3
}

/**
 * Bounded output ring buffer.
 *
 * `push` adds new output (dropping the oldest when over capacity); `drain` takes all unread
 * output at once and resets the cursor. Dropped bytes are counted separately, so the result can
 * tell the model that "some output was evicted".
 */
export class OutputRing {
  private chunks: string[] = []
  private size = 0
  private droppedChars = 0
  private readonly capacity: number

  constructor(capacity: number = RING_CAPACITY_CHARS) {
    this.capacity = Math.max(1, Math.floor(capacity))
  }

  /** Add one chunk of output (usually a stdout/stderr chunk); keep the newest content over capacity */
  push(text: string): void {
    if (!text) return
    this.chunks.push(text)
    this.size += text.length
    if (this.size <= this.capacity) return
    // Always trim to "keep the last capacity characters": handles both an oversized single chunk
    // and accumulated chunks exactly
    const joined = this.chunks.join('')
    const keep = joined.slice(-this.capacity)
    this.droppedChars += joined.length - keep.length
    this.chunks = [keep]
    this.size = keep.length
  }

  /** Current number of unread characters */
  get unreadChars(): number {
    return this.size
  }

  /** Total evicted characters (monotonically increasing until reset) */
  get dropped(): number {
    return this.droppedChars
  }

  /** Take unread output (at most maxChars; the rest stays in the buffer for the next read) */
  drain(maxChars: number = MAX_OUTPUT_CHARS_PER_READ): {
    text: string
    truncated: boolean
    dropped: number
  } {
    const limit = Math.max(1, Math.floor(maxChars))
    const all = this.chunks.join('')
    let text = all
    let truncated = false
    if (all.length > limit) {
      text = all.slice(0, limit)
      truncated = true
      // Put the untaken part back into the buffer (preserving unread semantics)
      this.chunks = [all.slice(limit)]
      this.size = all.length - limit
    } else {
      this.chunks = []
      this.size = 0
    }
    const dropped = this.droppedChars
    this.droppedChars = 0
    return { text, truncated, dropped }
  }

  /** Discard all unread output (used when closing a session / clearing the screen) */
  clear(): void {
    this.chunks = []
    this.size = 0
    this.droppedChars = 0
  }

  /**
   * Read-only snapshot: the most recent maxChars characters, **without consuming unread output**.
   *
   * The user-facing terminal panel refreshes output by polling; reusing `drain` would make the
   * panel eat content that the model's `terminal_read` should read. This returns the "last N
   * characters" without moving the cursor or resetting the dropped count.
   */
  snapshot(maxChars: number = MAX_OUTPUT_CHARS_PER_READ): {
    text: string
    truncated: boolean
    dropped: number
  } {
    const limit = Math.max(1, Math.floor(maxChars))
    const all = this.chunks.join('')
    const truncated = all.length > limit
    return {
      text: truncated ? all.slice(-limit) : all,
      truncated,
      dropped: this.droppedChars
    }
  }
}

/** Truncate output (return the tail: command errors are usually at the end) */
export function truncateTail(text: string, maxChars: number): { text: string; truncated: boolean } {
  const limit = Math.max(1, Math.floor(maxChars))
  if (text.length <= limit) return { text, truncated: false }
  return { text: `…（前 ${text.length - limit} 字符已省略）\n${text.slice(-limit)}`, truncated: true }
}

/**
 * Remove completion marker lines left behind in the output.
 *
 * `terminal_send` normally strips the current round's marker, but on timeout/late arrival an old
 * marker stays in the ring buffer; `terminal_read` clears it before display so internal protocol
 * text is not fed to the model.
 */
export function stripSentinelLines(text: string): string {
  return text.replace(/^__RB_DONE_[A-Za-z0-9]+__\r?$/gm, '')
}
