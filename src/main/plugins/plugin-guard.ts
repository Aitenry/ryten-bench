import { AsyncLocalStorage } from 'node:async_hooks'
import logger from 'electron-log'

/**
 * 主进程侧的**插件隔离**（最小但关键的一层）。
 *
 * 插件主模块运行在宿主进程里，Node 的权限对它是全开的——`process.exit()` 一行就能让
 * 整个应用立刻消失，`process.abort()` 更狠（没有机会保存/清理）。真正的沙箱（子进程 +
 * IPC 代理）代价太大，但**最致命的那几个调用**可以用 `AsyncLocalStorage` 精确归因：
 *
 * - 插件 `install()`、它注册的 IPC handler、以及它们派生出来的定时器/Promise 都带着
 *   「当前是哪个插件」的上下文；
 * - 在这些上下文里调 `process.exit` / `process.abort` / `process.kill(自己)` 会被拦住并
 *   抛出可读错误（IPC handler 里就是一次失败的调用，插件界面自己提示；install 里就是
 *   装载失败，宿主照常启动其它插件）；
 * - 上下文之外的调用（宿主自己的退出流程）原样放行。
 *
 * 边界（不夸大）：这只挡「退出/自杀」这一类。插件仍然能读写文件、发网络请求、注册全局
 * 监听器——那是「插件信任模型」本身的问题（见 PACKAGING.md），不在这里假装解决。
 */

export interface PluginScope {
  id: string
  /** 出错时能定位：install / ipc / effect / tool */
  surface: string
  /** 可选的通道名（IPC handler 用） */
  channel?: string
}

const storage = new AsyncLocalStorage<PluginScope>()
let patched = false

/** 当前是否正在执行某个插件的代码（诊断/日志用） */
export function currentPluginScope(): PluginScope | undefined {
  return storage.getStore()
}

/** 在指定插件的上下文里执行（同步/异步都支持；派生任务会继承上下文） */
export function withPluginScope<T>(scope: PluginScope, run: () => T): T {
  return storage.run(scope, run)
}

/** 把「插件试图退出应用」变成一个可捕获的错误，而不是真的退出 */
function denied(action: string): Error {
  const scope = storage.getStore()
  const where = scope
    ? `插件 '${scope.id}' 在 ${scope.surface}${scope.channel ? `（${scope.channel}）` : ''} 中`
    : '插件代码中'
  return new Error(`${where}调用了 ${action}；宿主已拦截（插件不得终止应用进程）`)
}

/**
 * 安装进程级拦截（幂等）。必须在任何插件 main.cjs 被 require 之前调用
 * （`initPluginHost()` 的第一件事）。
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
   * 只**记录**不接管：插件的定时器/回调里抛出的未捕获异常会带着上下文到这里。
   * 用 `uncaughtExceptionMonitor` 而不是 `uncaughtException`——不改变 Node/Electron
   * 原有的崩溃/报错行为，只把「是哪个插件」写进日志，避免排查时只剩一句无上下文的栈。
   */
  process.on('uncaughtExceptionMonitor', (err) => {
    const scope = storage.getStore()
    if (scope) {
      logger.error(
        `[Plugins] ${scope.id} 在 ${scope.surface}${scope.channel ? `（${scope.channel}）` : ''} 抛出未捕获异常:`,
        err
      )
    }
  })

  logger.info('[Plugins] 进程保护已启用（插件上下文中的 exit / abort / kill-self 会被拦截）')
}
