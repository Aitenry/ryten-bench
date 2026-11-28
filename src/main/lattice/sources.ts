import { app } from 'electron'
import { createHash } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import logger from 'electron-log'
import { releaseWorkspaceWatcherFor, withWorkspaceWatcherReleased } from '../workspace'
import { extractZipToTemp } from '../plugins/package-install'
import { assertDraftId, draftDir, hasPluginsRoot } from '../workshop/paths'
import type { LatticeSourceManaged } from './types'

/**
 * Plugin **source** lifecycle on this machine (contract v2 §2):
 *
 * - Priority order for downloaded source directories (rule added 2026-11-21):
 *   1. The user-configured "plugin storage path" `<pluginsPath>/<plugin id>/` (= the workshop draft directory) —
 *      it is visible in the plugin-mode sidebar and can open a "plugin" session so the model can edit the code;
 *   2. When pluginsPath is not configured (or the directory is already occupied by the user's own source of the same name), fall back to
 *      `userData/plugin-sources/<plugin id>/<version>/`.
 * - Each source directory root gets a `source.json` (plugin_id/version/sha256/downloaded_at/layout/dir_sha256);
 *   it marks "this source was downloaded and is managed by the app" and is also used to tell whether it was modified later by the user;
 * - `userData/lattice-sources.json` is a **fast index** (plugin id → current source directory/version/sha);
 *   when the index is lost/corrupted, it is rebuilt by scanning the source.json files in the directories;
 * - Before swapping in new source: clear the same plugin's old version directories (keep only the current one); when the target
 *   directory already contains user-modified content, back it up wholesale to `userData/plugin-source-backups/<id>/<timestamp>/`
 *   first and then replace it (recoverable, no silent loss of changes).
 *
 * Security boundaries:
 * - Extraction reuses `extractZipToTemp()` (rejects absolute paths / `..` traversal / empty archives, and strips the top-level directory of a "zip the whole folder" archive);
 * - Plugin ids / version numbers only allow safe characters, so `../` cannot be assembled;
 * - All deletions target only absolute paths computed by this module (the source root under userData / a single plugin directory under the plugin storage path).
 */

/** Source root under the app data directory (fallback location when pluginsPath is not configured) */
const SOURCE_ROOT_DIR = 'plugin-sources'
/** Backup root used before replacement (kept outside the source root so it is not cleaned up as an "old version directory") */
const BACKUP_ROOT_DIR = 'plugin-source-backups'
/** Index file mapping plugin id → current source directory */
const REGISTRY_FILE = 'lattice-sources.json'
/** Metadata file name at the root of each source directory */
const SOURCE_META_FILE = 'source.json'
/** Ownership marker in source.json (directories without it are not considered app-managed) */
const SOURCE_META_MARKER = 'ryten-bench-lattice'
/** source.json schema version (currently recorded as-is, no migration is performed) */
const SOURCE_META_VERSION = 1

/** Noise entries produced by archivers/VCS (same policy as package-install.ts; .git is not source content) */
const NOISE_NAMES: ReadonlySet<string> = new Set([
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  '__MACOSX',
  '.git'
])

/** Plugin id safety rule (consistent with the platform; also guarantees it can be used as a directory name) */
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/
/** Safety rule for version numbers used as directory names (semver plus prerelease/build tags, no path separators) */
const VERSION_SAFE_RE = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/

/** Metadata stored inside a source directory (contract §2 requires plugin_id/version/sha256/downloaded_at) */
export interface PluginSourceMeta {
  plugin_id: string
  version: string
  /** sha256 of the platform source zip (lowercase hex) */
  sha256: string
  /** Download time (ISO string) */
  downloaded_at: string
  /** Ownership marker; a source.json with any other value is treated as the user's own file */
  managed_by: string
  /** On-disk location (pluginsPath / userData) */
  layout: LatticeSourceManaged
  /** asset_name of the platform source package (recorded when available, for downloads/troubleshooting) */
  source_asset_name?: string
  /**
   * Fingerprint of the directory contents at the moment extraction finished.
   * Later downloads/updates compare against it to tell whether "the user has modified it": if so, back up before replacing.
   */
  dir_sha256?: string
  meta_version?: number
}

/** A resolved "current source for a plugin" */
export interface ResolvedPluginSource {
  path: string
  version?: string
  managed: LatticeSourceManaged
  /** true = the directory is the workshop draft directory (visible in the plugin-mode sidebar, a plugin session can be opened) */
  inWorkshop: boolean
  /** sha256 of the platform source zip (when metadata is available) */
  sha256?: string
}

