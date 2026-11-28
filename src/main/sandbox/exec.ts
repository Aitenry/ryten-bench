import { spawn, type ChildProcess, type ChildProcessByStdio } from 'node:child_process'
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
 * Confined execution — actually run one shell command inside the sandbox.
 *
 * Division of labor with the sandbox service and tool layer: the service decides "how to
 * isolate", this module decides "how to run and how to interpret the result":
 *  - The `danger-full-access` mode is not isolated (its meaning is "do not block"), so it runs
 *    directly;
 *  - Every other mode is wrapped by `sandboxService.confine()`; if no backend is available the
 *    command is **not executed** and `SANDBOX_UNAVAILABLE_MARKER` is returned (fail closed, never
 *    silently allow);
 *  - After exit the output is interpreted: first rule out "the backend itself broke"
 *    (runnerFailure), then detect "the sandbox denied the write" (denialSignatures) → attach the
 *    denial marker and the escalation hint so the model knows it may request a one-off manual
 *    escalation.
 *
 * Timeout/cancel: killing the runner is enough — the Windows runner puts child processes into a
 * kill-on-close Job Object, so the whole subtree is cleaned up by the system when the runner
 * dies; on Linux/macOS the launcher is an exec replacement, so the kill hits the command itself.
 * `danger-full-access` does not go through the runner and is terminated by process tree instead
 * (see terminateChild; a background job's "stop" must really stop the dev server's descendants).
 */

/** Result of a single execution */
export interface ConfinedRunResult {
  /** Command exit code (null when the sandbox did not execute it) */
  exitCode: number | null
  /** Combined output (stdout + stderr, truncated to the limit) */
  output: string
  /** The sandbox denied this write/operation */
  denied: boolean
  /** Sandbox unavailable (the command did not run) */
  unavailable?: string
  /** Backend failure (the command did not run) */
  runnerFailure?: string
  /** Terminated by timeout */
  timedOut: boolean
}

export interface ConfinedRunOptions {
  command: string
  mode: SandboxMode
  workspaceRoot?: string
  /** Output limit (characters) */
  maxChars: number
  /** Timeout (ms); 0 = no timeout (used by background jobs: a dev server must keep running) */
  timeoutMs: number
  signal?: AbortSignal
  /**
   * Output delta callback (used by background jobs): called once for each stdout/stderr chunk.
   *
   * Independent of the cumulative `maxChars` truncation: background jobs keep writing the command
   * log to the job registry (viewed via job_output / the top bar), while denial / runnerFailure
   * detection still only looks at the first `maxChars` window. Foreground calls pass nothing and
   * behave exactly as before.
   */
  onOutput?: (chunk: string) => void
  /** Platform override (for tooling) */
  platform?: string
}

/** Build the argv handing the string to the system shell (keeping the original shell semantics) */
export function shellArgv(command: string, platform: string = process.platform): string[] {
  return platform === 'win32' ? ['cmd.exe', '/d', '/s', '/c', command] : ['/bin/sh', '-c', command]
}

/**
 * Terminate one execution (including descendant processes).
 *
 * On Windows, execute really runs `cmd.exe /c <command>`: commands such as npm/pnpm spawn their
 * own node child processes, so killing only the direct child leaves orphans holding the port —
 * the user pressed "stop" but the dev server keeps running (especially visible for background
 * jobs). Windows therefore uses `taskkill /T /F` to kill the whole tree, while other platforms
 * keep the `child.kill()` (SIGTERM) semantics.
 *
 * If taskkill itself fails (trimmed-down system, extreme permissions), fall back to
 * `child.kill()`: at least the pending Promise can settle; a failing cleanup must never wedge a
 * tool call forever.
 */
function terminateChild(child: ChildProcess): void {
  if (process.platform === 'win32' && typeof child.pid === 'number') {
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      })
      killer.on('error', () => {
        try {
          child.kill()
        } catch {
          // The process may have exited already
        }
      })
      killer.on('close', (code) => {
        if (code !== 0) {
          try {
            child.kill()
          } catch {
            // Same as above
          }
        }
      })
      killer.unref()
      return
    } catch {
      // Fall through to the direct kill below
    }
  }
  try {
    child.kill()
  } catch {
    // The process may have exited already
  }
}

/** Run and collect output (with timeout, cancellation, and output limit) */
function runProcess(
  argv: readonly string[],
  options: {
    cwd?: string
    env: NodeJS.ProcessEnv
    timeoutMs: number
    maxChars: number
    signal?: AbortSignal
    /** Output delta callback (see ConfinedRunOptions.onOutput) */
    onOutput?: (chunk: string) => void
  }
): Promise<{ exitCode: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const [program, ...args] = argv
    // stdio[0] = 'ignore': the child's stdin is null (commands accept no interactive input)
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
      const text = chunk.toString('utf8')
      // Hand the chunk to the delta consumer first (background jobs keep it under their own
      // limit), then apply accumulation/truncation: maxChars caps "the result the model sees",
      // not the background job log.
      options.onOutput?.(text)
      if (truncated) return
      if (output.length + text.length > options.maxChars) {
        output += text.slice(0, Math.max(0, options.maxChars - output.length))
        truncated = true
        return
      }
      output += text
    }

    child.stdout.on('data', append)
    child.stderr.on('data', append)

    // timeoutMs <= 0 = no timeout (background jobs); setTimeout(0) fires immediately, so 0 cannot
    // be passed through
    let timer: NodeJS.Timeout | undefined
    if (options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        terminateChild(child)
      }, options.timeoutMs)
    }

    const onAbort = (): void => {
      terminateChild(child)
    }
    if (options.signal) {
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }

    const finish = (exitCode: number | null): void => {
      if (timer) clearTimeout(timer)
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
 * Run one shell command in the sandbox.
 *
 * @returns the result (including signals such as "denied by the sandbox" and "sandbox
 * unavailable", used by the tool layer to compose the text shown to the model)
 */
export async function runConfinedShell(options: ConfinedRunOptions): Promise<ConfinedRunResult> {
  const platform = options.platform ?? process.platform
  const argv = shellArgv(options.command, platform)
  const baseEnv: NodeJS.ProcessEnv = { ...process.env }

  // Full access: the mode means "no isolation", so run directly
  if (options.mode === 'danger-full-access') {
    const result = await runProcess(argv, {
      cwd: options.workspaceRoot,
      env: baseEnv,
      timeoutMs: options.timeoutMs,
      maxChars: options.maxChars,
      signal: options.signal,
      onOutput: options.onOutput
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
      sandboxLog.warn(`[Sandbox] Command not executed (no sandbox available): ${error.reason}`)
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
    signal: options.signal,
    onOutput: options.onOutput
  })

  const combined = result.output
  // Rule out "the backend itself broke" first: its diagnostics may contain denial words, so do
  // not misread it as a denial
  if (isRunnerFailure(combined, result.exitCode, confined.runnerFailure)) {
    sandboxLog.warn(`[Sandbox] Backend failed (${confined.backend}): ${combined.slice(0, 400)}`)
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

/** Render "denied by the sandbox" for the model (protocol marker plus escalation hint) */
export function sandboxDenialText(mode: SandboxMode, body: string): string {
  return `${body}\n${sandboxDenyMarker(mode)}\n${SANDBOX_ESCALATION_HINT}`
}

/** "Sandbox unavailable" text (the command did not run — the model must never think it did) */
export function sandboxUnavailableText(reason: string): string {
  return `${SANDBOX_UNAVAILABLE_MARKER} ${reason}`
}
