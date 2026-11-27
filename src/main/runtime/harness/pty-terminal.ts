/**
 * 用户侧**真终端**会话（node-pty + xterm.js）。
 *
 * 与模型侧 `terminal_*` 的行模式会话（terminal-sessions.ts）**刻意分开**：
 * - 行模式那套为工具调用设计（发送命令 → 完成标记切分 → 返回文本），没有 TTY；
 * - 这里给人类用：真 PTY，有回声、真实 prompt、Ctrl+C、颜色、列宽、全屏程序（vim/top）。
 *
 * 本模块不 import electron / i18n（可被 node 单测直接驱动）；事件通过 `onData` /
 * `onExit` 回调交给 IPC 层转发。node-pty 1.1 自带 N-API 预编译产物（不依赖 Electron ABI）。
 */
import { spawn as nodePtySpawn, type IPty } from 'node-pty'
import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'

/** 每个话题允许的终端会话数（与行模式一致） */
export const MAX_PTY_SESSIONS_PER_TOPIC = 3
/** 空闲多久自动关闭（毫秒） */
export const PTY_IDLE_TIMEOUT_MS = 30 * 60_000
/** 每个会话保留的输出回放上限（字符） */
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
  /** 测试注入：默认 node-pty 的 spawn */
  spawn?: typeof nodePtySpawn
  /** 测试注入：默认 60s 巡检一次空闲会话 */
  idleSweepMs?: number
}

/** 平台默认 shell（可强制指定；找不到可执行文件时由 spawn 抛错→spawn-failed） */
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

/** cwd 归一：必须是已存在目录，否则回落到主目录 */
export function resolvePtyCwd(cwd: string | undefined): string | null {
  const candidate = typeof cwd === 'string' && cwd.trim() ? cwd.trim() : ''
  if (!candidate) return null
  try {
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate
  } catch {
    // 无权限/竞态：回落
  }
  return null
}

/** 列宽/行数归一（xterm fit 给的是小数；异常值回落到 80x24，过大的夹到安全上限） */
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

  /** 输出事件（IPC 层可做批处理后再转发） */
  onData?: (sessionId: string, data: string) => void
  /** 退出事件（exitCode=null 表示被主动关闭时没有退出码） */
  onExit?: (sessionId: string, exitCode: number | null) => void
  /** 列表变化（新建/退出/关闭）——前端刷新页签用 */
  onSessionsChanged?: () => void

  constructor(options: PtyTerminalManagerOptions = {}) {
    this.spawnFn = options.spawn ?? nodePtySpawn
    const sweepMs = options.idleSweepMs ?? 60_000
    this.sweepTimer = setInterval(() => this.sweepIdle(), sweepMs)
    this.sweepTimer.unref?.()
  }

  /** 新建 PTY 会话 */
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
      // 退出后保留 10 分钟（前端还能看到最后一屏并用关闭按钮清理），再回收
      const cleanup = setTimeout(() => this.sessions.delete(record.id), 10 * 60_000)
      cleanup.unref?.()
    })
    this.onSessionsChanged?.()
    return { ok: true, session: this.viewOf(record) }
  }

  /** 键盘输入原样写入 PTY（xterm onData 直接转发，含 Ctrl+C、方向键、粘贴） */
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

  /** 终端尺寸变化（xterm fit → pty.resize） */
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

  /** 主动关闭（杀掉整棵进程树由 node-pty kill 处理） */
  close(sessionId: string): { ok: true; found: boolean } {
    const record = this.sessions.get(sessionId)
    if (!record) return { ok: true, found: false }
    this.sessions.delete(sessionId)
    try {
      record.process.kill()
    } catch {
      // 已退出：kill 抛错无所谓
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

  /** 输出回放（切页签/重开面板时 xterm 先写这份再续实时流） */
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

  /** 诊断：当前活跃进程数（测试用） */
  get activeCount(): number {
    return [...this.sessions.values()].filter((record) => record.alive).length
  }

  /** 全局统计（开始页/侧栏角标用）：活跃 + 全部保留中的会话数 */
  stats(): { alive: number; total: number } {
    const all = [...this.sessions.values()]
    return { alive: all.filter((record) => record.alive).length, total: all.length }
  }
}

/** 进程级单例（IPC 层接线 onData/onExit） */
export const ptyTerminals = new PtyTerminalManager()
