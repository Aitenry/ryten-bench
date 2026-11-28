/**
 * Shared types for the Lattice plugin hub (platform user-facing `/v1/hub`) between main / preload /
 * renderer.
 *
 * Boundary: this file is imported by all three sides, so it must **not** pull in electron / node /
 * React dependencies — both the preload and the renderer layer must bundle it directly.
 */

/**
 * Signed-in user (the normalized shape of `user` from `/v1/auth/login`, `/v1/auth/refresh` and
 * `/v1/me`).
 *
 * `avatar` is the personal avatar introduced in platform v0.8 (`users.avatar`): `null` = no avatar
 * (the UI falls back to the first letter of the username), non-empty = an `https://` URL or
 * `data:image/(png|jpeg|webp|gif);base64,...`.
 * The field as a whole may be absent: **older platforms** (nodes from before avatars) do not return
 * it, and older main processes omit it too; the renderer always treats it as `null` (no error, no
 * broken image).
 */
export interface LatticeUser {
  id: string
  username: string
  display_name?: string | null
  avatar?: string | null
}

/**
 * Normalizes the raw `avatar` value from the platform / session file, distinguishing "explicitly no
 * avatar" from "the old version has no such field":
 * - non-empty string → returned as-is after trimming (shape validation is left to the renderer;
 *   a bad value falls back to the initial letter);
 * - empty string / `null` → `null` (the platform explicitly says there is no avatar, or the user
 *   cleared it);
 * - anything else (missing field / invalid type) → `undefined` (old platforms / old main processes
 *   lack the field; identity correction keeps the existing cached value instead of clearing the
 *   avatar by mistake).
 */
export function normalizeLatticeAvatar(raw: unknown): string | null | undefined {
  if (typeof raw === 'string') {
    const value = raw.trim()
    return value === '' ? null : value
  }
  if (raw === null) return null
  return undefined
}

/** Summary of the most recent sync (shown in the settings card / status bar) */
export interface LatticeSyncSummary {
  at?: number
  pushed?: number
  pulled?: number
  /** Number of business data rows pushed/pulled (shown in the sync status bar) */
  pushedRows?: number
  pulledRows?: number
  conflicts?: number
  /** Number of plugins successfully auto-restored by the most recent sync (reinstalling missing plugins after a machine change/reinstall) */
  autoInstalled?: number
  /** Number of plugins the most recent sync failed to auto-restore (reasons live in sync details, never silent) */
  autoInstallFailed?: number
  /** Number of "deleted from the platform" install records found by the most recent sync (local data kept, marked orphaned) */
  orphaned?: number
  error?: string
}

/** Current plugin hub status (return of `lattice:status`, also the payload of `lattice:state-changed`) */
export interface LatticeStatus {
  /** Whether a base URL is configured: it defaults to the dev node, so this is true */
  configured: boolean
  baseUrl: string
  loggedIn: boolean
  user?: LatticeUser
  role?: string
  /** access token expiry (millisecond timestamp; in-memory only — refreshed again after restart) */
  expiresAt?: number
  lastError?: string
  sync?: LatticeSyncSummary
  /**
   * Current value of the "auto-restore missing plugins" switch (default **on**).
   *
   * When on, every pull automatically reinstalls plugins that "have a platform install record but
   * no local package" (recovery after a machine change/reinstall/user deleting the directory); when
   * off, they are only listed in the sync result's `pending`.
   */
  autoInstallMissing?: boolean
}

/** One plugin in the catalog page (platform fields as-is + install state from the caller's perspective) */
export interface HubEntry {
  plugin_id: string
  name: string
  description?: string
  icon?: string
  category: string
  tags: string[]
  owner: { id: string; username: string; display_name?: string | null }
  latest_version?: string
  size?: number
  downloads: number
  versions_count: number
  updated_at: string
  installed: boolean
  installed_version?: string
  update_available: boolean
  install_enabled?: boolean
  /** Whether the latest version ships a source package (old platforms that do not return it count as false) */
  has_source?: boolean
}

