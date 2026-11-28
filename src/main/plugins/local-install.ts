import { dialog } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import logger from 'electron-log'
import {
  extractZipToTemp,
  installPackageDir,
  resolvePackageRoot,
  type InstalledPackageInfo
} from './package-install'

/**
 * **Install a plugin from local** (requested by the user on 2026-09-26): one entry point, two
 * source kinds.
 *
 * - `.zip` archive: extract to a temp directory, then install as a plugin package (path traversal
 *   is rejected; the extra top-level directory produced by "compress the whole folder" is stripped
 *   automatically, see `extractZipToTemp`);
 * - plugin **folder** (a build output directory, e.g. `dist/<id>`).
 *
 * Why there is only **one** button: the Windows / Linux system picker **cannot** be a file picker
 * and a directory picker at the same time (the Electron docs state outright that when both
 * properties are given only the directory picker is shown). So a single dialog can offer only one
 * form; here we choose **file** (the vast majority of downloaded plugin packages are zips), and
 * the folder form is expressed as "enter the folder and pick its `plugin.json`" - the dialog's
 * filter names make that explicit, and installation takes the parent directory via `dirname` (see
 * `resolveSource` in this file).
 *
 * For the same reason, the `plugin.json` path is **overridable by tooling** (the picker itself
 * cannot be clicked programmatically, but "how to decide once a path is in hand" is pure logic).
 *
 * Why not use the user-picked directory as the plugin directory directly (symlink / enable in
 * place): the uninstall semantics are "delete `userData/plugins/<id>/`", and enabling in place
 * would mean "what gets deleted is the user's own source directory" - so everything is always
 * **copied into** `userData/plugins/<id>/`, taking the same placement path as installing from the
 * repository.
 */

/**
 * Open the system picker and get one path (null on cancel).
 *
 * One dialog, two filters: `.zip` archives, or the `plugin.json` inside a plugin folder. Native
 * dialogs **cannot be clicked by automation**, so CDP tooling uses the "install by explicit path"
 * IPC (`plugins-install-local`); this only serves the real user's interactive entry.
 */
export async function pickLocalPluginSource(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    title: '选择插件压缩包（.zip），或插件文件夹里的 plugin.json',
    properties: ['openFile'],
    filters: [
      { name: '插件压缩包 (*.zip)', extensions: ['zip'] },
      { name: '插件文件夹里的 plugin.json', extensions: ['json'] }
    ]
  })
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
}

/**
 * Resolve a non-zip path into a "plugin package directory":
 * - directory -> use it as the package directory directly (picking its parent is also allowed, see
 *   `resolvePackageRoot`);
 * - a file named `plugin.json` -> use its parent directory (how "install from folder" is expressed
 *   under a single dialog).
 */
function resolveSource(source: string): string {
  let stat: fs.Stats
  try {
    stat = fs.statSync(source)
  } catch {
    throw new Error(`路径不存在：${source}`)
  }
  if (stat.isDirectory()) {
    return resolvePackageRoot(source)
  }
  if (!stat.isFile()) {
    throw new Error(`只支持插件压缩包（.zip）或插件文件夹：${source}`)
  }
  if (path.basename(source).toLowerCase() === 'plugin.json') {
    return resolvePackageRoot(path.dirname(source))
  }
  throw new Error(
    '请选择插件压缩包（.zip），或进入插件文件夹选择其中的 plugin.json（文件夹必须是插件的构建产物目录）'
  )
}

/** Install by explicit path: a `.zip`, a plugin directory, or the `plugin.json` inside a plugin directory */
export async function installPluginFromLocalPath(source: string): Promise<InstalledPackageInfo> {
  let stat: fs.Stats
  try {
    stat = fs.statSync(source)
  } catch {
    throw new Error(`路径不存在：${source}`)
  }

  // zip: extract to a temp directory then install; delete the temp directory afterwards
  if (stat.isFile() && source.toLowerCase().endsWith('.zip')) {
    const extracted = await extractZipToTemp(source)
    try {
      const info = installPackageDir(extracted)
      logger.info(`[Plugins] Local zip package installed: ${source} -> ${info.dest}`)
      return info
    } finally {
      fs.rmSync(extracted, { recursive: true, force: true })
    }
  }

  return installPackageDir(resolveSource(source))
}
