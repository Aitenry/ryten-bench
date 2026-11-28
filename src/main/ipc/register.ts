import { ipcMain } from 'electron'
import logger from 'electron-log'

/**
 * Minimal helpers for main-process IPC registration and reversible side effects (used by core).
 *
 * System-level features (AI assistant / knowledge base) use these functions to mount their handler
 * maps directly on `ipcMain`: channel names are plain `harness:*` / `notes:*`, they do not go
 * through the plugin host's namespace validation and have no enable/disable layer — they start with
 * the app and stop with the app.
 *
 * Third-party plugins still go through `MainPluginContext` in `src/main/plugins/context.ts`, which
 * is meant for **loadable code**; the two deliberately do not share the same mechanism.
 */

/** One handler map: channel name -> handler function (arguments are passed from the renderer via the preload bridge) */
export type IpcHandlerMap = Record<string, (...args: never[]) => unknown>

/**
 * Register an IPC handler map and return an undo function that unregisters only this registration.
 *
 * Failure leaves no half-registered feature: all channels registered so far are removed before
 * rethrowing. Handler exceptions are logged with the channel name (otherwise the renderer only sees
 * a context-free "Error invoking remote method") and then rethrown unchanged.
 */
export function registerIpcHandlers(handlers: IpcHandlerMap): () => void {
  const registered: string[] = []
  try {
    for (const [channel, handler] of Object.entries(handlers)) {
      if (typeof handler !== 'function') {
        throw new Error(`通道 '${channel}' 缺少处理函数`)
      }
      ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
        try {
          return await handler(...(args as never[]))
        } catch (err) {
          logger.error(`[IPC] Error in ${channel}:`, err)
          throw err
        }
      })
      registered.push(channel)
    }
  } catch (err) {
    for (const channel of registered) {
      try {
        ipcMain.removeHandler(channel)
      } catch {
        // Ignore
      }
    }
    throw err
  }

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    for (const channel of registered) {
      try {
        ipcMain.removeHandler(channel)
      } catch {
        // Ignore
      }
    }
  }
}

/**
 * Reversible side-effect scope: subscriptions, timers, background services and other setup actions
 * are registered here and rolled back in LIFO order on exit (`dispose()`).
 *
 * System-level features live for the whole process and normally never roll back; this layer exists
 * so that "which global listeners were wired up" has a single exit point instead of being scattered
 * across module top levels.
 */
export class EffectScope {
  private readonly undos: Array<() => void> = []

  effect(register: () => void | (() => void)): void {
    const undo = register()
    if (typeof undo === 'function') this.undos.push(undo)
  }

  dispose(): void {
    while (this.undos.length > 0) {
      const undo = this.undos.pop()!
      try {
        undo()
      } catch (err) {
        logger.warn('[IPC] Failed to roll back effect:', err)
      }
    }
  }
}
