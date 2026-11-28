import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { LlmProviderInput, LlmProviderConfig } from '../main/database/mapper/provider'
import type { SystemSettings } from '../main/types/settings'
import type { PluginListEntry } from '../shared/plugin/types'
import { PLUGIN_CHANNEL_RE } from '../shared/plugin/protocol'
import { LATTICE_IPC } from '../main/lattice/types'
import type {
  HubDetail,
  HubListResult,
  LatticeAutoInstallSettingResult,
  LatticeDownloadAssetKind,
  LatticeDownloadAssetResult,
  LatticeImportLocalDirResult,
  LatticeInstallResult,
  LatticeInstallSummary,
  LatticeListQuery,
  LatticeLocalSourcePathResult,
  LatticeLoginInput,
  LatticeLoginResult,
  LatticeMeResult,
  LatticeOpenSourceResult,
  LatticeRepublishInput,
  LatticeRepublishResult,
  LatticeSetBaseUrlResult,
  LatticeSetPluginRootResult,
  LatticeSourcePathResult,
  LatticeStatus,
  LatticeSyncDetails,
  LatticeSyncInput,
  LatticeSyncResult,
  LatticeSyncConflict,
  LatticeResolveConflictResult,
  LatticeMergeDataResult,
  LatticeUploadProgress,
  LatticeUploadResult
} from '../main/lattice/types'

/**
 * Allowed prefixes for system-level feature channels.
 *
 * These channels belong to features compiled into the app, not loadable code, so they do not
 * need the "enabled channel allowlist"; the prefix is still checked on the preload side so that
 * third-party plugins (which only have `window.api.plugin`) cannot reach them.
 */
const SYSTEM_CHANNEL_RE = /^(harness|notes):[a-z0-9-]+$/

/**
 * Cache of the enabled-plugin channel allowlist (authoritative registry in the main process,
 * refreshed by the plugin-channels-updated push).
 * Only a fast gate on the preload side: the real authoritative check is in the main process
 * (the channel belongs to the plugin and the plugin is enabled).
 */
const enabledPluginChannels = new Set<string>()
const applyPluginChannels = (list: unknown): void => {
  enabledPluginChannels.clear()
  if (Array.isArray(list)) {
    for (const channel of list) {
      if (typeof channel === 'string') enabledPluginChannels.add(channel)
    }
  }
}

ipcRenderer.on('plugin-channels-updated', (_event, list: unknown) => {
  applyPluginChannels(list)
})

// Startup race fix: the push (including the did-finish-load re-push) arrives later than the
// renderer's first frame, so the plugin Provider hits "allowlist not here yet" when subscribing
// to event channels in useEffect. preload runs before page scripts, so fetch the authoritative
// list synchronously here and make the very first window.api.plugin.on(...) see the right result.
try {
  applyPluginChannels(ipcRenderer.sendSync('plugin-channels-sync'))
} catch {
  // Main process entry not registered yet (abnormal startup path): fall back to push-only mode
}

interface WeatherData {
  location: string
  current: {
    temp: string
    weatherCode: number
    weatherDesc: string
    windSpeed: string
    humidity: number
    apparentTemp: string
  }
  daily: {
    label: string
    weatherDesc: string
    tempMax: string
    tempMin: string
    precipProb: number
  }[]
}

