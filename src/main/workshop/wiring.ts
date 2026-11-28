import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import logger from 'electron-log'
import {
  isEnabledPlugin,
  reloadExternalMain,
  unloadExternalMain
} from '../plugins/host'
import { scanExternalPlugins } from '../plugins/scanner'
import { installPackageDir } from '../plugins/package-install'
import { uninstallExternalPlugin } from '../plugins/lifecycle'
import { setEnabledOverride } from '../plugins/store'
import { broadcastPluginStateChanged } from '../ipc/plugins'
import { hostRuntimeKeys } from '../plugins/runtime'
import { hostUiExportKeys } from '../plugins/host-ui-bridge'
import { settingsStore } from '../context'
import type { HarnessSettings } from '../types/settings'
import { isSamePath, migrateStorageDirectory } from '../storage/migration'
import { probeRendererPlugin } from './probe'
import { configureWorkshopHost, createNodeLoader } from './host'
import { resolveLoaderBases } from './loader-bases'
import { configurePluginsRoot } from './paths'
import { migrateLegacyDrafts } from './service'

/**
 * Wiring between the workshop and the application host (**the only** place that connects
 * workshop capabilities to the real app).
 *
 * Why a separate file: the rest of `main/workshop/**` deliberately avoids importing electron
 * / core (so the offline tooling can run the whole "generate → build → verify → publish"
 * chain); everything that exists only in the app is injected in one place here, so reading
 * this file shows exactly what the workshop borrows from the host:
 *
 * | Borrowed | Source | Used for |
 * |----------|--------|----------|
 * | Package install | `package-install.installPackageDir` | Publish (same validation/upgrade cleanup as "install from local") |
 * | Enable / disable | `store.setEnabledOverride` + `host.load/unloadExternalMain` | Enable right after install; disable only unloads the module |
 * | Uninstall | `lifecycle.uninstallExternalPlugin` | Third-party plugin semantics: delete code, keep data |
 * | Host runtime table | `runtime.hostRuntimeKeys` | Verify main-process `@host/**` specifiers during acceptance |
 * | Host UI table | `host-ui-bridge.hostUiExportKeys` | Verify renderer host specifiers during acceptance |
 * | Module loader | `createNodeLoader` (app root / asar.unpacked) | esbuild, tailwindcss, jszip |
 * | Renderer probe | `probe.probeRendererPlugin` | Import + install once in the real UI |
 */

/**
 * Candidate bases for the module loader (order is priority; constraints and pitfalls live in
 * `./loader-bases.ts`).
 *
 * In one sentence: **`app.asar.unpacked` must come before `app.asar`** — files inside asar
 * are visible to `require` but not to `spawn`, and with the order reversed `esbuild`
 * "resolves successfully" and then spawns a non-existent
 * `app.asar\…\@esbuild\win32-x64\esbuild.exe`.
 */