/** `installSourceBytes` parameters */
export interface InstallSourceOptions {
  pluginId: string
  version: string
  /** Raw bytes of the platform source zip */
  bytes: Buffer
  /** sha256 of the actually downloaded bytes (lowercase hex; already verified by the caller) */
  sha256: string
  /** asset_name of the platform source package (optional) */
  assetName?: string
}

/** `installSourceBytes` return value */
export interface InstalledPluginSource {
  path: string
  version: string
  managed: LatticeSourceManaged
  sha256: string
  /** Directory the previous source was backed up to before overwriting (absent when no backup was triggered) */
  backupPath?: string
}

interface SourceRegistryEntry {
  plugin_id: string
  version: string
  sha256: string
  path: string
  managed: LatticeSourceManaged
  downloaded_at: string
}

interface SourceRegistryFile {
  version: number
  plugins: Record<string, SourceRegistryEntry>
}

let registryCache: SourceRegistryFile | null = null

// ---------- Basic utilities ----------

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

/** Validate a plugin id (throws a readable error when invalid) */
export function assertSourcePluginId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!id) throw new Error('缺少插件 id')
  if (!PLUGIN_ID_RE.test(id))
    throw new Error(`插件 id 不合法（平台要求小写字母/数字/./_/-）：${id}`)
  return id
}

/** Validate a version number (used as a directory name; legally formatted but non-semver versions are re-validated by the platform at publish time) */
function assertSafeVersion(value: unknown): string {
  const version = typeof value === 'string' ? value.trim() : ''
  if (!version) throw new Error('缺少版本号')
  if (!VERSION_SAFE_RE.test(version)) throw new Error(`版本号不合法（不能作为目录名）：${version}`)
  return version
}

function isPathInside(parent: string, child: string): boolean {
  const p = path.resolve(parent)
  const c = path.resolve(child)
  return c === p || c.startsWith(p + path.sep)
}

