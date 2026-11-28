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
 * Main-process plugin host.
 *
 * The app **ships** no plugins (there is no "built-in plugin" form): plugins have exactly one
 * source - a disk package the user installs from the plugin center or from a local zip/directory
 * into `userData/plugins/<id>/`. There is also exactly one load path: `main.cjs` exports
 * `install(ctx)` (CJS) or the module itself is the install function; channels are registered via
 * `ctx.registerIpc({ 'plugin:<ns>:...': handler })`, and disabling calls `ctx.dispose()` to roll
 * everything back in one go (effects LIFO + channel removal + contribution removal).
 *
 * core's role ends there: register its own IPC (`registerCoreIpc`), load/unload plugins according
 * to the persisted enabled state, and push the channel list to the preload allowlist. core knows
 * no plugin module and no plugin channel name.
 *
 * The "built-in plugin" mechanism (bundled package staging / fingerprint self-update / static
 * registry fallback) has been removed entirely: the app package carries no plugin code, and
 * `resources/plugins` and `build:plugins` no longer exist.
 */

/** A loaded plugin main module (key = plugin id) */
interface LoadedExternalMain {
  ctx: MainPluginContextImpl
  teardown: () => void
  /** Plugin package directory at load time (used to purge module cache on unload even if it is not found in the scan results) */
  dir: string
  /**
   * The **content stamp** of the main entry at load time (mtime + byte size).
   *
   * Purpose: after the on-disk package is overwritten in place (plugin center upgrade / local
   * reinstall / workshop publish), `loadExternalMain()` is called again and uses it to decide that
   * the loaded code is stale and must be reloaded. **Do not rely on the version number alone**:
   * reinstalling and republishing the same version keep the version unchanged, and that is the
   * most common upgrade shape.
   */
  stamp: string
}

/** Loaded plugin main modules (key = plugin id) */
const externalMains = new Map<string, LoadedExternalMain>()

/** Run the dispose returned by install first, then roll back the effects, channels and contributions registered on ctx */
function runTeardown(id: string, dispose: void | (() => void), ctx: MainPluginContextImpl): void {
  if (typeof dispose === 'function') {
    try {
      // Cleanup on disable is plugin code too: the same process guard must cover it
      withPluginScope({ id, surface: 'install:dispose' }, dispose)
    } catch (err) {
      logger.warn(`[Plugins] ${id} install dispose failed:`, err)
    }
  }
  ctx.dispose()
}

/**
 * App startup: register core IPC + the preload channel sync entry + load enabled plugins (all from
 * disk packages).
 *
 * Order matters: both `registerCoreIpc()` and the preload channel sync entry
 * (`plugin-channels-sync`) must complete before any window is created - preload runs before page
 * scripts and fetches the allowlist over synchronous IPC; otherwise the first plugin subscription
 * is rejected as "channel not enabled".
 */
export function initPluginHost(): void {
  // Order cannot be changed:
  // (1) the host runtime table (`globalThis.__RB_HOST_RESOLVE__`) must be mounted **before any
  //     plugin main.cjs is required** - `require('@host/main/x')` in a plugin package calls it
  //     immediately;
  // (2) the process guard must be installed before any plugin main.cjs is required (see plugin-guard.ts);
  // (3) core's own IPC and the preload channel sync entry (both before window creation).
  installHostRuntime()
  installPluginProcessGuard()
  registerCoreIpc()
  // System-level features (AI assistant / docs library) are part of core: they start directly,
  // not through the plugin host. They must complete before the preload channel sync, otherwise the
  // renderer's first subscriptions hit "main process has not mounted the channel yet".
  startSystemModules()
  registerPluginChannelsSync()
  initExternalMains()
}

// ---------- Channel list (preload allowlist + event subscription gating) ----------

/** Channels currently held by all enabled plugins (system-level feature channels are not included: the preload system bridge lets them through directly) */
export function activePluginChannels(): string[] {
  return [...externalMains.values()].flatMap((e) => e.ctx.channels)
}