/** One published version in the detail page */
export interface HubVersion {
  version: string
  asset_name: string
  size: number
  sha256: string
  changelog: string
  manifest: unknown
  downloads: number
  published_at?: string
  /** Whether this version ships a source package */
  has_source?: boolean
  source_asset_name?: string
  source_size?: number
  source_sha256?: string
}

/** Detail (catalog fields + readme + version list + the caller's install record) */
export interface HubDetail extends HubEntry {
  readme: string
  versions: HubVersion[]
  my_install?: {
    version: string
    enabled: boolean
    data_rev: number
    data_updated_at?: string
  } | null
}

/** Catalog pagination result */
export interface HubListResult {
  items: HubEntry[]
  total: number
  page: number
  page_size: number
}

/** Catalog query parameters (camelCase for the renderer; the IPC layer converts to platform snake_case) */
export interface LatticeListQuery {
  q?: string
  category?: string
  sort?: 'recent' | 'popular' | 'name'
  page?: number
  pageSize?: number
}

/** Locally installed plugin view (one item returned by `lattice:hub-installs`) */
export interface LatticeInstallSummary {
  plugin_id: string
  version?: string
  enabled: boolean
  data_rev?: number
  updated_at?: string
}

/** Sync direction */
export type LatticeSyncDirection = 'push' | 'pull' | 'both'

/** Input of `lattice:sync`: `{direction?, installMissing?}`; a bare string is also accepted (old renderer compatibility) */
export interface LatticeSyncOptions {
  direction?: LatticeSyncDirection
  /**
   * Whether pull should auto-restore plugins that "have a platform install record but no local
   * package".
   *
   * Omitted = use the persisted setting (`autoInstallMissing` in `lattice-settings.json`, default
   * **on**); an explicit `false` means "only show the pending list, do not auto-install".
   * Auto-restore failures go into `autoInstall.failed`, do not interrupt other plugins, and do not
   * fail the whole sync.
   */
  installMissing?: boolean
  /**
   * Background automatic pull: when nothing changed, the UI shows no "sync complete" toast (the
   * status bar still updates). Do not pass this for user-triggered syncs.
   */
  silent?: boolean
}

export type LatticeSyncInput = LatticeSyncOptions | LatticeSyncDirection

/** One plugin successfully auto-restored */
export interface LatticeSyncAutoInstallItem {
  plugin_id: string
  version?: string
  /** Source directory restored alongside the install (absent when the version has no source package / source download failed) */
  sourcePath?: string
  /** Readable reason the source download failed (the install itself succeeded) */
  sourceError?: string
}

/** One plugin that failed to auto-restore (version removed from the platform during machine-change recovery / network failure, etc.; each is visible) */
export interface LatticeSyncAutoInstallFailure {
  plugin_id: string
  /** Version attempted for the restore (= the version in the platform install record; absent means latest) */
  version?: string
  error: string
}

/** Summary of auto-restore in one pull (the "auto-restore" section of sync details) */
export interface LatticeSyncAutoInstallResult {
  /** Number of plugins this run attempted to auto-install (= installed.length + failed.length) */
  attempted: number
  installed: LatticeSyncAutoInstallItem[]
  failed: LatticeSyncAutoInstallFailure[]
}

/** Why an install record no longer exists on the platform: the whole plugin was deleted / only one API returned 404 (platform version difference) */
export type LatticeSyncOrphanReason = 'plugin_deleted' | 'not_found'

/**
 * One "orphaned" install record: the plugin was deleted from the platform (push 410/404 or
 * plugin=null in the pull list).
 *
 * Handling: **keep the local plugin directory and plugin-state data** (never auto-delete user
 * data), only add a marker, and make it visible in sync details; the marker clears automatically
 * once the plugin reappears on the platform or the push succeeds.
 */
