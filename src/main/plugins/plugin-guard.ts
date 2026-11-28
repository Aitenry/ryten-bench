import { AsyncLocalStorage } from 'node:async_hooks'
import logger from 'electron-log'

/**
 * Main-process-side **plugin isolation** (a minimal but critical layer).
 *
 * Plugin main modules run inside the host process with full Node permissions - one
 * `process.exit()` line makes the whole app vanish instantly, and `process.abort()` is even worse
 * (no chance to save/clean up). A real sandbox (child process + IPC proxy) is too expensive, but
 * **the most fatal calls** can be attributed precisely with `AsyncLocalStorage`:
 *
 * - a plugin's `install()`, the IPC handlers it registers, and the timers/Promises derived from
 *   them all carry the "which plugin is current" context;
 * - calls to `process.exit` / `process.abort` / `process.kill(self)` in those contexts are blocked
 *   and throw a readable error (inside an IPC handler it is a failed call, and the plugin UI shows
 *   it; inside install it is a load failure, and the host keeps starting other plugins);
 * - calls outside that context (the host's own exit flow) pass through unchanged.
 *
 * Boundary (no overstating): this only blocks the "exit/self-kill" class. Plugins can still read
 * and write files, make network requests and register global listeners - that is a matter of the
 * plugin trust model itself, not something solved here.
 */

export interface PluginScope {
  id: string
  /** Lets errors be located: install / ipc / effect / tool */
  surface: string
  /** Optional channel name (used by IPC handlers) */
  channel?: string
}

const storage = new AsyncLocalStorage<PluginScope>()
let patched = false

/** Whether some plugin's code is currently executing (diagnostics/logging) */
export function currentPluginScope(): PluginScope | undefined {
  return storage.getStore()
}

/** Run in the given plugin's context (sync/async both supported; derived tasks inherit the context) */
export function withPluginScope<T>(scope: PluginScope, run: () => T): T {
  return storage.run(scope, run)
}

/** Turn "a plugin tried to quit the app" into a catchable error instead of a real exit */
function denied(action: string): Error {
  const scope = storage.getStore()
  const where = scope
    ? `插件 '${scope.id}' 在 ${scope.surface}${scope.channel ? `（${scope.channel}）` : ''} 中`
    : '插件代码中'
  return new Error(`${where}调用了 ${action}；宿主已拦截（插件不得终止应用进程）`)
}

/**
 * Install the process-level guard (idempotent). It must be called before any plugin main.cjs is
 * required (the first thing `initPluginHost()` does).
 */
export function installPluginProcessGuard(): void {
  if (patched) return
  patched = true

  const realExit = process.exit.bind(process)
  process.exit = ((code?: number) => {
    if (storage.getStore()) throw denied(`process.exit(${String(code ?? '')})`)
    return realExit(code)
  }) as typeof process.exit

  const realAbort = process.abort.bind(process)
  process.abort = (() => {
    if (storage.getStore()) throw denied('process.abort()')
    return realAbort()
  }) as typeof process.abort

  const realKill = process.kill.bind(process)
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    if (pid === process.pid && storage.getStore()) {
      throw denied(`process.kill(${pid}${signal !== undefined ? `, ${String(signal)}` : ''})`)
    }
    return realKill(pid, signal as NodeJS.Signals)
  }) as typeof process.kill

  /**
   * **Record only, do not take over**: uncaught exceptions thrown from a plugin's timers/callbacks
   * arrive here with the context. It uses `uncaughtExceptionMonitor` rather than
   * `uncaughtException` - it does not change Node/Electron's original crash/report behavior, it
   * only writes "which plugin it was" to the log, so diagnosis no longer ends with a stack that
   * has no context.
   */
  process.on('uncaughtExceptionMonitor', (err) => {
    const scope = storage.getStore()
    if (scope) {
      logger.error(
        `[Plugins] ${scope.id} threw an uncaught error in ${scope.surface}${scope.channel ? ` (${scope.channel})` : ''}:`,
        err
      )
    }
  })

  logger.info('[Plugins] Process guard enabled (exit / abort / kill-self in plugin contexts will be blocked)')
}
