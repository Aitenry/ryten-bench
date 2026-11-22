import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import logger from 'electron-log'
import { isValidManifest, type PluginManifest } from '../../shared/plugin/types'

/**
 * 外部插件目录扫描（application 目录约定模式，参照 harness/runtime/skills.ts）。
 *
 * 目录约定：userData/plugins/<id>/plugin.json。
 * 目录名即插件 id（manifest.id 需与目录名一致），非法清单跳过并告警。
 */

export interface ScannedExternalPlugin {
  id: string
  dir: string
  manifest: PluginManifest
}

/**
 * **宿主保留 id**：
 * - `host`：`plugin://host/ui.js` 渲染层宿主 UI 桥的地址段，用户插件不能占用；
 * - `harness` / `notes`：已升级为系统级功能，由 `src/main/system-services.ts` 直接装配，
 *   不再从 `userData/plugins/**` 扫描或装载（旧版本残留的插件包会被忽略）。
 */
export const RESERVED_PLUGIN_IDS: ReadonlySet<string> = new Set(['host', 'harness', 'notes'])

/**
 * 已告警过的保留 id。
 *
 * 扫描是热路径（插件列表、查找单插件都会走），旧版本残留的 `userData/plugins/harness`
 * 会跟着每次扫描各告警一次，日志被刷屏反而掩盖真正的问题。按 id 只提示一次即可。
 */
const warnedReservedIds = new Set<string>()

/** 外部插件根目录（userData/plugins），确保存在 */
export function externalPluginsRoot(): string {
  const root = path.join(app.getPath('userData'), 'plugins')
  fs.mkdirSync(root, { recursive: true })
  return root
}

/** 扫描全部外部插件（非法目录/清单跳过） */
export function scanExternalPlugins(): ScannedExternalPlugin[] {
  const root = externalPluginsRoot()
  const out: ScannedExternalPlugin[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch (err) {
    logger.warn('[Plugins] Failed to scan plugin directory:', err)
    return out
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = path.join(root, entry.name)
    const manifestPath = path.join(dir, 'plugin.json')
    try {
      const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
      if (!isValidManifest(raw)) {
        logger.warn(`[Plugins] ${entry.name}: invalid plugin.json fields, skipping`)
        continue
      }
      const manifest = raw as unknown as PluginManifest
      // 目录名与 manifest.id 一致性（协议路由按 manifest.id 寻址）
      if (manifest.id !== entry.name) {
        logger.warn(`[Plugins] ${entry.name}: manifest.id(${manifest.id}) does not match directory name, skipping`)
        continue
      }
      // 保留 id（host 是宿主 UI 桥地址段；harness/notes 是系统级功能）：合法清单也不装载
      if (RESERVED_PLUGIN_IDS.has(entry.name)) {
        if (!warnedReservedIds.has(entry.name)) {
          warnedReservedIds.add(entry.name)
          logger.warn(
            `[Plugins] ${entry.name}: reserved id (host UI bridge / system-level feature), no longer loaded as a plugin, skipping; ` +
              `leftover plugin directories from older versions can be deleted manually: ${dir}`
          )
        }
        continue
      }
      out.push({ id: entry.name, dir, manifest })
    } catch (err) {
      logger.warn(`[Plugins] ${entry.name}: failed to read plugin.json, skipping:`, err)
    }
  }
  return out
}

/** 按 id 查找单个外部插件 */
export function findExternalPlugin(id: string): ScannedExternalPlugin | null {
  return scanExternalPlugins().find((p) => p.id === id) ?? null
}

/**
 * 已安装插件的 id 集合（缓存）。
 *
 * 为什么缓存：插件面板的列表合并要在每次 `plugins-list` 时问「哪些 id 已经装在
 * `userData/plugins/` 下」，而每次都真去 readdir + 解析 N 份 `plugin.json` 太浪费。
 * 安装 / 卸载 / 重装目录之后调 `invalidateInstalledPluginIds()` 刷新。
 *
 * （P5 前它还有个热路径调用方——`builtin.ts` 的过渡共存判断；那张静态注册表已删。）
 */
let installedIdsCache: Set<string> | null = null

/** 已安装插件的 id 集合（含内置铺包与第三方） */
export function installedPluginIds(): Set<string> {
  installedIdsCache ??= new Set(scanExternalPlugins().map((p) => p.id))
  return installedIdsCache
}

/** 目录被改动过（安装/卸载/重装）后刷新缓存 */
export function invalidateInstalledPluginIds(): void {
  installedIdsCache = null
}
