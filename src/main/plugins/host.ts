import { BrowserWindow, ipcMain } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import logger from 'electron-log'
import { getEnabledOverride } from './store'
import { findExternalPlugin, scanExternalPlugins } from './scanner'
import { ensureBundledPluginsInstalled } from './installer'
import { installHostRuntime } from './runtime'
import { registerCoreIpc } from '../ipc'
import { BUILTIN_PLUGIN_MANIFESTS } from '../../plugins/manifests'
import { MainPluginContextImpl } from './context'
import { installPluginProcessGuard, withPluginScope } from './plugin-guard'
import { IPC_PLUGIN_CHANNELS_SYNC, IPC_PLUGIN_CHANNELS_UPDATED } from '../../shared/plugin/protocol'

/**
 * 主进程插件宿主。
 *
 * 只有**一条**装载路径（内置与第三方完全相同）：`userData/plugins/<id>/main.cjs`
 * 导出 `install(ctx)`（CJS）或让模块自身即 install 函数；通道经
 * `ctx.registerIpc({ 'plugin:<ns>:...': handler })` 注册，停用时 `ctx.dispose()`
 * 一次性回滚（效果 LIFO + 通道摘除 + 贡献摘除）。
 *
 * core 的角色到此为止：注册自己的 IPC（`registerCoreIpc`）、把应用包里的插件铺到 userData、
 * 按持久化启用态装载/卸载插件、把通道清单推给 preload 白名单。core 不认识任何插件模块，
 * 也不认识任何插件通道名。
 *
 * 历史（P1~P4 的过渡形态）已删：应用内的静态插件注册表（`./builtin.ts`）、
 * 「已就绪白名单」（`./packaged.ts`）与 `stateSyncHook` 都没了——四个内置插件现在
 * 与第三方插件走完全相同的磁盘包链路（见 src/plugins/PACKAGING.md）。
 */

/** 已装载的插件主模块（键 = id，内置与第三方不分家） */
const externalMains = new Map<string, { ctx: MainPluginContextImpl; teardown: () => void }>()

/** install 返回的 dispose 先跑，再回滚 ctx.effect 登记的效果、通道与贡献 */
function runTeardown(id: string, dispose: void | (() => void), ctx: MainPluginContextImpl): void {
  if (typeof dispose === 'function') {
    try {
      // 停用时的清理同样是插件代码：同一条进程保护要覆盖到
      withPluginScope({ id, surface: 'install:dispose' }, dispose)
    } catch (err) {
      logger.warn(`[Plugins] ${id} install dispose 异常:`, err)
    }
  }
  ctx.dispose()
}

/**
 * 应用启动：注册 core IPC + preload 通道同步入口 + 装载已启用的插件（全部来自磁盘包）。
 *
 * 顺序有意义：`registerCoreIpc()` 与 preload 通道同步入口（`plugin-channels-sync`）
 * 都必须在任何窗口创建之前完成——preload 先于页面脚本执行，它用同步 IPC 取回白名单，
 * 拿不到就会把首个插件订阅判为「通道未启用」。
 */
export function initPluginHost(): void {
  // 顺序不可换：
  // ① 宿主运行时表（`globalThis.__RB_HOST_RESOLVE__`）必须在**任何插件 main.cjs 被 require
  //    之前**挂上——插件包里的 `require('@host/main/x')` 会立刻调它；
  // ② 首次安装把应用包里的插件铺到 userData/plugins/（dev 下会先按需补打产物），
  //    之后的扫描/装载就只剩「磁盘包」一条路径；
  // ③ core 自己的 IPC 与 preload 的通道同步入口（都必须在窗口创建之前）。
  installHostRuntime()
  // 进程保护必须早于任何插件 main.cjs 被 require：插件装载期的一行 process.exit
  // 就能让应用在启动途中消失（见 plugin-guard.ts）。
  installPluginProcessGuard()
  ensureBundledPluginsInstalled()
  registerCoreIpc()
  registerPluginChannelsSync()
  initExternalMains()
}

// ---------- 通道清单（preload 白名单 + 事件订阅门控） ----------

/** 当前全部已启用插件占用的通道 */
export function activePluginChannels(): string[] {
  return [...externalMains.values()].flatMap((e) => e.ctx.channels)
}

/**
 * 把已启用插件通道推给渲染层（preload 白名单缓存）。
 *
 * 注意：启动期 `initPluginHost()` 早于任何窗口创建，此时推送等于丢掉；
 * 因此窗口 `did-finish-load` 之后必须再推一次（见 main/index.ts 的 browser-window-created）。
 */
export function pushPluginChannels(): void {
  const list = activePluginChannels()
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_PLUGIN_CHANNELS_UPDATED, list)
    }
  }
}

/**
 * preload 启动时的**同步**取清单入口（`ipcRenderer.sendSync`）。
 *
 * 必须在任何窗口创建之前注册（`initPluginHost` 的第一件事）：preload 先于页面脚本
 * 执行，用它一次性取回通道白名单，渲染层首个 `window.api.plugin.on(...)` 才不会撞上
 * 「推送还没到」的竞态（插件 Provider 在 useEffect 里订阅事件通道就是这个时机）。
 * 之后的启停变化仍由 `pushPluginChannels()` 增量刷新。
 */
