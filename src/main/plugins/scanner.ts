import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import logger from 'electron-log'
import { isValidManifest, type PluginManifest } from '../../shared/plugin/types'

/**
 * External plugin directory scan (application directory convention pattern).
 *
 * Directory convention: userData/plugins/<id>/plugin.json.
 * The directory name is the plugin id (manifest.id must match the directory name); invalid
 * manifests are skipped with a warning.
 */

export interface ScannedExternalPlugin {
  id: string
  dir: string
  manifest: PluginManifest
}

/**
 * **Host reserved ids**:
 * - `host`: the address segment of the renderer host UI bridge at `plugin://host/ui.js`, which
 *   user plugins must not take over;
 * - `harness` / `notes`: upgraded to system-level features, assembled directly by
 *   `src/main/system/`, no longer scanned or loaded from `userData/plugins/**` (leftover plugin
 *   packages from older versions are ignored).
 */
export const RESERVED_PLUGIN_IDS: ReadonlySet<string> = new Set(['host', 'harness', 'notes'])

/**
 * Reserved ids that have already been warned about.
 *
 * Scanning is a hot path (the plugin list and single-plugin lookups both go through it), and a
 * leftover `userData/plugins/harness` from an older version would warn on every scan, flooding the
 * log and hiding real problems. Warning once per id is enough.
 */
const warnedReservedIds = new Set<string>()

/** External plugin root directory (userData/plugins), created if needed */
export function externalPluginsRoot(): string {
  const root = path.join(app.getPath('userData'), 'plugins')
  fs.mkdirSync(root, { recursive: true })
  return root
}

/** Scan all external plugins (invalid directories/manifests are skipped) */
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
      // Directory name and manifest.id consistency (protocol routing addresses by manifest.id)
      if (manifest.id !== entry.name) {
        logger.warn(`[Plugins] ${entry.name}: manifest.id(${manifest.id}) does not match directory name, skipping`)
        continue
      }
      // Reserved ids (host is the host UI bridge address segment; harness/notes are system-level
      // features): valid manifests are not loaded either
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

/** Find a single external plugin by id */
export function findExternalPlugin(id: string): ScannedExternalPlugin | null {
  return scanExternalPlugins().find((p) => p.id === id) ?? null
}

/**
 * Installed plugin id set (cached).
 *
 * Why cache: the plugin panel's list merge asks "which ids are already installed under
 * `userData/plugins/`" on every `plugins-list`, and really doing readdir + parsing N
 * `plugin.json` files each time is too wasteful. Call `invalidateInstalledPluginIds()` to refresh
 * after install / uninstall / reinstalling the directory.
 */
let installedIdsCache: Set<string> | null = null

/** Installed plugin id set */
export function installedPluginIds(): Set<string> {
  installedIdsCache ??= new Set(scanExternalPlugins().map((p) => p.id))
  return installedIdsCache
}

/** Refresh the cache after the directory was changed (install/uninstall/reinstall) */
export function invalidateInstalledPluginIds(): void {
  installedIdsCache = null
}
