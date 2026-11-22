import { ipcMain, BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import logger from 'electron-log'
import { clearEnabledOverride, clearUninstalled, setEnabledOverride } from '../plugins/store'
import { scanExternalPlugins } from '../plugins/scanner'
import { installExternalPlugin, uninstallExternalPlugin } from '../plugins/lifecycle'
import {
  isBundledPluginId,
  isEnabledPlugin,
  loadExternalMain,
  pluginLoadInfo,
  unloadExternalMain
} from '../plugins/host'
import {
  bundledPluginDir,
  installBundledPlugin,
  listBundledPluginIds,
  removeBundledPlugin
} from '../plugins/installer'
import { pluginPurge } from '../plugins/contributions'
import {
  IPC_PLUGIN_HOST_UI_EXPORTS,
  IPC_PLUGIN_STATE_CHANGED,
  IPC_PLUGINS_INSTALL,
  IPC_PLUGINS_INSTALL_LOCAL,
  IPC_PLUGINS_LIST,
  IPC_PLUGINS_LIST_SYNC,
  IPC_PLUGINS_LOADED_FROM,
  IPC_PLUGINS_PICK_LOCAL,
  IPC_PLUGINS_SET_ENABLED,
  IPC_PLUGINS_UNINSTALL
} from '../../shared/plugin/protocol'
import type { PluginListEntry } from '../../shared/plugin/types'
import { setHostUiExports } from '../plugins/host-ui-bridge'
import { installPluginFromLocalPath, pickLocalPluginSource } from '../plugins/local-install'

/**
 * 插件管理 IPC（core，始终注册）。
 *
 * 列表口径（P1 起）：**一切以 `userData/plugins/<id>/` 里装了什么为准**——
 * - 「内置（bundled）」= 应用包里带着、可以随时重装（`bundled: true`）；
 * - 「第三方」= 用户自己放进去的；
 * - 内置插件**只有在已安装**（目录存在）时才进列表；未安装的内置插件出现在
 *   「可安装的内置插件」区（同一条目 `bundled: true, installed: false`）。
 *
 * 启停/安装/卸载都会广播 `plugin-state-changed`，渲染层据此重新拉清单并 diff 装载。
 */

/**
 * 磁盘上这份插件包的**内容戳**：入口文件与 `plugin.css` 的 mtime 最大值。
 *
 * 用途：渲染层据此判断「包换了，要重新 fetch renderer.mjs + 重新注入 plugin.css」。
 * 不能用版本号代替——「重新安装」与本地/仓库的原地升级常常版本号不变（实测：升完级
 * 界面还是旧的，因为渲染层看到「同一个 id 已登记」就跳过了重新装载）。
 */
function packageStamp(dir: string, entry?: { main?: string; renderer?: string }): string {
  const files = [
    'plugin.json',
    'plugin.css',
    entry?.main ?? 'main.cjs',
    entry?.renderer ?? 'renderer.mjs'
  ]
  let max = 0
  for (const file of files) {
    try {
      max = Math.max(max, fs.statSync(path.join(dir, file)).mtimeMs)
    } catch {
      // 缺文件就忽略（老包没有 plugin.css 是正常的）
    }
  }
  return String(Math.round(max))
}

/** 已安装插件与启用态（内置默认启用、第三方默认停用） */
function listEntries(): PluginListEntry[] {
  const entries: PluginListEntry[] = []

  // ① 已安装的插件：内置铺包与第三方走同一个扫描结果，天然去重（都看 userData/plugins/<id>）
  for (const ext of scanExternalPlugins()) {
    const bundled = isBundledPluginId(ext.id)
    const enabled = isEnabledPlugin(ext.id)
    entries.push({
      id: ext.id,
      name: ext.manifest.name,
      version: ext.manifest.version,
      description: ext.manifest.description,
      icon: ext.manifest.icon,
      // builtin 保留原语义（「随应用分发」的展示标签），bundled 是同一件事的显式字段
      builtin: bundled,
      bundled,
      installed: true,
      enabled,
      state: enabled ? 'active' : 'inactive',
      entry: ext.manifest.entry,
      // 应用包里的同名副本版本：面板据此把菜单项写成「更新」（版本不同）或「重新安装」（同版本）
      bundledVersion: bundled ? (bundledManifest(ext.id)?.version ?? undefined) : undefined,
      // 包内容戳：渲染层据此决定「要不要重新装载这个插件」（见 packageStamp 的说明）
      stamp: packageStamp(ext.dir, ext.manifest.entry),
      // 清单里的路由/菜单元数据：渲染层首帧据此声明式预注册（见 shared/plugin/types.ts）
      routes: ext.manifest.routes,
      menu: ext.manifest.menu,
      // 「卸载会删掉什么」：插件自己的 plugin.purge 贡献（停用/未装载时拿不到，面板有兜底文案）
      purgeLabel: pluginPurge(ext.id)?.label
    })
  }

  // ② 未安装的内置插件：应用包里有包、但目录没铺（用户卸载过）→ 供面板给「安装」按钮
  for (const id of bundledPluginIdsFromPackage()) {
    if (entries.some((e) => e.id === id)) continue
    const manifest = bundledManifest(id)
    if (!manifest) continue
    entries.push({
      id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      icon: manifest.icon,
      builtin: true,
      bundled: true,
      installed: false,
      enabled: false,
      state: 'inactive',
      routes: manifest.routes,
      menu: manifest.menu
    })
  }

  return entries
}

/**
 * 应用包里的内置插件 id（读 `resources/plugins/` 下的插件包目录）。
 *
 * 用包里的清单而不是源码里的静态清单：面板要显示的是
 * **能装回来的那个包**的信息（版本可能与源码不同），而且这样 core 侧不必认识任何插件。
 */
function bundledPluginIdsFromPackage(): string[] {
  return listBundledPluginIds()
}

/**
 * 读应用包里某插件的清单（读不到返回 null）。
 *
 * 除展示字段外一并带回 `routes`/`menu`：它们是渲染层**首帧声明式预注册**的输入
 * （未安装的插件在安装前也要能在面板里说清「装回来会有什么菜单」）。
 */
function bundledManifest(id: string): {
  name: string
  version: string
  description?: string
  icon?: string
  routes?: { path: string; skeleton?: string }[]
  menu?: { key: string; labelKey: string; icon: string; order?: number }
} | null {
  const dir = bundledPluginDir(id)
  if (!dir) return null
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf-8')) as {
      name?: string
      version?: string
      description?: string
      icon?: string
      routes?: { path: string; skeleton?: string }[]
      menu?: { key: string; labelKey: string; icon: string; order?: number }
    }
    if (!raw.name || !raw.version) return null
    return {
      name: raw.name,
      version: raw.version,
      description: raw.description,
      icon: raw.icon,
      routes: raw.routes,
      menu: raw.menu
    }
  } catch (err) {
    logger.warn(`[Plugins] Failed to read bundled plugin manifest: ${id}`, err)
    return null
  }
}