function registerPluginChannelsSync(): void {
  ipcMain.on(IPC_PLUGIN_CHANNELS_SYNC, (event) => {
    event.returnValue = activePluginChannels()
  })
}

// ---------- 外部插件主进程模块 ----------

/** 装载外部插件主进程模块（require CJS，导出的 install 或 { install }） */
export function loadExternalMain(id: string): void {
  if (externalMains.has(id)) return
  const scanned = findExternalPlugin(id)
  if (!scanned) throw new Error(`外部插件 '${id}' 未找到`)
  const entryRel = scanned.manifest.entry?.main ?? 'main.js'
  const abs = path.join(scanned.dir, entryRel)
  if (!fs.existsSync(abs)) return // 允许纯渲染层插件（无主进程代码）

  // 动态 require 外部文件（out/main 为 CJS 产物）
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(abs) as unknown
  const install: unknown =
    typeof mod === 'function' ? mod : (mod as { install?: unknown } | null)?.install
  if (typeof install !== 'function') {
    throw new Error(`外部插件 '${id}' 主进程入口需导出 install(ctx)`)
  }

  const ctx = new MainPluginContextImpl(id)
  let dispose: void | (() => void)
  try {
    // install 是插件代码：在它的上下文里执行，最致命的 process.exit / abort 会被拦截
    // 成一次装载失败（宿主继续启动其它插件），而不是让整个应用消失。
    dispose = withPluginScope({ id, surface: 'install' }, () =>
      (install as (c: MainPluginContextImpl) => void | (() => void))(ctx)
    )
  } catch (err) {
    ctx.dispose()
    throw err
  }

  externalMains.set(id, { ctx, teardown: () => runTeardown(id, dispose, ctx) })
  logger.info(`[Plugins] 外部插件主模块装载: ${id}（通道 ${ctx.channels.length} 个）`)
  pushPluginChannels()
}

/** 卸载外部插件主进程模块（注销 IPC + 通道清单推送刷新） */
export function unloadExternalMain(id: string): void {
  const record = externalMains.get(id)
  if (!record) return
  record.teardown()
  externalMains.delete(id)
  logger.info(`[Plugins] 外部插件主模块卸载: ${id}`)
  pushPluginChannels()
}

/** 启动时装载所有已启用的外部插件主模块 */
function initExternalMains(): void {
  for (const scanned of scanExternalPlugins()) {
    if (isEnabledPlugin(scanned.id)) {
      try {
        loadExternalMain(scanned.id)
      } catch (err) {
        logger.warn(`[Plugins] 外部插件 '${scanned.id}' 主模块启动装载失败:`, err)
      }
    }
  }
}

/** 内置插件 id 集合（不 import 插件实现，只借 manifests 的 id 面） */
const BUILTIN_MAIN_IDS: Record<string, true> = Object.fromEntries(
  BUILTIN_PLUGIN_MANIFESTS.map((m) => [m.id, true as const])
)

/**
 * 已安装 plugin id 的**默认启用态**。
 *
 * 内置插件铺包后就走磁盘包这条装载路径，但它们的语义仍是「内置：默认启用」——
 * 若这里按外部插件的默认值（停用）算，首次安装后音乐播放器在重启时就再也不装载了。
 * 第三方插件保持默认停用（用户装完要自己打开）。
 */
export function isBundledPluginId(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(BUILTIN_MAIN_IDS, id)
}

/** 已安装插件的最终启用态（显式覆写优先，否则内置默认启用 / 第三方默认停用） */
export function isEnabledPlugin(id: string): boolean {
  const override = getEnabledOverride(id)
  if (override !== undefined) return override
  return isBundledPluginId(id)
}

// ---------- 只读诊断（工装/面板核对「插件到底从哪来」） ----------

/** 某插件主模块的装载来源 */
export interface PluginLoadInfo {
  /** userData/plugins/<id>/ 下是否有插件包（内置铺包或第三方） */
  installed: boolean
  /** package = 由磁盘包提供；absent = 已铺包但当前未装载（停用） */
  source: 'package' | 'absent'
  /** 磁盘包主入口绝对路径（installed 时才有；工装用它证明是包在应答） */
  file?: string
}

/**
 * 各插件主模块的装载来源。
 *
 * 为什么需要它：工装要能断言「<id> 的 handler 确实由 userData/plugins/<id>/main.cjs 提供」，
 * 也能断言「卸载后目录没了、包来源消失」。P1~P4 期间 `source` 还可能是 `'builtin'`
 * （静态注册表回退），P5 删掉静态注册表后只剩这两态。
 */
export function pluginLoadInfo(): Record<string, PluginLoadInfo> {
  const out: Record<string, PluginLoadInfo> = {}
  for (const id of externalMains.keys()) {
    const scanned = findExternalPlugin(id)
    const entryRel = scanned?.manifest.entry?.main ?? 'main.js'
    out[id] = {
      installed: true,
      source: 'package',
      ...(scanned ? { file: path.join(scanned.dir, entryRel) } : {})
    }
  }
  // 已铺包但当前停用（未装载）的插件：也如实报 installed，避免工装把「停用」误判成「没装」
  for (const scanned of scanExternalPlugins()) {
    if (out[scanned.id]) continue
    out[scanned.id] = {
      installed: true,
      source: 'absent',
      file: path.join(scanned.dir, scanned.manifest.entry?.main ?? 'main.js')
    }
  }
  return out
}
