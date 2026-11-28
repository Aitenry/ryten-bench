import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import logger from 'electron-log'
import { broadcastPluginStateChanged, onPluginStateChanged } from '../ipc/plugins'
import { pluginSyncSnapshot } from '../plugins/contributions'
import { isEnabledPlugin, loadExternalMain, unloadExternalMain } from '../plugins/host'
import { isInstallRemoved, setEnabledOverride } from '../plugins/store'
import { scanExternalPlugins } from '../plugins/scanner'
import { onAppEvent } from '../plugins/app-events'
import { APP_EVENT_PLUGIN_DATA_PURGED, type AppPluginDataPurgedPayload } from '../plugins/app-hooks'
import { LatticeApiError, isLatticeLoggedIn, latticeErrorMessage, latticeRequest } from './client'
import { profileSyncGuard } from '../profiles/runtime'
import { getLatticeAutoInstallMissing } from './settings'
import { getLatticeDeviceId } from './session'
import { decideMergeAction, snapshotsEqual, type MergeBaseSnapshot } from './merge-base'

import type {
  LatticeInstallPutBody,
  LatticeInstallResult,
  LatticeInstallSummary,
  LatticeRemoteInstall,
  LatticeResolveConflictResult,
  LatticeMergeDataResult,
  LatticeSyncAutoInstallFailure,
  LatticeSyncAutoInstallItem,
  LatticeSyncAutoInstallResult,
  LatticeSyncDetails,
  LatticeSyncDirection,
  LatticeSyncOptions,
  LatticeSyncOrphanReason,
  LatticeSyncOrphanedItem,
  LatticeSyncResult
} from './types'

/**
 * Bidirectional sync of install records and plugin data.
 *
 * Semantics:
 * - **Local view** = `scanExternalPlugins()` + `isEnabledPlugin()`; data = the
 *   `PLUGIN_SYNC_SNAPSHOT` contributed by the plugin (settings + business tables), falling back to
 *   `userData/plugin-state/<id>.json` when nothing is contributed (only included if it exists and
 *   is ≤256KiB);
 * - **push**: per plugin `PUT /v1/hub/installs/{id}`, with `data_rev` taken from the local cache
 *   (`revs` in `userData/lattice-sync.json`); `409 data_conflict` **records a conflict without
 *   overwriting** (no silent force); platform 410/404 (plugin already deleted) →
 *   **keep the local plugin directory and data**, only mark the install record as `orphaned`
 *   (visible in sync details, never auto-deletes user data);
 * - **pull**: `GET /v1/hub/installs?include_data=1`, applies only data with a larger `data_rev` and
 *   applies the cloud enabled state;
 *   **automatic restore on a new machine**: when the platform has an install record but this
 *   machine has no plugin package (new machine/reinstall/user deleted the directory), automatically
 *   install it and restore the package + source per the setting (enabled by default), returning
 *   `{installed,failed}` details; failures are visible per plugin and do not interrupt other
 *   plugins; when disabled, missing items only go into `pending`. Records whose plugin was deleted
 *   from the platform are marked `orphaned`;
 * - **triggers**: pull after startup/login; a 5s debounced push after plugin state changes
 *   (`plugin-state-changed`); calling `ctx.requestSync()` after a plugin writes business tables
 *   triggers the same debounced push.
 *
 * Snapshot **application** must be idempotent: `import` is implemented by plugins with replace
 * semantics, so repeated pulls / conflict replays never produce duplicate rows.
 * Plugins using the snapshot contribution no longer read/write `plugin-state/<id>.json` as the sync
 * payload (it only holds settings); snapshots received while a plugin is disabled are kept in memory
 * and applied by `flushPendingSnapshots()` once it is enabled.
 *
 * `lattice-sync.json` also caches the most recent sync result, so the status card/settings page can
 * show the "last sync" after a cold start.
 */

/** Platform per-plugin data limit: 256KiB of JSON */
const DATA_MAX_BYTES = 256 * 1024
const SYNC_CACHE_FILE = 'lattice-sync.json'
const PUSH_DEBOUNCE_MS = 5_000
const PLUGIN_STATE_DIR = 'plugin-state'
/**
 * On-disk directory for merge bases: `plugin-state/.lattice-sync-base/<id>.json`.
 *
 * Living inside `plugin-state/` is intentional: on account switch `PROFILE_ITEMS` swaps the whole
 * `plugin-state/` directory, so the base follows the account and an "account A base paired with
 * account B rev" mix-up cannot happen.
 */
const MERGE_BASE_DIR = '.lattice-sync-base'

interface LatticeSyncCacheFile {
  revs: Record<string, number>
  last?: LatticeSyncResult
  /**
   * Unresolved `data_rev` conflicts (recorded on a 409 during push; the user picks a side in
   * "resolve conflict" in the plugin repository). Local cache only; `server_data` is fetched on
   * demand when listing, to avoid keeping a long-lived copy of up to 256KiB of data.
   */
  conflicts?: LatticeSyncConflict[]
  /**
   * Install records whose plugin was deleted from the platform (orphaned). The local plugin
   * directory and data are kept, only the marker is added; the marker clears automatically when the
   * plugin reappears or the push succeeds. The "records deleted from the platform" section in sync
   * details reads this cache.
   */
  orphaned?: LatticeSyncOrphanedItem[]
  /**
   * Local location of the plugin source (attachment info after install/republish).
   *
   * Local cache only (not part of push/pull): `lattice:source-path` still comes from source.json on
   * disk; this record is for troubleshooting and for quickly knowing where the source was after a
   * cold start.
   */
  sources?: Record<string, LatticeSourceCacheEntry>
  /**
   * Plugins that sync using their **own snapshot** (the `PLUGIN_SYNC_SNAPSHOT` contribution).
   *
   * The data of these plugins is not in `plugin-state/<id>.json` (that file only holds settings),
   * so:
   * - push only uses the plugin's `export()` result and never falls back to that file (otherwise
   *   cloud data would be overwritten with settings);
   * - if the plugin is not loaded (disabled) during pull → the snapshot is not written to disk; it is
   *   synced again by `requestSync` once the plugin is enabled.
   * Once a plugin is observed contributing a snapshot it is recorded, and stays recorded after
   * uninstall/disable.
   */
  snapshotPlugins?: Record<string, true>
  /**
   * Plugins whose own snapshot has already been uploaded successfully (marked **only** after a push
   * that carried data).
   *
   * Kept separate from `snapshotPlugins` (a semantics marker that pull import also writes): when
   * switching from the "settings file" semantics to the "snapshot" semantics for the first time,
   * the whole dataset must be uploaded once, otherwise the cloud stays on the old settings snapshot
   * forever. This marker — not `snapshotPlugins` — decides "snapshot not pushed yet".
   */
  snapshotPushed?: Record<string, true>
  /**
   * Local data changes that have **not been pushed yet** (marked via `ctx.requestSync()` after a
   * plugin writes to its tables).
   *
   * Pull protection: when `serverRev > localRev` and the local copy is dirty, the cloud data is
   * **not imported** (the cloud update would overwrite unsynced local edits — silent data loss);
   * a conflict is recorded instead and the user explicitly chooses local or cloud in "resolve
   * conflict". Cleared only after a successful push or choosing cloud.
   */
  dirty?: Record<string, true>
}

/** One unresolved plugin data conflict (mismatched `data_rev`) */
export interface LatticeSyncConflict {
  plugin_id: string
  /** Locally cached rev (the one sent with push) */
  local_rev: number
  /** Current server rev (returned by the 409) */
  server_rev: number
  /** Local data snapshot (re-pushed as-is when the user chooses "use local"; undefined if no data) */
  local_data?: unknown
  /** Conflict source: real divergence / rev conflict from old semantics / missing base */
  reason?: 'diverged' | 'no-base' | 'rev'
  at: number
}

/** Cached local location of a plugin's source (`sources[pluginId]` in `lattice-sync.json`) */
export interface LatticeSourceCacheEntry {
  path: string
  version?: string
  sha256?: string
  managed?: string
  at: number
}

interface LatticeSyncHooks {
  /** A sync finished (wired in index.ts to broadcast `lattice:sync-state` and refresh state) */
  onSyncState?: (result: LatticeSyncResult) => void
  /** Sync changed the enabled state etc. (wired in index.ts to broadcast `lattice:state-changed`) */
  onStateChanged?: () => void
  /**
   * Automatic restore on a new machine: calls the existing install flow (download package + source
   * + write install record).
   *
   * Injected as a hook instead of importing `./hub` directly: `hub.ts` depends back on this module's
   * `recordLatticeSourceCache`, and static mutual imports easily produce half-initialized objects
   * under the CJS bundle; `lattice/index.ts` does the wiring instead.
   * When not wired (standalone unit tests / abnormal assembly), automatic restore degrades to a
   * `pending` list instead of crashing.
   */
  installPlugin?: (pluginId: string, version?: string) => Promise<LatticeInstallResult>
}

let hooks: LatticeSyncHooks = {}
let cache: LatticeSyncCacheFile | null = null
let lastResult: LatticeSyncResult | null = null
let running: Promise<LatticeSyncResult> | null = null
let debounceTimer: NodeJS.Timeout | null = null
/** pull broadcasts plugin-state-changed when applying the cloud enabled state: suppress the debounced push it would trigger */
let suppressPush = false
/**
 * Suspends sync while the account data space is being switched (see `pauseLatticeSync`).
 *
 * The switch swaps `plugin-state/` and `lattice-sync.json` — exactly the files the sync flow reads
 * and writes, so it must stay completely idle during the switch window; otherwise the rename fails
 * or the previous account's snapshot is pushed into the new space.
 */
let paused = false