/**
 * 插件状态变化的**内部旁听者**（不暴露给渲染层，也不改变 `plugin-state-changed` 通道契约）。
 *
 * 用途：插件中心的数据同步要在「安装/卸载/启停」后做 5s 防抖 push（契约 §4），
 * 而广播发生在这里——用一个小钩子比让同步模块去轮询插件清单可靠。
 * 与 `webContents.send` 一样同步调用，异常只记日志（一个旁听者失败不该影响别的）。
 */
type PluginStateListener = () => void
const pluginStateListeners = new Set<PluginStateListener>()

/** 订阅插件状态变化（返回取消订阅函数） */
export function onPluginStateChanged(listener: PluginStateListener): () => void {
  pluginStateListeners.add(listener)
  return () => {
    pluginStateListeners.delete(listener)
  }
}

/** 广播插件启用态变化（含安装/卸载后的重扫通知） */
export function broadcastPluginStateChanged(): void {
  for (const listener of pluginStateListeners) {
    try {
      listener()
    } catch (err) {
      logger.warn('[Plugins] Error in plugin-state-changed listener:', err)
    }
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_PLUGIN_STATE_CHANGED)
    }
  }
}

/**
 * 启停某插件的主进程侧：装载/卸载它的磁盘包主模块。
 *
 * P5 起没有第二条路径了（应用内的静态插件注册表已删），因此这里就是一句
 * load/unload——早先的 `stateSyncHook`（通知静态注册表同名注册/注销）已经不需要。
 * 未安装的 id 不在这里判：`loadExternalMain` 找不到目录会抛「外部插件 '<id>' 未找到」，
 * 而调用方（面板开关）只在已安装的条目上触发。
 */
function applyEnabled(id: string, enabled: boolean): void {
  if (enabled) loadExternalMain(id)
  else unloadExternalMain(id)
}

/**
 * 卸载插件。
 *
 * @param purgeData 用户口径（P5 起语义按用户澄清调整为两件独立的事）：
 *                  - 卸载本身 = **移除插件代码**（删 `userData/plugins/<id>/`，写 `uninstalled`）；
 *                  - `purgeData` = **是否同时清除插件的数据**（表内记录 + 应用托管的文件）。
 *                  因此 `false` 也照样卸载，只是把数据留着（重装后还能用）。
 *
 * 顺序有讲究：
 * ① `plugin.purge` 贡献必须在**插件仍装载**时调用（它要读自己的 mapper / 托管目录）；
 * ② 摘除 IPC（`unloadExternalMain`）：渲染层随后由广播驱动卸载；
 * ③ 删 `userData/plugins/<id>/`；④ 记 `uninstalled`、清启用覆写；⑤ 广播。
 */