function dirExists(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

function isDirEmpty(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length === 0
  } catch {
    return false
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
  fs.renameSync(tmp, file)
}

/** Move a directory (rename yields EXDEV across drives, fall back to copy + delete) */
function moveDir(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  try {
    fs.renameSync(from, to)
    return
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
  }
  fs.cpSync(from, to, { recursive: true })
  fs.rmSync(from, { recursive: true, force: true })
}

/** Retry schedule for failed directory replacement (Windows antivirus/indexer/Explorer hold a directory briefly, usually releasing it after tens to hundreds of milliseconds) */
const FS_RETRY_DELAYS_MS = [0, 60, 180, 400, 800]

/** These error codes usually mean "directory/file is in use" on Windows and are worth retrying after a short wait */
function isRetryableFsError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return (
    code === 'EPERM' ||
    code === 'EACCES' ||
    code === 'EBUSY' ||
    code === 'EEXIST' ||
    code === 'ENOTEMPTY'
  )
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Run one file operation step with retries; the last failure is rethrown as-is (with a readable step name in the message) */
async function withFsRetry<T>(step: string, action: () => T): Promise<T> {
  let lastError: unknown = null
  for (const delay of FS_RETRY_DELAYS_MS) {
    if (delay > 0) await sleepMs(delay)
    try {
      return action()
    } catch (err) {
      lastError = err
      if (!isRetryableFsError(err)) break
      logger.warn(`[Lattice] ${step} is temporarily unavailable (retrying): ${String(err)}`)
    }
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(`${step}失败：${reason}`)
}

/**
 * Merge the contents of the new source directory **in place** into the old directory and remove files only the old version had.
 *
 * Only used as a last resort when "the old directory cannot even be renamed" (Explorer/editor/indexer has it open):
 * overwriting the contents in place does not require deleting/renaming the busy root directory, so Windows does not hit EPERM.
 */
function mergeDirContents(staging: string, target: string): void {
  fs.mkdirSync(target, { recursive: true })
  fs.cpSync(staging, target, { recursive: true, force: true })
  pruneMissingEntries(target, staging)
}

/** Delete entries in target that staging does not have (leftovers from the old version; recursive) */
function pruneMissingEntries(target: string, staging: string, prefix = ''): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(target, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    const counterpart = path.join(staging, entry.name)
    if (!fs.existsSync(counterpart)) {
      try {
        fs.rmSync(path.join(target, entry.name), { recursive: true, force: true })
      } catch (err) {
        logger.warn(`[Lattice] Failed to remove stale source entry (ignored): ${rel}`, err)
      }
      continue
    }
    if (entry.isDirectory()) pruneMissingEntries(path.join(target, entry.name), counterpart, rel)
  }
}

/**
 * Replace target with the staging directory (the last step of installing new source).
 *
 * Atomic rename is preferred: rename the old directory to a hidden `.lattice-source-old-*`, then rename staging into place,
 * and finally delete the old directory on a best-effort basis. This avoids the window where "the old directory is already
 * deleted but the new one is not yet in place", and avoids EPERM when the target name is briefly retained by the system.
 *
 * Fallback: the old directory cannot be renamed at all (opened by another process) → overwrite in place + prune extra files;
 * the next install removes leftover `.lattice-source-old-*` directories via `cleanupStaleArtifacts`.
 */
async function replaceSourceDirectory(
  staging: string,
  target: string,
  pluginId: string
): Promise<'renamed' | 'merged'> {
  const parent = path.dirname(target)
  if (!fs.existsSync(target)) {
    try {
      await withFsRetry(`把解压好的源码移动到 ${target}`, () => fs.renameSync(staging, target))
      return 'renamed'
    } catch (err) {
      // The target did not exist yet still could not be moved (parent directory/antivirus holding it, or another process
      // created it first after the check): fall back to creating it in place + copying, so the source at least lands on disk
      // and the user is not stuck with "install succeeded but no source".
      logger.warn(
        `[Lattice] Could not move the staged source into place, copying its contents instead: ${target}`,
        err
      )
      await withFsRetry(`写入源码目录 ${target}`, () => mergeDirContents(staging, target))
      return 'merged'
    }
  }

  const trash = path.join(parent, `.lattice-source-old-${pluginId}-${process.pid}-${Date.now()}`)
  try {
    await withFsRetry(`把旧源码目录移开 ${target}`, () => fs.renameSync(target, trash))
  } catch (err) {
    logger.warn(
      `[Lattice] Existing source directory cannot be moved aside (in use by another process), replacing its contents in place: ${target}`,
      err
    )
    await withFsRetry(`原地覆盖源码目录 ${target}`, () => mergeDirContents(staging, target))
    return 'merged'
  }

  try {
    await withFsRetry(`把新源码目录移动到 ${target}`, () => fs.renameSync(staging, target))
  } catch (err) {
    // The new directory could not be placed: move the old directory back, then try an in-place overwrite
    // (some locks only cover the final name, not the old directory)
    try {
      await withFsRetry(`恢复旧源码目录 ${target}`, () => fs.renameSync(trash, target))
    } catch (restoreErr) {
      logger.error(
        `[Lattice] Failed to place the new source at ${target} and failed to restore the old directory; it stays at ${trash}:`,
        restoreErr
      )
    }
    try {
      await withFsRetry(`原地覆盖源码目录 ${target}`, () => mergeDirContents(staging, target))
      return 'merged'
    } catch (mergeErr) {
      logger.error(
        `[Lattice] Failed to place the new source at ${target} (move and in-place copy both failed):`,
        mergeErr
      )
      throw err
    }
  }

  try {
    fs.rmSync(trash, { recursive: true, force: true })
  } catch (err) {
    logger.warn(
      `[Lattice] Old source directory could not be removed now (will be cleaned on the next install): ${trash}`,
      err
    )
  }
  return 'renamed'
}

/**
 * Directory content fingerprint: sha256 over the sorted concatenation of (relative path + contents) (read file by file, a 50MiB cap is acceptable).
 *
 * `source.json` is skipped: it records the fingerprint "at the moment of extraction" and is rewritten later (new download/publish success),
 * so including it would make the fingerprint never match and every update would be misjudged as "modified by the user", causing an extra backup.
 */
function computeDirHash(dir: string): string {
  const files: string[] = []
  const walk = (current: string, prefix: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (NOISE_NAMES.has(entry.name) || entry.name === SOURCE_META_FILE) continue
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      const abs = path.join(current, entry.name)
      if (entry.isDirectory()) walk(abs, rel)
      else if (entry.isFile()) files.push(rel)
    }
  }
  walk(dir, '')
  files.sort()
  const hash = createHash('sha256')
  for (const rel of files) {
    hash.update(rel)
    hash.update('\0')
    hash.update(fs.readFileSync(path.join(dir, rel)))
    hash.update('\0')
  }
  return hash.digest('hex')
}

/** Read plugin.json from the directory (for version/name; returns null when missing or when the JSON is invalid) */
function readManifestInfo(dir: string): { version?: string; name?: string } | null {
  const file = path.join(dir, 'plugin.json')
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8').replace(/^\uFEFF/u, '')) as unknown
    const record = asRecord(parsed)
    if (!record) return null
    const version = readString(record.version)
    const name = readString(record.name)
    return {
      ...(version ? { version } : {}),
      ...(name ? { name } : {})
    }
  } catch {
    return null
  }
}

