import { BrowserWindow, ipcMain } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import logger from 'electron-log'
import { getEnabledOverride } from './store'
import { findExternalPlugin, scanExternalPlugins } from './scanner'
import { installHostRuntime } from './runtime'
import { registerCoreIpc } from '../ipc'
import { startSystemModules, SYSTEM_MODULE_IDS_SET } from '../system'
import { MainPluginContextImpl } from './context'
import { installPluginProcessGuard, withPluginScope } from './plugin-guard'
import { IPC_PLUGIN_CHANNELS_SYNC, IPC_PLUGIN_CHANNELS_UPDATED } from '../../shared/plugin/protocol'

/**
 * 主进程插件宿主。
 *
 * 应用**不分发**任何插件（没有「内置插件」这种形态）：插件只有一条来源——用户从插件中心
 * 或本地压缩包/目录装进 `userData/plugins/<id>/` 的磁盘包。装载路径也只有一条：
 * `main.cjs` 导出 `install(ctx)`（CJS）或让模块自身即 install 函数；通道经
 * `ctx.registerIpc({ 'plugin:<ns>:...': handler })` 注册，停用时 `ctx.dispose()`
 * 一次性回滚（效果 LIFO + 通道摘除 + 贡献摘除）。
 *
 * core 的角色到此为止：注册自己的 IPC（`registerCoreIpc`）、按持久化启用态装载/卸载插件、
 * 把通道清单推给 preload 白名单。core 不认识任何插件模块，也不认识任何插件通道名。
 *
 * 「内置插件」机制（应用包铺包 / 指纹自更新 / 静态注册表回退）已整体删除：应用包里不带
 * 插件代码，`resources/plugins` 与 `build:plugins` 也不再存在。
 */

/** 一条已装载的插件主模块（键 = 插件 id） */
interface LoadedExternalMain {
  ctx: MainPluginContextImpl
  teardown: () => void
  /** 装载时的插件包目录（卸载时即使在扫描结果里找不到它，也照这个目录摘模块缓存） */
  dir: string
  /**
   * 装载时主入口的**内容戳**（mtime + 字节数）。
   *
   * 用途：磁盘上的包被原地覆盖（插件中心升级 / 本地重装 / 工坊发布）后，
   * `loadExternalMain()` 又被调用时据此判定「装载的还是旧代码，得重载」。
   * **不能只看版本号**：重装与同版本重发时版本号不变，而那正是升级最常见的形态。
   */
  stamp: string
}

/** 已装载的插件主模块（键 = 插件 id） */
const externalMains = new Map<string, LoadedExternalMain>()

