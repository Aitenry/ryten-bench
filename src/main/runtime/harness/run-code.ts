/**
 * `run_code`（PTC：programmatic tool calling）执行核心。
 *
 * 模型写一段 **JavaScript**，在 `node:vm` 隔离上下文里运行；代码通过注入的
 * `tools` 对象以 `await tools.read_file({ file_path: '/x' })` 的形式调用**只读工具**，
 * 一次调用就能做循环/过滤/聚合，省掉来回多轮工具调用。
 *
 * 安全边界（重要）：`node:vm` **不是安全边界**（上下文逃逸是已知问题）。因此：
 * - 工具层只在 `danger-full-access` 档放行 `run_code`（与持久终端同一规则）；
 * - 桥接只暴露只读工具（`tools` 里没有写/执行类工具）；
 * - 有同步时限（防死循环）、整体时限、输出/日志上限与工具调用上限。
 *
 * 本模块只依赖 node 内置模块（`vm`），可被离线测试直接驱动。
 */
import * as vm from 'node:vm'

/** 单次 run_code 的代码长度上限 */
export const RUN_CODE_MAX_CHARS = 20_000
/** 整体执行时限（含异步等待） */
export const RUN_CODE_TIMEOUT_MS = 120_000
/** 同步代码时限（防 `while(true){}` 把主线程卡死） */
export const RUN_CODE_SYNC_TIMEOUT_MS = 5_000
/** 返回值序列化后的上限 */
export const RUN_CODE_RESULT_MAX_CHARS = 50_000
/** 日志总上限 */
export const RUN_CODE_LOG_MAX_CHARS = 20_000
/** 单次执行的工具调用上限（防止无限循环打爆工具/网络） */
export const RUN_CODE_MAX_TOOL_CALLS = 200

/** 桥接给沙箱的工具：参数对象进，任意值出（工具层负责校验） */
export type RunCodeBridge = Record<string, (args: Record<string, unknown>) => Promise<unknown> | unknown>

export interface RunCodeOutput {
  ok: boolean
  /** console.* 收集（已按上限截断） */
  logs: string
  /** 返回值序列化（JSON 优先，已按上限截断） */
  result: string
  /** 失败原因（用户可读；已去掉宿主路径栈） */
  error?: string
  /** 整体超时（异步一直不结束 / 同步超时） */
  timedOut: boolean
  /** 代码长度/语法等前置校验失败 */
  failure?: 'empty' | 'too-long'
  durationMs: number
  /** 实际发生的工具调用次数 */
  toolCalls: number
  /** 返回值是否被截断 */
  truncated: boolean
}

export interface ExecuteRunCodeOptions {
  code: string
  tools?: RunCodeBridge
  timeoutMs?: number
  syncTimeoutMs?: number
  maxResultChars?: number
  maxLogChars?: number
  maxToolCalls?: number
}

/** 把任意值转成可展示文本（处理循环引用/大对象） */
export function serializeValue(value: unknown, maxChars: number): { text: string; truncated: boolean } {
  if (value === undefined) return { text: '', truncated: false }
  let text: string
  try {
    const json = JSON.stringify(value, null, 2)
    text = typeof json === 'string' ? json : String(value)
  } catch {
    try {
      text = String(value)
    } catch {
      text = '[unserializable value]'
    }
  }
  if (text.length <= maxChars) return { text, truncated: false }
  return { text: text.slice(0, maxChars), truncated: true }
}

/** 把 console 参数转成一行文本 */
function formatConsoleArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg
      try {
        return JSON.stringify(arg)
      } catch {
        return String(arg)
      }
    })
    .join(' ')
}

/** 提取错误信息（只要 message + 首行栈，不带宿主绝对路径细节） */
function errorText(error: unknown): string {
  if (error instanceof Error) {
    const firstFrame = (error.stack ?? '').split('\n').find((line) => line.includes('run_code.js'))
    return firstFrame ? `${error.message} (${firstFrame.trim()})` : error.message
  }
  return String(error)
}

/**
 * 执行一段模型写的 JS。
 *
 * 约定：代码体直接写语句，最后用 `return` 返回结果；整个代码体被包成 async IIFE，
 * 因此可以 `await` 工具调用。
 */
