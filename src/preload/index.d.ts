import { ElectronAPI } from '@electron-toolkit/preload'
import type { LlmProviderInput, LlmProviderConfig } from '../main/database/mapper/provider'
import type {
  LockCodeChangeResult,
  LockScreenSnapshot,
  LockUnlockResult,
  SystemSettings
} from '../main/types/settings'
import type { PluginListEntry } from '../shared/plugin/types'
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
 * Result of installing a plugin locally (archive / folder).
 *
 * `canceled` and `error` are separate: clicking cancel in a system chooser is not a failure and
 * the panel should not show red text (`ok: true, canceled: true`).
 */
interface LocalPluginInstallResult {
  ok: boolean
  canceled?: boolean
  id?: string
  name?: string
  version?: string
  /** true = an existing installation with the same id was overwritten (the panel shows "upgraded") */
  upgraded?: boolean
  error?: string
}

/**
 * core capabilities exposed by preload to the renderer (`window.api`).
 *
 * - `api.system`: channel bridge for system features (AI assistant / notes), plain `harness:*` / `notes:*`;
 * - `api.plugin`: generic bridge for third-party plugins (`plugin:<namespace>:*` + channel
 *   allowlist), with types provided by the plugin's own `shared/types.ts`.
 */
interface Api {
  file: {
    selectImageFile: (
      allowImages?: boolean
    ) => Promise<{ dataUrl: string; fileName: string; isImage: boolean } | null>
    selectTextFile: () => Promise<{ fileName: string; filePath: string } | null>
    /** Get the real disk path of a clipboard/drag File; returns an empty string when there is no on-disk source (e.g. an image copied from a web page) */
    getPathForFile: (file: File) => string
  }
  lock: {
    /** Lock-screen snapshot held by the main process (**excluding** the unlock code digest) */
    getState: () => Promise<LockScreenSnapshot>
    /** Lock manually (Esc) */
    lock: () => Promise<LockScreenSnapshot>
    /** Unlock: verification is done in the main process */
    unlock: (code: string) => Promise<LockUnlockResult>
    /** Toggle / auto-lock duration */
    configure: (patch: {
      enabled?: boolean
      autoLockMinutes?: number
    }) => Promise<LockScreenSnapshot>
    /** Change code: the old password is verified by the main process */
    changeCode: (oldCode: string, newCode: string) => Promise<LockCodeChangeResult>
    /** Lock-state push (returns an unsubscribe function) */
    onChanged: (callback: (state: LockScreenSnapshot) => void) => () => void
  }
  providers: {
    getAll: () => Promise<LlmProviderConfig[]>
    getById: (id: number) => Promise<LlmProviderConfig | null>
    getDefault: () => Promise<LlmProviderConfig | null>
    getEnabled: () => Promise<LlmProviderConfig[]>
    create: (input: LlmProviderInput) => Promise<number>
    createBatch: (inputs: LlmProviderInput[]) => Promise<{
      created: number
      skipped: number
    }>
    update: (id: number, updates: Partial<LlmProviderInput>) => Promise<boolean>
    delete: (id: number) => Promise<boolean>
    deleteBatch: (ids: number[]) => Promise<number>
    setDefault: (id: number) => Promise<boolean>
    lookupProfile: (modelId: string) => Promise<Record<string, unknown> | null>
    fetchModels: (
      providerType: string,
      baseUrl?: string,
      apiKey?: string
    ) => Promise<{ id: string; metadata: Record<string, unknown> | null }[]>
    /** Provider config change push (after enable/disable/changing the default) */
    onChanged: (callback: () => void) => () => void
  }
  systemSettings: {
    getAll: () => Promise<SystemSettings>
    update: (updates: Partial<SystemSettings>) => Promise<boolean>
  }
  window: {
    minimize: () => void
    maximize: () => void
    close: () => void
    isMaximized: () => Promise<boolean>
    onMaximized: (callback: (maximized: boolean) => void) => () => void
    /**
     * Theme sync for the custom title bar and the system window controls overlay
     * (Window Controls Overlay). Only affects the colors of the system-drawn buttons and the
     * title bar background, not button behavior.
     */
    setTitleBarOverlay: (options: { color?: string; symbolColor?: string; height?: number }) => void
    /** Make the system window border/title bar follow the app theme */
    setNativeTheme: (mode: 'light' | 'dark' | 'system') => void
    /** Set the window title (native title bar: content - RytenBench) */
    setTitle: (title: string) => void
    /** Reload the current window (title bar "App → Reload") */
    reload: () => void
    /** Quit the app (normal quit cleanup, not hide-to-tray) */
    quit: () => void
    /** Edit commands (title bar "Edit" menu): delegated to the main process to invoke native webContents edit actions */
    edit: (command: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll') => void
  }
  /** Current platform (win32 / darwin / linux), same value as the main process's `process.platform` */
  platform: NodeJS.Platform
  weather: {
    getCurrent: (force?: boolean) => Promise<WeatherData>
    onUpdate: (callback: (data: WeatherData) => void) => () => void
  }
  /**
   * Channel bridge for system-level features (AI assistant / notes).
   *
   * Channel names are plain `harness:*` / `notes:*`: they are features compiled into the app,
   * not plugins, so they bypass the plugin host's enable state and channel allowlist; preload
   * only validates the prefix once.
   */
  system: {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
    on: (channel: string, callback: (data: unknown) => void) => () => void
  }
  plugin: {
    /** Installed plugins and their enable state (scan result of `userData/plugins/<id>/`) */
    list: () => Promise<PluginListEntry[]>
    /**
     * **Synchronously** fetch the plugin list once (including enable state).
     * The renderer host needs the authoritative list synchronously during construction, and
     * only sync IPC can provide it at that moment.
     */
    listSync: () => PluginListEntry[]
    /** Enable/disable a plugin (persist and broadcast; the renderer loads/unloads immediately) */
    setEnabled: (id: string, enabled: boolean) => Promise<PluginListEntry[]>
    /** Install a plugin from a local path: a `.zip` archive, a plugin package directory, or the `plugin.json` inside it */
    installLocal: (source: string) => Promise<LocalPluginInstallResult>
    /** Show a system chooser to pick a local source and install it (the panel's only local install entry; cancel returns canceled) */
    installLocalFromDialog: () => Promise<LocalPluginInstallResult>
    /**
     * Uninstall a plugin and return the latest list.
     * Uninstalling always removes the plugin code; `purgeData` decides whether to also clear
     * data (false = data stays in the database).
     */
    uninstall: (id: string, purgeData: boolean) => Promise<PluginListEntry[]>
    /** Plugin enable-state change push (including install/uninstall) */
    onStateChanged: (callback: () => void) => () => void
    /** Plugin channel call (`plugin:<id>:` prefix; authoritatively validated by the main process) */
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
    /** Subscribe to plugin event channels (gated by a cached allowlist) */
    on: (channel: string, callback: (data: unknown) => void) => () => void
    /**
     * Read-only diagnostics: host lifecycle hooks contributed by each plugin (labels) + the
     * number of workspace event subscriptions.
     * Used to verify that "after disabling a plugin, app.preload / app.before-quit /
     * app.renderer-memory-dump and the workspace subscriptions no longer exist".
     */
    lifecycleHooks: () => Promise<{
      preload: string[]
      beforeQuit: string[]
      memoryDump: string[]
      workspaceListeners: number
    }>
    /**
     * Read-only diagnostics: the **load source** of each plugin's main module.
     * `package` = provided by the on-disk package's `main.cjs`; `absent` = installed but currently disabled (not loaded).
     */
    loadedFrom: () => Promise<
      Record<string, { installed: boolean; source: 'package' | 'absent'; file?: string }>
    >
    /** Read-only diagnostics: row counts of several tables (table names validated against an identifier allowlist) */
    tableCounts: (tables: string[]) => Promise<Record<string, number>>
    /** Report the host UI table's "key → export name" (used to generate the `plugin://host/ui.js` bridge) */
    reportHostUi: (names: Record<string, string[]>) => void
  }
  /**
   * Lattice plugin hub (core channels, bypassing the plugin allowlist).
   *
   * Contract: §3; the IPC constants live in `src/main/lattice/types.ts` under `LATTICE_IPC`
   * (shared by main and preload).
   */
  lattice: {
    /** Current state (base URL / login state / user / role / latest sync summary) */
    status: () => Promise<LatticeStatus>
    /** Log in; on failure does not throw, returns `{ok:false,error}` (platform message) */
    login: (input: LatticeLoginInput) => Promise<LatticeLoginResult>
    /** Log out (best-effort server refresh revocation first, local state cleared unconditionally) */
    logout: () => Promise<{ ok: boolean }>
    /** Current user and role (`/v1/me`) */
    me: () => Promise<LatticeMeResult>
    /** Set the base URL (the RB_LATTICE_URL env var takes precedence; changing it clears the old login state) */
    setBaseUrl: (url: string) => Promise<LatticeSetBaseUrlResult>
    /** Plugin catalog (search / category / sort / pagination) */
    list: (query?: LatticeListQuery) => Promise<HubListResult>
    /** Plugin details (readme / version list / my install record) */
    detail: (pluginId: string) => Promise<HubDetail | null>
    /** Publish a locally installed plugin directly (install package + source, no chooser dialog) */
    publishInstalled: (pluginId: string) => Promise<LatticeUploadResult>
    /** Show a directory chooser and publish; user cancel → `{ok:true,canceled:true}` */
    pickAndUpload: () => Promise<LatticeUploadResult>
    /** Pick a .zip install package to publish */
    pickAndUploadZip: () => Promise<LatticeUploadResult>
    /** Pick "install package directory + source directory" to publish: the package and the source are two different zips */
    pickAndUploadWithSource: () => Promise<LatticeUploadResult>
    /** Publish by explicit path: `source` is the install package directory/zip; `sourcePath` is optional and uploads the source separately when given */
    uploadSource: (source: string, sourcePath?: string) => Promise<LatticeUploadResult>
    /** Download and install (or upgrade); on failure returns `{ok:false,error}` without throwing */
    install: (pluginId: string, version?: string) => Promise<LatticeInstallResult>
    /** View of locally installed plugins (local only, no network) */
    listInstalls: () => Promise<{ items: LatticeInstallSummary[] }>
    /**
     * Current source directory (v2): where source downloaded automatically during install is
     * extracted.
     * `managed='pluginsPath'` = the user-configured plugin storage path (= workshop draft
     * directory, where plugin mode can start a conversation);
     * `managed='userData'` = fallback to the app data directory; `path=null` = this machine has
     * no source for that plugin.
     */
    sourcePath: (pluginId: string) => Promise<LatticeSourcePathResult>
    /** Local installed plugin package directory (`userData/plugins/<id>`, used for publishing after local install) */
    localSource: (pluginId: string) => Promise<LatticeLocalSourcePathResult>
    /**
     * "Modify in conversation": create/reuse a plugin workspace for the source directory and
     * start a plugin session.
     * On success → `{ok:true,workspaceId,topicId}`; when a reliable switch is not possible, fall
     * back to the file manager → `{ok:true,opened:'folder'}` (**never** pretend a conversation
     * was opened).
     */
    openSource: (pluginId: string) => Promise<LatticeOpenSourceResult>
    /** "Publish a new version": upload the whole source directory zip as both package and source */
    republish: (input: LatticeRepublishInput) => Promise<LatticeRepublishResult>
    /** Download the install package / source package locally (save dialog + sha256 check; user cancel is not a failure) */
    downloadAsset: (
      pluginId: string,
      version: string,
      kind: LatticeDownloadAssetKind
    ) => Promise<LatticeDownloadAssetResult>
    /**
     * "Import from local": show a directory chooser and publish every plugin under the chosen
     * directory that has a `plugin.json` (both package and source are whole-directory zips);
     * returns a success/skip summary.
     */
    importLocalDir: (dir?: string) => Promise<LatticeImportLocalDirResult>
    /**
     * Explicitly set the "plugin storage path" and apply it immediately (called after importing
     * a local directory in the plugin hub). Only accepts a non-empty path; clearing the path
     * goes through the settings page.
     */
    setPluginRoot: (dir: string) => Promise<LatticeSetPluginRootResult>
    /**
     * Manual sync (push / pull / both; a bare string is also accepted).
     *
     * Extended input: `{direction, installMissing?}` — `installMissing` controls whether this
     * pull also installs plugins that "have an install record on the platform but no local
     * package"; when omitted it follows the setting (enabled by default).
     * The returned `autoInstall` carries success/failure details, `orphaned` lists install
     * records already deleted on the platform.
     */
    sync: (input?: LatticeSyncInput) => Promise<LatticeSyncResult>
    /** Sync details: auto-install success/failure details of the latest sync + orphaned records (failure reasons can be inspected) */
    syncDetails: () => Promise<LatticeSyncDetails>
    /** "Auto-install missing plugins" toggle (persisted setting; on by default) */
    setAutoInstallMissing: (enabled: boolean) => Promise<LatticeAutoInstallSettingResult>
    /** Unresolved plugin data conflicts (including the cloud data snapshot pulled for them) */
    syncConflicts: () => Promise<LatticeSyncConflict[]>
    /** Resolve a conflict explicitly: local=overwrite cloud with this machine; cloud=overwrite this machine with cloud; merge=merge both sides (when the plugin supports it) */
    resolveConflict: (
      pluginId: string,
      strategy: 'local' | 'cloud' | 'merge'
    ) => Promise<LatticeResolveConflictResult>
    /** Merge cloud data: merge the cloud snapshots of installed plugins (those supporting merge) into this machine and push back to the cloud */
    mergeData: () => Promise<LatticeMergeDataResult>
    /** State change push (returns an unsubscribe function) */
    onStateChanged: (callback: (status: LatticeStatus) => void) => () => void
    /** Upload progress push (zip / meta / upload) */
    onUploadProgress: (callback: (progress: LatticeUploadProgress) => void) => () => void
    /** Sync result push (sent for both manual and background debounced syncs) */
    onSyncState: (callback: (result: LatticeSyncResult) => void) => () => void
  }
  mermaid: {
    /** Full-screen window preview of SVG (draggable/zoomable canvas) */
    preview: (svg: string) => Promise<void>
  }
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

declare global {
  /**
   * Startup page bridge (`window.loading`): initialization progress snapshots and subscriptions.
   *
   * The type is declared only here (the renderer used to keep an early copy under
   * `resource/types/window.d.ts`, and the two had already drifted).
   */
  interface LoadingBridge {
    /** App version (can be shown on the startup page) */
    getAppVersion: () => Promise<string>
    /** Initialization progress snapshot (taken once when the startup page mounts, to handle initialization already started/finished) */
    getInitState: () => Promise<{
      complete: boolean
      error: string | null
      currentTask: string
      progress: number
      taskIndex: number
      totalTasks: number
    }>
    /** Initialization progress (returns an unsubscribe function) */
    onInitProgress: (
      callback: (data: {
        currentTask: string
        progress: number
        taskIndex: number
        totalTasks: number
      }) => void
    ) => () => void
    /** Initialization complete (returns an unsubscribe function) */
    onInitComplete: (callback: () => void) => () => void
    /** Initialization failed (returns an unsubscribe function) */
    onInitError: (callback: (errorMessage: string) => void) => () => void
  }

  interface Window {
    electron: ElectronAPI
    api: Api
    loading: LoadingBridge
  }
}
