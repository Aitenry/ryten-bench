import * as fs from 'fs'
import * as path from 'path'
import logger from 'electron-log'
import { findExternalPlugin, invalidateInstalledPluginIds } from './scanner'
import { installPluginFromLocalPath, pickLocalPluginSource } from './local-install'
import { isValidManifest, type PluginManifest } from '../../shared/plugin/types'
import { isEnabledPlugin } from './host'
import { setEnabledOverride } from './store'
import { broadcastPluginStateChanged } from '../ipc/plugins'
import { unloadExternalMain } from './host'

/**
 * 插件目录的安装/卸载流程（内置铺包与第三方共用同一套目录语义）：
 * - 安装（第三方）：选路径（压缩包 / 文件夹）→ 校验 plugin.json → 复制到
 *   `userData/plugins/<id>/` → 广播刷新。真正的实现在 `local-install.ts` /
 *   `package-install.ts`（与插件中心的安装共用同一套校验与升级清理）；
 * - 卸载：若启用先停用（主进程注销 IPC + 广播渲染层卸载）→ 删除目录 → 广播。
 *
 * 内置插件（`bundled: true`）的卸载走 `ipc/plugins.ts` 的 `uninstallPlugin()`：它在删目录
 * 之前还要先问数据、调 `plugin.purge` 贡献、写 `uninstalled` 记录，因此不直接复用这里的
 * `uninstallExternalPlugin`（后者是第三方语义：用户自己装的目录，删掉就没有了）。
 */

/** 读取并校验目录下的 plugin.json（外部插件 manifest；bundled 插件不可作为第三方安装） */
export function readExternalManifest(dir: string): PluginManifest {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf-8'))
  if (!isValidManifest(raw)) {
    throw new Error('plugin.json 字段不完整或非法')
  }
  const manifest = raw as unknown as PluginManifest
  if (manifest.builtin) {
    throw new Error('随应用分发的内置插件不可作为第三方插件安装（请用设置 → 插件里的「安装」）')
  }
  return { ...manifest, builtin: false }
}

/** 安装外部插件：dialog 选路径（压缩包 / 插件文件夹里的 plugin.json）→ 校验 → 复制 */
export async function installExternalPlugin(): Promise<string> {
  // 旧的「选目录安装」入口保留（面板已改用单一的「从本地安装」按钮），
  // 内部直接复用本地安装链路：选择框 + 校验 + 落地只有一份实现（见 local-install.ts）
  const src = await pickLocalPluginSource()
  if (!src) throw new Error('未选择插件压缩包或插件文件夹')
  const info = await installPluginFromLocalPath(src)
  return info.id
}

/** 卸载第三方插件：启用中先停用（含主进程模块注销）再删除目录（无数据询问语义） */
export function uninstallExternalPlugin(id: string): void {
  const found = findExternalPlugin(id)
  if (!found) {
    throw new Error(`插件 '${id}' 不存在`)
  }
  if (isEnabledPlugin(id)) {
    setEnabledOverride(id, false)
    unloadExternalMain(id)
  }
  // 若主模块此前加载失败（未入 externalMains），再兜底注销一次（幂等）
  unloadExternalMain(id)
  fs.rmSync(found.dir, { recursive: true, force: true })
  invalidateInstalledPluginIds()
  logger.info(`[Plugins] External plugin uninstalled: ${id}`)
  broadcastPluginStateChanged()
}