/** Whether the directory has source content (any of source.json / plugin.json / workshop.json counts) */
function dirHasSourceContent(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, SOURCE_META_FILE)) ||
    fs.existsSync(path.join(dir, 'plugin.json')) ||
    fs.existsSync(path.join(dir, 'workshop.json'))
  )
}

// ---------- Location conventions ----------

/** Source root under the app data directory (`userData/plugin-sources`) */
export function pluginSourcesRoot(): string {
  const root = path.join(app.getPath('userData'), SOURCE_ROOT_DIR)
  fs.mkdirSync(root, { recursive: true })
  return root
}

/**
 * The plugin's directory under the "plugin storage path" (`<pluginsPath>/<id>`); returns null when unavailable.
 *
 * Two unusable cases: the user has not configured pluginsPath yet; the plugin id does not satisfy the workshop
 * directory-name rule (the platform allows dots/underscores, workshop allows only lowercase kebab — such plugins can only land in userData).
 */
export function workshopDraftDirFor(pluginId: string): string | null {
  if (!hasPluginsRoot()) return null
  try {
    assertDraftId(pluginId)
    return draftDir(pluginId)
  } catch {
    return null
  }
}

// ---------- source.json ----------

/** Read source.json from the directory (returns null when missing/corrupt/with missing fields) */
export function readSourceMeta(dir: string): PluginSourceMeta | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, SOURCE_META_FILE), 'utf-8')) as unknown
    const record = asRecord(parsed)
    if (!record) return null
    const pluginId = readString(record.plugin_id)
    const version = readString(record.version)
    if (!pluginId || !version) return null
    return {
      plugin_id: pluginId,
      version,
      sha256: readString(record.sha256),
      downloaded_at: readString(record.downloaded_at),
      managed_by: readString(record.managed_by),
      layout: record.layout === 'userData' ? 'userData' : 'pluginsPath',
      ...(readString(record.source_asset_name)
        ? { source_asset_name: readString(record.source_asset_name) }
        : {}),
      ...(readString(record.dir_sha256) ? { dir_sha256: readString(record.dir_sha256) } : {}),
      ...(typeof record.meta_version === 'number' ? { meta_version: record.meta_version } : {})
    }
  } catch {
    return null
  }
}

function writeSourceMeta(dir: string, meta: PluginSourceMeta): void {
  writeJsonAtomic(path.join(dir, SOURCE_META_FILE), {
    ...meta,
    meta_version: SOURCE_META_VERSION
  })
}

/** Whether this source directory was downloaded and is managed by this app (ownership marker present and plugin_id matches) */
function isManagedSourceDir(dir: string, pluginId: string): boolean {
  const meta = readSourceMeta(dir)
  return meta !== null && meta.managed_by === SOURCE_META_MARKER && meta.plugin_id === pluginId
}

/**
 * Whether this directory can be used by the app as "plugin source/draft".
 *
 * Criteria match the draft branch of `resolvePluginSource`: it has `source.json` (app-managed),
 * `plugin.json` (plugin package/draft), or `workshop.json` (workshop draft).
 *
 * Why this is needed: when deleting source, users often delete only the files (or even half of them), leaving
 * only empty folders or scattered files — such a directory is neither a usable draft nor overwritable, and it is blocked
 * by the "not managed by this app, do not overwrite" protection, so the source after reinstalling is placed in userData and
 * "edit in conversation" always falls back to "open folder" (user, 2026-11-23: "after uninstalling and deleting the source,
 * reinstalling makes edit-in-conversation fail; only a restart fixes it").
 */
function isUsableDraftDir(dir: string): boolean {
  return (
    readSourceMeta(dir) !== null ||
    readManifestInfo(dir) !== null ||
    fs.existsSync(path.join(dir, 'workshop.json'))
  )
}

// ---------- Index file (userData/lattice-sources.json) ----------

function registryPath(): string {
  return path.join(app.getPath('userData'), REGISTRY_FILE)
}

function loadRegistry(): SourceRegistryFile {
  if (registryCache) return registryCache
  const empty: SourceRegistryFile = { version: 1, plugins: {} }
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath(), 'utf-8')) as unknown
    const record = asRecord(parsed)
    const rawPlugins = asRecord(record?.plugins)
    if (rawPlugins) {
      for (const [pluginId, rawEntry] of Object.entries(rawPlugins)) {
        const entry = asRecord(rawEntry)
        if (!entry) continue
        const dir = readString(entry.path)
        if (!dir || !path.isAbsolute(dir)) continue
        empty.plugins[pluginId] = {
          plugin_id: pluginId,
          version: readString(entry.version),
          sha256: readString(entry.sha256),
          path: dir,
          managed: entry.managed === 'pluginsPath' ? 'pluginsPath' : 'userData',
          downloaded_at: readString(entry.downloaded_at)
        }
      }
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code
    if (code !== 'ENOENT')
      logger.warn('[Lattice] Failed to read lattice-sources.json, treating as an empty index:', err)
  }
  registryCache = empty
  return registryCache
}