// Custom APIs for renderer
// System features (AI assistant / notes) go through `api.system` (plain harness:* / notes:*
// channels); third-party plugins go through the generic bridge `api.plugin.invoke/on` (channels
// plugin:<namespace>:*, allowlist pushed by the main process). Only core shell capabilities live here.
const api = {
  file: {
    selectImageFile: (allowImages?: boolean) =>
      ipcRenderer.invoke('select-image-file', allowImages),
    selectTextFile: () =>
      ipcRenderer.invoke('select-text-file') as Promise<{
        fileName: string
        filePath: string
      } | null>,
    // Get the real disk path of a clipboard/drag File; returns an empty string when there is no on-disk file (e.g. an image copied from a web page)
    getPathForFile: (file: File) => {
      try {
        return webUtils.getPathForFile(file)
      } catch {
        return ''
      }
    }
  },
  lock: {
    /** Lock-screen snapshot held by the main process (the digest is never sent down) */
    getState: () => ipcRenderer.invoke('lock-screen-state'),
    /** Lock manually (Esc); the main process does not lock when disabled / no unlock code is set */
    lock: () => ipcRenderer.invoke('lock-screen-lock'),
    /** Unlock: verification is done in the main process (salted scrypt + backoff) */
    unlock: (code: string) => ipcRenderer.invoke('lock-screen-unlock', code),
    /** Toggle / auto-lock duration (persistence also happens in the main process) */
    configure: (patch: { enabled?: boolean; autoLockMinutes?: number }) =>
      ipcRenderer.invoke('lock-screen-configure', patch),
    /** Change code: the old password is verified in the main process and the new digest is written only after success */
    changeCode: (oldCode: string, newCode: string) =>
      ipcRenderer.invoke('lock-screen-change-code', oldCode, newCode),
    /** Lock-state push (auto lock / manual lock / unlock; returns an unsubscribe function) */
    onChanged: (callback: (state: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, state: unknown): void => {
        callback(state)
      }
      ipcRenderer.on('lock-screen-changed', listener)
      return () => {
        ipcRenderer.removeListener('lock-screen-changed', listener)
      }
    }
  },
  providers: {
    getAll: () => ipcRenderer.invoke('provider-get-all') as Promise<LlmProviderConfig[]>,
    getById: (id: number) =>
      ipcRenderer.invoke('provider-get-by-id', id) as Promise<LlmProviderConfig | null>,
    getDefault: () =>
      ipcRenderer.invoke('provider-get-default') as Promise<LlmProviderConfig | null>,
    getEnabled: () => ipcRenderer.invoke('provider-get-enabled') as Promise<LlmProviderConfig[]>,
    create: (input: LlmProviderInput) =>
      ipcRenderer.invoke('provider-create', input) as Promise<number>,
    createBatch: (inputs: LlmProviderInput[]) =>
      ipcRenderer.invoke('provider-create-batch', inputs) as Promise<{
        created: number
        skipped: number
      }>,
    update: (id: number, updates: Partial<LlmProviderInput>) =>
      ipcRenderer.invoke('provider-update', id, updates) as Promise<boolean>,
    delete: (id: number) => ipcRenderer.invoke('provider-delete', id) as Promise<boolean>,
    deleteBatch: (ids: number[]) =>
      ipcRenderer.invoke('provider-delete-batch', ids) as Promise<number>,
    setDefault: (id: number) => ipcRenderer.invoke('provider-set-default', id) as Promise<boolean>,
    lookupProfile: (modelId: string) =>
      ipcRenderer.invoke('provider-lookup-profile', modelId) as Promise<Record<
        string,
        unknown
      > | null>,
    fetchModels: (
      providerType: string,
      baseUrl?: string,
      apiKey?: string
    ): Promise<{ id: string; metadata: Record<string, unknown> | null }[]> =>
      ipcRenderer.invoke('provider-fetch-models', providerType, baseUrl, apiKey),
    onChanged: (callback: () => void) => {
      const handler = (): void => callback()
      ipcRenderer.on('providers-changed', handler)
      return () => {
        ipcRenderer.off('providers-changed', handler)
      }
    }
  },
  systemSettings: {
    getAll: () => ipcRenderer.invoke('system-settings-get-all') as Promise<SystemSettings>,
    update: (updates: Partial<SystemSettings>) =>
      ipcRenderer.invoke('system-settings-update', updates) as Promise<boolean>
  },
  window: {
    minimize: () => ipcRenderer.send('window-minimize'),
    maximize: () => ipcRenderer.send('window-maximize'),
    close: () => ipcRenderer.send('window-close'),
    isMaximized: () => ipcRenderer.invoke('window-is-maximized') as Promise<boolean>,
    onMaximized: (callback: (maximized: boolean) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, maximized: boolean): void => {
        callback(maximized)
      }
      ipcRenderer.on('window-maximized', handler)
      return () => {
        ipcRenderer.off('window-maximized', handler)
      }
    },
    /**
     * Theme sync for the custom title bar and the system window controls overlay
     * (Window Controls Overlay). Only affects the colors of the system-drawn buttons and the
     * title bar background, not button behavior.
     */
    setTitleBarOverlay: (options: { color?: string; symbolColor?: string; height?: number }) => {
      ipcRenderer.send('window-titlebar-overlay', options)
    },
    /** Make the system window border/title bar follow the app theme (no dark DWM border left on top of a light-themed app) */
    setNativeTheme: (mode: 'light' | 'dark' | 'system') => {
      ipcRenderer.send('window-native-theme', mode)
    },
    /** Set the window title (native title bar: content - RytenBench) */
    setTitle: (title: string) => ipcRenderer.send('window-set-title', title),
    /** Reload the current window (title bar "App → Reload") */
    reload: () => ipcRenderer.send('window-reload'),
    /** Quit the app (title bar "App → Quit"; normal quit cleanup, not hide-to-tray) */
    quit: () => ipcRenderer.send('app-quit'),
    /** Edit commands (title bar "Edit" menu): delegated to the main process to invoke native webContents edit actions */
    edit: (command: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll') => {
      ipcRenderer.send('window-edit-command', command)
    }
  },
  /** Current platform (the renderer uses it to decide whether to draw the custom title bar and whether to leave room for the macOS traffic lights) */
  platform: process.platform as NodeJS.Platform,
  mermaid: {
    preview: (svg: string) => ipcRenderer.invoke('mermaid-preview', svg) as Promise<void>
  },
  weather: {
    getCurrent: (force?: boolean) =>
      ipcRenderer.invoke('weather-get', force) as Promise<WeatherData>,
    onUpdate: (callback: (data: WeatherData) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: WeatherData): void => callback(data)
      ipcRenderer.on('weather-update', handler)
      return () => {
        ipcRenderer.off('weather-update', handler)
      }
    }
  },
  /** Channel bridge for system-level features (AI assistant / notes): plain `harness:*` / `notes:*`, not through the plugin host */
  system: {
    /** Invoke a system feature channel; a mismatched prefix is rejected outright (third-party plugins cannot get this bridge) */
    invoke: (channel: string, ...args: unknown[]) => {
      if (typeof channel !== 'string' || !SYSTEM_CHANNEL_RE.test(channel)) {
        throw new Error(`非法系统通道名: ${String(channel)}`)
      }
      return ipcRenderer.invoke(channel, ...args) as Promise<unknown>
    },
    /** Subscribe to a system feature event channel (returns an unsubscribe function) */
    on: (channel: string, callback: (data: unknown) => void) => {
      if (typeof channel !== 'string' || !SYSTEM_CHANNEL_RE.test(channel)) {
        throw new Error(`非法系统通道名: ${String(channel)}`)
      }
      const handler = (_event: Electron.IpcRendererEvent, data: unknown): void => callback(data)
      ipcRenderer.on(channel, handler)
      return () => {
        ipcRenderer.off(channel, handler)
      }
    }
  },
  plugin: {
    list: () => ipcRenderer.invoke('plugins-list') as Promise<PluginListEntry[]>,
    /**
     * Fetch the plugin list once **synchronously** (including enable state).
     *
     * The renderer host must decide synchronously during construction which built-in plugins to
     * load (the first frame needs routes/menus, and it must not load a user-disabled plugin first
     * and unload it afterwards — that would make the disabled plugin's Provider subscribe to
     * channels that do not exist). Only sync IPC can get the main process's authoritative enable
     * state at that moment; on failure fall back to an empty array so callers use defaults.
     */
    listSync: (): PluginListEntry[] => {
      try {
        const list = ipcRenderer.sendSync('plugins-list-sync')
        return Array.isArray(list) ? (list as PluginListEntry[]) : []
      } catch {
        return []
      }
    },
    /**
     * Read-only diagnostics: host lifecycle hooks contributed by each plugin in the main process
     * (count + labels) and the number of workspace event subscriptions. Used to verify that
     * "after disabling a plugin the hooks no longer run" (see main/ipc/misc.ts).
     */
    lifecycleHooks: () =>
      ipcRenderer.invoke('app-lifecycle-hooks') as Promise<{
        preload: string[]
        beforeQuit: string[]
        memoryDump: string[]
        workspaceListeners: number
      }>,
    /**
     * Read-only diagnostics: **where** each plugin's main module comes from.
     *
     * During the transitional coexistence period the same plugin may come from an on-disk package
     * (`userData/plugins/<id>/main.cjs`) or from the static registry (fallback when the packaging
     * script has not run in dev), and `plugins-list` cannot tell the source apart. Tooling uses
     * this to assert "the music handler is really served by the on-disk package".
     */
    loadedFrom: () =>
      ipcRenderer.invoke('plugins-loaded-from') as Promise<
        Record<string, { installed: boolean; source: 'package' | 'absent'; file?: string }>
      >,
    /**
     * Read-only diagnostics: row counts of several tables (used by tooling to verify "after
     * uninstalling and purging data, the plugin tables have 0 rows").
     * Table names are passed by the caller and validated against an identifier allowlist; core
     * contains no plugin table-name constants.
     */
    tableCounts: (tables: string[]) =>
      ipcRenderer.invoke('app-table-counts', tables) as Promise<Record<string, number>>,
    setEnabled: (id: string, enabled: boolean) =>
      ipcRenderer.invoke('plugins-set-enabled', id, enabled) as Promise<PluginListEntry[]>,
    /**
     * Install a plugin from a **local path**: a `.zip` archive, a plugin package directory, or
     * the `plugin.json` inside that directory.
     *
     * Same validation and installation semantics as installing from the plugin hub: it is
     * enabled and loaded automatically after install. On failure it does not throw, returning
     * `{ ok: false, error }` (path does not exist, no plugin.json in the package, ...).
     */
    installLocal: (source: string) =>
      ipcRenderer.invoke('plugins-install-local', source) as Promise<{
        ok: boolean
        canceled?: boolean
        id?: string
        name?: string
        version?: string
        upgraded?: boolean
        error?: string
      }>,
    /**
     * Show a system chooser to pick a local source and install it (the panel's **only** local
     * install entry). Returns `{ ok: true, canceled: true }` when the user cancels (cancel is
     * not an error).
     */
    installLocalFromDialog: () =>
      ipcRenderer.invoke('plugins-pick-local') as Promise<{
        ok: boolean
        canceled?: boolean
        id?: string
        name?: string
        version?: string
        upgraded?: boolean
        error?: string
      }>,
    /**
     * Uninstall a plugin (= remove the plugin code).
     *
     * `purgeData` only decides **whether data is purged too**: true = call the plugin's
     * `plugin.purge` to delete its table records and app-managed files; false = delete only the
     * plugin directory and leave the data in the database (still usable after reinstalling).
     */
    uninstall: (id: string, purgeData: boolean) =>
      ipcRenderer.invoke('plugins-uninstall', id, purgeData) as Promise<PluginListEntry[]>,
    /**
     * Report the host UI table's "key → export name" (once, very early during renderer startup).
     * The main process's `plugin://host/ui.js?m=<key>` bridge generates ESM named exports from
     * this list.
     */
    reportHostUi: (names: Record<string, string[]>) => {
      ipcRenderer.send('plugin-host-ui-exports', names)
    },
    onStateChanged: (callback: () => void) => {
      const handler = (): void => callback()
      ipcRenderer.on('plugin-state-changed', handler)
      return () => {
        ipcRenderer.off('plugin-state-changed', handler)
      }
    },
    /** External plugin channel call: strict prefix format validation; unregistered channels throw in the main process */
    invoke: (channel: string, ...args: unknown[]) => {
      if (typeof channel !== 'string' || !PLUGIN_CHANNEL_RE.test(channel)) {
        throw new Error(`非法插件通道名: ${String(channel)}`)
      }
      return ipcRenderer.invoke(channel, ...args) as Promise<unknown>
    },
    /**
     * Subscribe to a plugin event channel.
     *
     * Only the channel name format is strictly validated; **the allowlist is advisory and no
     * longer throws**. Reason (an incident observed on 2026-09-26): the allowlist is a cache of
     * channels loaded in the main process and can naturally lag behind the renderer (the window
     * after a plugin is disabled, a failed plugin module load in the main process, HMR reload
     * ordering in dev, ...). This used to throw directly, the exception escaped the plugin
     * Provider's useEffect → the ErrorBoundary took over → the whole UI turned into "RUNTIME
     * ERROR". The current semantics: subscribe as usual (the main process remains authoritative —
     * no one posts to that channel if the plugin is not loaded) and merely log a warning when the
     * channel is not in the allowlist at that moment.
     */
    on: (channel: string, callback: (data: unknown) => void) => {
      if (typeof channel !== 'string' || !PLUGIN_CHANNEL_RE.test(channel)) {
        throw new Error(`非法插件通道名: ${String(channel)}`)
      }
      if (!enabledPluginChannels.has(channel)) {
        console.warn(
          `[plugin] Subscribed channel is not enabled (the main process is authoritative; no events until the plugin loads): ${channel}`
        )
      }
      const handler = (_event: Electron.IpcRendererEvent, data: unknown): void => callback(data)
      ipcRenderer.on(channel, handler)
      return () => {
        ipcRenderer.off(channel, handler)
      }
    }
  },
  /**
   * Lattice plugin hub (core channels: login / catalog / upload / download install / data sync).
   *
   * Unlike the plugin bridge, these channels **bypass** the plugin allowlist: they are app shell
   * capabilities registered permanently by `src/main/ipc/lattice.ts`. Event subscriptions all
   * return an unsubscribe function.
   */
  lattice: {
    status: () => ipcRenderer.invoke(LATTICE_IPC.status) as Promise<LatticeStatus>,
    login: (input: LatticeLoginInput) =>
      ipcRenderer.invoke(LATTICE_IPC.login, input) as Promise<LatticeLoginResult>,
    logout: () => ipcRenderer.invoke(LATTICE_IPC.logout) as Promise<{ ok: boolean }>,
    me: () => ipcRenderer.invoke(LATTICE_IPC.me) as Promise<LatticeMeResult>,
    setBaseUrl: (url: string) =>
      ipcRenderer.invoke(LATTICE_IPC.setBaseUrl, url) as Promise<LatticeSetBaseUrlResult>,
    /** Plugin catalog (pagination/search/category) */
    list: (query?: LatticeListQuery) =>
      ipcRenderer.invoke(LATTICE_IPC.hubList, query ?? {}) as Promise<HubListResult>,
    /** Plugin details (including readme / version list / my install record) */
    detail: (pluginId: string) =>
      ipcRenderer.invoke(LATTICE_IPC.hubDetail, pluginId) as Promise<HubDetail | null>,
    /** Publish a locally installed plugin directly (install package + source, no chooser dialog) */
    publishInstalled: (pluginId: string) =>
      ipcRenderer.invoke(LATTICE_IPC.hubPublishInstalled, pluginId) as Promise<LatticeUploadResult>,
    /** Show a system directory chooser and publish (cancel returns `{ok:true,canceled:true}`) */
    pickAndUpload: () =>
      ipcRenderer.invoke(LATTICE_IPC.hubPickUpload) as Promise<LatticeUploadResult>,
    /** Pick a .zip install package to publish (supplementary to directory upload) */
    pickAndUploadZip: () =>
      ipcRenderer.invoke(LATTICE_IPC.hubPickUploadZip) as Promise<LatticeUploadResult>,
    /** Pick "install package directory + source directory" to publish: the package and the source are two different zips */
    pickAndUploadWithSource: () =>
      ipcRenderer.invoke(LATTICE_IPC.hubPickUploadWithSource) as Promise<LatticeUploadResult>,
    /** Publish by explicit path: `source` is the install package directory/zip; `sourcePath` is optional and uploads the source separately when given */
    uploadSource: (source: string, sourcePath?: string) =>
      ipcRenderer.invoke(LATTICE_IPC.hubUpload, {
        source,
        ...(sourcePath ? { sourcePath } : {})
      }) as Promise<LatticeUploadResult>,
    /** Download and install (or upgrade) a plugin; on failure returns `{ok:false,error}` without throwing */
    install: (pluginId: string, version?: string) =>
      ipcRenderer.invoke(
        LATTICE_IPC.hubInstall,
        pluginId,
        version
      ) as Promise<LatticeInstallResult>,
    /** View of locally installed plugins (local only, no network) */
    listInstalls: () =>
      ipcRenderer.invoke(LATTICE_IPC.hubInstalls) as Promise<{
        items: LatticeInstallSummary[]
      }>,
    /**
     * Current source directory (v2): where source downloaded automatically during install is
     * extracted.
     * `managed='pluginsPath'` = the user-configured plugin storage path (= workshop draft
     * directory, where plugin mode can start a conversation);
     * `managed='userData'` = fallback to the app data directory; `path=null` = this machine has
     * no source for that plugin.
     */
    sourcePath: (pluginId: string) =>
      ipcRenderer.invoke(LATTICE_IPC.sourcePath, pluginId) as Promise<LatticeSourcePathResult>,
    /** Local installed plugin package directory (`userData/plugins/<id>`, used for publishing after local install) */
    localSource: (pluginId: string) =>
      ipcRenderer.invoke(
        LATTICE_IPC.localSourcePath,
        pluginId
      ) as Promise<LatticeLocalSourcePathResult>,
    /**
     * "Modify in conversation": create/reuse a plugin workspace for the source directory and
     * start a plugin session.
     * On success returns `{ok:true,workspaceId,topicId}`; when that is not possible it falls back
     * to the file manager and returns `{ok:true,opened:'folder'}` (it will not pretend a
     * conversation was opened).
     */
    openSource: (pluginId: string) =>
      ipcRenderer.invoke(LATTICE_IPC.openSource, pluginId) as Promise<LatticeOpenSourceResult>,
    /** "Publish a new version": upload the whole source directory zip as both package and source; on failure returns `{ok:false,error}` */
    republish: (input: LatticeRepublishInput) =>
      ipcRenderer.invoke(LATTICE_IPC.republish, input) as Promise<LatticeRepublishResult>,
    /** Download the install package / source package locally (the main process shows a save dialog + sha256 check; user cancel is not a failure) */
    downloadAsset: (pluginId: string, version: string, kind: LatticeDownloadAssetKind) =>
      ipcRenderer.invoke(
        LATTICE_IPC.downloadAsset,
        pluginId,
        version,
        kind
      ) as Promise<LatticeDownloadAssetResult>,
    /**
     * "Import from local": show a directory chooser and publish every plugin under the chosen
     * directory that has a plugin.json (both package and source are whole-directory zips).
     */
    importLocalDir: (dir?: string) =>
      ipcRenderer.invoke(LATTICE_IPC.importLocalDir, dir) as Promise<LatticeImportLocalDirResult>,
    /**
     * Explicitly set the "plugin storage path" and apply it immediately (so that imported local
     * plugin sources show up in "Plugin" mode). Only accepts a non-empty path; use the settings
     * page to clear the path.
     */
    setPluginRoot: (dir: string) =>
      ipcRenderer.invoke(LATTICE_IPC.setPluginRoot, dir) as Promise<LatticeSetPluginRootResult>,
    /** Manual sync: `{direction, installMissing?}` or a bare string (installMissing follows the setting when omitted, on by default) */
    sync: (input?: LatticeSyncInput) =>
      ipcRenderer.invoke(
        LATTICE_IPC.sync,
        input ?? { direction: 'both' }
      ) as Promise<LatticeSyncResult>,
    /** Sync details: auto-install success/failure details of the latest sync and orphaned records (failure reasons can be inspected) */
    syncDetails: () => ipcRenderer.invoke(LATTICE_IPC.syncDetails) as Promise<LatticeSyncDetails>,
    /** "Auto-install missing plugins" toggle (persisted; on by default) */
    setAutoInstallMissing: (enabled: boolean) =>
      ipcRenderer.invoke(
        LATTICE_IPC.setAutoInstallMissing,
        enabled
      ) as Promise<LatticeAutoInstallSettingResult>,
    /** Unresolved plugin data conflicts (including the cloud data snapshot pulled for them) */
    syncConflicts: () =>
      ipcRenderer.invoke(LATTICE_IPC.syncConflicts) as Promise<LatticeSyncConflict[]>,
    /** Resolve a conflict explicitly: local=overwrite cloud with this machine; cloud=overwrite this machine with cloud; merge=merge both sides (when the plugin supports it) */
    resolveConflict: (pluginId: string, strategy: 'local' | 'cloud' | 'merge') =>
      ipcRenderer.invoke(
        LATTICE_IPC.resolveConflict,
        pluginId,
        strategy
      ) as Promise<LatticeResolveConflictResult>,
    /** Merge cloud data: merge the cloud snapshots of installed plugins (those supporting merge) into this machine and push back to the cloud */
    mergeData: () => ipcRenderer.invoke(LATTICE_IPC.mergeData) as Promise<LatticeMergeDataResult>,
    /** Push when login state / base URL / sync summary changes */
    onStateChanged: (callback: (status: LatticeStatus) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: LatticeStatus): void =>
        callback(status)
      ipcRenderer.on(LATTICE_IPC.stateChanged, handler)
      return () => {
        ipcRenderer.off(LATTICE_IPC.stateChanged, handler)
      }
    },
    /** Upload stage progress (zip / meta / upload) */
    onUploadProgress: (callback: (progress: LatticeUploadProgress) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: LatticeUploadProgress): void =>
        callback(progress)
      ipcRenderer.on(LATTICE_IPC.uploadProgress, handler)
      return () => {
        ipcRenderer.off(LATTICE_IPC.uploadProgress, handler)
      }
    },
    /** Sync result push (sent for both manual sync and background debounced sync) */
    onSyncState: (callback: (result: LatticeSyncResult) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, result: LatticeSyncResult): void =>
        callback(result)
      ipcRenderer.on(LATTICE_IPC.syncState, handler)
      return () => {
        ipcRenderer.off(LATTICE_IPC.syncState, handler)
      }
    }
  }
}