export interface LatticeSyncOrphanedItem {
  plugin_id: string
  version?: string
  reason: LatticeSyncOrphanReason
  /** First marking time (millisecond timestamp) */
  at: number
  /** Readable reason from the platform/client (for troubleshooting) */
  error?: string
}

/** Result of one sync (return of `lattice:sync`, payload of `lattice:sync-state`) */
export interface LatticeSyncResult {
  at: number
  /** Number of **plugins** pushed/pulled */
  pushed: number
  pulled: number
  /** Number of **business data rows** pushed/pulled (counted by plugins via count(); plugins without count count as 0) */
  pushedRows?: number
  pulledRows?: number
  conflicts: number
  /** Background automatic pull (not user-triggered): no toast is shown when nothing changed */
  silent?: boolean
  error?: string
  /** Plugin ids that have a cloud install record but no local package and were **not auto-installed** (auto-restore off/unavailable) */
  pending?: string[]
  /** Auto-restore result (during pull; absent when not enabled or nothing was missing) */
  autoInstall?: LatticeSyncAutoInstallResult
  /** Install records still marked "deleted from the platform" (local data kept, only marked) */
  orphaned?: LatticeSyncOrphanedItem[]
}

/** Return of `lattice:sync-details`: data for the sync details dialog (auto-restore failures / conflicts / orphaned records) */
export interface LatticeSyncDetails {
  /** Most recent sync (including autoInstall / orphaned details; restored from cache on cold start) */
  last: LatticeSyncResult | null
  conflicts: LatticeSyncConflict[]
  orphaned: LatticeSyncOrphanedItem[]
}

/** Return of `lattice:set-auto-install-missing`: state after the switch was persisted */
export interface LatticeAutoInstallSettingResult {
  ok: boolean
  enabled: boolean
  status?: LatticeStatus
  error?: string
}

/** Unresolved plugin data conflict (mismatched `data_rev`; the "resolve conflict" dialog lets the user explicitly pick a side) */
export interface LatticeSyncConflict {
  plugin_id: string
  local_rev: number
  server_rev: number
  /** Local data snapshot at conflict time (for preview / use local) */
  local_data?: unknown
  /** Cloud data snapshot fetched when the dialog opens (for preview) */
  server_data?: unknown
  /**
   * Whether this plugin supports **merge-base three-way merging**.
   *
   * True only when the plugin explicitly declares `mergeBase: true`; the `merge()` of older plugins
   * is an unconditional union and would bring back rows deleted/edited locally, so the UI should not
   * show "merge both" for them.
   */
  merge_supported?: boolean
  /**
   * Conflict source:
   * - `diverged`: local has unsynced changes and the cloud rev advanced too (a real fork);
   * - `rev`: a rev conflict from the old push/pull semantics;
   * - `no-base`: the merge base is missing (first time after an upgrade), a sync is needed first.
   */
  reason?: 'diverged' | 'no-base' | 'rev'
  at: number
}

export type LatticeResolveConflictStrategy = 'local' | 'cloud' | 'merge'

export type LatticeResolveConflictResult =
  | {
      ok: true
      /** Result summary of the merge strategy (only set when "merge both" is used) */
      summary?: string
      /** Number of data rows newly added by the merge strategy */
      rows?: number
    }
  | { ok: false; error: string }

/**
 * "Merge cloud data": per-plugin git-style fast-forward / conflict based on the **merge base**
 * (no more unconditional unions).
 *
 * The UI builds one sentence from `merged / rows / failed / conflicts` (same shape as "sync
 * complete"); the per-plugin summaries in `summaries` are **no longer** concatenated into the toast.
 */