/** install 返回的 dispose 先跑，再回滚 ctx.effect 登记的效果、通道与贡献 */
function runTeardown(id: string, dispose: void | (() => void), ctx: MainPluginContextImpl): void {
  if (typeof dispose === 'function') {
    try {
      // 停用时的清理同样是插件代码：同一条进程保护要覆盖到
      withPluginScope({ id, surface: 'install:dispose' }, dispose)
    } catch (err) {
      logger.warn(`[Plugins] ${id} install dispose failed:`, err)
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
  // ② 进程保护必须早于任何插件 main.cjs 被 require（见 plugin-guard.ts）；
  // ③ core 自己的 IPC 与 preload 的通道同步入口（都必须在窗口创建之前）。
  installHostRuntime()
  installPluginProcessGuard()
  registerCoreIpc()
  // 系统级功能（AI 助手 / 资料库）是 core 的一部分：直接启动，不经过插件宿主。
  // 必须在 preload 通道同步之前完成，否则渲染层首批订阅会撞上「主进程还没挂通道」。
  startSystemModules()
  registerPluginChannelsSync()
  initExternalMains()
}

// ---------- 通道清单（preload 白名单 + 事件订阅门控） ----------

/** 当前全部已启用插件占用的通道（系统级功能的通道不在其中：它们由 preload 系统桥直接放行） */
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

/**
 * 摘掉某插件目录下所有模块的 `require` 缓存。
 *
 * 为什么必须有：插件主模块是 `require('<插件目录>/main.cjs')` 装进来的，Node 按**绝对
 * 路径**缓存模块。升级时磁盘上的 `main.cjs` 被覆盖，缓存里却还是旧模块——再次 require
 * 直接拿回旧对象，于是新渲染层调新通道时主进程只有旧的那批 handler，报
 * `No handler registered for 'plugin:<id>:…'`，插件界面只能提示
 * 「插件刚刚更新，但应用主进程还在跑旧版本，请完全退出并重新打开应用」
 * （2026-11-23 用户反馈：全球时区加「手动排序」后点上移/下移就撞上这条，必须重启应用）。
 *
 * 只删**插件目录内**的条目：`@host/main/**` 是宿主自己的单例，裸模块（electron / zod…）
 * 也按应用根解析，都不在这个前缀里，因此不会被误伤——「插件主进程与宿主共用同一份 core」
 * 这条语义必须保住。
 */
function purgePluginModuleCache(dir: string): void {
  const root = path.resolve(dir)
  const prefix = root.endsWith(path.sep) ? root : root + path.sep
  for (const key of Object.keys(require.cache)) {
    const resolved = path.resolve(key)
    if (resolved === root || resolved.startsWith(prefix)) delete require.cache[key]
  }
}

/** 插件主入口的「内容戳」（mtime + 字节数）；入口不在时给 `missing` */
function mainEntryStamp(abs: string): string {
  try {
    const stat = fs.statSync(abs)
    return `${Math.round(stat.mtimeMs)}:${stat.size}`
  } catch {
    return 'missing'
  }
}

/**
 * 装载/重载外部插件主进程模块（require CJS，导出的 install 或 `{ install }`）。
 *
 * **幂等且认磁盘**：已装载且主入口内容戳没变 → 直接返回；已装载但内容戳变了
 * （升级 / 重装 / 工坊发布刚覆盖了 `userData/plugins/<id>/`）→ 先走完整 teardown
 * （注销通道、回滚 effects、摘贡献）再按磁盘上的新文件重装。这样「更新插件」不需要用户
 * 完全退出应用：渲染层换新 `renderer.mjs` 的同时，主进程也换成了新的 `main.cjs`。
 */
export function loadExternalMain(id: string): void {
  const scanned = findExternalPlugin(id)
  if (!scanned) throw new Error(`外部插件 '${id}' 未找到`)
  const entryRel = scanned.manifest.entry?.main ?? 'main.js'
  const abs = path.join(scanned.dir, entryRel)
  if (!fs.existsSync(abs)) {
    // 允许纯渲染层插件（无主进程代码）；若之前有主模块而新包把入口删了，旧模块要摘掉
    if (externalMains.has(id)) unloadExternalMain(id)
    return
  }

  const stamp = mainEntryStamp(abs)
  const loaded = externalMains.get(id)
  if (loaded) {
    if (loaded.stamp === stamp) return // 已装载且代码没变：真幂等（重复 enable 不重建状态）
    logger.info(`[Plugins] Package on disk changed, reloading main module: ${id}`)
    unloadExternalMain(id)
  }

  // 缓存里可能留着上一次装载的模块（停用 → 覆盖包 → 启用）：先摘掉，require 才会读新文件
  purgePluginModuleCache(scanned.dir)

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

  externalMains.set(id, {
    ctx,
    teardown: () => runTeardown(id, dispose, ctx),
    dir: scanned.dir,
    stamp
  })
  logger.info(`[Plugins] Loaded external plugin main module: ${id} (${ctx.channels.length} channels)`)
  pushPluginChannels()
}

/**
 * **强制重载**某插件的主模块（磁盘上的包刚被覆盖时调用）。
 *
 * 与 `loadExternalMain` 的区别：不看内容戳，一定 teardown → 重新 require。
 * 升级路径（安装内核刚把新文件拷进 `userData/plugins/<id>/`）用它，是为了不赌 mtime 精度：
 * 同一次安装里「删旧文件 + 写新文件」可能落在同一毫秒，内容却已经换了。
 */
export function reloadExternalMain(id: string): void {
  if (externalMains.has(id)) {
    // 留一行可核对的日志：升级后「主进程真的换了模块」只能从这里/装载日志看出来，
    // 否则现场排查又会退化成「到底重启没重启」的口水战。
    logger.info(`[Plugins] Reloading external plugin main module (package replaced on disk): ${id}`)
    unloadExternalMain(id)
  }
  loadExternalMain(id)
}

/** 卸载外部插件主进程模块（注销 IPC + 通道清单推送刷新） */
export function unloadExternalMain(id: string): void {
  const record = externalMains.get(id)
  // 停用期间包也可能被更新（面板「重新安装」/ 插件中心升级）：模块缓存一起摘掉，
  // 否则「停用 → 升级 → 启用」拿到的还是旧模块（同一条「主进程跑旧代码」的另一半）。
  // 用装载时记下的目录兜底：卸载流程里目录随后就被删了，那时 `findExternalPlugin` 已经找不到它。
  const dir = record?.dir ?? findExternalPlugin(id)?.dir
  if (dir) purgePluginModuleCache(dir)
  if (!record) return
  record.teardown()
  externalMains.delete(id)
  logger.info(`[Plugins] Unloaded external plugin main module: ${id}`)
  pushPluginChannels()
}

/** 启动时装载所有已启用的外部插件主模块 */
function initExternalMains(): void {
  for (const scanned of scanExternalPlugins()) {
    if (SYSTEM_MODULE_IDS_SET.has(scanned.id)) continue
    if (isEnabledPlugin(scanned.id)) {
      try {
        loadExternalMain(scanned.id)
      } catch (err) {
        logger.warn(`[Plugins] External plugin '${scanned.id}' failed to load main module at startup:`, err)
      }
    }
  }
}

/**
 * 运行中切换账号数据空间前：把所有插件主模块摘掉（**不删代码、不删数据**）。
 *
 * 为什么必须摘：`plugin-state/` 里是各账号自己的设置与数据，插件主模块在装载期就可能
 * 打开文件 / 建库 / 起监听；带着它们对调目录，轻则 rename 失败（Windows 句柄占用），
 * 重则插件继续把上一个账号的状态写进新账号的空间。摘掉 = 回到「刚启动、还没装载插件」
 * 的状态，切换完成后由 `reloadAllExternalMains()` 按磁盘上的包重新装载。
 *
 * @returns 实际摘掉的插件 id（顺序即装载顺序，便于日志核对）
 */
export function unloadAllExternalMains(): string[] {
  const ids = [...externalMains.keys()]
  for (const id of ids) {
    try {
      unloadExternalMain(id)
    } catch (err) {
      logger.warn(`[Plugins] Failed to unload '${id}' before profile switch:`, err)
    }
  }
  if (ids.length > 0) {
    logger.info(`[Plugins] Unloaded ${ids.length} plugin main module(s) for profile switch`)
  }
  return ids
}

/**
 * 切换完成后重新装载已启用的插件主模块（与启动期完全同一条路径）。
 *
 * 用 `initExternalMains()` 而不是「只装回刚才那几个」：切换前后启用态可能已经变化
 * （云端 pull 会写启用覆写），以磁盘 + 启用态为准才不会漏装。
 */
export function reloadAllExternalMains(): void {
  initExternalMains()
}

/**
 * 已安装插件的最终启用态：**显式覆写优先，未覆写即停用**。
 *
 * 应用不分发插件（没有任何内置插件），所以「没被用户显式启用过的插件」一律不装载——
 * 默认停用也是安全默认值：装进来不等于让它开始跑代码。
 */
export function isEnabledPlugin(id: string): boolean {
  return getEnabledOverride(id) ?? false
}

// ---------- 只读诊断（工装/面板核对「插件到底从哪来」） ----------

/** 某插件主模块的装载来源 */
export interface PluginLoadInfo {
  /** userData/plugins/<id>/ 下是否有插件包 */
  installed: boolean
  /** package = 由磁盘包提供；absent = 已安装但当前未装载（停用） */
  source: 'package' | 'absent'
  /** 磁盘包主入口绝对路径（installed 时才有；工装用它证明是包在应答） */
  file?: string
}

/**
 * 各插件主模块的装载来源。
 *
 * 为什么需要它：工装要能断言「<id> 的 handler 确实由 userData/plugins/<id>/main.cjs 提供」，
 * 也能断言「卸载后目录没了、包来源消失」。
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
