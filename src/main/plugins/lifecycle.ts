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
 * Plugin directory install/uninstall flow:
 * - Install: pick a path (zip / folder) -> validate plugin.json -> copy to `userData/plugins/<id>/`
 *   -> broadcast refresh. The real implementation lives in `local-install.ts` /
 *   `package-install.ts` (sharing the same validation and upgrade cleanup with the plugin
 *   center's install);
 * - Uninstall: if enabled, disable first (main process unregisters IPC + tells the renderer to
 *   unload) -> delete the directory -> broadcast.
 *
 * The data semantics of uninstall (whether data is cleared too) live in `ipc/plugins.ts`'s
 * `uninstallPlugin()`: it must ask about data and call the `plugin.purge` contribution before
 * deleting the directory, so it does not directly reuse `uninstallExternalPlugin` here (the
 * latter is this "delete only the code directory" third-party semantic).
 */

/** Read and validate plugin.json in a directory */
export function readExternalManifest(dir: string): PluginManifest {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf-8'))
  if (!isValidManifest(raw)) {
    throw new Error('plugin.json 字段不完整或非法')
  }
  return raw as unknown as PluginManifest
}

/** Install an external plugin: dialog path picker (zip / the plugin.json inside a plugin folder) -> validate -> copy */
export async function installExternalPlugin(): Promise<string> {
  // The old "pick a directory to install" entry is kept (the panel now uses the single "install
  // from local" button); internally it reuses the local-install chain: picker + validation +
  // placement have only one implementation (see local-install.ts)
  const src = await pickLocalPluginSource()
  if (!src) throw new Error('未选择插件压缩包或插件文件夹')
  const info = await installPluginFromLocalPath(src)
  return info.id
}

/** Uninstall a third-party plugin: if enabled, disable first (including main-process module unregistration) and then delete the directory (no data-prompt semantics) */
export function uninstallExternalPlugin(id: string): void {
  const found = findExternalPlugin(id)
  if (!found) {
    throw new Error(`插件 '${id}' 不存在`)
  }
  if (isEnabledPlugin(id)) {
    setEnabledOverride(id, false)
    unloadExternalMain(id)
  }
  // If the main module previously failed to load (not in externalMains), unregister once more as a fallback (idempotent)
  unloadExternalMain(id)
  fs.rmSync(found.dir, { recursive: true, force: true })
  invalidateInstalledPluginIds()
  logger.info(`[Plugins] External plugin uninstalled: ${id}`)
  broadcastPluginStateChanged()
}
