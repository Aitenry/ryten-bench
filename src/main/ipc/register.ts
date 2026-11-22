import { ipcMain } from 'electron'
import logger from 'electron-log'

/**
 * 主进程 IPC 注册与可逆副作用的最小工具（core 自用）。
 *
 * 系统级功能（AI 助手 / 资料库）直接用这里的函数把处理器表挂到 `ipcMain`：
 * 通道名是普通的 `harness:*` / `notes:*`，不再经过插件宿主的命名空间校验、
 * 也没有“启用/停用”这一层——它们随应用启动、随应用退出。
 *
 * 第三方插件仍然走 `src/main/plugins/context.ts` 的 `MainPluginContext`，
 * 那是给**可装卸代码**用的；两者刻意不共用同一套机制。
 */

/** 一张处理器表：通道名 → 处理函数（参数由渲染层经 preload 桥传入） */
export type IpcHandlerMap = Record<string, (...args: never[]) => unknown>

/**
 * 注册一张 IPC 处理器表，返回只注销本次注册的逆操作。
 *
 * 失败时不留下半个功能：已注册的通道全部摘除后再抛出。处理器异常带通道名记一条日志
 * （否则渲染层只能看到一句没有上下文的 “Error invoking remote method”），然后原样抛回。
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
        // 忽略
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
        // 忽略
      }
    }
  }
}

/**
 * 可逆副作用作用域：订阅、定时器、后台服务等装配动作登记在这里，
 * 退出时按 LIFO 回滚（`dispose()`）。
 *
 * 系统级功能常驻整个进程，正常情况下不会回滚；保留这一层是为了让
 * “装配了哪些全局监听”有唯一出口，而不是散落在模块顶层。
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
