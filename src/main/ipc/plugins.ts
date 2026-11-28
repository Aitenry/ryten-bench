import { ipcMain, BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import logger from 'electron-log'
import { clearEnabledOverride, markInstallRemoved, setEnabledOverride } from '../plugins/store'
import { scanExternalPlugins } from '../plugins/scanner'
import { uninstallExternalPlugin } from '../plugins/lifecycle'
import { withPluginOperation } from '../plugins/operation-lock'
import { isProfileSwitchInProgress, profileMatchesSession } from '../profiles/runtime'
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
 * Plugin management IPC (core, always registered).
 *
 * Source of truth for the list: **whatever is installed under `userData/plugins/<id>/`**. The app
 * no longer ships any plugins (there is no "built-in plugin"), so the list only contains plugins
 * the user installed: disabled by default, enabled automatically by the host after installation.
 *
 * Enable/disable/install/uninstall all broadcast `plugin-state-changed`; the renderer re-fetches
 * the list and diffs the loaded set in response.
 */

/**
 * **Content stamp** of this plugin package on disk: the max mtime of the entry file and
 * `plugin.css`.
 *
 * Used by the renderer to decide "the package changed, so re-fetch renderer.mjs and re-inject
 * plugin.css". A version number cannot replace it — reinstall and in-place upgrade from a local or
 * repository source often keep the same version (observed: after the upgrade the UI still ran the
 * old code because the renderer saw "an entry with the same id is already registered" and skipped
 * reloading).
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
      // Ignore missing files (it is normal for older packages to have no plugin.css)
    }
  }
  return String(Math.round(max))
}

/** Installed plugins and their enabled state (disabled by default; the host enables them explicitly after installation) */
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
      // Package content stamp: the renderer uses it to decide whether to reload this plugin (see packageStamp)
      stamp: packageStamp(ext.dir, ext.manifest.entry),
      // Route/menu metadata from the manifest: the renderer pre-registers it declaratively on the first frame (see shared/plugin/types.ts)
      routes: ext.manifest.routes,
      menu: ext.manifest.menu,
      // "What uninstall would delete": the plugin's own plugin.purge contribution (unavailable while disabled/unloaded; the panel has fallback copy)
      purgeLabel: pluginPurge(ext.id)?.label
    }
  })
}

/**
 * **Internal observer** of plugin state changes (not exposed to the renderer and does not change
 * the `plugin-state-changed` channel contract).
 *
 * Purpose: the plugin center's data sync needs a 5s debounced push after "install/uninstall/
 * enable/disable", and the broadcast happens here — a small hook is more reliable than making the
 * sync module poll the plugin list. Called synchronously like `webContents.send`; exceptions are
 * only logged (one failing observer must not affect the others).
 */
type PluginStateListener = () => void
const pluginStateListeners = new Set<PluginStateListener>()

/** Subscribe to plugin state changes (returns an unsubscribe function) */
export function onPluginStateChanged(listener: PluginStateListener): () => void {
  pluginStateListeners.add(listener)
  return () => {
    pluginStateListeners.delete(listener)
  }
}

/** Broadcast plugin enabled-state changes (including rescan notifications after install/uninstall) */
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
 * Main-process side of enabling/disabling a plugin: load/unload the main module of its on-disk
 * package.
 *
 * Uninstalled ids are not checked here: `loadExternalMain` throws "external plugin '<id>' not
 * found" when the directory is missing, and callers (the panel switch) only fire for installed
 * entries.
 */
function applyEnabled(id: string, enabled: boolean): void {
  if (enabled) loadExternalMain(id)
  else unloadExternalMain(id)
}

/**
 * Uninstall a plugin.
 *
 * @param purgeData User-facing semantics: uninstall itself = **remove plugin code** (delete
 *                  `userData/plugins/<id>/`); `purgeData` only controls **whether plugin data is
 *                  also cleared** (table records + app-managed files). So `false` still
 *                  uninstalls, it just keeps the data around (still usable after reinstall).
 *
 * Order matters:
 * 1. The `plugin.purge` contribution must be invoked while the **plugin is still loaded** (it
 *    reads its own mapper / managed directories);
 * 2. Tear down IPC (`unloadExternalMain`): the renderer then unloads driven by the broadcast;
 * 3. Delete `userData/plugins/<id>/`; 4. record "user explicitly uninstalled", clear the enabled
 *    override; 5. broadcast.
 */