function loaderBases(): string[] {
  return resolveLoaderBases({
    resourcesPath: (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath,
    appPath: app.getAppPath()
  })
}

/**
 * Occupied channel namespaces (collision check, including plugins that are installed but
 * currently disabled).
 *
 * **Scans installed plugins only** (not the live channel table): a channel name does not
 * reveal the owning plugin id, so "the draft itself is installed" would be reported as a
 * conflict; the installed manifest is both authoritative and sufficient — channels can only
 * come from installed plugins.
 *
 * @param exceptId plugin id to exclude (the draft itself: its namespace is obviously its own)
 */
function usedNamespaces(exceptId?: string): string[] {
  const namespaces = new Set<string>()
  for (const plugin of scanExternalPlugins()) {
    if (plugin.id === exceptId) continue
    namespaces.add(plugin.id.startsWith('plugin.') ? plugin.id.slice('plugin.'.length) : plugin.id)
  }
  return [...namespaces]
}

/**
 * Workshop root directory (`<userData>/plugin-workshop`).
 *
 * Holds **only workshop-owned data**: build outputs, acceptance reports, exported zips, and
 * the legacy draft directory (for migration). Plugin source lives under the user-configured
 * "plugins path" (`pluginsPath` in the `harness` settings; on first launch it is preset to
 * `<install dir>/data/plugins`, the user may change it, and data migrates along with it) —
 * this userData directory deliberately does not appear on the settings page (user decision
 * 2026-09-27: "don't show this directory on the settings page").
 */
export function workshopRootDir(): string {
  return path.join(app.getPath('userData'), 'plugin-workshop')
}

/** User-configured plugins path (empty string when not configured) */
function configuredPluginsRoot(): string {
  const settings = settingsStore.get('harness') as HarnessSettings | undefined
  return typeof settings?.pluginsPath === 'string' ? settings.pluginsPath : ''
}

/** Persist the "plugins path" (writes it into the harness settings) */
function persistPluginsRoot(dir: string): void {
  const current = (settingsStore.get('harness') as HarnessSettings | undefined) ?? {}
  settingsStore.set('harness', { ...current, pluginsPath: dir || undefined })
  logger.info(`[Workshop] Plugins path updated: ${dir || '(cleared)'}`)
}

/**
 * Explicitly set the "plugins path" and **apply it immediately** (no restart).
 *
 * The plugin center's "import local plugin directory" needs this: the user picks the root of
 * their own plugin sources and expects those directories to show up in "plugin" mode right
 * away (editable in conversation). Writing settings alone is not enough —
 * `configurePluginsRoot` holds module state injected at startup, and without re-injecting it
 * the process keeps using the old path. Called by `ipc/lattice.ts`; both persistence and
 * runtime injection live here so they cannot drift apart.
 *
 * Plugin sources in the old path are migrated to the new one first (the user explicitly
 * changing the storage location means data follows); if migration fails it throws and the
 * setting keeps its old value.
 */
export function applyPluginsRoot(dir: string): {
  dir: string
  /**
   * Plugins root before the change (lets the caller rewrite old plugin workspace rows under
   * the new root).
   */
  previousDir?: string
} {
  const resolved = path.resolve(dir)
  const previous = configuredPluginsRoot()
  const changed = Boolean(previous) && !isSamePath(previous, resolved)
  if (changed) {
    const result = migrateStorageDirectory('plugins', previous, resolved)
    logger.info(
      `[Workshop] Plugins path changed: ${previous} -> ${resolved} ` +
        `(${result.moved.length} top-level item(s) migrated, ${result.conflicts.length} conflict(s))`
    )
    for (const warning of result.warnings) logger.warn(`[Workshop] ${warning}`)
    for (const conflict of result.conflicts) {
      logger.warn(
        `[Workshop] Plugins target already had "${conflict}"; kept it and preserved the old copy as *.migrated-*`
      )
    }
  }
  persistPluginsRoot(resolved)
  configurePluginsRoot(resolved)
  return { dir: resolved, ...(changed ? { previousDir: previous } : {}) }
}

/**
 * Wires everything up (called from the startup assembly in `src/main/system/harness.ts`).
 */
export function installWorkshopHost(): void {
  const root = workshopRootDir()
  fs.mkdirSync(root, { recursive: true })
  const loader = createNodeLoader(loaderBases())

  // Plugins path comes from settings (preset to the install dir on first launch): inject it on
  // load; once the user clears it, all draft-related actions are refused
  configurePluginsRoot(configuredPluginsRoot())

  configureWorkshopHost({
    root,
    loader,
    hostMainKeys: () => hostRuntimeKeys(),
    hostUiKeys: () => hostUiExportKeys(),
    isInstalled: (id) => scanExternalPlugins().some((plugin) => plugin.id === id),
    isEnabled: (id) => isEnabledPlugin(id),
    usedNamespaces,
    installPackage: (dir) => installPackageDir(dir),
    enable: (id) => {
      setEnabledOverride(id, true)
      // Publish = "install into userData and enable immediately": the on-disk package was just
      // overwritten while the plugin is still enabled in upgrade scenarios, so the main module
      // must be reloaded. Otherwise the new renderer calls new channels while the main process
      // only has the old handlers — the user sees "the plugin was just updated, but the app's
      // main process is still running the old version, please quit and reopen the app"
      // (reported 2026-11-23: global time zones gained manual ordering, and up/down raised this).
      reloadExternalMain(id)
    },
    disable: (id) => {
      setEnabledOverride(id, false)
      unloadExternalMain(id)
    },
    uninstall: (id) => uninstallExternalPlugin(id),
    setPluginsRoot: (dir) => persistPluginsRoot(dir),
    // "Workshop state changed" is broadcast by ipc/workshop.ts (panel refresh); here we
    // broadcast the **host** `plugin-state-changed` — that is what makes the renderer refetch
    // the plugin list, grab the new plugin's renderer.mjs from plugin:// and register its
    // menu/route. Miss this line and the plugin installs and its channels work, but the
    // sidebar/settings page never appears (seen on a real machine 2026-09-27, easily mistaken
    // for "the plugin was not installed").
    notify: () => broadcastPluginStateChanged(),
    probeRenderer: (id) => {
      // The probe loads outputs through `plugin://<id>/…`: not-installed plugins get no file
      // (404) and disabled plugins get 403. Both cases are honestly reported as skip (a
      // re-check runs automatically after publishing).
      if (!scanExternalPlugins().some((plugin) => plugin.id === id)) {
        return Promise.resolve({
          status: 'skip',
          detail: '插件尚未安装：渲染层探针在发布后自动复验（或安装后重跑验收）'
        })
      }
      if (!isEnabledPlugin(id)) {
        return Promise.resolve({
          status: 'skip',
          detail: '插件已安装但处于停用状态：启用后再跑验收即可覆盖渲染层探针'
        })
      }
      return probeRendererPlugin(id)
    }
  })

  // Older versions kept sources in userData/plugin-workshop/drafts/: now pluginsPath may be
  // auto-preset from the install directory, so existing users never go through "pick a path
  // manually" again; migrate historical drafts to the current plugins path at startup.
  const pluginsRoot = configuredPluginsRoot()
  if (pluginsRoot) {
    try {
      const moved = migrateLegacyDrafts(pluginsRoot)
      if (moved.length > 0) {
        logger.info(
          `[Workshop] Migrated ${moved.length} legacy draft(s) to plugins path: ${pluginsRoot}`
        )
      }
    } catch (err) {
      logger.warn('[Workshop] Failed to migrate legacy drafts (workshop still usable):', err)
    }
  }

  logger.info(
    `[Workshop] Plugin workshop wired: internal directory ${root}; plugins path ${configuredPluginsRoot() || '(not configured)'} ` +
      `(loader bases ${loaderBases().join(' / ')})`
  )
}

/**
 * Removes the wiring (app exit = workshop unavailable; tools and channels return readable
 * errors).
 */
export function uninstallWorkshopHost(): void {
  configureWorkshopHost(null)
  configurePluginsRoot('')
}
