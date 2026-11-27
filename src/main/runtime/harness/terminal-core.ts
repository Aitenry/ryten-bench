/**
 * 持久终端的**纯逻辑核心**（无 electron / 无子进程，可离线测试）。
 *
 * 设计见 `docs/terminal-sandbox-design-2026-11.md`。这一层只负责「怎么把命令变成一段可切分的
 * 文本、怎么把输出流按完成标记切开、怎么有界地缓存与读取」；真正的进程与会话管理在
 * `terminal-sessions.ts`。把纯逻辑独立出来，是为了让这些容易出错的边界（跨 chunk 半行、
 * ANSI 转义、洪泛输出、二进制垃圾）都能用单测钉住，而不必启动 shell。
 */

/** 单条命令的最大字符数（防止一次写入超大脚本） */
export const MAX_COMMAND_CHARS = 8_000
/** 单次 `terminal_read` / 返回给模型的输出上限 */
export const MAX_OUTPUT_CHARS_PER_READ = 50_000
/** 每条会话的未读输出环形缓冲上限（字节近似 = 字符） */
export const RING_CAPACITY_CHARS = 256 * 1024

/** 会话使用的 shell 种类 */
export type TerminalShell = 'pwsh' | 'cmd' | 'sh'

/** 启动一种 shell 所需的完整描述 */
export interface ShellSpec {
  kind: TerminalShell
  /** 可执行文件（Windows 用 .exe 全名，避免 PATH 解析歧义） */
  command: string
  args: string[]
  /** 会话建立后先注入的命令（抑制提示符等） */
  initCommands: string[]
  /** 命令行分隔符：cmd 用 CRLF，其它用 LF */
  newline: '\n' | '\r\n'
}

/**
 * 选择 shell：Windows 优先 PowerShell 7+（若已安装），否则 cmd；POSIX 用 bash。
 *
 * `pwshAvailable` 由会话层探测（`spawn` 一次 `pwsh -v`），这里只做纯决策，便于测试。
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

/** 生成一条命令的完成标记（每轮随机，避免与命令输出碰撞） */
export function createSentinel(nonce: string): string {
  const safe = nonce.replace(/[^a-zA-Z0-9]/g, '').slice(0, 32) || 'x'
  return `__RB_DONE_${safe}__`
}

/**
 * 把一条用户命令拼成「命令 + 完成标记」的写入串。
 *
 * 完成标记单独占一行：命令无论成功失败（甚至语法错误）最后都会执行到 `echo`，
 * 读取侧据此判断这一轮结束；不能用退出码——持久 shell 没有「本次命令的退出码」。
 */
export function buildCommandLine(command: string, sentinel: string, shell: ShellSpec): string {
  const body = command.replace(/\r\n/g, '\n').replace(/\n$/, '')
  return `${body}${shell.newline}echo ${sentinel}${shell.newline}`
}

/** 命令规范化：空/超长/含 NUL 拒绝；多行命令保留（按行执行） */
export function normalizeCommand(
  raw: string
): { ok: true; command: string } | { ok: false; reason: 'empty' | 'too-long' | 'nul' } {
  if (typeof raw !== 'string' || raw.trim().length === 0) return { ok: false, reason: 'empty' }
  if (raw.includes('\u0000')) return { ok: false, reason: 'nul' }
  // 只清掉整个命令末尾的空白（含换行）；**行内**空白不动——可能是字符串字面量的一部分
  const command = raw.replace(/\r\n/g, '\n').replace(/\s+$/, '')
  if (command.length > MAX_COMMAND_CHARS) return { ok: false, reason: 'too-long' }
  return { ok: true, command }
}

/** 清理 ANSI 转义（颜色、光标控制、OSC 标题等），保留可读文本 */
export function stripAnsi(text: string): string {
  return text
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[@-Z\\-_]/g, '')
}

/**
 * 在一段缓冲里找完成标记行。
 *
 * 只认**整行精确匹配**（允许行尾 `\r`）：命令输出里碰巧出现标记文本也不会误切。
 * 返回标记之前的输出与标记之后的剩余（下一条命令的输出）。
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
 * 粗略判断输出是否像二进制。
 *
 * 编译产物/压缩包等直接塞进上下文既浪费预算又无意义；控制字符（除换行/回车/制表）
 * 比例超过 30% 或出现 NUL 即视为二进制。
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
 * 有界的输出环形缓冲。
 *
 * `push` 写入新输出（超容量丢最旧），`drain` 一次性取走未读输出并清空游标。
 * 丢弃的字节数单独累计，返回给模型时能说明「有输出被挤掉了」。
 */
export class OutputRing {
  private chunks: string[] = []
  private size = 0
  private droppedChars = 0
  private readonly capacity: number

  constructor(capacity: number = RING_CAPACITY_CHARS) {
    this.capacity = Math.max(1, Math.floor(capacity))
  }

  /** 写入一段输出（通常是 stdout/stderr 的 chunk）；超过容量时保留最新内容 */
  push(text: string): void {
    if (!text) return
    this.chunks.push(text)
    this.size += text.length
    if (this.size <= this.capacity) return
    // 统一按「保留最后 capacity 个字符」裁剪：单块超长与多块累积都能精确处理
    const joined = this.chunks.join('')
    const keep = joined.slice(-this.capacity)
    this.droppedChars += joined.length - keep.length
    this.chunks = [keep]
    this.size = keep.length
  }

  /** 当前未读字符数 */
  get unreadChars(): number {
    return this.size
  }

  /** 累计被挤掉的字符数（清零前单调递增） */
  get dropped(): number {
    return this.droppedChars
  }

  /** 取走未读输出（最多 maxChars；超出的留在缓冲里等下次读） */
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
      // 把没取走的部分放回缓冲（保持未读语义）
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

  /** 丢弃全部未读输出（关闭会话/清屏用） */
  clear(): void {
    this.chunks = []
    this.size = 0
    this.droppedChars = 0
  }

  /**
   * 只读快照：取最近 maxChars 字符，**不消费未读输出**。
   *
   * 用户侧终端面板靠轮询刷新输出；如果复用 `drain`，面板会把模型 `terminal_read` 该读的
   * 内容提前吃掉。这里按「尾部 N 字符」返回，既不移动游标也不重置 dropped 计数。
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

/** 输出截断（返回尾部：命令报错通常在最后） */
export function truncateTail(text: string, maxChars: number): { text: string; truncated: boolean } {
  const limit = Math.max(1, Math.floor(maxChars))
  if (text.length <= limit) return { text, truncated: false }
  return { text: `…（前 ${text.length - limit} 字符已省略）\n${text.slice(-limit)}`, truncated: true }
}

/**
 * 去掉输出里残留的完成标记行。
 *
 * `terminal_send` 正常会切掉当轮的标记，但超时/迟到的情况下旧标记会留在环形缓冲里；
 * `terminal_read` 展示前统一清掉，避免把内部协议文本喂给模型。
 */
export function stripSentinelLines(text: string): string {
  return text.replace(/^__RB_DONE_[A-Za-z0-9]+__\r?$/gm, '')
}