async function uninstallPlugin(id: string, purgeData: boolean): Promise<PluginListEntry[]> {
  /**
   * Same mutex as installation: uninstall deletes the directory while install overwrites it, so
   * the result under concurrency depends entirely on completion order. Typical case: click
   * "update" then immediately "uninstall", uninstall finishes first and install lands afterwards,
   * so the plugin comes back.
   */
  if (isProfileSwitchInProgress() || !profileMatchesSession()) {
    throw new Error('账号数据空间正在切换，请稍候再卸载')
  }
  return await withPluginOperation(id, '正在卸载', () => uninstallPluginInner(id, purgeData))
}

async function uninstallPluginInner(id: string, purgeData: boolean): Promise<PluginListEntry[]> {
  if (!listEntries().some((e) => e.id === id)) {
    throw new Error(`插件 '${id}' 未安装，无法卸载`)
  }

  // 1. Clear data (implemented by the plugin itself; plugins without a purge contribution are
  //    skipped). When not clearing, log a line so that seeing "uninstalled but rows remain in the
  //    DB" later does not suggest purge failed to run
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
         * Local data (table rows / managed files) is cleared, but the cloud data snapshot is
         * kept. Notify the plugin center to drop its local `data_rev` cache: otherwise after a
         * reinstall, pull compares the stale rev against the cloud, wrongly concludes "already up
         * to date", and cloud data never comes back (user, 2026-11-23: "what about data sync from
         * now on").
         */
        emitAppEvent(APP_EVENT_PLUGIN_DATA_PURGED, { pluginId: id })
      } catch (err) {
        // A purge failure must not block uninstall: the directory/channels still have to be
        // removed, otherwise the plugin is left in a dead state where it can be neither
        // installed nor uninstalled
        logger.error(`[Plugins] Failed to purge ${id} data (continuing uninstall):`, err)
      }
    } else {
      logger.warn(
        `[Plugins] ${id} has no plugin.purge contribution; data not purged (directory only)`
      )
    }
  }

  // 2. Tear down the main-process load (on-disk package module)
  unloadExternalMain(id)

  // 3. Delete the directory + 4. bookkeeping (clear the enabled override)
  //
  // Uninstall touches **local state only**: the cloud install record and data snapshot are always
  // kept. An explicit user uninstall leaves a marker; otherwise the plugin center, following the
  // user's saved install record, would "auto-restore" the just-uninstalled plugin on the next sync
  // (user feedback 2026-11-23: "state does not match after uninstall").
  uninstallExternalPlugin(id)
  markInstallRemoved(id)
  clearEnabledOverride(id)

  /**
   * Uninstall touches **local state only**: the cloud install record and data snapshot are always
   * kept.
   *
   * Reason (explicit user position, 2026-11-23): "uninstalling must not uninstall data in cloud
   * storage, only local data, otherwise what about the user's data sync later". The cloud is a
   * per-user backup (restores plugins and settings after switching machines / reinstall); tying it
   * to the uninstall checkbox would silently lose data; "also delete all data for this plugin"
   * only clears **this machine's** table rows and managed files.
   *
   * A normal uninstall does not resurrect automatically: the local `removedInstalls` marker makes
   * machine-switch auto-restore skip it, and the plugin repository/details page shows "not
   * installed" based on local state; reinstalling clears the marker and keeps syncing cloud data.
   */

  logger.info(`[Plugins] Plugin uninstalled: ${id} (cloud install record and data are kept)`)
  broadcastPluginStateChanged()
  return listEntries()
}