/**
 * Push the enabled plugin channels to the renderer (preload allowlist cache).
 *
 * Note: during startup `initPluginHost()` runs before any window is created, so pushing at that
 * point is lost; therefore it must be pushed again after the window's `did-finish-load` (see
 * browser-window-created in main/index.ts).
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
 * The **synchronous** channel-list entry used by preload at startup (`ipcRenderer.sendSync`).
 *
 * It must be registered before any window is created (the first thing `initPluginHost` does):
 * preload runs before page scripts and fetches the channel allowlist once, so the renderer's first
 * `window.api.plugin.on(...)` does not hit the "push has not arrived yet" race (the plugin
 * Provider subscribes to event channels inside useEffect at this point). Later enable/disable
 * changes are still refreshed incrementally by `pushPluginChannels()`.
 */
function registerPluginChannelsSync(): void {
  ipcMain.on(IPC_PLUGIN_CHANNELS_SYNC, (event) => {
    event.returnValue = activePluginChannels()
  })
}

// ---------- External plugin main-process modules ----------

/**
 * Purge the `require` cache of every module under a plugin directory.
 *
 * Why this is required: a plugin main module is loaded via `require('<plugin dir>/main.cjs')`, and
 * Node caches modules by **absolute path**. On upgrade the on-disk `main.cjs` is overwritten but
 * the cache still holds the old module - requiring it again returns the old object, so when the
 * new renderer calls the new channels the main process only has the old handlers and reports
 * `No handler registered for 'plugin:<id>:…'`; the plugin UI can then only advise
 * "the plugin was just updated, but the app's main process is still running the old version;
 * fully quit and reopen the app" (user feedback 2026-11-23: after adding manual sorting to world
 * timezones, clicking move up/down hit exactly this and required an app restart).
 *
 * Only entries **inside the plugin directory** are deleted: `@host/main/**` is the host's own
 * singleton and bare modules (electron / zod…) also resolve from the app root, so neither is
 * under this prefix and neither is affected - the semantics "plugin main process shares the same
 * core as the host" must be preserved.
 */
function purgePluginModuleCache(dir: string): void {
  const root = path.resolve(dir)
  const prefix = root.endsWith(path.sep) ? root : root + path.sep
  for (const key of Object.keys(require.cache)) {
    const resolved = path.resolve(key)
    if (resolved === root || resolved.startsWith(prefix)) delete require.cache[key]
  }
}

/** The "content stamp" of the plugin main entry (mtime + byte size); `missing` when the entry is absent */
function mainEntryStamp(abs: string): string {
  try {
    const stat = fs.statSync(abs)
    return `${Math.round(stat.mtimeMs)}:${stat.size}`
  } catch {
    return 'missing'
  }
}

/**
 * Load/reload an external plugin main-process module (require CJS; exports install or `{ install }`).
 *
 * **Idempotent and disk-aware**: already loaded and the main entry stamp is unchanged -> return
 * immediately; already loaded but the stamp changed (upgrade / reinstall / a workshop publish just
 * overwrote `userData/plugins/<id>/`) -> run the full teardown first (unregister channels, roll
 * back effects, remove contributions), then reinstall from the new files on disk. This way
 * "update plugin" needs no full app quit: the renderer swaps in the new `renderer.mjs` while the
 * main process swaps in the new `main.cjs`.
 */
