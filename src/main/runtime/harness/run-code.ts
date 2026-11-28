/**
 * `run_code` (PTC: programmatic tool calling) execution core.
 *
 * The model writes **JavaScript** that runs in an isolated `node:vm` context; through the injected
 * `tools` object it calls **read-only tools** as `await tools.read_file({ file_path: '/x' })`, so a
 * single call can loop/filter/aggregate and skip many back-and-forth tool rounds.
 *
 * Security boundary (important): `node:vm` is **not a security boundary** (context escapes are a
 * known issue). Therefore:
 * - the tool layer only allows `run_code` in the `danger-full-access` mode (same rule as the
 *   persistent terminal);
 * - the bridge exposes read-only tools only (`tools` contains no write/execute tools);
 * - there is a synchronous time limit (against infinite loops), an overall time limit,
 *   output/log caps and a tool-call cap.
 *
 * This module depends only on the built-in `vm` module and can be driven directly by offline
 * tests.
 */
import * as vm from 'node:vm'

/** Code length cap for a single run_code */
export const RUN_CODE_MAX_CHARS = 20_000
/** Overall execution time limit (including async waits) */
export const RUN_CODE_TIMEOUT_MS = 120_000
/** Synchronous code time limit (stops `while(true){}` from freezing the main thread) */
export const RUN_CODE_SYNC_TIMEOUT_MS = 5_000
/** Cap on the serialized return value */
export const RUN_CODE_RESULT_MAX_CHARS = 50_000
/** Total log cap */
export const RUN_CODE_LOG_MAX_CHARS = 20_000
/** Tool-call cap per execution (stops infinite loops from hammering tools/network) */
export const RUN_CODE_MAX_TOOL_CALLS = 200

/** Tools bridged into the sandbox: takes an args object, returns any value (tool layer validates) */
export type RunCodeBridge = Record<string, (args: Record<string, unknown>) => Promise<unknown> | unknown>

export interface RunCodeOutput {
  ok: boolean
  /** Captured console.* output (already truncated to the cap) */
  logs: string
  /** Serialized return value (JSON preferred, already truncated to the cap) */
  result: string
  /** Failure reason (user-readable; host path stack removed) */
  error?: string
  /** Overall timeout (async never finishes / synchronous timeout) */
  timedOut: boolean
  /** Pre-check failure such as empty or too-long code */
  failure?: 'empty' | 'too-long'
  durationMs: number
  /** Number of tool calls actually made */
  toolCalls: number
  /** Whether the return value was truncated */
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

/** Turn any value into displayable text (handles circular references / big objects) */
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

/** Turn console arguments into one line of text */
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

/** Extract error info (message plus the first stack frame, no host absolute-path details) */
function errorText(error: unknown): string {
  if (error instanceof Error) {
    const firstFrame = (error.stack ?? '').split('\n').find((line) => line.includes('run_code.js'))
    return firstFrame ? `${error.message} (${firstFrame.trim()})` : error.message
  }
  return String(error)
}

/**
 * Execute a snippet of model-written JS.
 *
 * Convention: write statements directly in the body and `return` the result at the end; the whole
 * body is wrapped in an async IIFE so tool calls can be awaited.
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

  // ── Log collection (capped; once exceeded only the drop is recorded) ───────────────
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

  // ── Tool bridge (rejects calls after close; tool-call cap) ──────────────────────────
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
    // Allow bounded waiting (still subject to the overall time limit)
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
        // Do not unref: this timer is the only basis for timeout detection; after unref, once the
        // event loop drains the process exits with an unsettled top-level await (Node exit 13)
        timeoutTimer = setTimeout(() => reject(new Error('run_code: timeout')), timeoutMs)
      })
    ])
  } catch (error) {
    const message = errorText(error)
    if (/timeout|timed out/i.test(message)) timedOut = true
    else errorMessage = message
  } finally {
    // If the result arrives first, clear the timeout timer or it holds an event-loop handle for
    // up to 2 minutes
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
