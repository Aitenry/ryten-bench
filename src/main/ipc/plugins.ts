import { ipcMain, BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import logger from 'electron-log'
import { clearEnabledOverride, markInstallRemoved, setEnabledOverride } from '../plugins/store'
import { scanExternalPlugins } from '../plugins/scanner'
import { uninstallExternalPlugin } from '../plugins/lifecycle'
import { emitAppEvent } from '../plugins/app-events'
import { APP_EVENT_PLUGIN_DATA_PURGED } from '../plugins/app-hooks'
import {
  isEnabledPlugin,
  loadExternalMain,
  pluginLoadInfo,
  reloadExternalMain,
  unloadExternalMain
} from '../plugins/host'
import { pluginPurge } from '../plugins/contributions'
import {
  IPC_PLUGIN_HOST_UI_EXPORTS,
  IPC_PLUGIN_STATE_CHANGED,
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
 * 列表口径：**一切以 `userData/plugins/<id>/` 里装了什么为准**。应用不再分发任何插件
 * （没有「内置插件」），因此清单里只有用户自己装的插件：默认停用，装完由宿主自动启用。
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

/** 已安装插件与启用态（默认停用，用户装完由宿主显式启用） */
function listEntries(): PluginListEntry[] {
  return scanExternalPlugins().map((ext) => {
    const enabled = isEnabledPlugin(ext.id)
    return {
      id: ext.id,
      name: ext.manifest.name,
      version: ext.manifest.version,
      description: ext.manifest.description,
      icon: ext.manifest.icon,
      enabled,
      state: enabled ? 'active' : 'inactive',
      entry: ext.manifest.entry,
      // 包内容戳：渲染层据此决定「要不要重新装载这个插件」（见 packageStamp 的说明）
      stamp: packageStamp(ext.dir, ext.manifest.entry),
      // 清单里的路由/菜单元数据：渲染层首帧据此声明式预注册（见 shared/plugin/types.ts）
      routes: ext.manifest.routes,
      menu: ext.manifest.menu,
      // 「卸载会删掉什么」：插件自己的 plugin.purge 贡献（停用/未装载时拿不到，面板有兜底文案）
      purgeLabel: pluginPurge(ext.id)?.label
    }
  })
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
 * @param purgeData 用户口径：卸载本身 = **移除插件代码**（删 `userData/plugins/<id>/`）；
 *                  `purgeData` 只决定**是否同时清除插件的数据**（表内记录 + 应用托管的文件），
 *                  因此 `false` 也照样卸载，只是把数据留着（重装后还能用）。
 *
 * 顺序有讲究：
 * ① `plugin.purge` 贡献必须在**插件仍装载**时调用（它要读自己的 mapper / 托管目录）；
 * ② 摘除 IPC（`unloadExternalMain`）：渲染层随后由广播驱动卸载；
 * ③ 删 `userData/plugins/<id>/`；④ 记「用户显式卸载」、清启用覆写；⑤ 广播。
 */
async function uninstallPlugin(id: string, purgeData: boolean): Promise<PluginListEntry[]> {
  if (!listEntries().some((e) => e.id === id)) {
    throw new Error(`插件 '${id}' 未安装，无法卸载`)
  }

  // ① 清数据（插件自己实现；没贡献 purge 的插件跳过）。不清时留一句日志，
  //    免得日后看到「卸载了但库里还有行」时怀疑是 purge 没跑
  if (!purgeData) {
    logger.info(
      `[Plugins] Uninstalling ${id} with data preserved: plugin code only; table records and managed files kept intact`
    )
  } else {
    const purge = pluginPurge(id)
    if (purge) {
      try {
        await purge.run()
        logger.info(`[Plugins] ${id} data purged (${purge.label})`)
        /**
         * 本机数据（表行 / 托管文件）已清，但云端数据快照保留。通知插件中心丢掉本地
         * `data_rev` 缓存：否则重新安装后 pull 会拿旧 rev 与云端比较，误判「已是最新」，
         * 云端数据永远不回来（用户 2026-11-23：「不然以后的数据同步怎么办」）。
         */
        emitAppEvent(APP_EVENT_PLUGIN_DATA_PURGED, { pluginId: id })
      } catch (err) {
        // 清数据失败不阻断卸载：目录/通道该摘的仍要摘，否则会留下「装不了也卸不掉」的死状态
        logger.error(`[Plugins] Failed to purge ${id} data (continuing uninstall):`, err)
      }
    } else {
      logger.warn(
        `[Plugins] ${id} has no plugin.purge contribution; data not purged (directory only)`
      )
    }
  }

  // ② 摘除主进程装载（磁盘包模块）
  unloadExternalMain(id)

  // ③ 删目录 + ④ 记账（清启用覆写）
  //
  // 卸载**只动本地**：云端安装记录与数据快照一律保留。用户显式卸载要留一笔标记，
  // 否则插件中心按用户保存的安装记录会在下次同步时把刚卸载的插件「自动补齐」回来
  // （用户 2026-11-23 反馈「卸载后状态对不上」）。
  uninstallExternalPlugin(id)
  markInstallRemoved(id)
  clearEnabledOverride(id)

  /**
   * 卸载**只动本地**：云端安装记录与数据快照一律保留。
   *
   * 原因（用户 2026-11-23 明确口径）：「卸载不能把云存储的数据卸载了，只卸载本地的数据，
   * 不然用户以后的数据同步怎么办」。云端是按用户的备份（换机/重装后恢复插件与设置），
   * 挂在卸载的勾选框上会悄悄丢数据；「同时删除该插件的全部数据」只清**本机**表行与托管文件。
   *
   * 普通卸载后不会自动复活：本机的 `removedInstalls` 标记会让换机自动补齐跳过它，
   * 插件仓库/详情按本机口径显示「未安装」；重新安装会清掉标记并继续用云端数据同步。
   */

  logger.info(`[Plugins] Plugin uninstalled: ${id} (cloud install record and data are kept)`)
  broadcastPluginStateChanged()
  return listEntries()
}

/**
 * 装好之后的统一收尾：启用 + 装载主模块。
 *
 * 装载失败不掩盖「已经装上了」这个事实：抛出的错误里写明目录已就位，避免用户以为
 * 什么都没发生（与插件中心的安装同一口径）。
 *
 * 这里必须是**重载**：升级（同 id 已在跑）时磁盘包刚被覆盖，直接 load 会因「已装载」
 * 提前返回，主进程继续跑旧模块——正是「插件刚刚更新，但主进程还在跑旧版本」的来源。
 */
function enableInstalled(id: string): void {
  setEnabledOverride(id, true)
  try {
    reloadExternalMain(id)
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

  // 只读诊断：插件主模块的装载来源（工装核对「handler 是否由磁盘包提供」）
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
   * 面板据此提示（路径不存在、包里没有 plugin.json 等都走这条）。
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