export interface LatticeMergeDataResult {
  ok: boolean
  /** Number of plugins actually aligned (push + pull) */
  merged?: number
  /** Number of those where "local updates were pushed" (deletions/edits go this way and are not restored by the cloud) */
  pushed?: number
  /** Number of those where "cloud updates were pulled" (only happens when local has no unsynced changes) */
  pulled?: number
  /** Number of business data rows actually synced this time (counted by the plugin's count(), push + pull) */
  rows?: number
  /** Number of failed plugins; failures are isolated per plugin and do not affect others */
  failed?: number
  /** Number of plugins where both sides changed and a conflict was recorded (needs an explicit user choice, no auto-overwrite) */
  conflicts?: number
  /** Number of plugins skipped due to a missing merge base / unreadable local snapshot (a sync first fixes it) */
  blocked?: number
  /**
   * No plugin moved and no failure/conflict: no snapshot plugins installed, or the cloud has no
   * snapshots for them. Not an error; the UI says "no data to merge".
   */
  empty?: boolean
  /** Per-plugin processing summary (for per-plugin details, no longer sent straight to the toast) */
  summaries?: string[]
  /** "id: reason" of failing plugins, joined one by one; for logs / details, not shown directly */
  error?: string
}

/** Upload phase progress (`lattice:upload-progress` payload) */
export interface LatticeUploadProgress {
  phase: 'zip' | 'meta' | 'upload'
  sent: number
  total: number
}

/** Login input. When `baseUrl` is omitted the current base URL is used (setting / RB_LATTICE_URL / default) */
export interface LatticeLoginInput {
  baseUrl?: string
  username: string
  password: string
}

/** Login result: failures are not thrown; `{ok:false,error}` is returned for the UI to show the platform message */
export type LatticeLoginResult =
  | {
      ok: true
      user: LatticeUser
      role?: string
      /**
       * Account switch succeeded and the data space was **switched in place** (no app restart): the
       * main window reloads entirely a few tens of milliseconds later, and afterwards runs on the
       * new account's data/cloud snapshots; the UI need not handle any follow-up itself.
       */
      switching?: boolean
      /**
       * Account switch succeeded, but the local data space requires an **app restart** to switch
       * (the cheapest fallback path): only happens when initialization has not finished or the
       * in-place switch failed; the app restarts automatically a few hundred milliseconds later.
       */
      restarting?: boolean
    }
  | { ok: false; error: string }

/** Upload result. The user canceling the picker is not a failure (`canceled:true`) */
export type LatticeUploadResult =
  | { ok: true; canceled: true }
  | {
      ok: true
      plugin_id: string
      version: string
      /**
       * Final platform status: `published` = published; `review` = submitted, awaiting admin review.
       *
       * The platform sends uploads to review by default since 2026-11-23 (invisible to other users
       * until approved), so "upload succeeded" no longer equals "published" — the UI must choose its
       * message from this field and must not treat review as a failure. When an old platform does
       * not return it, treat it as `published`.
       */
      status?: 'published' | 'review'
      /** Whether a source package was actually uploaded this time (false when there is no source / the platform gave no upload URL) */
      sourceUploaded?: boolean
    }
  | { ok: false; error: string }

/** Download/install result: failures are not thrown to the renderer; `{ok:false,error}` is returned */
export type LatticeInstallResult =
  | {
      ok: true
      id: string
      name: string
      version: string
      /**
       * Source directory downloaded and unpacked automatically during install.
       *
       * Directory priority: the user-configured "plugin storage path" `<pluginsPath>/<id>/` (= the
       * workshop draft directory, visible in the plugin-mode sidebar and editable through model
       * conversations) → when not configured, fall back to
       * `userData/plugin-sources/<id>/<version>/`.
       */
      sourcePath?: string
      sourceVersion?: string
      /** Which kind of directory the source landed in: pluginsPath = user plugin storage path; userData = app data directory fallback */
      sourceManaged?: LatticeSourceManaged
      /** Readable reason the source download/unpack failed (**does not affect a successful install**; the local package is already installed) */
      sourceError?: string
      /** Backup directory kept before overwriting existing local source (only when the source had been modified locally) */
      sourceBackupPath?: string
    }
  | { ok: false; error: string }

/** Where the source lands locally (`lattice:source-path` / the install result's `sourceManaged`) */
export type LatticeSourceManaged = 'pluginsPath' | 'userData'