/** Wired by `lattice/index.ts` at startup (avoids the sync → index circular dependency) */
export function configureLatticeSync(next: LatticeSyncHooks): void {
  hooks = next
}

// ---------- Small helpers ----------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function syncCachePath(): string {
  return path.join(app.getPath('userData'), SYNC_CACHE_FILE)
}

function pluginStatePath(pluginId: string): string {
  return path.join(app.getPath('userData'), PLUGIN_STATE_DIR, `${pluginId}.json`)
}

// ---------- Merge base ----------

/** Merge base file path for a plugin (account-scoped: swapped together with plugin-state) */
function mergeBasePath(pluginId: string): string {
  return path.join(app.getPath('userData'), PLUGIN_STATE_DIR, MERGE_BASE_DIR, `${pluginId}.json`)
}

/**
 * Reads a plugin's merge base: **the cloud snapshot from the last successful sync plus its
 * data_rev**.
 *
 * Returns null without a base (first sync after upgrade, node change, corrupt base file) — callers
 * must degrade to "sync once first" instead of guessing; that is the precondition for "never merge
 * deleted/modified rows back".
 */
function readMergeBase(pluginId: string): MergeBaseSnapshot | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(mergeBasePath(pluginId), 'utf-8')) as unknown
    const record = asRecord(parsed)
    if (!record || typeof record.rev !== 'number' || !Number.isFinite(record.rev)) return null
    if (!('data' in record)) return null
    return {
      rev: record.rev,
      data: record.data,
      ...(typeof record.at === 'number' ? { at: record.at } : {})
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code
    if (code !== 'ENOENT') {
      logger.warn(`[Lattice] Failed to read merge base for ${pluginId}:`, err)
    }
    return null
  }
}

/** Writes the base (atomic replace; failures only warn, the next merge degrades to no-base and data is not corrupted) */
function writeMergeBase(pluginId: string, rev: number, data: unknown): void {
  if (!Number.isFinite(rev) || rev < 0 || data === undefined) return
  const file = mergeBasePath(pluginId)
  const tmp = `${file}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify({ rev, at: Date.now(), data }), 'utf-8')
    fs.renameSync(tmp, file)
  } catch (err) {
    logger.warn(
      `[Lattice] Failed to persist merge base for ${pluginId}; the next merge will ask for a sync first:`,
      err
    )
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      // Failing to clean up the temp file does not matter
    }
  }
}

/** Clears a plugin's base (used on uninstall data purge / manual reset) */
function clearMergeBase(pluginId: string): void {
  try {
    fs.rmSync(mergeBasePath(pluginId), { force: true })
  } catch (err) {
    logger.warn(`[Lattice] Failed to remove merge base for ${pluginId}:`, err)
  }
}

/** Clears all bases (plugin hub node switch: data_rev is not comparable across nodes) */
function clearAllMergeBases(): void {
  try {
    fs.rmSync(path.join(app.getPath('userData'), PLUGIN_STATE_DIR, MERGE_BASE_DIR), {
      recursive: true,
      force: true
    })
  } catch (err) {
    logger.warn('[Lattice] Failed to remove merge bases:', err)
  }
}

/** Reads `lattice-sync.json` (a corrupt file falls back to an empty cache without blocking sync) */
function loadSyncCache(): LatticeSyncCacheFile {
  if (cache) return cache
  let last: LatticeSyncResult | undefined
  const revs: Record<string, number> = {}
  const sources: Record<string, LatticeSourceCacheEntry> = {}
  const snapshotPlugins: Record<string, true> = {}
  const snapshotPushed: Record<string, true> = {}
  const dirty: Record<string, true> = {}
  const orphaned: LatticeSyncOrphanedItem[] = []
  const conflicts: LatticeSyncConflict[] = []
  try {
    const parsed = JSON.parse(fs.readFileSync(syncCachePath(), 'utf-8')) as unknown
    const record = asRecord(parsed)
    const rawRevs = asRecord(record?.revs)
    if (rawRevs) {
      for (const [id, value] of Object.entries(rawRevs)) {
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) revs[id] = value
      }
    }
    const rawLast = asRecord(record?.last)
    if (rawLast && typeof rawLast.at === 'number') last = rawLast as unknown as LatticeSyncResult
    const rawConflicts = Array.isArray(record?.conflicts) ? record?.conflicts : []
    for (const value of rawConflicts) {
      const entry = asRecord(value)
      const pluginId = readString(entry?.plugin_id)
      if (!pluginId) continue
      conflicts.push({
        plugin_id: pluginId,
        local_rev: typeof entry?.local_rev === 'number' ? entry.local_rev : 0,
        server_rev: typeof entry?.server_rev === 'number' ? entry.server_rev : 0,
        ...(entry && 'local_data' in entry ? { local_data: entry.local_data } : {}),
        ...(entry?.reason === 'diverged' || entry?.reason === 'no-base' || entry?.reason === 'rev'
          ? { reason: entry.reason }
          : {}),
        at: typeof entry?.at === 'number' ? entry.at : 0
      })
    }
    const rawOrphaned = Array.isArray(record?.orphaned) ? record?.orphaned : []
    for (const value of rawOrphaned) {
      const entry = asRecord(value)
      const pluginId = readString(entry?.plugin_id)
      if (!pluginId) continue
      orphaned.push({
        plugin_id: pluginId,
        ...(readOptionalString(entry?.version)
          ? { version: readOptionalString(entry?.version) }
          : {}),
        reason: entry?.reason === 'not_found' ? 'not_found' : 'plugin_deleted',
        at: typeof entry?.at === 'number' && Number.isFinite(entry.at) ? entry.at : 0,
        ...(readOptionalString(entry?.error) ? { error: readOptionalString(entry?.error) } : {})
      })
    }
    const rawSources = asRecord(record?.sources)
    if (rawSources) {
      for (const [pluginId, value] of Object.entries(rawSources)) {
        const entry = asRecord(value)
        if (!entry) continue
        const entryPath = readString(entry.path)
        if (!entryPath) continue
        sources[pluginId] = {
          path: entryPath,
          ...(readOptionalString(entry.version)
            ? { version: readOptionalString(entry.version) }
            : {}),
          ...(readOptionalString(entry.sha256) ? { sha256: readOptionalString(entry.sha256) } : {}),
          ...(readOptionalString(entry.managed)
            ? { managed: readOptionalString(entry.managed) }
            : {}),
          at: typeof entry.at === 'number' && Number.isFinite(entry.at) ? entry.at : 0
        }
      }
    }
    const rawSnapshotPlugins = asRecord(record?.snapshotPlugins)
    if (rawSnapshotPlugins) {
      for (const [pluginId, value] of Object.entries(rawSnapshotPlugins)) {
        if (value === true && pluginId.trim() !== '') snapshotPlugins[pluginId] = true
      }
    }
    const rawDirty = asRecord(record?.dirty)
    if (rawDirty) {
      for (const [pluginId, value] of Object.entries(rawDirty)) {
        if (value === true && pluginId.trim() !== '') dirty[pluginId] = true
      }
    }
    const rawSnapshotPushed = asRecord(record?.snapshotPushed)
    if (rawSnapshotPushed) {
      for (const [pluginId, value] of Object.entries(rawSnapshotPushed)) {
        if (value === true && pluginId.trim() !== '') snapshotPushed[pluginId] = true
      }
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code
    if (code !== 'ENOENT')
      logger.warn('[Lattice] Failed to read lattice-sync.json, using empty cache:', err)
  }
  cache = {
    revs,
    last,
    ...(conflicts.length > 0 ? { conflicts } : {}),
    ...(orphaned.length > 0 ? { orphaned } : {}),
    ...(Object.keys(sources).length > 0 ? { sources } : {}),
    ...(Object.keys(snapshotPlugins).length > 0 ? { snapshotPlugins } : {}),
    ...(Object.keys(snapshotPushed).length > 0 ? { snapshotPushed } : {}),
    ...(Object.keys(dirty).length > 0 ? { dirty } : {})
  }
  return cache
}

/**
 * Records the local location of a plugin's source (called after downloading the source on install /
 * after a successful republish).
 *
 * Local cache only, not part of push/pull; failures only warn (the source is already on disk, the
 * cache is just attachment info).
 */
export function recordLatticeSourceCache(
  pluginId: string,
  entry: Omit<LatticeSourceCacheEntry, 'at'>
): void {
  const id = String(pluginId ?? '').trim()
  if (!id) return
  try {
    const store = loadSyncCache()
    store.sources = { ...(store.sources ?? {}), [id]: { ...entry, at: Date.now() } }
    saveSyncCache()
  } catch (err) {
    logger.warn('[Lattice] Failed to record source cache (source itself is unaffected):', err)
  }
}

function saveSyncCache(): void {
  const file = syncCachePath()
  const tmp = `${file}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, `${JSON.stringify(cache ?? { revs: {} }, null, 2)}\n`, 'utf-8')
    fs.renameSync(tmp, file)
  } catch (err) {
    logger.warn('[Lattice] Failed to write lattice-sync.json:', err)
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      // Failing to clean up the temp file does not matter
    }
  }
}

/**
 * Counts business data rows in a snapshot (only when the plugin provides `count()`; failures count
 * as 0 and do not affect sync).
 */
async function countSnapshotRows(pluginId: string, data: unknown): Promise<number> {
  const counter = pluginSyncSnapshot(pluginId)?.count
  if (!counter) return 0
  try {
    const value = Number(await counter(data))
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
  } catch (err) {
    logger.warn(`[Lattice] ${pluginId}: count() failed, rows will show as 0:`, err)
    return 0
  }
}