async function uninstallPlugin(id: string, purgeData: boolean): Promise<PluginListEntry[]> {
  if (!listEntries().some((e) => e.id === id)) {
    throw new Error(`插件 '${id}' 未安装，无法卸载`)
  }

  // ① 清数据（插件自己实现；没贡献 purge 的插件跳过）。不清时留一句日志，
  //    免得日后看到「卸载了但库里还有行」时怀疑是 purge 没跑
  if (!purgeData) {
    logger.info(`[Plugins] Uninstalling ${id} with data preserved: plugin code only; table records and managed files kept intact`)
  } else {
    const purge = pluginPurge(id)
    if (purge) {
      try {
        await purge.run()
        logger.info(`[Plugins] ${id} data purged (${purge.label})`)
      } catch (err) {
        // 清数据失败不阻断卸载：目录/通道该摘的仍要摘，否则会留下「装不了也卸不掉」的死状态
        logger.error(`[Plugins] Failed to purge ${id} data (continuing uninstall):`, err)
      }
    } else {
      logger.warn(`[Plugins] ${id} has no plugin.purge contribution; data not purged (directory only)`)
    }
  }

  // ② 摘除主进程装载（磁盘包模块）
  unloadExternalMain(id)

  // ③ 删目录
  //
  // 内置插件必须走 `removeBundledPlugin`：它除了删目录还会写 `uninstalled` 记录。
  // 早先这里不分来源一律调第三方的 `uninstallExternalPlugin`（只删目录、不记账），
  // 于是**卸载后重启会被 `ensureBundledPluginsInstalled()` 立刻铺回来**——「物理卸载」
  // 退化成「卸载后自动复活」（2026-09-26 工装实测：plugins.json 里没有 uninstalled）。
  if (isBundledPluginId(id)) {
    removeBundledPlugin(id)
    clearEnabledOverride(id)
  } else {
    uninstallExternalPlugin(id)
  }

  logger.info(`[Plugins] Plugin uninstalled: ${id}`)
  broadcastPluginStateChanged()
  return listEntries()
}

/**
 * 安装（重装）内置插件：从应用包 copy 回 `userData/plugins/<id>/`。
 * 第三方插件不走这里（它们由「安装插件」目录选择流程处理）。
 */
function installPlugin(id: string): PluginListEntry[] {
  if (!isBundledPluginId(id)) {
    throw new Error(`'${id}' 不是随应用分发的内置插件，请用「安装插件」选择目录安装`)
  }
  if (!bundledPluginDir(id)) {
    throw new Error(
      `应用包里找不到插件 '${id}'（resources/plugins/${id}）。` +
        `开发环境下请先运行 node scripts/build-plugins.mjs 生成插件包。`
    )
  }
  installBundledPlugin(id, true)
  clearUninstalled(id)
  // 重装后按默认启用态装载（内置默认启用；用户此前显式停用过就保持停用）
  if (isEnabledPlugin(id)) {
    try {
      loadExternalMain(id)
    } catch (err) {
      logger.error(`[Plugins] Plugin '${id}' failed to load after reinstall:`, err)
      throw new Error(
        `插件 '${id}' 已安装，但装载失败：${err instanceof Error ? err.message : err}`
      )
    }
  }
  logger.info(`[Plugins] Plugin installed: ${id}`)
  broadcastPluginStateChanged()
  return listEntries()
}

/**
 * 装好之后的统一收尾：「用户主动装的」→ 启用 + 装载主模块。
 *
 * 装载失败不掩盖「已经装上了」这个事实：抛出的错误里写明目录已就位，避免用户以为
 * 什么都没发生（与插件中心的安装同一口径）。
 */