/** Return of `lattice:source-path`: the currently editable source directory */
export interface LatticeSourcePathResult {
  path: string | null
  version?: string
  /**
   * Source directory kind:
   * - `pluginsPath` = the user-configured plugin storage path (workshop draft directory, plugin mode
   *   can open conversations);
   * - `userData` = app data directory fallback (when no plugin storage path is configured);
   * the whole field is absent when there is no source.
   */
  managed?: LatticeSourceManaged
}

/** Return of `lattice:local-source-path`: the locally installed plugin package directory (`userData/plugins/<id>`, for publishing after a local install) */
export interface LatticeLocalSourcePathResult {
  path: string | null
  version?: string
}

/**
 * Return of `lattice:open-source`:
 * - conversation opened successfully: `{ok:true,workspaceId,topicId?}` (workspace = plugin source
 *   directory, topic = plugin conversation);
 * - when the plugin mode cannot be switched reliably, fall back to the file manager:
 *   `{ok:true,opened:'folder',path}` (never pretend a conversation was opened);
 * - failure: `{ok:false,error}`.
 */
export type LatticeOpenSourceResult =
  | {
      ok: true
      workspaceId: number
      topicId?: number
      /** 'conversation' = really created/reused the plugin workspace and opened a plugin conversation */
      mode?: 'conversation'
      /** Working directory used by the conversation (= plugin source directory) */
      path?: string
    }
  | { ok: true; opened: 'folder'; path?: string }
  | { ok: false; error: string }

/** Input of `lattice:republish` */
export interface LatticeRepublishInput {
  pluginId: string
  /** New version number (required semver; must be greater than the platform's current latest version; a server 409 becomes a readable error) */
  version: string
  changelog?: string
  /** Source directory; absent = sourcePath, then absent = localSourcePath (userData/plugins/<id>)) */
  sourceDir?: string
}

/** Return of `lattice:republish`: the install package = whole source directory zip, source package = the same bytes */
export type LatticeRepublishResult =
  | {
      ok: true
      plugin_id: string
      version: string
      /** Final platform status: published / awaiting admin review (the platform sends uploads to review by default since 2026-11-23) */
      status?: 'published' | 'review'
      sourcePath?: string
    }
  | { ok: false; error: string }

/** Download kind: install package / source package */
export type LatticeDownloadAssetKind = 'package' | 'source'

/** Return of `lattice:download-asset`: downloads via a save dialog; user cancel is not a failure (canceled=true, savedPath is an empty string) */
export type LatticeDownloadAssetResult =
  { ok: true; savedPath: string; canceled?: boolean } | { ok: false; error: string }

/** Local directory batch import: one successfully published plugin */
export interface LatticeImportLocalItem {
  plugin_id: string
  version: string
}

/** Local directory batch import: one skipped plugin directory (reason is a readable reason from the platform/validation) */
export interface LatticeImportLocalSkipped {
  dir: string
  reason: string
}

/**
 * Return of `lattice:import-local-dir`: show a directory picker → scan direct subdirectories (also
 * supports the selected directory itself being a single plugin) for plugins with `plugin.json` →
 * publish each to the platform (install package + source uploaded as one package).
 */
export type LatticeImportLocalDirResult =
  | {
      ok: true
      canceled?: boolean
      imported: LatticeImportLocalItem[]
      skipped: LatticeImportLocalSkipped[]
      /** Root directory scanned this time (the UI can suggest "set as plugin storage path") */
      root?: string
    }
  | { ok: false; error: string }

/** Explicitly sets the "plugin storage path" (takes effect immediately; used after importing local directories in the plugin hub) */
export type LatticeSetPluginRootResult = { ok: true; dir: string } | { ok: false; error: string }

/** Base URL setting result */
export interface LatticeSetBaseUrlResult {
  ok: boolean
  status: LatticeStatus
  error?: string
  /** The data space was switched back to anonymous in place; the main window is about to reload entirely */
  switching?: boolean
  /** In-place switching is unavailable; the app is about to restart */
  restarting?: boolean
}