export function loadExternalMain(id: string): void {
  const scanned = findExternalPlugin(id)
  if (!scanned) throw new Error(`外部插件 '${id}' 未找到`)
  const entryRel = scanned.manifest.entry?.main ?? 'main.js'
  const abs = path.join(scanned.dir, entryRel)
  if (!fs.existsSync(abs)) {
    // Allow renderer-only plugins (no main-process code); if there was a main module before and
    // the new package removed the entry, remove the old module
    if (externalMains.has(id)) unloadExternalMain(id)
    return
  }

  const stamp = mainEntryStamp(abs)
  const loaded = externalMains.get(id)
  if (loaded) {
    if (loaded.stamp === stamp) return // Already loaded and code unchanged: truly idempotent (repeated enable does not rebuild state)
    logger.info(`[Plugins] Package on disk changed, reloading main module: ${id}`)
    unloadExternalMain(id)
  }

  // The cache may still hold the module from the previous load (disable -> overwrite package ->
  // enable): purge it first so require reads the new file
  purgePluginModuleCache(scanned.dir)

  // Dynamically require an external file (out/main is CJS output)
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
    // install is plugin code: run it in its context, so the most fatal process.exit / abort is
    // intercepted as a load failure (the host keeps starting other plugins) instead of making the whole app vanish.
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
 * **Force-reload** a plugin's main module (called when the on-disk package was just overwritten).
 *
 * Difference from `loadExternalMain`: it ignores the content stamp and always tears down, then
 * requires again. The upgrade path (the install kernel just copied new files into
 * `userData/plugins/<id>/`) uses it to avoid betting on mtime precision: within one install,
 * "delete old files + write new files" can land in the same millisecond while the content has
 * already changed.
 */
export function reloadExternalMain(id: string): void {
  if (externalMains.has(id)) {
    // Keep a verifiable log line: after an upgrade, "the main process really swapped modules" can
    // only be seen from here / the load log; otherwise on-site diagnosis degrades into arguing
    // about "did it restart or not".
    logger.info(`[Plugins] Reloading external plugin main module (package replaced on disk): ${id}`)
    unloadExternalMain(id)
  }
  loadExternalMain(id)
}

/** Unload an external plugin main-process module (unregister IPC + refresh the pushed channel list) */
export function unloadExternalMain(id: string): void {
  const record = externalMains.get(id)
  // The package may also be updated while disabled (panel "reinstall" / plugin center upgrade):
  // purge the module cache as well, otherwise "disable -> upgrade -> enable" still gets the old
  // module (another half of "main process runs old code"). Fall back to the directory recorded at
  // load time: during uninstall the directory is deleted right after, at which point
  // `findExternalPlugin` no longer finds it.
  const dir = record?.dir ?? findExternalPlugin(id)?.dir
  if (dir) purgePluginModuleCache(dir)
  if (!record) return
  record.teardown()
  externalMains.delete(id)
  logger.info(`[Plugins] Unloaded external plugin main module: ${id}`)
  pushPluginChannels()
}

/** Load the main modules of all enabled external plugins at startup */
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
 * Before switching the account data space at runtime: remove all plugin main modules (**without
 * deleting code or data**).
 *
 * Why removal is mandatory: `plugin-state/` holds each account's own settings and data, and plugin
 * main modules may already open files / create databases / start listeners while loaded; swapping
 * directories with them alive is at best a rename failure (Windows handle held) and at worst the
 * plugin keeps writing the previous account's state into the new account's space. Removal returns
 * to the "just started, no plugins loaded yet" state; after the switch,
 * `reloadAllExternalMains()` reloads them from the on-disk packages.
 *
 * @returns The plugin ids actually removed (in load order, for log verification)
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
 * Reload enabled plugin main modules after the switch (exactly the same path as startup).
 *
 * It uses `initExternalMains()` rather than "reinstall only the ones from before": the enabled
 * state may have changed across the switch (a cloud pull writes enabled overrides), so using disk
 * + enabled state as the source of truth avoids missing any.
 */
export function reloadAllExternalMains(): void {
  initExternalMains()
}

/**
 * Final enabled state of an installed plugin: **an explicit override wins; without one it stays
 * disabled**.
 *
 * The app ships no plugins (no built-in plugins at all), so a plugin the user never explicitly
 * enabled is never loaded - defaulting to disabled is also the safe default: installing does not
 * mean letting it run code.
 */
export function isEnabledPlugin(id: string): boolean {
  return getEnabledOverride(id) ?? false
}

// ---------- Read-only diagnostics (tooling/panel verification of "where plugins actually come from") ----------

/** Load source of a plugin main module */
export interface PluginLoadInfo {
  /** Whether a plugin package exists under userData/plugins/<id>/ */
  installed: boolean
  /** package = provided by the disk package; absent = installed but not currently loaded (disabled) */
  source: 'package' | 'absent'
  /** Absolute path of the disk package's main entry (only when installed; tooling uses it to prove the package is answering) */
  file?: string
}

/**
 * Load source of each plugin main module.
 *
 * Why it exists: tooling must assert that "<id>'s handler really comes from
 * userData/plugins/<id>/main.cjs", and that "after uninstall the directory is gone and the package
 * source disappears".
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
  // Plugins whose package is staged but currently disabled (not loaded): also report installed
  // truthfully, so tooling does not mistake "disabled" for "not installed"
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