function saveRegistry(next: SourceRegistryFile): void {
  registryCache = next
  try {
    writeJsonAtomic(registryPath(), next)
  } catch (err) {
    logger.warn(
      '[Lattice] Failed to write lattice-sources.json (does not affect the sources themselves):',
      err
    )
  }
}

function updateRegistryEntry(entry: SourceRegistryEntry): void {
  const registry = loadRegistry()
  saveRegistry({
    version: 1,
    plugins: { ...registry.plugins, [entry.plugin_id]: entry }
  })
}

// ---------- Target location / backup / cleanup ----------

interface SourceTargetPlan {
  target: string
  managed: LatticeSourceManaged
  existing: boolean
  existingMeta: PluginSourceMeta | null
}

/**
 * Decide where this source lands: prefer `<pluginsPath>/<id>/`, otherwise `<userData>/plugin-sources/<id>/<version>/`.
 *
 * If `<pluginsPath>/<id>/` already exists and is **not** an app-managed source directory (the user's own draft or one
 * created by another tool), do not overwrite it (that is the user's work and may be uncommitted) — this source is stored
 * under userData instead, with a warning.
 */
function planSourceTarget(pluginId: string, version: string): SourceTargetPlan {
  const draft = workshopDraftDirFor(pluginId)
  if (draft) {
    if (!dirExists(draft)) {
      return { target: draft, managed: 'pluginsPath', existing: false, existingMeta: null }
    }
    /**
     * Only protect "drafts the app can recognize" (plugin.json / workshop.json / source.json).
     * A leftover directory with only empty folders/half-deleted files is not a usable draft, so it becomes the landing
     * spot for this install: `installSourceBytes` backs up before replacing, so no user data is lost and the source is not
     * pushed to userData, which would make the subsequent "edit in conversation" fail.
     */
    if (isManagedSourceDir(draft, pluginId) || !isUsableDraftDir(draft)) {
      return {
        target: draft,
        managed: 'pluginsPath',
        existing: true,
        existingMeta: readSourceMeta(draft)
      }
    }
    logger.warn(
      `[Lattice] Plugin storage path already contains a source directory not managed by this app, not overwriting: ${draft}` +
        ' (this install stores its source under userData/plugin-sources; your own source stays as is)'
    )
  }
  const target = path.join(pluginSourcesRoot(), pluginId, assertSafeVersion(version))
  return {
    target,
    managed: 'userData',
    existing: dirExists(target),
    existingMeta: readSourceMeta(target)
  }
}

/** Back up the whole old source directory to `userData/plugin-source-backups/<id>/<timestamp>/` (returns the backup path) */
function backupExistingSource(pluginId: string, dir: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const base = path.join(app.getPath('userData'), BACKUP_ROOT_DIR, pluginId, stamp)
  let target = base
  let index = 1
  while (fs.existsSync(target)) {
    target = `${base}-${index}`
    index += 1
  }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.cpSync(dir, target, { recursive: true })
  return target
}

/**
 * Remove old version directories under the same plugin's userData source root.
 *
 * @param keepDirName version directory name to keep; null = remove all (used when the source has already been migrated to pluginsPath)
 */
function cleanupUserDataVersions(pluginId: string, keepDirName: string | null): void {
  const root = path.join(app.getPath('userData'), SOURCE_ROOT_DIR, pluginId)
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (keepDirName !== null && entry.name === keepDirName) continue
    const dir = path.join(root, entry.name)
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      logger.info(`[Lattice] Cleaned up old source directory: ${dir}`)
    } catch (err) {
      logger.warn(
        `[Lattice] Failed to clean up old source directory (can be deleted manually): ${dir}`,
        err
      )
    }
  }
  if (keepDirName === null) {
    try {
      fs.rmdirSync(root)
    } catch {
      // Empty/non-existent makes no difference
    }
  }
}

/** Remove staging / old directories left behind by an interrupted install (only hidden directories with this plugin's prefix) */
function cleanupStaleArtifacts(parent: string, pluginId: string): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true })
  } catch {
    return
  }
  const prefixes = [`.lattice-source-stage-${pluginId}-`, `.lattice-source-old-${pluginId}-`]
  for (const entry of entries) {
    if (!entry.isDirectory() || !prefixes.some((prefix) => entry.name.startsWith(prefix))) continue
    try {
      fs.rmSync(path.join(parent, entry.name), { recursive: true, force: true })
    } catch {
      // If it cannot be removed, leave it; it does not affect this install
    }
  }
}