/** Records that "this plugin provides its own sync payload" — remembered across disable to avoid falling back to the settings file */
function markSnapshotPlugin(pluginId: string): void {
  const store = loadSyncCache()
  if (store.snapshotPlugins?.[pluginId]) return
  store.snapshotPlugins = { ...(store.snapshotPlugins ?? {}), [pluginId]: true }
  saveSyncCache()
}

/** Whether the plugin uses its own snapshot (it has contributed `PLUGIN_SYNC_SNAPSHOT` before) */
function isSnapshotPlugin(pluginId: string): boolean {
  return loadSyncCache().snapshotPlugins?.[pluginId] === true
}

/** Whether the plugin has uploaded its own snapshot successfully once (set only after a push that carried data succeeds) */
function isSnapshotPushed(pluginId: string): boolean {
  return loadSyncCache().snapshotPushed?.[pluginId] === true
}

/** Records that "a plugin's own snapshot has been uploaded successfully" — later pushes without dirty need not resend the whole dataset */
function markSnapshotPushed(pluginId: string): void {
  const store = loadSyncCache()
  if (store.snapshotPushed?.[pluginId]) return
  store.snapshotPushed = { ...(store.snapshotPushed ?? {}), [pluginId]: true }
  saveSyncCache()
}

/** Marks "local has unpushed changes" after a plugin writes to its tables (`ctx.requestSync()` passes the plugin id) */
export function markLatticePluginDirty(pluginId: string): void {
  const id = String(pluginId ?? '').trim()
  if (!id) return
  const store = loadSyncCache()
  if (store.dirty?.[id]) return
  store.dirty = { ...(store.dirty ?? {}), [id]: true }
  saveSyncCache()
}

function isPluginDirty(pluginId: string): boolean {
  return loadSyncCache().dirty?.[pluginId] === true
}

function clearPluginDirty(pluginId: string): void {
  const store = loadSyncCache()
  if (!store.dirty?.[pluginId]) return
  const next = { ...store.dirty }
  delete next[pluginId]
  if (Object.keys(next).length > 0) store.dirty = next
  else delete store.dirty
  saveSyncCache()
}

/**
 * Records a conflict for "local has unsynced changes and the cloud has updates too" (pull side).
 *
 * Shares the same `conflicts` list and the same "resolve conflict" dialog as push 409 conflicts:
 * the user choosing "use local" = force push, "use cloud" = import; both paths clear dirty.
 */
function recordPullConflict(
  pluginId: string,
  localRev: number,
  serverRev: number,
  localData?: unknown,
  reason?: LatticeSyncConflict['reason']
): void {
  const store = loadSyncCache()
  const existing = store.conflicts?.find((c) => c.plugin_id === pluginId)
  if (
    existing &&
    existing.local_rev === localRev &&
    existing.server_rev === serverRev &&
    existing.reason === reason
  ) {
    return
  }
  store.conflicts = [
    ...(store.conflicts ?? []).filter((c) => c.plugin_id !== pluginId),
    {
      plugin_id: pluginId,
      local_rev: localRev,
      server_rev: serverRev,
      ...(localData !== undefined ? { local_data: localData } : {}),
      ...(reason ? { reason } : {}),
      at: Date.now()
    }
  ]
  saveSyncCache()
  logger.warn(
    `[Lattice] ${pluginId}: local data has unsynced changes (dirty, local_rev=${localRev}) ` +
      `while the cloud moved to data_rev=${serverRev}; not importing (would drop local edits)`
  )
}

/**
 * Reads the sync payload.
 *
 * Priority:
 * 1. The plugin contributes `PLUGIN_SYNC_SNAPSHOT` → use its `export()` (a complete snapshot of
 *    settings + business tables). This path **returns null on failure/oversize and never falls back
 *    to the file**: `plugin-state/<id>.json` only holds settings, and uploading it as a snapshot
 *    would overwrite cloud data with settings;
 * 2. Otherwise read `plugin-state/<id>.json` with the legacy semantics (missing / invalid JSON /
 *    over 256KiB all count as no data).
 */
async function readPluginData(pluginId: string): Promise<{ data: unknown; bytes: number } | null> {
  const snapshot = pluginSyncSnapshot(pluginId)
  if (snapshot) {
    try {
      const data = await snapshot.export()
      if (data === undefined) return null
      const bytes = Buffer.byteLength(JSON.stringify(data), 'utf8')
      if (bytes > DATA_MAX_BYTES) {
        logger.error(
          `[Lattice] plugin snapshot for ${pluginId} is ${bytes}B, over 256KiB, skipping sync ` +
            '(not truncated to avoid losing user data; shrink the snapshot or raise the platform limit)'
        )
        return null
      }
      markSnapshotPlugin(pluginId)
      return { data, bytes }
    } catch (err) {
      logger.error(
        `[Lattice] Plugin snapshot export failed for ${pluginId}; cloud data is left untouched:`,
        err
      )
      // Do not mark snapshotPlugins: let the next push retry the export (marking it would make it skip forever as "not dirty")
      return null
    }
  }

  // Known to use its own snapshot but not loaded right now (disabled/load failed): must **not**
  // fall back to the settings file — that would overwrite the cloud snapshot with settings. Only
  // version/enabled are synced; data is pushed after the plugin is enabled.
  if (isSnapshotPlugin(pluginId)) return null

  const file = pluginStatePath(pluginId)
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile()) return null
    if (stat.size > DATA_MAX_BYTES) {
      logger.warn(
        `[Lattice] plugin-state data for ${pluginId} is ${stat.size}B, over 256KiB, skipping sync (not truncated to avoid losing user data)`
      )
      return null
    }
    const text = fs.readFileSync(file, 'utf-8')
    return { data: JSON.parse(text) as unknown, bytes: stat.size }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code
    if (code !== 'ENOENT')
      logger.warn(`[Lattice] Failed to read plugin-state/${pluginId}.json:`, err)
    return null
  }
}

/**
 * Cloud snapshots received while a plugin is disabled (kept in memory): applied once the plugin is
 * loaded again.
 *
 * They cannot be written straight to `plugin-state/<id>.json` — that is the settings file, and a
 * later push would send those settings back to the cloud as a snapshot (overwriting real data). So
 * they stay in memory and are applied on `plugin-state-changed`.
 */
const pendingSnapshots = new Map<string, { data: unknown; rev: number }>()

/**
 * Applies a cloud snapshot locally.
 *
 * - Plugin loaded and implements `import` → hand it to the plugin (**replace + idempotent**;
 *   repeated application never produces duplicate rows);
 * - Plugin uses its own snapshot but is not loaded → **do not write to disk**, keep it in memory
 *   until it is enabled (returns false, rev is not advanced);
 * - Other plugins keep the legacy semantics: write back to `plugin-state/<id>.json`.
 */
async function applyRemoteData(pluginId: string, data: unknown, rev: number): Promise<boolean> {
  const snapshot = pluginSyncSnapshot(pluginId)
  if (snapshot?.import) {
    try {
      await snapshot.import(data)
      pendingSnapshots.delete(pluginId)
      markSnapshotPlugin(pluginId)
      // Apply succeeded = local now matches this cloud snapshot: it becomes the baseline for the next merge
      writeMergeBase(pluginId, rev, data)
      logger.info(`[Lattice] Applied cloud snapshot via plugin: ${pluginId} (data_rev=${rev})`)
      return true
    } catch (err) {
      logger.error(
        `[Lattice] Plugin snapshot import failed for ${pluginId}; keeping local data and data_rev:`,
        err
      )
      return false
    }
  }
  if (snapshot || isSnapshotPlugin(pluginId)) {
    pendingSnapshots.set(pluginId, { data, rev })
    logger.info(
      `[Lattice] Plugin ${pluginId} is not loaded (or has no importer); cloud snapshot kept in memory ` +
        `(data_rev=${rev}) until the plugin is enabled`
    )
    return false
  }
  return writePluginStateFile(pluginId, data)
}