// Expose the specific APIs to the renderer process
const loadingAPI = {
  /** App version (can be shown on the startup page) */
  getAppVersion: () => ipcRenderer.invoke('app-version') as Promise<string>,

  /** Initialization progress snapshot: fetched once when the startup page mounts (initialization may already be in progress or done) */
  getInitState: () =>
    ipcRenderer.invoke('init-state') as Promise<{
      complete: boolean
      error: string | null
      currentTask: string
      progress: number
      taskIndex: number
      totalTasks: number
    }>,

  /** Initialization progress (returns an unsubscribe function) */
  onInitProgress: (
    callback: (data: {
      currentTask: string
      progress: number
      taskIndex: number
      totalTasks: number
    }) => void
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: Parameters<typeof callback>[0]
    ): void => {
      callback(data)
    }
    ipcRenderer.on('init-progress', handler)
    return () => ipcRenderer.off('init-progress', handler)
  },

  /** Initialization complete (returns an unsubscribe function) */
  onInitComplete: (callback: () => void) => {
    const handler = (): void => callback()
    ipcRenderer.on('init-complete', handler)
    return () => ipcRenderer.off('init-complete', handler)
  },

  /** Initialization failed (returns an unsubscribe function) */
  onInitError: (callback: (errorMessage: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, message: string): void => callback(message)
    ipcRenderer.on('init-error', handler)
    return () => ipcRenderer.off('init-error', handler)
  }
}
// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
    contextBridge.exposeInMainWorld('loading', loadingAPI)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
  // @ts-ignore (define in dts)
  window.loading = loadingAPI
}
