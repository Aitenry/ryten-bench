import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { sandboxLog } from './log'
import { sandboxService } from './service'
import {
  SANDBOX_ESCALATION_HINT,
  SANDBOX_UNAVAILABLE_MARKER,
  SandboxUnavailableError,
  isRunnerFailure,
  isSandboxDenial,
  sandboxDenyMarker,
  type SandboxMode
} from './types'

/**
 * 受限执行 —— 把一条 shell 命令真正放进沙箱里跑。
 *
 * 与「沙箱服务 + 工具层」的分工：service 负责「怎么隔离」，这里负责「怎么跑、怎么判读结果」：
 *  - `danger-full-access` 档位不隔离（档位语义就是「不拦」），直接跑；
 *  - 其余档位一律经 `sandboxService.confine()` 包装；拿不到后端 → **不执行**并返回
 *    `SANDBOX_UNAVAILABLE_MARKER`（故障关闭，绝不静默放行）；
 *  - 退出后判读输出：先排除「后端自己坏了」（runnerFailure），再识别「沙箱把写拒了」
 *    （denialSignatures）→ 附上拒绝标记与升权提示，让模型知道可以申请一次人工提权。
 *
 * 超时/取消：kill 掉 runner 即可——Windows runner 把子进程放进了 kill-on-close 的
 * Job Object，runner 一死整棵子树就被系统清理；Linux/macOS 的启动器是 exec 替换，
 * kill 到的就是命令本身。
 */

/** 单次执行的结果 */
export interface ConfinedRunResult {
  /** 命令退出码（沙箱未执行时为 null） */
  exitCode: number | null
  /** 合并后的输出（stdout + stderr，已按上限截断） */
  output: string
  /** 沙箱拒绝了这次写入/操作 */
  denied: boolean
  /** 沙箱不可用（命令没跑） */
  unavailable?: string
  /** 后端自身失败（命令没跑） */
  runnerFailure?: string
  /** 超时被终止 */
  timedOut: boolean
}

export interface ConfinedRunOptions {
  command: string
  mode: SandboxMode
  workspaceRoot?: string
  /** 输出上限（字符） */
  maxChars: number
  /** 超时（毫秒） */
  timeoutMs: number
  signal?: AbortSignal
  /** 平台覆盖（工装用） */
  platform?: string
}

/** 组装「把这段字符串交给系统 shell」的 argv（保持 execute 工具原有的 shell 语义） */
export function shellArgv(command: string, platform: string = process.platform): string[] {
  return platform === 'win32' ? ['cmd.exe', '/d', '/s', '/c', command] : ['/bin/sh', '-c', command]
}

/** 执行并收集输出（带超时、取消、输出上限） */
function runProcess(
  argv: readonly string[],
  options: {
    cwd?: string
    env: NodeJS.ProcessEnv
    timeoutMs: number
    maxChars: number
    signal?: AbortSignal
  }
): Promise<{ exitCode: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const [program, ...args] = argv
    // stdio[0] = 'ignore'：子进程的 stdin 是 null（沙箱命令不接受交互输入）
    let child: ChildProcessByStdio<null, Readable, Readable>
    try {
      child = spawn(program, args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      resolve({
        exitCode: null,
        output: error instanceof Error ? error.message : String(error),
        timedOut: false
      })
      return
    }

    let output = ''
    let truncated = false
    let timedOut = false

    const append = (chunk: Buffer): void => {
      if (truncated) return
      const text = chunk.toString('utf8')
      if (output.length + text.length > options.maxChars) {
        output += text.slice(0, Math.max(0, options.maxChars - output.length))
        truncated = true
        return
      }
      output += text
    }

    child.stdout.on('data', append)
    child.stderr.on('data', append)

    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill()
      } catch {
        // 进程可能已经退出
      }
    }, options.timeoutMs)

    const onAbort = (): void => {
      try {
        child.kill()
      } catch {
        // 同上
      }
    }
    if (options.signal) {
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }

    const finish = (exitCode: number | null): void => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      resolve({ exitCode, output, timedOut })
    }

    child.on('error', (error) => {
      output += `\n${error.message}`
      finish(null)
    })
    child.on('close', (code) => finish(code))
  })
}

/**
 * 在沙箱里执行一条 shell 命令。
 *
 * @returns 结果（含「是否被沙箱拒绝」「沙箱是否不可用」等信号，供工具层拼装给模型的文本）
 */
export async function runConfinedShell(options: ConfinedRunOptions): Promise<ConfinedRunResult> {
  const platform = options.platform ?? process.platform
  const argv = shellArgv(options.command, platform)
  const baseEnv: NodeJS.ProcessEnv = { ...process.env }

  // 完全权限：档位语义就是「不隔离」，直接跑
  if (options.mode === 'danger-full-access') {
    const result = await runProcess(argv, {
      cwd: options.workspaceRoot,
      env: baseEnv,
      timeoutMs: options.timeoutMs,
      maxChars: options.maxChars,
      signal: options.signal
    })
    return {
      exitCode: result.exitCode,
      output: result.output,
      denied: false,
      timedOut: result.timedOut
    }
  }

  let confined
  try {
    confined = sandboxService.confine(argv, {
      mode: options.mode,
      workspaceRoot: options.workspaceRoot ?? process.cwd()
    })
  } catch (error) {
    if (error instanceof SandboxUnavailableError) {
      sandboxLog.warn(`[Sandbox] 命令未执行（无可用沙箱）：${error.reason}`)
      return {
        exitCode: null,
        output: '',
        denied: false,
        unavailable: error.reason,
        timedOut: false
      }
    }
    throw error
  }

  const result = await runProcess(confined.argv, {
    cwd: options.workspaceRoot,
    env: { ...baseEnv, ...(confined.env ?? {}) },
    timeoutMs: options.timeoutMs,
    maxChars: options.maxChars,
    signal: options.signal
  })

  const combined = result.output
  // 先排除「后端自己坏了」：它的诊断里也可能出现 denial 词，不能误判成拒绝
  if (isRunnerFailure(combined, result.exitCode, confined.runnerFailure)) {
    sandboxLog.warn(`[Sandbox] 后端自身失败（${confined.backend}）：${combined.slice(0, 400)}`)
    return {
      exitCode: result.exitCode,
      output: combined,
      denied: false,
      runnerFailure: combined.trim() || `backend ${confined.backend} failed`,
      timedOut: result.timedOut
    }
  }
  const denied =
    result.exitCode !== 0 &&
    isSandboxDenial(combined, confined.denialSignatures) &&
    !result.timedOut
  return { exitCode: result.exitCode, output: combined, denied, timedOut: result.timedOut }
}

/** 把「被沙箱拒绝」翻译成给模型看的文本（附协议标记与升权提示） */
export function sandboxDenialText(mode: SandboxMode, body: string): string {
  return `${body}\n${sandboxDenyMarker(mode)}\n${SANDBOX_ESCALATION_HINT}`
}

/** 「沙箱不可用」文本（命令没有执行——绝不能让模型以为它跑了） */
export function sandboxUnavailableText(reason: string): string {
  return `${SANDBOX_UNAVAILABLE_MARKER} ${reason}`
}