function enableInstalled(id: string): void {
  setEnabledOverride(id, true)
  try {
    loadExternalMain(id)
  } catch (err) {
    logger.error(`[Plugins] Installed plugin '${id}' failed to load:`, err)
    throw new Error(
      `插件 '${id}' 已安装，但装载失败：${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/** 本地安装（压缩包 / 文件夹）→ 启用装载 → 广播；失败返回 `{ ok: false, error }` */
async function installLocalAndEnable(source: string): Promise<{
  ok: boolean
  canceled?: boolean
  id?: string
  name?: string
  version?: string
  upgraded?: boolean
  error?: string
}> {
  try {
    const info = await installPluginFromLocalPath(source)
    enableInstalled(info.id)
    broadcastPluginStateChanged()
    return {
      ok: true,
      id: info.id,
      name: info.name,
      version: info.version,
      upgraded: info.upgraded
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.warn(`[Plugins] Local install failed (${source}):`, msg)
    return { ok: false, error: msg }
  }
}

export function registerPluginsIpc(): void {
  ipcMain.handle(IPC_PLUGINS_LIST, () => listEntries())

  // 同步取启用清单：渲染层首帧要靠它决定「只装载用户启用的插件」，
  // 否则会先按默认值装载一遍再卸载（见 protocol.ts 里该常量的说明）。
  // listEntries 本身是同步的（读 electron-store + 同步扫插件目录），可以直接当返回值。
  ipcMain.on(IPC_PLUGINS_LIST_SYNC, (event) => {
    try {
      event.returnValue = listEntries()
    } catch (err) {
      logger.warn('[Plugins] Failed to sync plugin list:', err)
      event.returnValue = []
    }
  })

  // 渲染层启动最早期上报宿主 UI 表的「键 → 导出名」（plugin://host/ui.js 桥据此生成）
  ipcMain.on(IPC_PLUGIN_HOST_UI_EXPORTS, (_event, names: unknown) => {
    setHostUiExports(names)
    logger.info(
      `[Plugins] Host UI exports reported: ${Object.keys((names ?? {}) as object).length} module keys`
    )
  })

  // 只读诊断：插件主模块的装载来源（工装核对「music 是否由磁盘包接管」）
  ipcMain.handle(IPC_PLUGINS_LOADED_FROM, () => pluginLoadInfo())

  ipcMain.handle(IPC_PLUGINS_SET_ENABLED, (_event, id: unknown, enabled: unknown) => {
    if (typeof id !== 'string' || typeof enabled !== 'boolean') {
      throw new Error('plugins-set-enabled 参数非法')
    }
    const entry = listEntries().find((e) => e.id === id)
    if (!entry) {
      throw new Error(`插件 '${id}' 不存在`)
    }
    setEnabledOverride(id, enabled)
    logger.info(`[Plugins] ${id} -> ${enabled ? 'enabled' : 'disabled'}`)
    applyEnabled(id, enabled)
    broadcastPluginStateChanged()
    return listEntries()
  })

  ipcMain.handle(IPC_PLUGINS_INSTALL, async (_event, id: unknown) => {
    // 无参数 = 第三方插件「选目录安装」；带 id = 重装内置插件
    if (id === undefined || id === null) {
      try {
        const installed = await installExternalPlugin()
        return { ok: true, id: installed }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.warn('[Plugins] Install failed:', msg)
        return { ok: false, error: msg }
      }
    }
    if (typeof id !== 'string') {
      throw new Error('plugins-install 参数非法')
    }
    try {
      installPlugin(id)
      return { ok: true, id }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn(`[Plugins] Failed to install bundled plugin '${id}':`, msg)
      return { ok: false, error: msg }
    }
  })

  ipcMain.handle(IPC_PLUGINS_UNINSTALL, async (_event, id: unknown, purgeData: unknown) => {
    if (typeof id !== 'string') throw new Error('plugins-uninstall 参数非法')
    if (typeof purgeData !== 'boolean') {
      throw new Error('plugins-uninstall 需要第二个参数 purgeData（是否清除插件数据）')
    }
    return await uninstallPlugin(id, purgeData)
  })

  /**
   * 从**本地路径**安装插件（`.zip` 或插件包目录）。
   *
   * 与插件中心的安装共用同一套落地与校验（`package-install.ts`），因此这里的
   * 语义完全一致：装完即启用 + 装载 + 广播；失败返回 `{ ok: false, error }` 而不是抛错，
   * 面板据此提示（路径不存在、包里没有 plugin.json、id 撞内置插件等都走这条）。
   */
  ipcMain.handle(IPC_PLUGINS_INSTALL_LOCAL, async (_event, source: unknown) => {
    if (typeof source !== 'string' || source === '') {
      throw new Error('plugins-install-local 需要压缩包或插件目录的路径')
    }
    return await installLocalAndEnable(source)
  })

  /**
   * 弹系统选择框挑一个本地来源并安装（面板**唯一**的本地安装入口）。
   *
   * 一个对话框两个筛选器：`.zip` 压缩包，或插件文件夹里的 `plugin.json`
   * （Windows 的系统选择框不能同时选文件与目录，见 local-install.ts 的说明）。
   * 取消返回 `{ ok: true, canceled: true }`——取消不是失败，面板不弹错误。
   */
  ipcMain.handle(IPC_PLUGINS_PICK_LOCAL, async () => {
    const source = await pickLocalPluginSource()
    if (!source) return { ok: true as const, canceled: true as const }
    return await installLocalAndEnable(source)
  })
}
