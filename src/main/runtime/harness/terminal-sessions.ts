/**
 * Persistent terminal session layer: really starts a long-lived shell (pwsh / cmd / bash) and
 * splits output at the completion marker.
 *
 * Security boundary: **usable only in the `danger-full-access` tier** — this module performs no
 * isolation and matches the existing `execute` behavior at the full-permission tier; the tier
 * check lives in the tool layer (`terminal-tools.ts`), while this layer only manages processes.
 *
 * This module **does not import electron / i18n**: errors come back as stable codes that the tool
 * layer translates; that also lets the node integration tests bundled by esbuild drive it
 * directly (real shell, really started).
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import * as path from 'node:path'
import {
  MAX_COMMAND_CHARS,
  OutputRing,
  buildCommandLine,
  createSentinel,
  looksBinary,
  normalizeCommand,
  resolveShell,
  splitAtSentinel,
  stripAnsi,
  stripSentinelLines,
  truncateTail,
  type ShellSpec,
  type TerminalShell
} from './terminal-core'

/** Maximum terminal sessions per topic */
export const MAX_SESSIONS_PER_TOPIC = 3
/** How long a session may be idle before it is closed (ms) */
export const IDLE_TIMEOUT_MS = 10 * 60_000
/** Default wait time and cap for `terminal_send` (ms) */
export const DEFAULT_WAIT_MS = 15_000
export const MAX_WAIT_MS = 60_000
/** Cap on output returned to the model per read (characters) */
export const MAX_RESULT_CHARS = 50_000
/** Cap on waiting for the shell to become ready when opening a session */
const INIT_WAIT_MS = 8_000

/** Stable error codes (translated into UI language by the tool layer) */
export type TerminalErrorCode =
  | 'too-many-sessions'
  | 'no-shell'
  | 'invalid-cwd'
  | 'session-not-found'
  | 'session-busy'
  | 'session-exited'
  | 'empty-command'
  | 'command-too-long'
  | 'nul-command'
  | 'spawn-failed'

export interface TerminalSessionView {
  sessionId: string
  shell: TerminalShell
  cwd: string
  createdAt: number
  alive: boolean
  unreadChars: number
}

export interface TerminalSendResult {
  /** This round's output with ANSI cleaned */
  output: string
  /** Wait timed out (the command may still be running; keep reading with terminal_read) */
  timedOut: boolean
  /** Output looks binary (the body has been omitted) */
  binary: boolean
  /** Still-unread output (characters) */
  unreadChars: number
}

interface PendingCommand {
  sentinel: string
  buffer: string
  resolve: (result: TerminalSendResult) => void
  timer: NodeJS.Timeout
}

interface SessionRecord {
  id: string
  topicId: number
  shell: ShellSpec
  cwd: string
  child: ChildProcessWithoutNullStreams
  ring: OutputRing
  pending: PendingCommand | null
  alive: boolean
  createdAt: number
  lastUsedAt: number
  exitCode: number | null
}

/** Session open result (error code and detail kept separate so the tool layer can localize) */
export type TerminalOpenResult =
  | { ok: true; session: TerminalSessionView; initOutput: string }
  | { ok: false; error: TerminalErrorCode; detail?: string }

/**
 * Process-level terminal session manager.
 *
 * Sessions belong to a topic (topicId), at most {@link MAX_SESSIONS_PER_TOPIC}; a background
 * timer reclaims them after {@link IDLE_TIMEOUT_MS} of idleness; the system wiring layer calls
 * `closeAll` when the application exits.
 */
export class TerminalSessionManager {
  private readonly sessions = new Map<string, SessionRecord>()
  private idleTimer: NodeJS.Timeout | null = null
  private pwshChecked = false
  private pwshAvailable = false

