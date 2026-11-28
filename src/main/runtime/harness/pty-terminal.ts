/**
 * User-facing **real terminal** session (node-pty + xterm.js).
 *
 * Deliberately separate from the model-side `terminal_*` line-mode sessions
 * (terminal-sessions.ts):
 * - line mode is built for tool calls (send a command -> split on a completion marker -> return
 *   text) and has no TTY;
 * - this one is for humans: a real PTY with echo, a real prompt, Ctrl+C, colors, column width and
 *   full-screen programs (vim/top).
 *
 * This module imports neither electron nor i18n (node unit tests can drive it directly); events
 * are handed to the IPC layer through the `onData` / `onExit` callbacks. node-pty 1.1 ships N-API
 * prebuilt binaries (independent of the Electron ABI).
 */
import { spawn as nodePtySpawn, type IPty } from 'node-pty'
import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'

/** Terminal sessions allowed per topic (same as line mode) */
export const MAX_PTY_SESSIONS_PER_TOPIC = 3
/** How long an idle session lives before it is closed (ms) */
export const PTY_IDLE_TIMEOUT_MS = 30 * 60_000
/** Output replay cap per session (characters) */
export const PTY_BUFFER_CHARS = 200_000

export type PtyShellKind = 'pwsh' | 'cmd' | 'sh'

export interface PtySessionView {
  sessionId: string
  topicId: number
  shell: PtyShellKind
  cwd: string
  cols: number
  rows: number
  alive: boolean
  createdAt: number
  pid: number
}

export type PtyOpenResult =
  | { ok: true; session: PtySessionView }
  | { ok: false; error: 'too-many-sessions' | 'no-shell' | 'spawn-failed'; detail?: string }

interface PtyRecord {
  id: string
  topicId: number
  shell: PtyShellKind
  cwd: string
  cols: number
  rows: number
  createdAt: number
  lastUsedAt: number
  alive: boolean
  exitCode: number | null
  process: IPty
  buffer: string
}

export interface PtyTerminalManagerOptions {
  /** Test injection: defaults to node-pty's spawn */
  spawn?: typeof nodePtySpawn
  /** Test injection: sweeps idle sessions every 60s by default */
  idleSweepMs?: number
}

/** Platform default shell (forced kind; a missing executable makes spawn throw -> spawn-failed) */
export function resolvePtyShell(requested?: PtyShellKind): {
  file: string
  args: string[]
  kind: PtyShellKind
} {
  if (process.platform === 'win32') {
    if (requested === 'sh') return { file: 'bash.exe', args: ['-i'], kind: 'sh' }
    if (requested === 'pwsh') return { file: 'pwsh.exe', args: ['-NoLogo'], kind: 'pwsh' }
    const comspec = process.env.ComSpec || 'cmd.exe'
    return { file: comspec, args: ['/d'], kind: 'cmd' }
  }
  const shell = process.env.SHELL || '/bin/bash'
  return { file: shell, args: ['-i'], kind: 'sh' as PtyShellKind }
}

/** Normalize cwd: it must be an existing directory, otherwise fall back to the home directory */
export function resolvePtyCwd(cwd: string | undefined): string | null {
  const candidate = typeof cwd === 'string' && cwd.trim() ? cwd.trim() : ''
  if (!candidate) return null
  try {
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate
  } catch {
    // No permission / race: fall back
  }
  return null
}

/**
 * Normalize cols/rows (xterm fit yields fractions; bad values fall back to 80x24, oversized ones
 * are clamped)
 */
export function clampPtySize(cols: unknown, rows: unknown): { cols: number; rows: number } {
  const rawCols = Number.isFinite(cols) ? Math.floor(Number(cols)) : 0
  const rawRows = Number.isFinite(rows) ? Math.floor(Number(rows)) : 0
  return {
    cols: rawCols > 0 ? Math.max(2, Math.min(500, rawCols)) : 80,
    rows: rawRows > 0 ? Math.max(2, Math.min(200, rawRows)) : 24
  }
}

export class PtyTerminalManager {
  private readonly sessions = new Map<string, PtyRecord>()
  private readonly spawnFn: typeof nodePtySpawn
  private readonly sweepTimer: NodeJS.Timeout

  /** Output event (the IPC layer may batch it before forwarding) */
  onData?: (sessionId: string, data: string) => void
  /** Exit event (exitCode=null means it was closed on purpose and has no exit code) */
  onExit?: (sessionId: string, exitCode: number | null) => void
  /** List changed (created/exited/closed) — used by the frontend to refresh tabs */
  onSessionsChanged?: () => void

  constructor(options: PtyTerminalManagerOptions = {}) {
    this.spawnFn = options.spawn ?? nodePtySpawn
    const sweepMs = options.idleSweepMs ?? 60_000
    this.sweepTimer = setInterval(() => this.sweepIdle(), sweepMs)
    this.sweepTimer.unref?.()
  }