/** Writes back cloud data (atomic write; oversized data over 256KiB is not written) */
function writePluginStateFile(pluginId: string, data: unknown): boolean {
  let text: string
  try {
    text = JSON.stringify(data)
  } catch (err) {
    logger.warn(`[Lattice] Cloud data for ${pluginId} is not serializable, skipping:`, err)
    return false
  }
  if (Buffer.byteLength(text, 'utf8') > DATA_MAX_BYTES) {
    logger.warn(`[Lattice] Cloud data for ${pluginId} exceeds 256KiB, skipping write-back`)
    return false
  }
  const file = pluginStatePath(pluginId)
  const tmp = `${file}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, text, 'utf-8')
    fs.renameSync(tmp, file)
    logger.info(`[Lattice] Wrote back cloud data: plugin-state/${pluginId}.json`)
    return true
  } catch (err) {
    logger.warn(`[Lattice] Failed to write back plugin-state/${pluginId}.json:`, err)
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      // Failing to clean up the temp file does not matter
    }
    return false
  }
}

function mapRemoteInstall(raw: unknown): LatticeRemoteInstall {
  const record = asRecord(raw) ?? {}
  const pluginRaw = asRecord(record.plugin)
  return {
    plugin_id: readString(record.plugin_id),
    version: readOptionalString(record.version),
    enabled: typeof record.enabled === 'boolean' ? record.enabled : undefined,
    data_rev: typeof record.data_rev === 'number' ? record.data_rev : undefined,
    data_updated_at: readOptionalString(record.data_updated_at),
    last_device: typeof record.last_device === 'string' ? record.last_device : null,
    updated_at: readOptionalString(record.updated_at),
    plugin: pluginRaw
      ? {
          name: readOptionalString(pluginRaw.name),
          icon: readOptionalString(pluginRaw.icon),
          latest_version: readOptionalString(pluginRaw.latest_version),
          status: readOptionalString(pluginRaw.status)
        }
      : null,
    // The platform shows a deleted plugin in two ways: an explicit `plugin:null`, or the plugin row
    // still present after a soft delete (`status:'removed'`). When an old platform has neither
    // field, do not treat it as deleted (that would mark every record from old platforms orphaned).
    plugin_deleted:
      ('plugin' in record && record.plugin === null) ||
      readOptionalString(pluginRaw?.status) === 'removed',
    data: record.data
  }
}

// ---------- Local view ----------

/** Return of `lattice:hub-installs`: locally installed plugins + cached local data_rev */
export function listLatticeLocalInstalls(): LatticeInstallSummary[] {
  const revs = loadSyncCache().revs
  return scanExternalPlugins().map((plugin) => ({
    plugin_id: plugin.id,
    version: plugin.manifest.version,
    enabled: isEnabledPlugin(plugin.id),
    data_rev: revs[plugin.id] ?? 0
  }))
}

export function getLastLatticeSyncResult(): LatticeSyncResult | null {
  if (!lastResult) {
    const cached = loadSyncCache().last
    if (cached) lastResult = cached
  }
  return lastResult
}

/** Unresolved conflict list (for the renderer's "resolve conflict" dialog; server_data added on demand) */
export function listLatticeSyncConflicts(): LatticeSyncConflict[] {
  return [...(loadSyncCache().conflicts ?? [])]
}

// ---------- Orphaned install records (plugin deleted from the platform; local data kept, only marked) ----------

/** Install records still marked "deleted from the platform" (local plugin directory and data kept, never auto-deleted) */
export function listLatticeSyncOrphaned(): LatticeSyncOrphanedItem[] {
  return [...(loadSyncCache().orphaned ?? [])]
}

/**
 * Marks/updates an orphaned record (idempotent: one record per plugin).
 *
 * `at` keeps the first marking time; `reason`/`error` are overwritten by the latest observation (so
 * the latest cause is visible if the platform deletes the plugin again). Clearing only happens when
 * pull observes the plugin visible again (a successful push does not mean the plugin still exists,
 * see pushInstallRecords).
 */
function markLatticeOrphaned(
  pluginId: string,
  version: string | undefined,
  reason: LatticeSyncOrphanReason,
  error?: string
): void {
  const id = String(pluginId ?? '').trim()
  if (!id) return
  const store = loadSyncCache()
  const existing = store.orphaned?.find((entry) => entry.plugin_id === id)
  const next: LatticeSyncOrphanedItem = {
    plugin_id: id,
    ...(version ? { version } : existing?.version ? { version: existing.version } : {}),
    reason,
    at: existing?.at ?? Date.now(),
    ...(error ? { error } : existing?.error ? { error: existing.error } : {})
  }
  store.orphaned = [...(store.orphaned ?? []).filter((entry) => entry.plugin_id !== id), next]
  saveSyncCache()
  logger.warn(
    `[Lattice] Install record '${id}' marked orphaned (${reason}): ${error ?? 'plugin deleted on platform'}; local data kept, not deleted`
  )
}

/** The plugin reappears on the platform (pull observes a non-null `plugin`): clear the orphaned flag; local data is unaffected */
function clearLatticeOrphaned(pluginId: string): boolean {
  const id = String(pluginId ?? '').trim()
  if (!id) return false
  const store = loadSyncCache()
  const orphaned = store.orphaned ?? []
  if (!orphaned.some((entry) => entry.plugin_id === id)) return false
  store.orphaned = orphaned.filter((entry) => entry.plugin_id !== id)
  saveSyncCache()
  logger.info(
    `[Lattice] Install record '${id}' is no longer orphaned (plugin is back on the platform)`
  )
  return true
}

/** `lattice:sync-details`: data for the sync details dialog (last sync detail + conflicts + orphaned records) */
export function getLatticeSyncDetails(): LatticeSyncDetails {
  return {
    last: getLastLatticeSyncResult(),
    conflicts: listLatticeSyncConflicts(),
    orphaned: listLatticeSyncOrphaned()
  }
}

/**
 * Fetches cloud data snapshots so the user can compare "use local / use cloud".
 *
 * A 409 response only carries the server `data_rev` (no 256KiB payload echo), so this fetches the
 * conflicting plugins' data separately via `GET /v1/hub/installs?include_data=1`; on failure it
 * shows rev only instead of blocking the dialog.
 */
export async function listLatticeSyncConflictsDetailed(): Promise<
  Array<LatticeSyncConflict & { server_data?: unknown }>
> {
  const conflicts = listLatticeSyncConflicts()
  if (conflicts.length === 0) return []
  try {
    const raw = await latticeRequest<unknown>('/v1/hub/installs', {
      query: { include_data: '1' }
    })
    const record = asRecord(raw) ?? {}
    const items = Array.isArray(record.items) ? record.items.map(mapRemoteInstall) : []
    return conflicts.map((conflict) => {
      const item = items.find((i) => i.plugin_id === conflict.plugin_id)
      return {
        ...conflict,
        // Only plugins declaring "supports merge-base three-way merge" show "merge both":
        // the merge() of older plugins is an unconditional union and would bring back rows deleted/
        // edited locally, so it must stay disabled.
        merge_supported: pluginSyncSnapshot(conflict.plugin_id)?.mergeBase === true,
        server_rev: item?.data_rev ?? conflict.server_rev,
        ...(item && item.data !== undefined ? { server_data: item.data } : {})
      }
    })
  } catch (err) {
    logger.warn('[Lattice] Failed to fetch cloud data for conflicts (showing rev only):', err)
    return conflicts
  }
}

/**
 * Resolves one `data_rev` conflict.
 *
 * - `strategy='local'`: overwrite the cloud with local data (`PUT ...?force=1`, i.e. "last writer
 *   wins");
 * - `strategy='cloud'`: overwrite local with cloud data (handed to the plugin's `import` for
 *   own-snapshot plugins, otherwise written back to `plugin-state/<id>.json`, and rev aligned; when
 *   the cloud has no data, both sides are kept consistent).
 *
 * Both choices require an explicit user click (no silent overwrite).
 */
/** Conflict handling strategy: use local / use cloud / merge both */
export type LatticeConflictStrategy = 'local' | 'cloud' | 'merge'

export async function resolveLatticeSyncConflict(
  pluginId: string,
  strategy: LatticeConflictStrategy
): Promise<LatticeResolveConflictResult> {
  const id = String(pluginId ?? '').trim()
  if (!id) return { ok: false, error: '缺少插件 id' }
  const store = loadSyncCache()
  const conflict = store.conflicts?.find((c) => c.plugin_id === id)
  if (!conflict) return { ok: false, error: '没有待解决的冲突' }
  const plugin = scanExternalPlugins().find((p) => p.id === id)
  if (!plugin) return { ok: false, error: '本机未安装这个插件，无法解决冲突' }

  let summary: string | undefined
  let mergedRows = 0
  try {
    if (strategy === 'local') {
      const dataInfo = await readPluginData(id)
      const body: LatticeInstallPutBody = {
        version: plugin.manifest.version,
        enabled: isEnabledPlugin(id),
        device_id: getLatticeDeviceId() ?? undefined
      }
      if (dataInfo) {
        body.data = dataInfo.data
        body.data_rev = store.revs[id] ?? conflict.local_rev
      }
      const record = await latticeRequest<LatticeRemoteInstall>(
        `/v1/hub/installs/${encodeURIComponent(id)}`,
        { method: 'PUT', body, query: { force: '1' } }
      )
      if (typeof record?.data_rev === 'number') store.revs[id] = record.data_rev
      if (dataInfo) {
        // Only own-snapshot plugins need a merge base (file-semantics plugin data does not take part in three-way merges)
        if (pluginSyncSnapshot(id)) {
          writeMergeBase(id, store.revs[id] ?? conflict.local_rev, dataInfo.data)
        }
        clearPluginDirty(id)
        markSnapshotPushed(id)
      }
    } else {
      const raw = await latticeRequest<unknown>('/v1/hub/installs', {
        query: { include_data: '1' }
      })
      const record = asRecord(raw) ?? {}
      const items = Array.isArray(record.items) ? record.items.map(mapRemoteInstall) : []
      const item = items.find((i) => i.plugin_id === id)
      if (!item) return { ok: false, error: '云端没有这个插件的安装记录' }

      if (strategy === 'merge') {
        const contribution = pluginSyncSnapshot(id)
        const merger = contribution?.merge
        if (!merger || contribution?.mergeBase !== true) {
          return {
            ok: false,
            error: '当前插件版本不支持基于合并基线的安全合并，请选择「用本机」或「用云端」'
          }
        }
        if (item.data === undefined || item.data === null) {
          return { ok: false, error: '云端没有可合并的数据' }
        }
        // Merging changes local data: keep a rollback point first and restore it on push failure/409 to avoid a half-merged state
        const beforeInfo = await readPluginData(id)
        const before = beforeInfo?.data
        markLatticePluginDirty(id)
        try {
          const merged = await merger(item.data, { base: readMergeBase(id)?.data })
          summary = merged?.summary
          mergedRows = Number(merged?.rows ?? 0) || 0
          const dataInfo = await readPluginData(id)
          if (!dataInfo) throw new Error('合并完成，但读取合并后的本机快照失败')
          const pushed = await latticeRequest<LatticeRemoteInstall>(
            `/v1/hub/installs/${encodeURIComponent(id)}`,
            {
              method: 'PUT',
              body: {
                version: plugin.manifest.version,
                enabled: isEnabledPlugin(id),
                device_id: getLatticeDeviceId() ?? undefined,
                data: dataInfo.data,
                data_rev: item.data_rev ?? conflict.server_rev
              }
            }
          )
          const nextRev =
            typeof pushed?.data_rev === 'number'
              ? pushed.data_rev
              : (item.data_rev ?? conflict.server_rev) + 1
          store.revs[id] = nextRev
          writeMergeBase(id, nextRev, dataInfo.data)
          markSnapshotPushed(id)
        } catch (err) {
          if (before !== undefined) await restoreLocalSnapshot(id, before)
          throw err
        }
      } else {
        const beforeInfo = await readPluginData(id)
        const before = beforeInfo?.data
        if (item.data !== undefined && item.data !== null) {
          if (!(await applyRemoteData(id, item.data, item.data_rev ?? conflict.server_rev))) {
            if (before !== undefined) await restoreLocalSnapshot(id, before)
            return {
              ok: false,
              error: isSnapshotPlugin(id)
                ? '本机插件未启用或快照导入失败，无法应用云端数据（本机已回滚，启用插件后重试）'
                : '写入本机插件数据失败'
            }
          }
        } else if (!isSnapshotPlugin(id)) {
          // The cloud has no data: clear local as well so the next push does not send the old data
          // back. Own-snapshot plugins skip this: `plugin-state/<id>.json` is their settings file
          // and deleting it would lose settings.
          try {
            fs.rmSync(pluginStatePath(id), { force: true })
          } catch (err) {
            logger.warn(`[Lattice] Failed to clear local plugin data: ${id}`, err)
          }
        }
        store.revs[id] = item.data_rev ?? conflict.server_rev
      }
    }
    store.conflicts = (store.conflicts ?? []).filter((c) => c.plugin_id !== id)
    // All three paths (use local / use cloud / merge) align local with cloud: no unsynced changes remain
    clearPluginDirty(id)
    saveSyncCache()
    try {
      hooks.onStateChanged?.()
    } catch (err) {
      logger.warn('[Lattice] Error in state callback after conflict resolution:', err)
    }
    logger.info(
      `[Lattice] Conflict resolved: ${id} -> ${
        strategy === 'local' ? 'use local' : strategy === 'cloud' ? 'use cloud' : 'merge'
      }${summary ? ` (${summary})` : ''}`
    )
    return {
      ok: true,
      ...(summary ? { summary } : {}),
      ...(mergedRows > 0 ? { rows: mergedRows } : {})
    }
  } catch (err) {
    const message = latticeErrorMessage(err)
    logger.warn(`[Lattice] Failed to resolve conflict: ${id} -> ${strategy}: ${message}`)
    return { ok: false, error: message }
  }
}

// ---------- push / pull ----------

/**
 * "Merge cloud data": per-plugin **git-style fast-forward / conflict**, no more unconditional
 * unions.
 *
 * The old implementation (reported by a user on 2026-11-25) `merge()`d the cloud snapshot into local
 * data and pushed it back with `force=1`:
 * - no merge base, so "deleted locally" could not be told apart from "added in the cloud" → deleted/
 *   edited rows were restored;
 * - local dirty state was ignored, so clicking merge within 5s after a delete brought the rows back;
 * - a failed push did not roll back, leaving local data half-merged.
 *
 * It now decides from the merge base (`plugin-state/.lattice-sync-base/<id>.json`) plus dirty/
 * snapshot drift:
 * - only local changed → push (deletions/edits go up and are not restored by stale cloud data);
 * - only cloud changed → pull (only allowed when local has no unsynced changes);
 * - both changed → record a conflict, **never auto-union/overwrite**, the user explicitly chooses in
 *   "resolve conflict";
 * - never send `force`; a server 409 means "the cloud moved again" and turns directly into a
 *   conflict.
 *
 * Failures are isolated per plugin: one plugin failing does not affect the others.
 */
export async function mergeAllLatticePluginData(): Promise<LatticeMergeDataResult> {
  if (!isLatticeLoggedIn()) return { ok: false, error: '未登录插件中心，请先登录' }
  const guard = profileSyncGuard()
  if (guard) return { ok: false, error: guard }

  try {
    const raw = await latticeRequest<unknown>('/v1/hub/installs', {
      query: { include_data: '1' }
    })
    const record = asRecord(raw) ?? {}
    const items = Array.isArray(record.items) ? record.items.map(mapRemoteInstall) : []
    const store = loadSyncCache()
    const summaries: string[] = []
    const failures: string[] = []
    let pushed = 0
    let pulled = 0
    let mergedRows = 0
    let conflicts = 0
    let blocked = 0

    for (const plugin of scanExternalPlugins()) {
      const contribution = pluginSyncSnapshot(plugin.id)
      // Only own-snapshot plugins take part: plugins without export have no data to align
      if (!contribution) continue
      const item = items.find((i) => i.plugin_id === plugin.id)
      if (!item || item.plugin_deleted) continue
      const remoteData = item.data
      if (remoteData === undefined || remoteData === null) continue

      const name = plugin.manifest.name || plugin.id
      try {
        const localInfo = await readPluginData(plugin.id)
        if (!localInfo) {
          if (isPluginDirty(plugin.id)) {
            failures.push(`${plugin.id}: 本机快照读不到（插件未装载或导出失败），本次未处理`)
          }
          continue
        }

        const base = readMergeBase(plugin.id)
        const serverRev = item.data_rev ?? 0
        const expectedRev = Math.max(store.revs[plugin.id] ?? 0, base?.rev ?? 0)
        const decision = decideMergeAction({
          hasBase: base !== null,
          baseRev: base?.rev ?? 0,
          serverRev,
          dirty: isPluginDirty(plugin.id),
          localDrift: base !== null && !snapshotsEqual(localInfo.data, base.data)
        })

        if (decision === 'sync') {
          store.revs[plugin.id] = serverRev
          clearPluginDirty(plugin.id)
          continue
        }

        if (decision === 'no-base') {
          // First time after upgrade / just switched node: both sides match and local is clean, so the cloud copy can safely become the base
          if (!isPluginDirty(plugin.id) && snapshotsEqual(localInfo.data, remoteData)) {
            store.revs[plugin.id] = serverRev
            writeMergeBase(plugin.id, serverRev, remoteData)
            clearPluginDirty(plugin.id)
            continue
          }
          blocked += 1
          failures.push(
            `${plugin.id}: 缺少合并基线，请先「立即同步」一次再合并（本次没有改动任何数据）`
          )
          continue
        }

        if (decision === 'conflict') {
          recordPullConflict(plugin.id, expectedRev, serverRev, localInfo.data, 'diverged')
          conflicts += 1
          summaries.push(`${name}: 两边都有改动，已记冲突（不会自动覆盖）`)
          continue
        }

        if (decision === 'push') {
          try {
            const pushedRecord = await latticeRequest<LatticeRemoteInstall>(
              `/v1/hub/installs/${encodeURIComponent(plugin.id)}`,
              {
                method: 'PUT',
                body: {
                  version: plugin.manifest.version,
                  enabled: isEnabledPlugin(plugin.id),
                  device_id: getLatticeDeviceId() ?? undefined,
                  data: localInfo.data,
                  data_rev: expectedRev
                }
              }
            )
            const nextRev =
              typeof pushedRecord?.data_rev === 'number' ? pushedRecord.data_rev : expectedRev + 1
            store.revs[plugin.id] = nextRev
            writeMergeBase(plugin.id, nextRev, localInfo.data)
            clearPluginDirty(plugin.id)
            markSnapshotPushed(plugin.id)
            store.conflicts = (store.conflicts ?? []).filter((c) => c.plugin_id !== plugin.id)
            pushed += 1
            mergedRows += await countSnapshotRows(plugin.id, localInfo.data)
            summaries.push(`${name}: 已推送本机更新`)
          } catch (err) {
            // 409 = the cloud moved again after the comparison: turn into a conflict, never force-overwrite
            if (err instanceof LatticeApiError && err.status === 409) {
              recordPullConflict(
                plugin.id,
                expectedRev,
                conflictServerRev(err, expectedRev),
                localInfo.data,
                'diverged'
              )
              conflicts += 1
              summaries.push(`${name}: 云端同时有更新，已记冲突（本机未覆盖云端）`)
            } else {
              throw err
            }
          }
          continue
        }

        // decision === 'pull': only allowed to replace local with the cloud snapshot when local has no unsynced changes
        const before = localInfo.data
        if (!(await applyRemoteData(plugin.id, remoteData, serverRev))) {
          const restored = await restoreLocalSnapshot(plugin.id, before)
          throw new Error(
            restored
              ? '应用云端快照失败（插件未启用或导入失败），本机已回滚到合并前'
              : '应用云端快照失败（插件未启用或导入失败），且回滚失败，请检查插件数据'
          )
        }
        store.revs[plugin.id] = serverRev
        clearPluginDirty(plugin.id)
        pulled += 1
        mergedRows += await countSnapshotRows(plugin.id, remoteData)
        summaries.push(`${name}: 已拉取云端更新`)
      } catch (err) {
        failures.push(`${plugin.id}: ${latticeErrorMessage(err)}`)
        logger.warn(`[Lattice] Merge cloud data failed for ${plugin.id}:`, err)
      }
    }

    saveSyncCache()
    if (pushed + pulled > 0) {
      try {
        hooks.onStateChanged?.()
      } catch (err) {
        logger.warn('[Lattice] Error in state callback after merge:', err)
      }
    }
    logger.info(
      `[Lattice] Merge cloud data: pushed=${pushed} pulled=${pulled} ` +
        `conflicts=${conflicts} blocked=${blocked} failed=${failures.length}`
    )
    const merged = pushed + pulled
    if (merged === 0 && failures.length === 0 && conflicts === 0) {
      // Nothing moved and no failure/conflict: no snapshot plugins installed, or the cloud has no
      // snapshots for them. Not an error — let the UI say "no data to merge" instead of showing
      // "merge complete: 0 plugins".
      return {
        ok: true,
        merged: 0,
        pushed: 0,
        pulled: 0,
        rows: 0,
        failed: 0,
        conflicts: 0,
        blocked,
        empty: true,
        summaries: []
      }
    }
    return {
      ok: failures.length === 0,
      merged,
      pushed,
      pulled,
      rows: mergedRows,
      failed: failures.length,
      conflicts,
      blocked,
      summaries,
      ...(failures.length > 0 ? { error: failures.join('；') } : {})
    }
  } catch (err) {
    return { ok: false, error: latticeErrorMessage(err) }
  }
}

/** Restores the local snapshot to its pre-merge state (the plugin's `import` has replace semantics and is idempotent) */
async function restoreLocalSnapshot(pluginId: string, before: unknown): Promise<boolean> {
  const importer = pluginSyncSnapshot(pluginId)?.import
  if (!importer) return false
  try {
    await importer(before)
    logger.info(`[Lattice] Rolled back local snapshot for ${pluginId} after a failed cloud apply`)
    return true
  } catch (err) {
    logger.error(`[Lattice] Failed to roll back local snapshot for ${pluginId}:`, err)
    return false
  }
}

/** Reads the current server rev from a 409 response (for conflict records; falls back to +1 estimate) */
function conflictServerRev(err: LatticeApiError, fallback: number): number {
  const detail = asRecord(err.details)
  const server = asRecord(detail?.server)
  if (typeof server?.data_rev === 'number') return server.data_rev
  if (typeof detail?.data_rev === 'number') return detail.data_rev
  return fallback + 1
}

/** Push hit a "deleted from the platform" error (404/410) */
function isOrphanedPushError(err: unknown): err is LatticeApiError {
  return err instanceof LatticeApiError && (err.status === 404 || err.status === 410)
}

/**
 * Pushes install records plugin by plugin (attaching data + data_rev when there is local data).
 *
 * - 409: the cloud was changed by another device → record a conflict without overwriting (the user
 *   chooses explicitly);
 * - 410/404: the plugin the install record points to was deleted from the platform → **keep the
 *   local plugin directory and plugin-state data**, only mark the record `orphaned` (visible in sync
 *   details), never auto-delete user data, and do not interrupt other plugins.
 */
async function pushInstallRecords(): Promise<{
  pushed: number
  /** Number of business data rows actually uploaded this time (counted by the plugin's count()) */
  rows: number
  conflicts: number
  orphaned: LatticeSyncOrphanedItem[]
}> {
  const store = loadSyncCache()
  const deviceId = getLatticeDeviceId() ?? undefined
  let pushed = 0
  let rows = 0
  let conflicts = 0
  for (const plugin of scanExternalPlugins()) {
    // Own-snapshot plugins export and upload data only when "local has unsynced changes", "never
    // pushed yet" or "first switch from file semantics to snapshot semantics": this avoids bumping
    // data_rev on every enable/disable or unrelated plugin change, and avoids pointless re-imports
    // on other devices.
    const contribution = pluginSyncSnapshot(plugin.id)
    const snapshotMode = contribution !== null || isSnapshotPlugin(plugin.id)
    const firstPush = !(plugin.id in store.revs)
    // Use snapshotPushed (set only after a push that carried data), not snapshotPlugins: a pull
    // import (even of an old "settings only" snapshot) also sets snapshotPlugins, so using it here
    // would mean the "first full upload after upgrade" never triggers.
    const firstSnapshotPush = contribution !== null && !isSnapshotPushed(plugin.id)
    const withData = !snapshotMode || firstPush || firstSnapshotPush || isPluginDirty(plugin.id)
    const dataInfo = withData ? await readPluginData(plugin.id) : null
    const uploadedRows = dataInfo ? await countSnapshotRows(plugin.id, dataInfo.data) : 0
    const body: LatticeInstallPutBody = {
      version: plugin.manifest.version,
      enabled: isEnabledPlugin(plugin.id),
      device_id: deviceId
    }
    if (dataInfo) {
      body.data = dataInfo.data
      body.data_rev = store.revs[plugin.id] ?? 0
    }
    try {
      const record = await latticeRequest<LatticeRemoteInstall>(
        `/v1/hub/installs/${encodeURIComponent(plugin.id)}`,
        { method: 'PUT', body }
      )
      if (typeof record?.data_rev === 'number') store.revs[plugin.id] = record.data_rev
      // Data was uploaded with this push → local has no "unsynced changes" and the "first snapshot" is done
      if (dataInfo) {
        // Upload succeeded = cloud and local are aligned: this data becomes the baseline for the
        // next merge. Only own-snapshot plugins get a base: file-semantics plugins (e.g. music
        // playlists) do not take part in three-way merges.
        if (contribution !== null || isSnapshotPlugin(plugin.id)) {
          writeMergeBase(
            plugin.id,
            typeof record?.data_rev === 'number' ? record.data_rev : (store.revs[plugin.id] ?? 0),
            dataInfo.data
          )
        }
        clearPluginDirty(plugin.id)
        markSnapshotPushed(plugin.id)
        rows += uploadedRows
      }
      // A successful push means the plugin has no conflict left (e.g. retry succeeded after the user chose "use local")
      if (store.conflicts?.some((c) => c.plugin_id === plugin.id)) {
        store.conflicts = store.conflicts.filter((c) => c.plugin_id !== plugin.id)
      }
      // Note: a successful push only means the platform accepted the install record, **not that the
      // plugin still exists in the plugin hub** (the platform accepts installs upserts for deleted
      // plugins too). So the orphaned flag is cleared only when pull observes "plugin visible again
      // (plugin field non-null)" — see pullInstallRecords.
      pushed += 1
    } catch (err) {
      if (isOrphanedPushError(err)) {
        // The platform deleted this plugin: keep the local record and mark it orphaned (no data deletion, no interruption of other plugins)
        markLatticeOrphaned(
          plugin.id,
          plugin.manifest.version,
          err.status === 410 ? 'plugin_deleted' : 'not_found',
          latticeErrorMessage(err)
        )
        continue
      }
      if (err instanceof LatticeApiError && err.status === 409) {
        // The cloud was changed by another device: record a conflict, no force overwrite (the user must pick a side)
        const detail = asRecord(err.details)
        const server = asRecord(detail?.server)
        const serverRev =
          typeof server?.data_rev === 'number'
            ? server.data_rev
            : typeof detail?.data_rev === 'number'
              ? detail.data_rev
              : (store.revs[plugin.id] ?? 0) + 1
        const entry: LatticeSyncConflict = {
          plugin_id: plugin.id,
          local_rev: store.revs[plugin.id] ?? 0,
          server_rev: serverRev,
          ...(dataInfo ? { local_data: dataInfo.data } : {}),
          at: Date.now()
        }
        store.conflicts = [
          ...(store.conflicts ?? []).filter((c) => c.plugin_id !== plugin.id),
          entry
        ]
        conflicts += 1
        logger.warn(
          `[Lattice] Cloud data for ${plugin.id} was updated by another device (409 data_conflict, local=${entry.local_rev} server=${serverRev}), not overwriting this time`
        )
        continue
      }
      throw err
    }
  }
  saveSyncCache()
  return { pushed, rows, conflicts, orphaned: listLatticeSyncOrphaned() }
}

/** Result of auto-restoring one plugin (success carries restore info, failure carries a readable reason) */
type AutoInstallOutcome =
  | { ok: true; item: LatticeSyncAutoInstallItem; rows: number }
  | { ok: false; failure: LatticeSyncAutoInstallFailure }

/**
 * Auto-restores a plugin that "has a platform install record but no local package" (new machine/
 * reinstall/user deleted the directory).
 *
 * Reuses the existing install flow (download package → sha256 verify → unpack/install → download
 * source → write install record); this only adds two things: apply the enabled state from the cloud
 * install record, and write back newer cloud data with pull semantics.
 * **Errors are not swallowed**: failure reasons are returned as-is in the sync result
 * (autoInstall.failed) and shown one by one by the UI.
 */
async function autoInstallMissingPlugin(
  item: LatticeRemoteInstall,
  store: LatticeSyncCacheFile
): Promise<AutoInstallOutcome> {
  const pluginId = item.plugin_id
  const version = item.version || undefined
  const failure = (error: string): AutoInstallOutcome => ({
    ok: false,
    failure: { plugin_id: pluginId, ...(version ? { version } : {}), error }
  })
  const installer = hooks.installPlugin
  if (!installer) return failure('主进程未接线安装能力，无法自动补齐（请重试或手动安装）')
  try {
    logger.info(
      `[Lattice] Plugin ${pluginId}${version ? `@${version}` : ''} missing locally (platform install record exists), auto-restoring...`
    )
    const result = await installer(pluginId, version)
    if (!result.ok) {
      logger.warn(
        `[Lattice] Failed to auto-restore ${pluginId} (other plugins unaffected): ${result.error}`
      )
      return failure(result.error || '安装失败')
    }
    // Enabled state: installs are enabled by default; when the cloud record explicitly says disabled, follow it (never re-enable a plugin the user disabled)
    if (typeof item.enabled === 'boolean' && item.enabled !== isEnabledPlugin(pluginId)) {
      setEnabledOverride(pluginId, item.enabled)
      try {
        if (item.enabled) loadExternalMain(pluginId)
        else unloadExternalMain(pluginId)
        logger.info(
          `[Lattice] Applied cloud enabled state to ${pluginId} after auto-restore: ${item.enabled}`
        )
      } catch (err) {
        logger.warn(
          `[Lattice] Failed to load/unload main module of ${pluginId} after auto-restore:`,
          err
        )
      }
    }
    // Data: after restoring, local has no data, so apply cloud data with a larger rev using pull semantics
    const serverRev = item.data_rev ?? 0
    let dataRows = 0
    if (serverRev > (store.revs[pluginId] ?? 0)) {
      if (item.data !== undefined && item.data !== null) {
        dataRows = await countSnapshotRows(pluginId, item.data)
        if (await applyRemoteData(pluginId, item.data, serverRev)) store.revs[pluginId] = serverRev
      } else {
        store.revs[pluginId] = serverRev
      }
    }
    logger.info(
      `[Lattice] Auto-restore succeeded: ${pluginId}@${result.version}${result.sourceError ? ` (source restore failed: ${result.sourceError})` : ''}`
    )
    return {
      ok: true,
      item: {
        plugin_id: pluginId,
        version: result.version,
        ...(result.sourcePath ? { sourcePath: result.sourcePath } : {}),
        ...(result.sourceError ? { sourceError: result.sourceError } : {})
      },
      rows: dataRows
    }
  } catch (err) {
    const message = latticeErrorMessage(err)
    logger.warn(
      `[Lattice] Error while auto-restoring ${pluginId} (other plugins unaffected): ${message}`
    )
    return failure(message)
  }
}

/**
 * Pulls install records: writes back only newer cloud data, applies the enabled state, and
 * auto-restores missing plugins.
 *
 * - A record returned with `plugin:null` = the plugin was deleted → mark orphaned (local data kept,
 *   no auto-install);
 * - records with no local package: when `installMissing=true`, auto-install them one by one
 *   (failures are recorded individually and do not interrupt other plugins); when disabled, only put
 *   them into `pending` for the user to handle manually;
 * - write back only data with `data_rev > cached local rev` (never overwrite newer local data;
 *   conflicts still go through the push 409 mechanism).
 */
async function pullInstallRecords(installMissing: boolean): Promise<{
  pulled: number
  /** Number of business data rows actually applied this time (counted by the plugin's count()) */
  rows: number
  pending: string[]
  autoInstall: LatticeSyncAutoInstallResult
  orphaned: LatticeSyncOrphanedItem[]
  /** Number of conflicts newly recorded during this pull (local has unsynced changes and the cloud also updated) */
  conflicts: number
}> {
  const raw = await latticeRequest<unknown>('/v1/hub/installs', {
    query: { include_data: '1' }
  })
  const record = asRecord(raw) ?? {}
  const items = Array.isArray(record.items) ? record.items.map(mapRemoteInstall) : []
  const store = loadSyncCache()
  const localIds = new Set(scanExternalPlugins().map((plugin) => plugin.id))
  const pending: string[] = []
  const appliedEnabled: string[] = []
  const autoInstall: LatticeSyncAutoInstallResult = { attempted: 0, installed: [], failed: [] }
  let pulled = 0
  let rows = 0
  let conflicts = 0

  for (const item of items) {
    if (!item.plugin_id) continue
    if (item.plugin_deleted) {
      // The platform deleted this plugin (install record still exists): keep the local plugin
      // directory and data, only mark orphaned. Such records are never auto-installed (no
      // downloadable version remains) and user data is not deleted.
      markLatticeOrphaned(
        item.plugin_id,
        item.version,
        'plugin_deleted',
        '平台已删除该插件（本机安装记录与数据已保留）'
      )
      continue
    }
    // The plugin is visible on the platform: clear any historical orphaned flag (recovered after the author republished)
    clearLatticeOrphaned(item.plugin_id)

    /**
     * Plugins **explicitly uninstalled** on this machine: the platform record may still exist
     * because of an offline uninstall or a push from another device. Such plugins must not go
     * through "auto-restore on a new machine" (otherwise a single sync resurrects them), nor into
     * `pending` (they are not "missing", the user deliberately removed them). Reinstalling clears
     * this flag.
     */
    if (!localIds.has(item.plugin_id) && isInstallRemoved(item.plugin_id)) {
      logger.info(
        `[Lattice] Skipping auto-restore of '${item.plugin_id}': explicitly uninstalled on this machine`
      )
      continue
    }

    if (!localIds.has(item.plugin_id)) {
      // New machine/reinstall/user deleted the plugin directory: the platform has an install record but this machine has no package
      if (installMissing) {
        autoInstall.attempted += 1
        const outcome = await autoInstallMissingPlugin(item, store)
        if (outcome.ok) {
          autoInstall.installed.push(outcome.item)
          rows += outcome.rows
          localIds.add(item.plugin_id)
        } else {
          autoInstall.failed.push(outcome.failure)
        }
        continue
      }
      pending.push(item.plugin_id)
      continue
    }

    // 1. Enabled state: the cloud wins; write and load/unload only when it actually differs (avoid reloading plugins on every sync)
    if (typeof item.enabled === 'boolean' && item.enabled !== isEnabledPlugin(item.plugin_id)) {
      setEnabledOverride(item.plugin_id, item.enabled)
      try {
        if (item.enabled) loadExternalMain(item.plugin_id)
        else unloadExternalMain(item.plugin_id)
        appliedEnabled.push(item.plugin_id)
        logger.info(`[Lattice] Applied cloud enabled state to ${item.plugin_id}: ${item.enabled}`)
      } catch (err) {
        logger.warn(
          `[Lattice] Failed to load/unload main module of ${item.plugin_id} per cloud enabled state:`,
          err
        )
      }
    }

    // 2. Data: apply only newer versions; do not overwrite when local has unpushed changes / has never pushed a snapshot and holds data
    const serverRev = item.data_rev ?? 0
    const localRev = store.revs[item.plugin_id] ?? 0
    if (serverRev > localRev) {
      let protectLocal = isPluginDirty(item.plugin_id)
      if (!protectLocal && !isSnapshotPushed(item.plugin_id)) {
        const contribution = pluginSyncSnapshot(item.plugin_id)
        if (contribution?.hasData) {
          try {
            protectLocal = (await contribution.hasData()) === true
          } catch (err) {
            logger.warn(
              `[Lattice] ${item.plugin_id}: hasData() failed, treating local as empty:`,
              err
            )
          }
        }
      }
      /**
       * Base drift check: some writes (e.g. an assistant tool modifying the database directly) do
       * not necessarily go through `requestSync()`, so `dirty` may be empty. Compare against the
       * merge base once more before overwriting — better to turn it into a conflict for the user to
       * decide than to silently overwrite local deletions/edits (user, 2026-11-25: "I deleted/
       * edited it and it still got pushed back to me").
       */
      if (!protectLocal) {
        const base = readMergeBase(item.plugin_id)
        const contribution = pluginSyncSnapshot(item.plugin_id)
        if (base && contribution) {
          try {
            const local = await contribution.export()
            if (!snapshotsEqual(local, base.data)) {
              protectLocal = true
              logger.warn(
                `[Lattice] ${item.plugin_id}: local snapshot differs from the merge base but is not marked dirty; ` +
                  'not importing the cloud snapshot (would drop local edits/deletions)'
              )
            }
          } catch (err) {
            protectLocal = true
            logger.warn(
              `[Lattice] ${item.plugin_id}: failed to export local snapshot for the drift check; not importing:`,
              err
            )
          }
        }
      }
      if (protectLocal) {
        // A silent import would drop unsynced local edits / a dataset never uploaded → hand it to "resolve conflict" for an explicit choice (including merge)
        recordPullConflict(item.plugin_id, localRev, serverRev)
        conflicts += 1
      } else if (item.data !== undefined && item.data !== null) {
        const cloudRows = await countSnapshotRows(item.plugin_id, item.data)
        if (await applyRemoteData(item.plugin_id, item.data, serverRev)) {
          store.revs[item.plugin_id] = serverRev
          clearPluginDirty(item.plugin_id)
          pulled += 1
          rows += cloudRows
        }
      } else {
        store.revs[item.plugin_id] = serverRev
      }
    }
  }

  // Install records deleted on the platform (user deleted them elsewhere / platform cleanup) → clear the matching orphaned flags so nothing lingers in the local cache
  const remoteIds = new Set(items.map((item) => item.plugin_id))
  const orphanedBefore = store.orphaned ?? []
  const orphanedNow = orphanedBefore.filter((entry) => remoteIds.has(entry.plugin_id))
  if (orphanedNow.length !== orphanedBefore.length) {
    if (orphanedNow.length > 0) store.orphaned = orphanedNow
    else delete store.orphaned
    logger.info(
      `[Lattice] Cleared orphaned flags for install records that no longer exist: ${orphanedBefore.length - orphanedNow.length} record(s)`
    )
  }

  if (appliedEnabled.length > 0) {
    suppressPush = true
    try {
      broadcastPluginStateChanged()
    } finally {
      suppressPush = false
    }
  }
  saveSyncCache()
  return { pulled, rows, pending, autoInstall, orphaned: listLatticeSyncOrphaned(), conflicts }
}

function finishSync(result: LatticeSyncResult): LatticeSyncResult {
  lastResult = result
  const store = loadSyncCache()
  store.last = result
  saveSyncCache()
  try {
    hooks.onSyncState?.(result)
  } catch (err) {
    logger.warn('[Lattice] Error in sync state callback:', err)
  }
  try {
    hooks.onStateChanged?.()
  } catch (err) {
    logger.warn('[Lattice] Error in state callback after sync:', err)
  }
  return result
}

async function runSync(
  direction: LatticeSyncDirection,
  options: LatticeSyncOptions = {}
): Promise<LatticeSyncResult> {
  const result: LatticeSyncResult = {
    at: Date.now(),
    pushed: 0,
    pulled: 0,
    pushedRows: 0,
    pulledRows: 0,
    conflicts: 0,
    ...(options.silent ? { silent: true } : {})
  }
  if (!isLatticeLoggedIn()) {
    result.error = '未登录插件中心，请先登录'
    // Not logged in is not a "sync result": do not write the cache or broadcast, so a background
    // pull after logout does not write a "not logged in" error into the new account space's
    // lattice-sync.json
    return result
  }
  // The account data space and the signed-in identity disagree (just logged in/out, no restart yet) → pause sync to avoid cross-account mixing
  const profileGuard = profileSyncGuard()
  if (profileGuard) {
    result.error = profileGuard
    return result
  }
  // Switching the account data space in place: the directories are being swapped, so no sync may write to disk
  if (paused) {
    result.error = '账号数据空间正在切换，已暂停同步'
    return result
  }
  // Without an explicit installMissing, follow the setting (enabled by default), so the background pull after startup/login also auto-restores on a new machine
  const installMissing = options.installMissing ?? getLatticeAutoInstallMissing()
  try {
    // Pull first, then push: pull cloud updates down (align rev), then push the latest local
    // install state/data; this way a multi-device setup never treats freshly pulled cloud data as
    // "local dirty data" and pushes it back.
    if (direction === 'pull' || direction === 'both') {
      const pulled = await pullInstallRecords(installMissing)
      result.pulled = pulled.pulled
      result.pulledRows = pulled.rows
      // Conflicts found during pull (local dirty + cloud updated) also count toward the conflict total (otherwise the sync bar would not show them)
      result.conflicts += pulled.conflicts
      if (pulled.pending.length > 0) result.pending = pulled.pending
      if (pulled.autoInstall.attempted > 0) result.autoInstall = pulled.autoInstall
      if (pulled.orphaned.length > 0) result.orphaned = pulled.orphaned
    }
    if (direction === 'push' || direction === 'both') {
      const pushed = await pushInstallRecords()
      result.pushed = pushed.pushed
      result.pushedRows = pushed.rows
      result.conflicts += pushed.conflicts
      if (pushed.orphaned.length > 0) result.orphaned = pushed.orphaned
    }
  } catch (err) {
    result.error = latticeErrorMessage(err)
    logger.warn(`[Lattice] Sync failed (direction=${direction}): ${result.error}`)
  }
  result.at = Date.now()
  return finishSync(result)
}

/**
 * Runs one sync (push / pull / both, optionally with the auto-restore option).
 *
 * Accepts two argument forms (the `{direction}` object and a bare string):
 * - `syncLattice('pull')`;
 * - `syncLattice({ direction: 'pull', installMissing: true })` — explicitly request that this pull
 *   auto-restore missing plugins (otherwise the setting is followed, enabled by default).
 *
 * Concurrent calls share the same running Promise (only one run at a time, avoiding request storms
 * and rev races). Errors are not thrown: failures go into the result's `error` field (shown by the
 * renderer in the status bar).
 */
export async function syncLattice(
  directionOrOptions: LatticeSyncDirection | LatticeSyncOptions = 'both'
): Promise<LatticeSyncResult> {
  const options: LatticeSyncOptions =
    typeof directionOrOptions === 'string'
      ? { direction: directionOrOptions }
      : (directionOrOptions ?? {})
  const direction = options.direction ?? 'both'
  if (running) return await running
  const task = runSync(direction, options)
  running = task
  try {
    return await task
  } finally {
    running = null
  }
}

/** 5s debounced push (triggered after plugin enabled/install state changes; callers trigger it again on login state changes) */
export function scheduleLatticePush(delayMs = PUSH_DEBOUNCE_MS): void {
  if (suppressPush) return
  if (paused) return
  if (!isLatticeLoggedIn()) return
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    void syncLattice('push')
  }, delayMs)
}

/**
 * Cancels a not-yet-fired debounced push (used on logout / base URL switch).
 *
 * Does not clear the rev cache: local plugin-state data is still there, and a push after the next
 * login still needs the "last seen rev" for conflict detection — clearing it would degrade to a
 * rev=0 overwrite and could lose unsynced local changes.
 */
export function cancelPendingLatticePush(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
}

/**
 * Call before switching the account data space: suspend sync and wait for the running sync to
 * finish.
 *
 * It does not abort the network request (aborting would leave a half-written state); it just
 * **waits for the write to finish** so the caller can swap directories. The timeout keeps a stuck
 * network from hanging the account switch forever (after the timeout the switch still proceeds; the
 * worst case is that sync reports an error).
 */
/**
 * Call before switching the account data space: suspend sync and wait for the running sync to
 * finish.
 *
 * It does not abort the network request (aborting would leave a half-written state); it just
 * **waits for the write to finish** so the caller can swap directories. The timeout keeps a stuck
 * network from hanging the account switch forever.
 *
 * @returns true = no sync is running (directories can be swapped safely); false = still running
 * after the timeout. On false the caller **must not** swap directories: the running sync holds the
 * old account's in-memory cache while paths already point to the new space, so further writes would
 * put A's data into B (cross-account mixing). Better to fail the switch / restart this time.
 */
export async function pauseLatticeSync(timeoutMs = 5000): Promise<boolean> {
  paused = true
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  if (!running) return true
  return await Promise.race([
    running.then(
      () => true,
      () => true
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs))
  ])
}

/** Resumes sync after the switch completes (or rolls back on failure) */
export function resumeLatticeSync(): void {
  paused = false
}

/**
 * Re-reads `lattice-sync.json` after the account data space has switched.
 *
 * Unlike `resetLatticeSyncCache()`, it **neither clears nor writes the file** — the cache in the new
 * space (revs / conflicts / last sync result) belongs to the current account; losing it would
 * degrade to a rev=0 overwrite of cloud data.
 */
export function reloadLatticeSyncCache(): void {
  cache = null
  lastResult = null
  pendingSnapshots.clear()
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  logger.info('[Lattice] Sync cache reloaded for the switched account data space')
}

/**
 * Drops a plugin's `data_rev` cache after its local data was purged (uninstall with "delete all
 * data" checked).
 *
 * The cloud install record and data snapshot are **kept**; if the local rev stays at the old value,
 * a pull after reinstalling compares that old rev with the server, wrongly decides "already up to
 * date" and does not write the data back. Once cleared, a server rev > 0 restores the cloud
 * snapshot into `plugin-state/<id>.json`, and data syncs normally after the user reinstalls.
 * Historical conflicts for the plugin are also discarded: the local data no longer exists, so
 * keeping conflicts would only mislead the user.
 */
function forgetLocalPluginDataRev(pluginId: string): void {
  const id = String(pluginId ?? '').trim()
  if (!id) return
  pendingSnapshots.delete(id)
  // Local data was purged: clear the base too, so a new base is established before merging after reinstall
  clearMergeBase(id)
  const store = loadSyncCache()
  const hadRev = id in store.revs
  if (hadRev) delete store.revs[id]
  if (store.dirty?.[id]) clearPluginDirty(id)
  // After local data is purged, the next time there is data it must still be uploaded in full once
  if (store.snapshotPushed?.[id]) {
    const next = { ...store.snapshotPushed }
    delete next[id]
    if (Object.keys(next).length > 0) store.snapshotPushed = next
    else delete store.snapshotPushed
    saveSyncCache()
  }
  const hadConflict = (store.conflicts ?? []).some((c) => c.plugin_id === id)
  if (hadConflict) store.conflicts = (store.conflicts ?? []).filter((c) => c.plugin_id !== id)
  if (!hadRev && !hadConflict) return
  saveSyncCache()
  logger.info(
    `[Lattice] Local data purged for ${id}: cleared local data_rev cache ` +
      '(cloud install record and data snapshot are kept)'
  )
}

/**
 * Applies "cloud snapshots received while disabled" once a plugin is loaded.
 *
 * While disabled the snapshot cannot be written to `plugin-state/<id>.json` (that is settings and
 * would be pushed back to the cloud as a snapshot on the next push), so pull keeps it in memory;
 * after the plugin is enabled (`plugin-state-changed`) it is applied here and the rev aligned on
 * success.
 */
async function flushPendingSnapshots(): Promise<void> {
  if (pendingSnapshots.size === 0) return
  const store = loadSyncCache()
  let applied = 0
  for (const [pluginId, pending] of [...pendingSnapshots]) {
    if (!pluginSyncSnapshot(pluginId)?.import) continue
    if (await applyRemoteData(pluginId, pending.data, pending.rev)) {
      store.revs[pluginId] = pending.rev
      applied += 1
    }
  }
  if (applied > 0) {
    saveSyncCache()
    logger.info(`[Lattice] Applied ${applied} pending cloud snapshot(s) after plugin load`)
    scheduleLatticePush()
  }
}

/** Startup wiring: listen to `plugin-state-changed` (install/uninstall/enable/disable all go through this broadcast) */
export function initLatticeSync(): void {
  onPluginStateChanged(() => {
    void flushPendingSnapshots()
    scheduleLatticePush()
  })
  onAppEvent(APP_EVENT_PLUGIN_DATA_PURGED, (payload) => {
    const record = payload as Partial<AppPluginDataPurgedPayload> | null
    if (record && typeof record.pluginId === 'string') {
      forgetLocalPluginDataRev(record.pluginId)
    }
  })
}

/** Clears the rev cache after a base URL switch (data_rev is not comparable across nodes) */
export function resetLatticeSyncCache(): void {
  cache = { revs: {} }
  lastResult = null
  pendingSnapshots.clear()
  clearAllMergeBases()
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  saveSyncCache()
  logger.info('[Lattice] Sync revision cache cleared (plugin hub base URL changed)')
}