/**
 * When the source package root has no plugin.json, add one from the **installed package** manifest.
 *
 * Why: the plugin-mode sidebar only lists directories under `<pluginsPath>` that "have plugin.json or workshop.json"
 * (see workshop/store.listDraftIds). The contract allows the source package to be a project directory (plugin.json is
 * not mandatory), so without this the source would not be visible in plugin mode at all and the user could not "edit in conversation".
 */
function ensureRootManifest(dir: string, pluginId: string): void {
  if (fs.existsSync(path.join(dir, 'plugin.json'))) return
  const installed = path.join(app.getPath('userData'), 'plugins', pluginId, 'plugin.json')
  try {
    const parsed = JSON.parse(
      fs.readFileSync(installed, 'utf-8').replace(/^\uFEFF/u, '')
    ) as unknown
    if (asRecord(parsed) === null) return
    fs.writeFileSync(path.join(dir, 'plugin.json'), `${JSON.stringify(parsed, null, 2)}\n`, 'utf-8')
    logger.info(
      `[Lattice] No plugin.json in the source package root, added one from the installed package: ${dir}`
    )
  } catch (err) {
    logger.warn(
      '[Lattice] Source package is missing plugin.json and the write-back failed (source is still saved, but may not appear in the plugin mode sidebar):',
      err
    )
  }
}

// ---------- Install (downloaded bytes → local source directory) ----------

/**
 * Extract the platform source zip into the local source directory (contract §2).
 *
 * Flow: extract (reject path traversal/strip the top-level directory) → copy to staging on the same drive as the target →
 * add plugin.json → compute the directory fingerprint + write source.json → (back up the old directory when necessary) →
 * swap in → clean up old versions/update the index.
 *
 * Throws a readable error on failure (the caller records it as the install result's `sourceError`; the plugin installation itself is unaffected).
 */
export async function installSourceBytes(
  options: InstallSourceOptions
): Promise<InstalledPluginSource> {
  const pluginId = assertSourcePluginId(options.pluginId)
  const version = assertSafeVersion(options.version)
  const sha256 =
    readString(options.sha256) || createHash('sha256').update(options.bytes).digest('hex')
  const plan = planSourceTarget(pluginId, version)
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ryten-lattice-src-'))
  /**
   * The target directory may be the currently active "plugin workspace": on Windows the directory handle held by `fs.watch`
   * does not allow it to be deleted/renamed (manifesting as `EPERM: rename '.lattice-source-stage-…' -> '…/plugins/<id>'`,
   * field report 2026-11-25; only an app restart recovered it). Release the watcher before replacing and reattach it afterwards.
   */
  const releaseWatcher = releaseWorkspaceWatcherFor(plan.target)

  const zipPath = path.join(workDir, `${pluginId}-${version}-src.zip`)
  let extracted: string | null = null
  let staging: string | null = null
  try {
    fs.writeFileSync(zipPath, options.bytes)
    extracted = await extractZipToTemp(zipPath)

    const parent = path.dirname(plan.target)
    fs.mkdirSync(parent, { recursive: true })
    cleanupStaleArtifacts(parent, pluginId)
    staging = path.join(parent, `.lattice-source-stage-${pluginId}-${process.pid}-${Date.now()}`)
    fs.cpSync(extracted, staging, { recursive: true })
    ensureRootManifest(staging, pluginId)

    const dirSha256 = computeDirHash(staging)
    const meta: PluginSourceMeta = {
      plugin_id: pluginId,
      version,
      sha256,
      downloaded_at: new Date().toISOString(),
      managed_by: SOURCE_META_MARKER,
      layout: plan.managed,
      ...(options.assetName ? { source_asset_name: options.assetName } : {}),
      dir_sha256: dirSha256
    }
    writeSourceMeta(staging, meta)

    let backupPath: string | undefined
    if (fs.existsSync(plan.target)) {
      let modified = true
      if (plan.existingMeta?.dir_sha256) {
        try {
          modified = computeDirHash(plan.target) !== plan.existingMeta.dir_sha256
        } catch {
          modified = true
        }
      }
      if (modified) {
        backupPath = backupExistingSource(pluginId, plan.target)
        logger.info(
          `[Lattice] Backed up user changes before replacing source: ${plan.target} -> ${backupPath}`
        )
      }
    }
    /**
     * No `rmSync(target)` followed directly by rename anymore: on Windows, even after the target directory is deleted, as long
     * as another process (Explorer/editor/indexer) has it open the directory name is briefly retained and the following rename
     * hits EPERM. replaceSourceDirectory uses the atomic order "rename the old directory aside first → rename the new directory
     * into place", falling back to an in-place overwrite when it cannot be moved; neither path leaves the user stuck with
     * "must restart the app".
     */
    const replacement = await replaceSourceDirectory(staging, plan.target, pluginId)
    staging = null
    logger.info(`[Lattice] Source directory installed (${replacement}): ${plan.target}`)

    if (plan.managed === 'userData') {
      cleanupUserDataVersions(pluginId, version)
    } else {
      cleanupUserDataVersions(pluginId, null)
    }
    updateRegistryEntry({
      plugin_id: pluginId,
      version,
      sha256,
      path: plan.target,
      managed: plan.managed,
      downloaded_at: meta.downloaded_at
    })
    logger.info(
      `[Lattice] Source ready: ${pluginId}@${version} -> ${plan.target} (${plan.managed}, sha256=${sha256.slice(0, 12)}...)`
    )
    return {
      path: plan.target,
      version,
      managed: plan.managed,
      sha256,
      ...(backupPath ? { backupPath } : {})
    }
  } finally {
    releaseWatcher?.()
    if (staging) {
      try {
        fs.rmSync(staging, { recursive: true, force: true })
      } catch {
        // staging is a hidden temp directory; failing to remove it does no harm
      }
    }
    if (extracted) {
      try {
        fs.rmSync(extracted, { recursive: true, force: true })
      } catch {
        // It does not matter if the temp directory cannot be removed
      }
    }
    try {
      fs.rmSync(workDir, { recursive: true, force: true })
    } catch {
      // Same as above
    }
  }
}