/** Return of `lattice:me` */
export interface LatticeMeResult {
  user: LatticeUser
  role: string
}

// ---------- Platform API record types (main-internal, not used directly by preload) ----------

/** One item in `GET /v1/hub/installs?include_data=1` */
export interface LatticeRemoteInstall {
  plugin_id: string
  version?: string
  enabled?: boolean
  data_rev?: number
  data_updated_at?: string
  last_device?: string | null
  updated_at?: string
  plugin?: {
    name?: string
    icon?: string
    latest_version?: string
    /** Plugin status (the platform returns `removed` for delisted plugins; old platforms may not return it) */
    status?: string
  } | null
  /**
   * The plugin the platform install record points to has been deleted: the platform explicitly
   * returns `plugin:null`, or `plugin.status==='removed'` (a soft delete: the plugin row still
   * exists with `status=removed`). When an old platform has neither, keep this false to avoid
   * mislabeling.
   */
  plugin_deleted?: boolean
  data?: unknown
}

/** Request body of `PUT /v1/hub/installs/{plugin_id}` */
export interface LatticeInstallPutBody {
  version?: string
  enabled?: boolean
  data?: unknown
  /** Required when sending data: the data version the client last saw (use 0 for a new record) */
  data_rev?: number
  device_id?: string
  force?: boolean
}

/** IPC channel names (one shared constant used by main registration / preload calls, avoiding string drift) */
export const LATTICE_IPC = {
  status: 'lattice:status',
  login: 'lattice:login',
  logout: 'lattice:logout',
  me: 'lattice:me',
  setBaseUrl: 'lattice:set-base-url',
  hubList: 'lattice:hub-list',
  hubDetail: 'lattice:hub-detail',
  hubPickUpload: 'lattice:hub-pick-upload',
  /** Publish a locally installed plugin directly (install package + source, no directory picker) */
  hubPublishInstalled: 'lattice:hub-publish-installed',
  hubUpload: 'lattice:hub-upload',
  hubPickUploadZip: 'lattice:hub-pick-upload-zip',
  /** Pick two directories — "install package directory + source directory" — then publish (the source and package are two different zips) */
  hubPickUploadWithSource: 'lattice:hub-pick-upload-with-source',
  hubInstall: 'lattice:hub-install',
  hubInstalls: 'lattice:hub-installs',
  /** Current source directory (path/version/managed) */
  sourcePath: 'lattice:source-path',
  /** Locally installed plugin package directory (userData/plugins/<id>) */
  localSourcePath: 'lattice:local-source-path',
  /** Edit the source in a conversation: create/reuse the plugin workspace and open a plugin conversation, falling back to the file manager on failure */
  openSource: 'lattice:open-source',
  /** Republish a new version (install package + source uploaded as one package) */
  republish: 'lattice:republish',
  /** Download the install package / source package to this machine (save dialog) */
  downloadAsset: 'lattice:download-asset',
  /** Show a directory picker and batch-publish local plugin source directories to the platform */
  importLocalDir: 'lattice:import-local-dir',
  setPluginRoot: 'lattice:set-plugin-root',
  sync: 'lattice:sync',
  syncConflicts: 'lattice:sync-conflicts',
  /** Sync details: auto-restore/orphaned record details of the most recent sync (failures can be inspected) */
  syncDetails: 'lattice:sync-details',
  resolveConflict: 'lattice:resolve-conflict',
  /** Per installed plugin, merge the cloud snapshot into local data (non-destructive union) and push it back to the cloud */
  mergeData: 'lattice:merge-data',
  /** Auto-restore missing plugins switch (persisted setting; on by default) */
  setAutoInstallMissing: 'lattice:set-auto-install-missing',
  stateChanged: 'lattice:state-changed',
  uploadProgress: 'lattice:upload-progress',
  syncState: 'lattice:sync-state'
} as const
