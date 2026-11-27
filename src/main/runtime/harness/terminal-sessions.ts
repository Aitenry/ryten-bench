/**
 * 持久终端会话语义层：真正启动长驻 shell（pwsh / cmd / bash）并按完成标记切分输出。
 *
 * 安全边界（见 `docs/terminal-sandbox-design-2026-11.md`）：**只允许在
 * `danger-full-access` 档使用**——本模块不做任何隔离，与现有 `execute` 在完全权限档
 * 的行为一致；档位判断在工具层（`terminal-tools.ts`），这一层只管进程。
 *
 * 本模块**不 import electron / i18n**：错误以稳定代码返回，由工具层翻译；这样它也能被
 * esbuild 打进的 node 集成测试直接驱动（真实 shell，真开机）。
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

/** 每个话题允许的终端会话数 */
export const MAX_SESSIONS_PER_TOPIC = 3
/** 空闲多久自动关闭（毫秒） */
export const IDLE_TIMEOUT_MS = 10 * 60_000
/** `terminal_send` 默认等待时间与上限（毫秒） */
export const DEFAULT_WAIT_MS = 15_000
export const MAX_WAIT_MS = 60_000
/** 单条返回给模型的输出上限（字符） */
export const MAX_RESULT_CHARS = 50_000
/** 打开会话时等待 shell 就绪的上限 */
const INIT_WAIT_MS = 8_000

/** 稳定错误码（工具层翻译成界面语言） */
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
  /** 已清理 ANSI 的本轮输出 */
  output: string
  /** 等待超时（命令可能还在跑，需要 terminal_read 继续取） */
  timedOut: boolean
  /** 输出看起来是二进制（已省略正文） */
  binary: boolean
  /** 仍有未读输出（字符数） */
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

/** 会话管理结果（错误码与细节分开，便于工具层本地化） */
export type TerminalOpenResult =
  | { ok: true; session: TerminalSessionView; initOutput: string }
  | { ok: false; error: TerminalErrorCode; detail?: string }

/**
 * 进程级终端会话管理器。
 *
 * 会话按话题归属（topicId），最多 {@link MAX_SESSIONS_PER_TOPIC} 条；空闲上限
 * {@link IDLE_TIMEOUT_MS} 后由后台定时器回收；应用退出时由系统装配层调用 `closeAll`。
 */
export class TerminalSessionManager {
  private readonly sessions = new Map<string, SessionRecord>()
  private idleTimer: NodeJS.Timeout | null = null
  private pwshChecked = false
  private pwshAvailable = false

  /** pwsh（PowerShell 7+）是否可用（缓存探测结果） */
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

  /** 打开一个会话（供工具与测试使用） */
  async open(options: {
    topicId: number
    workspaceRoot: string
    cwd?: string
    shell?: TerminalShell
    /** 测试用：跳过 init 等待（默认不跳） */
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
      // 进程已退出时写入会报 EPIPE：交给 exit 处理，这里不抛出
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

    // 注入初始化命令（抑制提示符），并等它跑完，保证 open 返回后输出干净
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

  /** 发送一条命令并等待完成标记（或超时） */
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
      // TS 的控制流不知道 Promise executor 里同步赋过值，这里显式标注类型
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

  /** 读取会话自上次读取以来的增量输出 */
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
   * 只读快照（用户侧终端面板轮询用）：返回最近 maxChars 的合并输出，**不消费**未读缓冲，
   * 因此不会抢走模型 `terminal_read` 该读的内容；同时带回会话存活与 cwd 供面板展示。
   *
   * `raw: true` 时保留 ANSI 转义序列（xterm.js 前端要自己渲染颜色/光标控制）；
   * 模型侧 `read()` 与默认 peek 仍走 stripAnsi 的纯文本。
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

  /** 关闭一个会话（整树终止；幂等） */
  close(sessionId: string): { ok: true; found: boolean; exitCode: number | null } {
    const session = this.sessions.get(sessionId)
    if (!session) return { ok: true, found: false, exitCode: null }
    this.terminate(session)
    this.sessions.delete(sessionId)
    return { ok: true, found: true, exitCode: session.exitCode }
  }

  /** 列出某话题的会话 */
  list(topicId: number): TerminalSessionView[] {
    return [...this.sessions.values()]
      .filter((session) => session.topicId === topicId)
      .map((session) => this.viewOf(session))
  }

  /** 关闭某话题的全部会话（话题删除/切换时用） */
  closeTopic(topicId: number): void {
    for (const session of [...this.sessions.values()]) {
      if (session.topicId === topicId) this.close(session.id)
    }
  }

  /** 关闭全部会话（应用退出时用） */
  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id)
    if (this.idleTimer) {
      clearInterval(this.idleTimer)
      this.idleTimer = null
    }
  }

  /** 当前活跃会话总数（测试/诊断用） */
  get activeCount(): number {
    return this.sessions.size
  }

  /** 会话视图 */
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

  /** 输出到达：进环形缓冲 + 若有等待中的命令则尝试切出完成标记 */
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

  /** 清理 ANSI、尾部截断、空输出兜底 */
  private cleanOutput(text: string): string {
    const cleaned = stripAnsi(stripSentinelLines(text))
      .replace(/^\r?\n/, '')
      .replace(/\r/g, '')
    return truncateTail(cleaned, MAX_RESULT_CHARS).text
  }

  /** 跑初始化命令并等完成标记 */
  private runInit(
    session: SessionRecord,
    timeoutMs: number
  ): Promise<{ ok: true; output: string } | { ok: false; output: string }> {
    const sentinel = createSentinel(randomUUID())
    // cmd 在 stdin 是管道时只会在**第一条命令前**打印一次提示符（无换行），
    // 必须先用一条空 echo 收掉这一行，否则首条命令的完成标记会被拼到提示符后面。
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

  /** 整树终止 */
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
        // 忽略：进程可能已退出
      }
      return
    }
    try {
      session.child.kill('SIGKILL')
    } catch {
      // 同上
    }
  }

  /** 空闲回收定时器（60s 粒度） */
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

/** 进程级单例（工具层与系统退出清理共用） */
export const terminalSessions = new TerminalSessionManager()

/** 命令长度上限（供工具 schema 校验文案引用） */
export const TERMINAL_MAX_COMMAND_CHARS = MAX_COMMAND_CHARS