// ---------- Query / migration / recording ----------

/** Scan `userData/plugin-sources/<id>/<version>/` and pick the newest one by downloaded_at */
function scanUserDataSource(pluginId: string): ResolvedPluginSource | null {
  const root = path.join(app.getPath('userData'), SOURCE_ROOT_DIR, pluginId)
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return null
  }
  let best: { dir: string; meta: PluginSourceMeta } | null = null
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = path.join(root, entry.name)
    const meta = readSourceMeta(dir)
    if (!meta) continue
    if (!best || meta.downloaded_at > best.meta.downloaded_at) best = { dir, meta }
  }
  if (!best) return null
  return {
    path: best.dir,
    version: best.meta.version,
    managed: 'userData',
    inWorkshop: false,
    ...(best.meta.sha256 ? { sha256: best.meta.sha256 } : {})
  }
}

/**
 * The plugin's currently usable source directory (returns null when none is found).
 *
 * Priority: workshop draft directory (`<pluginsPath>/<id>`, the user-editable surface) → index → scan userData version directories.
 */
export function resolvePluginSource(rawPluginId: unknown): ResolvedPluginSource | null {
  const pluginId = typeof rawPluginId === 'string' ? rawPluginId.trim() : ''
  if (!pluginId || !PLUGIN_ID_RE.test(pluginId)) return null

  const draft = workshopDraftDirFor(pluginId)
  if (draft && dirExists(draft)) {
    const meta = readSourceMeta(draft)
    const manifest = readManifestInfo(draft)
    if (meta !== null || manifest !== null || fs.existsSync(path.join(draft, 'workshop.json'))) {
      const version = meta && meta.plugin_id === pluginId ? meta.version : manifest?.version
      return {
        path: draft,
        managed: 'pluginsPath',
        inWorkshop: true,
        ...(version ? { version } : {}),
        ...(meta?.sha256 ? { sha256: meta.sha256 } : {})
      }
    }
  }

  const entry = loadRegistry().plugins[pluginId]
  if (entry && dirExists(entry.path) && dirHasSourceContent(entry.path)) {
    return {
      path: entry.path,
      managed: entry.managed,
      inWorkshop: workshopDraftDirFor(pluginId) === path.resolve(entry.path),
      ...(entry.version ? { version: entry.version } : {}),
      ...(entry.sha256 ? { sha256: entry.sha256 } : {})
    }
  }

  return scanUserDataSource(pluginId)
}

/**
 * **Migrate** the source from the userData fallback directory to the user-configured plugin storage path (`<pluginsPath>/<id>/`).
 *
 * Trigger: the user configures pluginsPath after installation and then clicks "edit in conversation". Only after migration
 * is it a workshop draft, and only then can a conversation be opened in plugin mode.
 *
 * Returns the migrated/currently usable source (returns the original directory when migration fails, without blocking the "open folder" fallback).
 */