export async function executeRunCode(options: ExecuteRunCodeOptions): Promise<RunCodeOutput> {
  const startedAt = Date.now()
  const code = (options.code ?? '').replace(/\r\n/g, '\n')
  const maxResultChars = Math.max(1, Math.floor(options.maxResultChars ?? RUN_CODE_RESULT_MAX_CHARS))
  const maxLogChars = Math.max(1, Math.floor(options.maxLogChars ?? RUN_CODE_LOG_MAX_CHARS))
  const maxToolCalls = Math.max(1, Math.floor(options.maxToolCalls ?? RUN_CODE_MAX_TOOL_CALLS))
  const timeoutMs = Math.max(100, Math.floor(options.timeoutMs ?? RUN_CODE_TIMEOUT_MS))
  const syncTimeoutMs = Math.max(50, Math.floor(options.syncTimeoutMs ?? RUN_CODE_SYNC_TIMEOUT_MS))

  if (code.trim().length === 0) {
    return {
      ok: false,
      logs: '',
      result: '',
      failure: 'empty',
      timedOut: false,
      durationMs: 0,
      toolCalls: 0,
      truncated: false
    }
  }
  if (code.length > RUN_CODE_MAX_CHARS) {
    return {
      ok: false,
      logs: '',
      result: '',
      failure: 'too-long',
      timedOut: false,
      durationMs: 0,
      toolCalls: 0,
      truncated: false
    }
  }

  // ── 日志收集（有上限，超出后只记丢弃量） ──────────────────────────
  const logLines: string[] = []
  let logChars = 0
  let logsTruncated = false
  const capture = (level: string) => (...args: unknown[]) => {
    const line = level === 'log' || level === 'info' ? formatConsoleArgs(args) : `[${level}] ${formatConsoleArgs(args)}`
    if (logChars + line.length + 1 > maxLogChars) {
      if (!logsTruncated) {
        logChars += 1
        logLines.push(`…（日志超过 ${maxLogChars} 字符，后续省略）`)
        logsTruncated = true
      }
      return
    }
    logChars += line.length + 1
    logLines.push(line)
  }

  // ── 工具桥（闭合后拒绝再调用；有调用次数上限） ────────────────────
  let closed = false
  let toolCalls = 0
  const bridge: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {}
  for (const [name, fn] of Object.entries(options.tools ?? {})) {
    bridge[name] = async (args: Record<string, unknown> = {}) => {
      if (closed) throw new Error(`run_code: execution already finished (tool "${name}" ignored)`)
      if (toolCalls >= maxToolCalls) {
        throw new Error(`run_code: tool call limit reached (${maxToolCalls})`)
      }
      toolCalls += 1
      return fn(args)
    }
  }

  const sandbox: Record<string, unknown> = {
    console: {
      log: capture('log'),
      info: capture('info'),
      warn: capture('warn'),
      error: capture('error'),
      debug: capture('debug')
    },
    tools: bridge,
    // 允许有限等待（仍受整体时限约束）
    setTimeout: (fn: () => void, ms?: number) =>
      setTimeout(fn, Math.max(0, Math.min(Number(ms) || 0, 5_000))),
    clearTimeout
  }

  const context = vm.createContext(sandbox)
  let result: unknown
  let timedOut = false
  let errorMessage: string | undefined
  let timeoutTimer: NodeJS.Timeout | undefined
  try {
    const script = new vm.Script(`(async () => {\n${code}\n})()`, { filename: 'run_code.js' })
    const pending = script.runInContext(context, { timeout: syncTimeoutMs }) as Promise<unknown>
    result = await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        // 不能 unref：这个定时器是超时判定的唯一依据，unref 后事件循环一空
        // 进程会带着未结算的 top-level await 直接退出（Node exit 13）
        timeoutTimer = setTimeout(() => reject(new Error('run_code: timeout')), timeoutMs)
      })
    ])
  } catch (error) {
    const message = errorText(error)
    if (/timeout|timed out/i.test(message)) timedOut = true
    else errorMessage = message
  } finally {
    // 结果先到时要清掉超时定时器，否则它会白占一个事件循环句柄（最长 2 分钟）
    if (timeoutTimer) clearTimeout(timeoutTimer)
    closed = true
  }

  const serialized = serializeValue(result, maxResultChars)
  return {
    ok: !timedOut && errorMessage === undefined,
    logs: logLines.join('\n'),
    result: serialized.text,
    error: errorMessage,
    timedOut,
    durationMs: Date.now() - startedAt,
    toolCalls,
    truncated: serialized.truncated
  }
}