  /** Whether pwsh (PowerShell 7+) is available (probe result cached) */
  hasPwsh(): boolean {
    if (this.pwshChecked) return this.pwshAvailable
    this.pwshChecked = true
    try {
      const probe = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-Command', 'exit 0'], {
        timeout: 3_000,
        windowsHide: true,
        stdio: 'ignore'
      })
      this.pwshAvailable = probe.status === 0
    } catch {
      this.pwshAvailable = false
    }
    return this.pwshAvailable
  }

  /** Open a session (used by tools and tests) */
  async open(options: {
    topicId: number
    workspaceRoot: string
    cwd?: string
    shell?: TerminalShell
    /** Test only: skip the init wait (not skipped by default) */
    initTimeoutMs?: number
  }): Promise<TerminalOpenResult> {
    const forTopic = [...this.sessions.values()].filter((item) => item.topicId === options.topicId)
    if (forTopic.length >= MAX_SESSIONS_PER_TOPIC) {
      return { ok: false, error: 'too-many-sessions' }
    }

    const requested: TerminalShell | undefined = options.shell
    const pwsh = this.hasPwsh()
    if (requested === 'pwsh' && (process.platform !== 'win32' || !pwsh)) {
      return { ok: false, error: 'no-shell' }
    }
    if (requested === 'cmd' && process.platform !== 'win32') return { ok: false, error: 'no-shell' }
    if (requested === 'sh' && process.platform === 'win32') return { ok: false, error: 'no-shell' }
    const shell: ShellSpec =
      requested === 'pwsh'
        ? resolveShell('win32', true)
        : requested === 'cmd'
          ? resolveShell('win32', false)
          : requested === 'sh'
            ? resolveShell(process.platform, false)
            : resolveShell(process.platform, pwsh)

    const cwd = path.resolve(options.workspaceRoot, options.cwd ?? '.')
    try {
      if (!statSync(cwd).isDirectory()) return { ok: false, error: 'invalid-cwd', detail: cwd }
    } catch {
      return { ok: false, error: 'invalid-cwd', detail: cwd }
    }

    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(shell.command, shell.args, {
        cwd,
        env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (err) {
      return {
        ok: false,
        error: 'spawn-failed',
        detail: err instanceof Error ? err.message : String(err)
      }
    }

    const session: SessionRecord = {
      id: `term-${randomUUID().slice(0, 8)}`,
      topicId: options.topicId,
      shell,
      cwd,
      child,
      ring: new OutputRing(),
      pending: null,
      alive: true,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      exitCode: null
    }

    child.stdout.on('data', (chunk: Buffer) => this.onData(session, chunk.toString('utf8')))
    child.stderr.on('data', (chunk: Buffer) => this.onData(session, chunk.toString('utf8')))
    child.stdin.on('error', () => {
      // Writing after the process has exited raises EPIPE: let the exit handler deal with it, do
      // not throw here
    })
    child.on('exit', (code) => {
      session.alive = false
      session.exitCode = code
      if (session.pending) {
        const pending = session.pending
        session.pending = null
        clearTimeout(pending.timer)
        pending.resolve({
          output: stripAnsi(pending.buffer),
          timedOut: false,
          binary: false,
          unreadChars: session.ring.unreadChars
        })
      }
    })

    // Inject the init commands (suppress the prompt) and wait for them to finish, so output is
    // clean once open returns
    const init = await this.runInit(session, options.initTimeoutMs ?? INIT_WAIT_MS)
    if (!init.ok) {
      this.terminate(session)
      return { ok: false, error: 'spawn-failed', detail: init.output }
    }

    this.sessions.set(session.id, session)
    this.ensureIdleTimer()
    return {
      ok: true,
      session: this.viewOf(session),
      initOutput: init.output
    }
  }

  /** Send a command and wait for the completion marker (or timeout) */
  async send(
    sessionId: string,
    rawCommand: string,
    waitMs: number = DEFAULT_WAIT_MS
  ): Promise<{ ok: true; result: TerminalSendResult } | { ok: false; error: TerminalErrorCode }> {
    const session = this.sessions.get(sessionId)
    if (!session) return { ok: false, error: 'session-not-found' }
    if (!session.alive) return { ok: false, error: 'session-exited' }
    const normalized = normalizeCommand(rawCommand)
    if (!normalized.ok) {
      return {
        ok: false,
        error:
          normalized.reason === 'empty'
            ? 'empty-command'
            : normalized.reason === 'too-long'
              ? 'command-too-long'
              : 'nul-command'
      }
    }
    if (session.pending) return { ok: false, error: 'session-busy' }

    const timeout = Math.max(200, Math.min(MAX_WAIT_MS, Math.floor(waitMs)))
    const sentinel = createSentinel(randomUUID())
    const result = new Promise<TerminalSendResult>((resolve) => {
      session.pending = {
        sentinel,
        buffer: '',
        resolve,
        timer: setTimeout(() => {
          const pending = session.pending
          if (!pending) return
          session.pending = null
          pending.resolve({
            output: this.cleanOutput(pending.buffer),
            timedOut: true,
            binary: false,
            unreadChars: session.ring.unreadChars
          })
        }, timeout)
      }
    })
    session.lastUsedAt = Date.now()
    try {
      session.child.stdin.write(buildCommandLine(normalized.command, sentinel, session.shell))
    } catch {
      // TS control flow does not know about the synchronous assignment inside the Promise
      // executor, so annotate the type explicitly
      const pending = session.pending as PendingCommand | null
      session.pending = null
      if (pending) {
        clearTimeout(pending.timer)
        pending.resolve({ output: '', timedOut: false, binary: false, unreadChars: 0 })
      }
      return { ok: false, error: 'session-exited' }
    }
    return { ok: true, result: await result }
  }

  /** Read the session's incremental output since the last read */
  read(
    sessionId: string,
    maxChars: number = MAX_RESULT_CHARS
  ): { ok: true; text: string; truncated: boolean; droppedChars: number; binary: boolean } | { ok: false; error: TerminalErrorCode } {
    const session = this.sessions.get(sessionId)
    if (!session) return { ok: false, error: 'session-not-found' }
    const drained = session.ring.drain(maxChars)
    const text = stripSentinelLines(stripAnsi(drained.text))
    return {
      ok: true,
      text,
      truncated: drained.truncated,
      droppedChars: drained.dropped,
      binary: looksBinary(text)
    }
  }

  /**
   * Read-only snapshot (for polling by the user-facing terminal panel): returns the most recent
   * maxChars of merged output **without consuming** the unread buffer, so it does not steal
   * content that the model's `terminal_read` should read; it also returns session liveness and cwd
   * for the panel.
   *
   * With `raw: true` ANSI escape sequences are kept (the xterm.js frontend renders colors/cursor
   * control itself); the model-side `read()` and the default peek still use stripAnsi plain text.
   */
  peek(
    sessionId: string,
    maxChars: number = MAX_RESULT_CHARS,
    options?: { raw?: boolean }
  ):
    | {
        ok: true
        sessionId: string
        alive: boolean
        shell: TerminalShell
        cwd: string
        createdAt: number
        text: string
        truncated: boolean
        droppedChars: number
        binary: boolean
      }
    | { ok: false; error: TerminalErrorCode } {
    const session = this.sessions.get(sessionId)
    if (!session) return { ok: false, error: 'session-not-found' }
    const snap = session.ring.snapshot(maxChars)
    const stripped = stripSentinelLines(options?.raw ? snap.text : stripAnsi(snap.text))
    return {
      ok: true,
      sessionId: session.id,
      alive: session.alive,
      shell: session.shell.kind,
      cwd: session.cwd,
      createdAt: session.createdAt,
      text: stripped,
      truncated: snap.truncated,
      droppedChars: snap.dropped,
      binary: looksBinary(stripAnsi(stripped))
    }
  }

  /** Close a session (terminate the whole tree; idempotent) */
  close(sessionId: string): { ok: true; found: boolean; exitCode: number | null } {
    const session = this.sessions.get(sessionId)
    if (!session) return { ok: true, found: false, exitCode: null }
    this.terminate(session)
    this.sessions.delete(sessionId)
    return { ok: true, found: true, exitCode: session.exitCode }
  }

  /** List the sessions of a topic */
  list(topicId: number): TerminalSessionView[] {
    return [...this.sessions.values()]
      .filter((session) => session.topicId === topicId)
      .map((session) => this.viewOf(session))
  }

  /** Close all sessions of a topic (used when a topic is deleted/switched) */
  closeTopic(topicId: number): void {
    for (const session of [...this.sessions.values()]) {
      if (session.topicId === topicId) this.close(session.id)
    }
  }

  /** Close all sessions (used on application exit) */
  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id)
    if (this.idleTimer) {
      clearInterval(this.idleTimer)
      this.idleTimer = null
    }
  }

  /** Current number of active sessions (for tests/diagnostics) */
  get activeCount(): number {
    return this.sessions.size
  }

  /** Session view */
  viewOf(session: SessionRecord): TerminalSessionView {
    return {
      sessionId: session.id,
      shell: session.shell.kind,
      cwd: session.cwd,
      createdAt: session.createdAt,
      alive: session.alive,
      unreadChars: session.ring.unreadChars
    }
  }

  /** Output arrived: add it to the ring buffer + try to split out the completion marker if a command is waiting */
  private onData(session: SessionRecord, text: string): void {
    session.lastUsedAt = Date.now()
    session.ring.push(text)
    const pending = session.pending
    if (!pending) return
    pending.buffer += text
    const split = splitAtSentinel(pending.buffer, pending.sentinel)
    if (!split) return
    session.pending = null
    clearTimeout(pending.timer)
    pending.resolve({
      output: this.cleanOutput(split.output),
      timedOut: false,
      binary: looksBinary(split.output),
      unreadChars: session.ring.unreadChars
    })
  }

  /** Clean ANSI, truncate the tail, fall back for empty output */
  private cleanOutput(text: string): string {
    const cleaned = stripAnsi(stripSentinelLines(text))
      .replace(/^\r?\n/, '')
      .replace(/\r/g, '')
    return truncateTail(cleaned, MAX_RESULT_CHARS).text
  }

  /** Run the init commands and wait for the completion marker */
  private runInit(
    session: SessionRecord,
    timeoutMs: number
  ): Promise<{ ok: true; output: string } | { ok: false; output: string }> {
    const sentinel = createSentinel(randomUUID())
    // When stdin is a pipe, cmd prints its prompt only once **before the first command** (no
    // newline); an empty echo must flush that line first, otherwise the first command's
    // completion marker gets appended to the prompt.
    const flushLine =
      session.shell.kind === 'cmd'
        ? 'echo.'
        : session.shell.kind === 'pwsh'
          ? "Write-Output ''"
          : 'echo'
    const payload = session.shell.initCommands
      .map((command) => `${command}${session.shell.newline}`)
      .join('') + `${flushLine}${session.shell.newline}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        session.pending = null
        resolve({ ok: false, output: 'shell init timeout' })
      }, timeoutMs)
      session.pending = {
        sentinel,
        buffer: '',
        timer,
        resolve: (result) => {
          clearTimeout(timer)
          resolve({ ok: true, output: result.output })
        }
      }
      try {
        session.child.stdin.write(`${payload}echo ${sentinel}${session.shell.newline}`)
      } catch (err) {
        clearTimeout(timer)
        session.pending = null
        resolve({ ok: false, output: err instanceof Error ? err.message : String(err) })
      }
    })
  }

  /** Terminate the whole tree */
  private terminate(session: SessionRecord): void {
    session.alive = false
    if (session.pending) {
      clearTimeout(session.pending.timer)
      session.pending = null
    }
    if (process.platform === 'win32' && typeof session.child.pid === 'number') {
      try {
        spawn('taskkill', ['/pid', String(session.child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore'
        })
      } catch {
        // Ignore: the process may have already exited
      }
      return
    }
    try {
      session.child.kill('SIGKILL')
    } catch {
      // Same as above
    }
  }

  /** Idle-reclaim timer (60s granularity) */
  private ensureIdleTimer(): void {
    if (this.idleTimer) return
    this.idleTimer = setInterval(() => {
      const deadline = Date.now() - IDLE_TIMEOUT_MS
      for (const session of [...this.sessions.values()]) {
        if (session.lastUsedAt < deadline) this.close(session.id)
      }
      if (this.sessions.size === 0 && this.idleTimer) {
        clearInterval(this.idleTimer)
        this.idleTimer = null
      }
    }, 60_000)
    this.idleTimer.unref?.()
  }
}

/** Process-level singleton (shared by the tool layer and system exit cleanup) */
export const terminalSessions = new TerminalSessionManager()

/** Command length cap (referenced by the tool schema validation message) */
export const TERMINAL_MAX_COMMAND_CHARS = MAX_COMMAND_CHARS