export function promoteSourceToWorkshop(rawPluginId: unknown): ResolvedPluginSource | null {
  const pluginId = typeof rawPluginId === 'string' ? rawPluginId.trim() : ''
  if (!pluginId) return null
  const draft = workshopDraftDirFor(pluginId)
  if (!draft) return null
  if (dirExists(draft)) {
    // Usable draft (the user's own source / already-managed source): leave it alone and use the existing source
    if (isUsableDraftDir(draft)) return resolvePluginSource(pluginId)
    /**
     * Unusable leftover directory (after the user deletes the source, only empty folders/scattered files remain): it makes
     * the migration below give up immediately, so "edit in conversation" only ever opens a folder (field report 2026-11-23).
     * Back it up and remove it, then migrate the source from userData back to the plugin storage path; if removal fails, fall
     * back to the existing source.
     */
    try {
      const backup = isDirEmpty(draft) ? null : backupExistingSource(pluginId, draft)
      // This leftover directory may be watched by a workspace (plugin mode has it open): release the watcher before deleting
      withWorkspaceWatcherReleased(draft, () => fs.rmSync(draft, { recursive: true, force: true }))
      logger.warn(
        `[Lattice] Removed unusable leftover source directory before migrating: ${draft}` +
          (backup ? ` (backup: ${backup})` : ' (it was empty)')
      )
    } catch (err) {
      logger.warn(
        `[Lattice] Failed to remove unusable leftover source directory (${draft}); keeping the source where it is:`,
        err
      )
      return resolvePluginSource(pluginId)
    }
  }
  const current = resolvePluginSource(pluginId)
  if (!current || current.inWorkshop) return current
  try {
    fs.mkdirSync(path.dirname(draft), { recursive: true })
    // If the target draft directory is watched by a workspace, rename hits EPERM on Windows: release the watcher during migration
    withWorkspaceWatcherReleased(draft, () => moveDir(current.path, draft))
    const meta = readSourceMeta(draft)
    if (meta) writeSourceMeta(draft, { ...meta, layout: 'pluginsPath' })
    const version = current.version ?? meta?.version
    const sha256 = current.sha256 ?? meta?.sha256
    updateRegistryEntry({
      plugin_id: pluginId,
      version: version ?? '',
      sha256: sha256 ?? '',
      path: draft,
      managed: 'pluginsPath',
      downloaded_at: meta?.downloaded_at ?? new Date().toISOString()
    })
    cleanupUserDataVersions(pluginId, null)
    logger.info(`[Lattice] Source migrated to plugin storage path: ${current.path} -> ${draft}`)
    return {
      path: draft,
      managed: 'pluginsPath',
      inWorkshop: true,
      ...(version ? { version } : {}),
      ...(sha256 ? { sha256 } : {})
    }
  } catch (err) {
    logger.warn(
      `[Lattice] Failed to migrate source to plugin storage path (continuing to use ${current.path}):`,
      err
    )
    return current
  }
}

/**
 * Record the source's version/fingerprint after a successful publish (used by republish):
 * - The directory already has source.json (app-managed source) → update version/sha256/directory fingerprint;
 * - Write the index only for the workshop draft directory or a directory under the userData source root (**never touch the user's arbitrary project directories**).
 */
export function recordPublishedSource(
  rawPluginId: string,
  version: string,
  dir: string,
  sha256: string
): void {
  try {
    const pluginId = assertSourcePluginId(rawPluginId)
    const resolvedDir = path.resolve(dir)
    const draft = workshopDraftDirFor(pluginId)
    const inWorkshop = draft !== null && path.resolve(draft) === resolvedDir
    const inSourcesRoot = isPathInside(pluginSourcesRoot(), resolvedDir)
    const meta = readSourceMeta(resolvedDir)
    if (!inWorkshop && !inSourcesRoot) return
    if (meta) {
      writeSourceMeta(resolvedDir, {
        ...meta,
        plugin_id: pluginId,
        version,
        sha256,
        dir_sha256: computeDirHash(resolvedDir)
      })
    }
    updateRegistryEntry({
      plugin_id: pluginId,
      version,
      sha256,
      path: resolvedDir,
      managed: inWorkshop ? 'pluginsPath' : 'userData',
      downloaded_at: meta?.downloaded_at ?? new Date().toISOString()
    })
    logger.info(`[Lattice] Recorded release version: ${pluginId}@${version} (${resolvedDir})`)
  } catch (err) {
    logger.warn(
      '[Lattice] Failed to record published source info (does not affect the release itself):',
      err
    )
  }
}