  /** Open a new PTY session */
  open(input: {
    topicId: number
    cwd?: string
    shell?: PtyShellKind
    cols?: number
    rows?: number
  }): PtyOpenResult {
    const topicId = Number.isFinite(input.topicId) && input.topicId > 0 ? Math.floor(input.topicId) : 0
    const forTopic = [...this.sessions.values()].filter((record) => record.topicId === topicId)
    if (forTopic.length >= MAX_PTY_SESSIONS_PER_TOPIC) {
      return { ok: false, error: 'too-many-sessions' }
    }
    const { cols, rows } = clampPtySize(input.cols, input.rows)
    const shell = resolvePtyShell(input.shell)
    const cwd = resolvePtyCwd(input.cwd) ?? homedir()
    let ptyProcess: IPty
    try {
      ptyProcess = this.spawnFn(shell.file, shell.args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: {
          ...(globalThis.process.env as Record<string, string>),
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor'
        }
      })
    } catch (error) {
      return { ok: false, error: 'spawn-failed', detail: (error as Error).message }
    }

    const record: PtyRecord = {
      id: `pty-${randomUUID()}`,
      topicId,
      shell: shell.kind,
      cwd,
      cols,
      rows,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      alive: true,
      exitCode: null,
      process: ptyProcess,
      buffer: ''
    }
    this.sessions.set(record.id, record)

    ptyProcess.onData((data) => {
      record.lastUsedAt = Date.now()
      this.appendBuffer(record, data)
      this.onData?.(record.id, data)
    })
    ptyProcess.onExit(({ exitCode }) => {
      record.alive = false
      record.exitCode = exitCode
      this.onExit?.(record.id, exitCode)
      this.onSessionsChanged?.()
      // Keep it for 10 minutes after exit (the frontend can still show the last screen and clear
      // it with the close button), then reclaim
      const cleanup = setTimeout(() => this.sessions.delete(record.id), 10 * 60_000)
      cleanup.unref?.()
    })
    this.onSessionsChanged?.()
    return { ok: true, session: this.viewOf(record) }
  }

  /** Write keyboard input straight into the PTY (xterm onData as-is: Ctrl+C, arrows, paste) */
  write(sessionId: string, data: string): boolean {
    const record = this.sessions.get(sessionId)
    if (!record || !record.alive) return false
    record.lastUsedAt = Date.now()
    try {
      record.process.write(data)
      return true
    } catch {
      return false
    }
  }

  /** Terminal resized (xterm fit -> pty.resize) */
  resize(sessionId: string, cols: unknown, rows: unknown): boolean {
    const record = this.sessions.get(sessionId)
    if (!record || !record.alive) return false
    const size = clampPtySize(cols, rows)
    record.cols = size.cols
    record.rows = size.rows
    record.lastUsedAt = Date.now()
    try {
      record.process.resize(size.cols, size.rows)
      return true
    } catch {
      return false
    }
  }

  /** Close on purpose (killing the whole process tree is handled by node-pty kill) */
  close(sessionId: string): { ok: true; found: boolean } {
    const record = this.sessions.get(sessionId)
    if (!record) return { ok: true, found: false }
    this.sessions.delete(sessionId)
    try {
      record.process.kill()
    } catch {
      // Already exited: a throwing kill is harmless
    }
    record.alive = false
    this.onExit?.(sessionId, null)
    this.onSessionsChanged?.()
    return { ok: true, found: true }
  }

  closeTopic(topicId: number): void {
    for (const record of [...this.sessions.values()]) {
      if (record.topicId === topicId) this.close(record.id)
    }
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id)
  }

  list(topicId: number): PtySessionView[] {
    return [...this.sessions.values()]
      .filter((record) => record.topicId === topicId)
      .map((record) => this.viewOf(record))
  }

  /** Output replay (on tab switch / panel reopen, xterm writes this first, then goes live) */
  buffer(sessionId: string): string {
    return this.sessions.get(sessionId)?.buffer ?? ''
  }

  viewOf(record: PtyRecord): PtySessionView {
    return {
      sessionId: record.id,
      topicId: record.topicId,
      shell: record.shell,
      cwd: record.cwd,
      cols: record.cols,
      rows: record.rows,
      alive: record.alive,
      createdAt: record.createdAt,
      pid: record.process.pid
    }
  }

  private appendBuffer(record: PtyRecord, data: string): void {
    record.buffer += data
    if (record.buffer.length > PTY_BUFFER_CHARS) {
      record.buffer = record.buffer.slice(record.buffer.length - PTY_BUFFER_CHARS)
    }
  }

  private sweepIdle(): void {
    const now = Date.now()
    for (const record of [...this.sessions.values()]) {
      if (!record.alive) continue
      if (now - record.lastUsedAt > PTY_IDLE_TIMEOUT_MS) this.close(record.id)
    }
  }

  /** Diagnostics: number of currently active processes (for tests) */
  get activeCount(): number {
    return [...this.sessions.values()].filter((record) => record.alive).length
  }

  /** Global stats (start page / sidebar badge): active plus all retained session counts */
  stats(): { alive: number; total: number } {
    const all = [...this.sessions.values()]
    return { alive: all.filter((record) => record.alive).length, total: all.length }
  }
}

/** Process-level singleton (the IPC layer wires up onData/onExit) */
export const ptyTerminals = new PtyTerminalManager()