/**
 * Common post-install finishing: enable + load the main module.
 *
 * A load failure must not hide the fact that "it is already installed": the thrown error says the
 * directory is in place, so the user does not think nothing happened (same position as install in
 * the plugin center).
 *
 * This must be a **reload**: on upgrade (same id already running) the on-disk package was just
 * overwritten, and a plain load returns early because it is "already loaded", leaving the main
 * process running the old module — exactly the source of "the plugin was just updated but the main
 * process still runs the old version".
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

/** Local install (archive / folder) -> enable and load -> broadcast; on failure returns `{ ok: false, error }` */
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

  // Fetch the enabled list synchronously: the renderer's first frame relies on it to decide "only
  // load plugins the user enabled", otherwise it would load defaults once and unload them
  // afterwards (see the comment on this constant in protocol.ts).
  // listEntries itself is synchronous (reads electron-store + scans the plugin directory
  // synchronously), so it can be used directly as the return value.
  ipcMain.on(IPC_PLUGINS_LIST_SYNC, (event) => {
    try {
      event.returnValue = listEntries()
    } catch (err) {
      logger.warn('[Plugins] Failed to sync plugin list:', err)
      event.returnValue = []
    }
  })

  // The renderer reports the host UI table's "key -> export name" mapping very early at startup
  // (the plugin://host/ui.js bridge is generated from it)
  ipcMain.on(IPC_PLUGIN_HOST_UI_EXPORTS, (_event, names: unknown) => {
    setHostUiExports(names)
    logger.info(
      `[Plugins] Host UI exports reported: ${Object.keys((names ?? {}) as object).length} module keys`
    )
  })

  // Read-only diagnostics: load source of a plugin main module (tooling checks whether the handler is provided by the on-disk package)
  ipcMain.handle(IPC_PLUGINS_LOADED_FROM, () => pluginLoadInfo())

  ipcMain.handle(IPC_PLUGINS_SET_ENABLED, (_event, id: unknown, enabled: unknown) => {
    if (typeof id !== 'string' || typeof enabled !== 'boolean') {
      throw new Error('plugins-set-enabled 参数非法')
    }
    const entry = listEntries().find((e) => e.id === id)
    if (!entry) {
      throw new Error(`插件 '${id}' 不存在`)
    }
    if (entry.enabled === enabled) return listEntries()
    /**
     * Load/unload for real first, and only persist the enabled state on success.
     *
     * The old order was `setEnabledOverride` then `applyEnabled`: when loading failed the IPC call
     * threw and the UI said "switch failed", but the enabled state had already been written, so
     * after a refresh the button showed "enabled" while the runtime state was error, and on
     * restart the app would try to load a broken plugin. Here failures roll back to the previous
     * state and broadcast, keeping the persisted state consistent with reality.
     */
    try {
      applyEnabled(id, enabled)
    } catch (err) {
      try {
        applyEnabled(id, entry.enabled)
      } catch (rollbackErr) {
        logger.warn(
          `[Plugins] Failed to roll back '${id}' to its previous enabled state:`,
          rollbackErr
        )
      }
      broadcastPluginStateChanged()
      throw new Error(
        `插件 '${id}' ${enabled ? '启用' : '停用'}失败：${err instanceof Error ? err.message : String(err)}`
      )
    }
    setEnabledOverride(id, enabled)
    logger.info(`[Plugins] ${id} -> ${enabled ? 'enabled' : 'disabled'}`)
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
   * Install a plugin from a **local path** (a `.zip` or a plugin package directory).
   *
   * Shares the same landing and validation flow as installation from the plugin center
   * (`package-install.ts`), so the semantics are identical: enable + load + broadcast right after
   * installation; on failure returns `{ ok: false, error }` instead of throwing, and the panel
   * shows the hint from it (missing path, no plugin.json in the package, etc. all take this path).
   */
  ipcMain.handle(IPC_PLUGINS_INSTALL_LOCAL, async (_event, source: unknown) => {
    if (typeof source !== 'string' || source === '') {
      throw new Error('plugins-install-local 需要压缩包或插件目录的路径')
    }
    return await installLocalAndEnable(source)
  })

  /**
   * Open a system picker to choose a local source and install it (the panel's **only** local
   * install entry point).
   *
   * One dialog, two filters: a `.zip` archive, or the `plugin.json` inside a plugin folder
   * (Windows system dialogs cannot select files and directories at the same time, see the notes in
   * local-install.ts). Cancel returns `{ ok: true, canceled: true }` — cancel is not failure, so
   * the panel shows no error.
   */
  ipcMain.handle(IPC_PLUGINS_PICK_LOCAL, async () => {
    const source = await pickLocalPluginSource()
    if (!source) return { ok: true as const, canceled: true as const }
    return await installLocalAndEnable(source)
  })
}
