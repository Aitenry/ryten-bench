import { app, dialog } from 'electron'
import { createHash } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import logger from 'electron-log'
import JSZip from 'jszip'
import { broadcastWorkshopChanged } from '../ipc/harness/workshop'
import { broadcastPluginStateChanged } from '../ipc/plugins'
import { setEnabledOverride } from '../plugins/store'
import { reloadExternalMain } from '../plugins/host'
import {
  extractZipToTemp,
  installPackageDir,
  resolvePackageRoot,
  type InstalledPackageInfo
} from '../plugins/package-install'
import { findExternalPlugin } from '../plugins/scanner'
import { isPluginOperationRunning, withPluginOperation } from '../plugins/operation-lock'
import { isProfileSwitchInProgress, profileMatchesSession } from '../profiles/runtime'
import {
  LatticeApiError,
  downloadLatticeFile,
  latticeErrorMessage,
  latticeRequest,
  uploadLatticeBytes
} from './client'
import { getLatticeDeviceId, hasLatticeSession } from './session'
import {
  installSourceBytes,
  promoteSourceToWorkshop,
  recordPublishedSource,
  resolvePluginSource,
  type ResolvedPluginSource
} from './sources'
import { recordLatticeSourceCache, syncLattice } from './sync'
import { buildDraft } from '../workshop/build'
import { hasBuild, isBuildStale } from '../workshop/host'
import { distDir, draftDir } from '../workshop/paths'
import { isSamePath } from '../storage/migration'
import type {
  HubDetail,
  HubEntry,
  HubListResult,
  HubVersion,
  LatticeDownloadAssetKind,
  LatticeDownloadAssetResult,
  LatticeImportLocalDirResult,
  LatticeImportLocalItem,
  LatticeImportLocalSkipped,
  LatticeInstallResult,
  LatticeListQuery,
  LatticeLocalSourcePathResult,
  LatticeRepublishInput,
  LatticeRepublishResult,
  LatticeSourceManaged,
  LatticeSourcePathResult,
  LatticeUploadProgress,
  LatticeUploadResult
} from './types'

/**
 * Plugin hub (`/v1/hub`) main-process business logic: catalog / detail / publish upload / download install.
 *
 * Upload flow:
 *   pick directory → `resolvePackageRoot()` → read plugin.json + README.md → JSZip package (plugin.json at root)
 *   → sha256 → `POST /v1/hub/plugins` metadata → `PUT {upload.path}` raw bytes (`X-Content-SHA256`)
 * Each stage emits `lattice:upload-progress` to the renderer.
 *
 * Download/install flow:
 *   pick a version in the detail → `GET .../download` (302 → presigned) → sha256 check → extract to a temp dir
 *   → `installPackageDir({expectId})` → enable + load main module + broadcast → `PUT /v1/hub/installs/{id}`.
 * Failures always return `{ok:false,error}`; exceptions never reach the renderer.
 *
 * Source lifecycle (see `./sources.ts`):
 * - if the version ships source (`has_source`) → download `.../source` (302 → presigned) → extract to
 *   `<pluginsPath>/<id>/` (falls back to `userData/plugin-sources/<id>/<version>/` when unconfigured) → source.json;
 *   a source failure **does not fail the install**, it is only reported as `sourceError`;
 * - `republish`: source directory → validate plugin.json → whole-directory zip (install package) → the same bytes
 *   serve as the source package → POST (with source metadata) → PUT install package → PUT source;
 * - `downloadAsset`: install package / source package save-dialog download to this machine (sha256 checked);
 * - `importLocalPlugins`: open a directory picker and publish every plugin that has a plugin.json under the local
 *   source directory to the platform, one by one.
 */

/** Platform limits: package ≤20MiB, source package ≤50MiB, readme ≤16KiB, manifest ≤16KiB */
const PACKAGE_MAX_BYTES = 20 * 1024 * 1024
const SOURCE_MAX_BYTES = 50 * 1024 * 1024
const README_MAX_BYTES = 16 * 1024
const MANIFEST_MAX_BYTES = 16 * 1024
const NAME_MAX_CHARS = 64
const DESCRIPTION_MAX_CHARS = 500
const CHANGELOG_MAX_CHARS = 2000
const ICON_MAX_CHARS = 512
const CATEGORY_VALUES = new Set(['productivity', 'ai', 'media', 'devtools', 'data', 'other'])
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]{1,32})?$/
/** Noise entries produced by archiving tools (same policy as package-install.ts; never uploaded) */
const NOISE_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '__MACOSX'])
/**
 * Directories skipped wholesale when packaging: VCS and dependency directories are not part of the plugin
 * package and only blow the 20MiB limit (the "zip the whole source directory" flow especially tends to
 * run into the user's own project directories).
 */
const PACKAGE_EXCLUDED_DIRS = new Set(['.git', 'node_modules'])
/** Host metadata files in the package root that are not package content (workshop draft / source download marker) */
const PACKAGE_ROOT_META_FILES = new Set(['source.json', 'workshop.json'])

interface LatticeHubHooks {
  onUploadProgress?: (progress: LatticeUploadProgress) => void
  /** State change after publish/install (wired up by index.ts to the `lattice:state-changed` broadcast) */
  onStateChanged?: () => void
}

let hooks: LatticeHubHooks = {}

/** Wired up by `lattice/index.ts` at startup (avoids the hub → index circular dependency) */
export function configureLatticeHub(next: LatticeHubHooks): void {
  hooks = next
}

function emitUploadProgress(progress: LatticeUploadProgress): void {
  try {
    hooks.onUploadProgress?.(progress)
  } catch (err) {
    logger.warn('[Lattice] Error in upload progress callback:', err)
  }
}

function notifyStateChanged(): void {
  try {
    hooks.onStateChanged?.()
  } catch (err) {
    logger.warn('[Lattice] Error in state change callback:', err)
  }
}

// ---------- General helpers ----------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const num = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.min(max, Math.max(min, num))
}

/** Truncate by characters (platform limits are checked in characters; Array.from never splits surrogate pairs) */
function clampChars(value: string, maxChars: number): string {
  const chars = Array.from(value)
  return chars.length <= maxChars ? value : chars.slice(0, maxChars).join('')
}

/** Truncate by UTF-8 bytes (the readme limit is in bytes; drops a half character that may be cut at the boundary) */
function clampUtf8Bytes(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, 'utf8')
  if (buffer.length <= maxBytes) return value
  return buffer
    .subarray(0, maxBytes)
    .toString('utf8')
    .replace(/\uFFFD+$/u, '')
}

// ---------- Catalog / detail ----------

function mapOwner(raw: unknown): HubEntry['owner'] {
  const record = asRecord(raw) ?? {}
  return {
    id: readString(record.id),
    username: readString(record.username),
    display_name: readOptionalString(record.display_name) ?? null
  }
}

/** Platform catalog entry → shared HubEntry (missing fields always fall back; bad data must not crash the panel) */
function mapHubEntry(raw: unknown): HubEntry {
  const record = asRecord(raw) ?? {}
  return {
    plugin_id: readString(record.plugin_id),
    name: readString(record.name) || readString(record.plugin_id),
    description: readOptionalString(record.description),
    icon: readOptionalString(record.icon),
    category: readString(record.category) || 'other',
    tags: readStringArray(record.tags),
    owner: mapOwner(record.owner),
    latest_version: readOptionalString(record.latest_version),
    size: readOptionalNumber(record.size),
    downloads: readNumber(record.downloads, 0),
    versions_count: readNumber(record.versions_count, 0),
    updated_at: readString(record.updated_at),
    installed: record.installed === true,
    installed_version: readOptionalString(record.installed_version),
    update_available: record.update_available === true,
    install_enabled: readOptionalBoolean(record.install_enabled),
    ...(readOptionalBoolean(record.has_source) !== undefined
      ? { has_source: record.has_source === true }
      : {})
  }
}

function mapHubVersion(raw: unknown): HubVersion {
  const record = asRecord(raw) ?? {}
  return {
    version: readString(record.version),
    asset_name: readString(record.asset_name),
    size: readNumber(record.size, 0),
    sha256: readString(record.sha256).toLowerCase(),
    changelog: readString(record.changelog),
    manifest: record.manifest,
    downloads: readNumber(record.downloads, 0),
    published_at: readOptionalString(record.published_at),
    ...(readOptionalBoolean(record.has_source) !== undefined
      ? { has_source: record.has_source === true }
      : {}),
    ...(readOptionalString(record.source_asset_name)
      ? { source_asset_name: readOptionalString(record.source_asset_name) }
      : {}),
    ...(readOptionalNumber(record.source_size) !== undefined
      ? { source_size: readOptionalNumber(record.source_size) }
      : {}),
    ...(readOptionalString(record.source_sha256)
      ? { source_sha256: readOptionalString(record.source_sha256)?.toLowerCase() }
      : {})
  }
}

/** Whether this version ships a source package (the detail carries has_source; a legacy source_sha256 counts too) */
function versionHasSource(version: HubVersion): boolean {
  return version.has_source === true || Boolean(version.source_sha256)
}

/** Catalog: `GET /v1/hub/plugins` (renderer camelCase params → platform snake_case) */
export async function listLatticeHub(query: LatticeListQuery = {}): Promise<HubListResult> {
  const page = clampInt(query.page, 1, 1, 100_000)
  const pageSize = clampInt(query.pageSize, 20, 1, 100)
  const sort =
    query.sort === 'recent' || query.sort === 'popular' || query.sort === 'name'
      ? query.sort
      : undefined
  const raw = await latticeRequest<unknown>('/v1/hub/plugins', {
    query: {
      q: query.q?.trim() || undefined,
      category: query.category?.trim() || undefined,
      sort,
      page,
      page_size: pageSize
    }
  })
  const record = asRecord(raw) ?? {}
  const items = Array.isArray(record.items) ? record.items.map(mapHubEntry) : []
  return {
    items,
    total: readNumber(record.total, items.length),
    page: readNumber(record.page, page),
    page_size: readNumber(record.page_size, pageSize)
  }
}

/** Detail: `GET /v1/hub/plugins/{plugin_id}` */
export async function getLatticeHubDetail(pluginId: string): Promise<HubDetail> {
  const id = pluginId.trim()
  if (!id) throw new Error('缺少插件 id')
  const raw = await latticeRequest<unknown>(`/v1/hub/plugins/${encodeURIComponent(id)}`)
  const record = asRecord(raw) ?? {}
  const entry = mapHubEntry(record)
  const myInstall = asRecord(record.my_install)
  return {
    ...entry,
    readme: readString(record.readme),
    versions: Array.isArray(record.versions) ? record.versions.map(mapHubVersion) : [],
    my_install: myInstall
      ? {
          version: readString(myInstall.version),
          enabled: myInstall.enabled === true,
          data_rev: readNumber(myInstall.data_rev, 0),
          data_updated_at: readOptionalString(myInstall.data_updated_at)
        }
      : null
  }
}

// ---------- Upload ----------

interface LocalPackageManifest {
  id: string
  name: string
  version: string
  description?: string
  icon?: string
  entry?: { main?: string; renderer?: string }
  category?: string
  tags?: unknown
  changelog?: string
  [key: string]: unknown
}

interface CollectedPackageFile {
  abs: string
  rel: string
  size: number
}

/**
 * Brand icon from the manifest: prefer `icon` (external plugins may use plugin:// or data:),
 * falling back to `menu.icon` when `icon` is absent (built-in and older plugins declare an icon only there).
 *
 * The platform's `hub_plugins.icon` is a single field read by both cards and the detail page; taking only
 * `manifest.icon` would turn every plugin that only has `menu.icon` into the default puzzle piece in the hub
 * (user feedback 2026-11-21).
 */
function manifestIcon(manifest: LocalPackageManifest): string {
  const direct = typeof manifest.icon === 'string' ? manifest.icon.trim() : ''
  if (direct) return direct
  const menu = manifest.menu
  if (menu && typeof menu === 'object') {
    const menuIcon = (menu as { icon?: unknown }).icon
    if (typeof menuIcon === 'string') return menuIcon.trim()
  }
  return ''
}

function collectPackageFiles(root: string): CollectedPackageFile[] {
  const files: CollectedPackageFile[] = []
  const walk = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (NOISE_NAMES.has(entry.name)) continue
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (PACKAGE_EXCLUDED_DIRS.has(entry.name)) continue
        walk(abs, rel)
      } else if (entry.isFile()) {
        if (prefix === '' && PACKAGE_ROOT_META_FILES.has(entry.name)) continue
        files.push({ abs, rel, size: fs.statSync(abs).size })
      }
    }
  }
  walk(root, '')
  return files
}

/** Read and validate the in-package plugin.json (required fields + entry files really exist + not a built-in plugin) */
function readLocalPackageManifest(
  root: string,
  files: CollectedPackageFile[]
): {
  manifest: LocalPackageManifest
  rawText: string
} {
  const manifestPath = path.join(root, 'plugin.json')
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      '插件包目录里没有 plugin.json：请选择插件**构建产物**目录（例如插件仓库里的 dist/<id>）'
    )
  }
  const rawText = fs.readFileSync(manifestPath, 'utf-8')
  let parsed: unknown
  try {
    // Some build scripts emit a UTF-8 BOM: JSON.parse rejects a BOM, so strip it before parsing
    parsed = JSON.parse(rawText.replace(/^\uFEFF/u, '')) as unknown
  } catch (err) {
    throw new Error(
      `plugin.json 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`
    )
  }
  const record = asRecord(parsed)
  if (!record) throw new Error('plugin.json 必须是 JSON 对象')
  const manifest = record as unknown as LocalPackageManifest
  if (typeof manifest.id !== 'string' || !PLUGIN_ID_RE.test(manifest.id)) {
    throw new Error(
      `插件 id 不合法（平台要求 2–64 位小写字母/数字/./_/-，且以字母或数字开头）：${String(manifest.id)}`
    )
  }
  if (typeof manifest.name !== 'string' || manifest.name.trim() === '') {
    throw new Error('plugin.json 缺少 name')
  }
  if (typeof manifest.version !== 'string' || !VERSION_RE.test(manifest.version)) {
    throw new Error(
      `版本号不合法（平台要求 semver，如 1.2.0 或 1.2.0-beta.1）：${String(manifest.version)}`
    )
  }
  const mainEntry = typeof manifest.entry?.main === 'string' ? manifest.entry.main : ''
  const rendererEntry = typeof manifest.entry?.renderer === 'string' ? manifest.entry.renderer : ''
  if (!mainEntry || !rendererEntry) {
    throw new Error('plugin.json 的 entry 缺少 main / renderer：插件包必须带主进程与渲染层入口')
  }
  const relSet = new Set(files.map((file) => file.rel))
  if (!relSet.has(mainEntry)) throw new Error(`插件包缺少主进程入口：${mainEntry}`)
  if (!relSet.has(rendererEntry)) throw new Error(`插件包缺少渲染层入口：${rendererEntry}`)
  return { manifest, rawText }
}

/** Read README.md (≤16KiB; truncated by bytes when longer) */
function readReadme(root: string): string {
  for (const name of ['README.md', 'readme.md', 'Readme.md']) {
    const file = path.join(root, name)
    try {
      if (!fs.statSync(file).isFile()) continue
      return clampUtf8Bytes(fs.readFileSync(file, 'utf-8'), README_MAX_BYTES)
    } catch {
      // Try the next file name when this one does not exist
    }
  }
  return ''
}

/** Manifest snapshot used for publishing (≤16KiB; send only the minimal fields when larger) */
function manifestForPublish(
  manifest: LocalPackageManifest,
  rawText: string
): Record<string, unknown> {
  if (Buffer.byteLength(rawText, 'utf8') <= MANIFEST_MAX_BYTES) {
    return manifest as unknown as Record<string, unknown>
  }
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    icon: manifest.icon,
    entry: manifest.entry
  }
}

/** Zip packaging options (on republish, replaces the version in the in-package plugin.json with the new version the user entered) */
interface ZipDirOptions {
  overrides?: Map<string, Buffer>
  /** Do not emit progress to the renderer (progress is meaningless across a batch import of several pipelines) */
  silent?: boolean
}

/** Directory → raw zip bytes (relative paths flattened, plugin.json at the root; emits zip-stage progress as a percentage) */
async function zipPackageDir(
  files: CollectedPackageFile[],
  options: ZipDirOptions = {}
): Promise<{ buffer: Buffer; totalBytes: number }> {
  const zip = new JSZip()
  let totalBytes = 0
  for (const file of files) {
    const override = options.overrides?.get(file.rel)
    const bytes = override ?? fs.readFileSync(file.abs)
    zip.file(file.rel, bytes)
    totalBytes += bytes.length
  }
  const emit = (progress: LatticeUploadProgress): void => {
    if (!options.silent) emitUploadProgress(progress)
  }
  emit({ phase: 'zip', sent: 0, total: totalBytes })
  let lastPercent = -1
  const buffer = await zip.generateAsync(
    { type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } },
    (metadata) => {
      const percent = Math.round(metadata.percent)
      if (percent < 100 && percent - lastPercent < 2) return
      lastPercent = percent
      emit({
        phase: 'zip',
        sent: Math.round((totalBytes * percent) / 100),
        total: totalBytes
      })
    }
  )
  emit({ phase: 'zip', sent: totalBytes, total: totalBytes })
  return { buffer, totalBytes }
}

function normalizeHeaders(raw: unknown): Record<string, string> {
  const record = asRecord(raw)
  const headers: Record<string, string> = {}
  if (!record) return headers
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string') headers[key] = value
  }
  return headers
}

interface ApiPublishResponse {
  plugin?: unknown
  version?: unknown
  upload?: { path?: unknown; headers?: unknown } | null
  /** Source package upload URL (the platform only returns it when the POST carries `source` metadata) */
  source_upload?: { path?: unknown; headers?: unknown; max_bytes?: unknown } | null
  idempotent_reused?: unknown
}

interface ApiUploadResponse {
  status?: unknown
  download_path?: unknown
}

/** Options for publishing a directory (source package defaults to the same bytes as the install package; an independent source directory may also be given explicitly) */
interface PublishPackageOptions {
  /**
   * Compatibility path: upload the **same zip** as the source package (in the plugin workshop "plugin = source
   * directory", so the install package is the whole-directory zip and both byte sets are identical).
   *
   * Has no effect when `sourcePath` is set — a real source directory must be uploaded separately from the build output.
   */
  includeSource?: boolean
  /**
   * Independent source directory / source .zip: uploaded as this version's source package (≤50MiB).
   *
   * The use case is "a plugin inside a repository": the install package comes from `dist/<id>/` (build output),
   * the source from `plugins/<id>/` (TypeScript and so on). The platform validates against the declared sha256;
   * the two byte sets differ.
   */
  sourcePath?: string
  /** Override the version in plugin.json (the new version the user entered on republish; the in-package manifest is rewritten to match) */
  versionOverride?: string
  /** Override the changelog (defaults to plugin.json.changelog or a generated "published v<version>" note when absent) */
  changelogOverride?: string
  /** Do not emit progress to the renderer (progress is meaningless across a batch import of several pipelines) */
  silent?: boolean
}

interface PublishPackageResult {
  plugin_id: string
  version: string
  /** sha256 of this package body */
  sha256: string
  /** sha256 of this source package (absent when there is no source package) */
  sourceSha256?: string
  /** Final platform status: published / awaiting admin review (the platform submits for review by default since 2026-11-23) */
  status: 'published' | 'review'
  /** Whether the platform accepted the source package (source_upload returned and the PUT succeeded) */
  sourceUploaded: boolean
  /** Idempotent reuse: the same version and sha were already published, so no bytes were uploaded */
  reused: boolean
}

/** Turn platform errors from the publish stage into user-facing text (especially 409: version must increase / source cannot be replaced) */
function publishPhaseError(
  err: unknown,
  phase: 'meta' | 'package' | 'source',
  pluginId: string,
  version: string
): Error {
  if (!(err instanceof LatticeApiError)) {
    return err instanceof Error ? err : new Error(String(err))
  }
  if (phase === 'meta' && err.status === 409) {
    return new Error(
      `发布 ${pluginId}@${version} 被平台拒绝（409 ${err.code}）：${err.message}。` +
        '版本号必须大于当前最新版本，同一版本不能重复发布不同内容'
    )
  }
  if (phase === 'source') {
    if (err.status === 409 && err.code === 'source_published') {
      return new Error(
        '源码已发布过且与本次内容不同（409 source_published）：同一版本的源码不可替换，请提升版本号后重试'
      )
    }
    return new Error(`源码包上传失败${err.status ? `（HTTP ${err.status}）` : ''}：${err.message}`)
  }
  if (phase === 'package') {
    return new Error(`安装包上传失败${err.status ? `（HTTP ${err.status}）` : ''}：${err.message}`)
  }
  return err
}

/**
 * Resolve the source package origin: a directory (repackaged, skipping irrelevant directories like `.git` /
 * `node_modules`) or a `.zip` (uploaded as is).
 *
 * Difference from the install package: the source directory does **not** need plugin.json (the platform allows
 * the source package to be a plain project directory); the size limit is 50MiB, looser than the install package.
 */
async function resolveSourceArchive(
  sourcePath: string,
  options: { silent?: boolean } = {}
): Promise<{ buffer: Buffer; sha256: string; size: number }> {
  const trimmed = String(sourcePath ?? '').trim()
  if (trimmed === '') throw new Error('源码目录为空')
  let stat: fs.Stats
  try {
    stat = fs.statSync(trimmed)
  } catch {
    throw new Error(`源码路径不存在：${trimmed}`)
  }
  let buffer: Buffer
  if (stat.isDirectory()) {
    const files = collectPackageFiles(trimmed)
    if (files.length === 0) throw new Error('源码目录是空的')
    const zipped = await zipPackageDir(files, options.silent ? { silent: true } : {})
    buffer = zipped.buffer
  } else if (stat.isFile() && trimmed.toLowerCase().endsWith('.zip')) {
    buffer = fs.readFileSync(trimmed)
  } else {
    throw new Error('源码必须是目录或 .zip 文件')
  }
  if (buffer.length === 0) throw new Error('源码包是空的')
  if (buffer.length > SOURCE_MAX_BYTES) {
    throw new Error(
      `源码包 ${(buffer.length / 1024 / 1024).toFixed(1)}MiB 超过平台上限 50MiB，请去掉不需要的文件`
    )
  }
  return { buffer, sha256: createHash('sha256').update(buffer).digest('hex'), size: buffer.length }
}

/** Publish a package directory to the plugin hub: metadata → install package body → (optional) source package body */
async function publishPackageDir(
  root: string,
  options: PublishPackageOptions = {}
): Promise<PublishPackageResult> {
  const files = collectPackageFiles(root)
  if (files.length === 0) throw new Error('插件包目录是空的')
  const { manifest, rawText } = readLocalPackageManifest(root, files)
  const pluginId = manifest.id
  const version = (options.versionOverride ?? manifest.version).trim()
  if (!VERSION_RE.test(version)) {
    throw new Error(
      `版本号不合法（平台要求 semver，如 1.2.0 或 1.2.0-beta.1）：${version || '（空）'}`
    )
  }

  // Version override (republish): the in-package plugin.json version must match the published version, otherwise the platform manifest does not line up
  const overrides = new Map<string, Buffer>()
  let effectiveManifest: LocalPackageManifest = manifest
  let effectiveRawText = rawText
  if (version !== manifest.version) {
    const patchedText = `${JSON.stringify({ ...manifest, version }, null, 2)}\n`
    effectiveManifest = { ...manifest, version }
    effectiveRawText = patchedText
    overrides.set('plugin.json', Buffer.from(patchedText, 'utf-8'))
  }

  const { buffer } = await zipPackageDir(files, {
    overrides,
    ...(options.silent ? { silent: true } : {})
  })
  if (buffer.length > PACKAGE_MAX_BYTES) {
    throw new Error(
      `插件包 ${(buffer.length / 1024 / 1024).toFixed(1)}MiB 超过平台上限 20MiB，请去掉不需要的文件`
    )
  }
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  // Source package: an explicit source directory wins (source separate from build output); otherwise keep the legacy "install package = whole source directory" convention
  const sourceArchive = options.sourcePath
    ? await resolveSourceArchive(options.sourcePath, options.silent ? { silent: true } : {})
    : options.includeSource
      ? { buffer, sha256, size: buffer.length }
      : null
  const readme = readReadme(root)
  const tags = readStringArray(effectiveManifest.tags)
    .slice(0, 8)
    .map((tag) => clampChars(tag, 24))
    .filter((tag) => tag !== '')
  const category =
    typeof effectiveManifest.category === 'string' &&
    CATEGORY_VALUES.has(effectiveManifest.category)
      ? effectiveManifest.category
      : 'other'
  const description = clampChars(
    typeof effectiveManifest.description === 'string' ? effectiveManifest.description : '',
    DESCRIPTION_MAX_CHARS
  )
  const icon = manifestIcon(effectiveManifest)
  const changelogSource =
    typeof options.changelogOverride === 'string' && options.changelogOverride.trim() !== ''
      ? options.changelogOverride
      : typeof effectiveManifest.changelog === 'string' && effectiveManifest.changelog.trim() !== ''
        ? effectiveManifest.changelog
        : `发布 v${version}`
  const changelog = clampChars(changelogSource, CHANGELOG_MAX_CHARS)

  const meta: Record<string, unknown> = {
    plugin_id: pluginId,
    version,
    name: clampChars(effectiveManifest.name.trim(), NAME_MAX_CHARS),
    category,
    asset_name: `${pluginId}-${version}.zip`,
    size: buffer.length,
    sha256,
    manifest: manifestForPublish(effectiveManifest, effectiveRawText)
  }
  if (sourceArchive) {
    meta.source = {
      asset_name: `${pluginId}-${version}-src.zip`,
      size: sourceArchive.size,
      sha256: sourceArchive.sha256
    }
  }
  if (description !== '') meta.description = description
  if (readme !== '') meta.readme = readme
  if (icon !== '' && Array.from(icon).length <= ICON_MAX_CHARS) meta.icon = icon
  if (tags.length > 0) meta.tags = tags
  if (changelog !== '') meta.changelog = changelog

  const emit = (progress: LatticeUploadProgress): void => {
    if (!options.silent) emitUploadProgress(progress)
  }
  emit({ phase: 'meta', sent: 0, total: 1 })
  logger.info(
    `[Lattice] Publishing metadata for ${pluginId}@${version} (${(buffer.length / 1024).toFixed(1)}KiB` +
      `${sourceArchive ? `, source ${(sourceArchive.size / 1024).toFixed(1)}KiB` : ''})`
  )
  let publish: ApiPublishResponse
  try {
    publish = await latticeRequest<ApiPublishResponse>('/v1/hub/plugins', {
      method: 'POST',
      body: meta
    })
  } catch (err) {
    throw publishPhaseError(err, 'meta', pluginId, version)
  }
  emit({ phase: 'meta', sent: 1, total: 1 })

  const uploadPath = typeof publish.upload?.path === 'string' ? publish.upload.path : ''
  const reused = uploadPath === ''
  let sourceUploaded = false
  // The platform submits for review by default since 2026-11-23: a successful upload ≠ published; both are success, only the message text differs
  let status: 'published' | 'review' = 'published'
  if (!uploadPath) {
    // Idempotent retry hit: the same version and sha were already published, no need to upload the package body again
    const reusedStatus = asRecord(publish.version)?.status
    if (reusedStatus === 'review') status = 'review'
    logger.info(
      `[Lattice] ${pluginId}@${version} already exists with identical content (idempotent reuse), skipping package upload`
    )
  } else {
    const headers = normalizeHeaders(publish.upload?.headers)
    if (!headers['Content-Type']) headers['Content-Type'] = 'application/octet-stream'
    if (!headers['X-Content-SHA256']) headers['X-Content-SHA256'] = sha256
    emit({ phase: 'upload', sent: 0, total: buffer.length })
    try {
      const uploaded = await uploadLatticeBytes(uploadPath, buffer, headers, (sent, total) => {
        emit({ phase: 'upload', sent, total })
      })
      let uploadResult: ApiUploadResponse | null = null
      try {
        const parsed = JSON.parse(uploaded.text) as unknown
        uploadResult = asRecord(parsed) as ApiUploadResponse | null
      } catch {
        // A non-JSON upload response does not change the fact that the 2xx already succeeded
      }
      const uploadStatus = typeof uploadResult?.status === 'string' ? uploadResult.status : ''
      if (uploadStatus === 'review') {
        // Submitted and awaiting admin review: this is a normal outcome, not a failure
        status = 'review'
      } else if (uploadStatus !== '' && uploadStatus !== 'published') {
        throw new Error(`插件包上传后状态异常：${uploadStatus}（期望 published 或 review）`)
      }
    } catch (err) {
      throw publishPhaseError(err, 'package', pluginId, version)
    }
  }

  if (sourceArchive) {
    const sourceUploadPath =
      typeof publish.source_upload?.path === 'string' ? publish.source_upload.path : ''
    if (sourceUploadPath) {
      const sourceHeaders = normalizeHeaders(publish.source_upload?.headers)
      if (!sourceHeaders['Content-Type']) sourceHeaders['Content-Type'] = 'application/zip'
      if (!sourceHeaders['X-Content-SHA256'])
        sourceHeaders['X-Content-SHA256'] = sourceArchive.sha256
      emit({ phase: 'upload', sent: 0, total: sourceArchive.size })
      try {
        await uploadLatticeBytes(
          sourceUploadPath,
          sourceArchive.buffer,
          sourceHeaders,
          (sent, total) => {
            emit({ phase: 'upload', sent, total })
          }
        )
        sourceUploaded = true
      } catch (err) {
        throw publishPhaseError(err, 'source', pluginId, version)
      }
    } else {
      // The platform returned no source upload URL (legacy platform / idempotent reuse): the source status is unknown, so record it as-is, but the install package has published successfully
      logger.warn(
        `[Lattice] Platform returned no source upload URL (source_upload): ${pluginId}@${version} may have no source package`
      )
    }
  }

  logger.info(
    `[Lattice] Published ${pluginId}@${version} (${(buffer.length / 1024).toFixed(1)}KiB` +
      `${sourceArchive ? ', with source package' : ''}, status=${status})`
  )
  notifyStateChanged()
  return {
    plugin_id: pluginId,
    version,
    sha256,
    ...(sourceArchive ? { sourceSha256: sourceArchive.sha256 } : {}),
    status,
    sourceUploaded,
    reused
  }
}

/** Upload a plugin package and normalize the result into the IPC shape (`sourcePath`, when given, uploads the source separately from the install package) */
async function uploadPackageDirAsLatticeResult(
  root: string,
  sourcePath?: string
): Promise<LatticeUploadResult> {
  // The requirement is "version management, source management, install package" — plugins uploaded from this
  // machine must ship source too, otherwise another machine cannot view/modify the source after installing
  // (the install package is only a bundle). For a plugin inside a repository: install package from the build
  // output directory, source from the source directory (two different byte sets).
  const result = sourcePath
    ? await publishPackageDir(root, { sourcePath })
    : await publishPackageDir(root, { includeSource: true })
  return {
    ok: true,
    plugin_id: result.plugin_id,
    version: result.version,
    status: result.status,
    sourceUploaded: result.sourceUploaded
  }
}

/** Resolve the upload source: directory / .zip (archives are extracted to a temp directory first) */
async function resolveUploadRoot(source: string): Promise<{ root: string; cleanup?: () => void }> {
  let stat: fs.Stats
  try {
    stat = fs.statSync(source)
  } catch {
    throw new Error(`路径不存在：${source}`)
  }
  if (stat.isDirectory()) return { root: resolvePackageRoot(source) }
  if (stat.isFile() && source.toLowerCase().endsWith('.zip')) {
    const extracted = await extractZipToTemp(source)
    return {
      root: resolvePackageRoot(extracted),
      cleanup: () => {
        try {
          fs.rmSync(extracted, { recursive: true, force: true })
        } catch (err) {
          logger.warn('[Lattice] Failed to clean up upload temp directory:', err)
        }
      }
    }
  }
  throw new Error('请选择插件包目录（含 plugin.json）或 .zip 压缩包')
}

/** Upload by explicit path (directory or zip); when `sourcePath` is given, source and install package are uploaded separately */
export async function uploadLatticePackage(
  source: string,
  sourcePath?: string
): Promise<LatticeUploadResult> {
  const trimmed = String(source ?? '').trim()
  if (!trimmed) return { ok: false, error: '缺少插件包路径' }
  try {
    const resolved = await resolveUploadRoot(trimmed)
    try {
      return await uploadPackageDirAsLatticeResult(resolved.root, sourcePath)
    } finally {
      resolved.cleanup?.()
    }
  } catch (err) {
    const message = latticeErrorMessage(err)
    logger.warn(`[Lattice] Failed to upload plugin package (${trimmed}): ${message}`)
    return { ok: false, error: message }
  }
}

/**
 * Source directory uploaded together with a direct publish of an "installed plugin".
 *
 * The directory counts as source only when its `plugin.json` really is for the **same plugin**; otherwise no
 * source is uploaded (falling back to the legacy "install package bytes also serve as the source package"
 * convention), so that a wrong directory is never uploaded by mistake.
 */
function sourceDirForInstalledPublish(pluginId: string): string | undefined {
  const resolved = resolvePluginSource(pluginId)
  if (!resolved?.path) return undefined
  try {
    const raw = fs.readFileSync(path.join(resolved.path, 'plugin.json'), 'utf-8')
    const manifest = JSON.parse(raw.replace(/^\uFEFF/u, '')) as { id?: unknown }
    return manifest?.id === pluginId ? resolved.path : undefined
  } catch {
    return undefined
  }
}

/**
 * `lattice:hub-publish-installed`: publish this **locally installed** plugin straight to the plugin hub.
 *
 * Why it is needed (user 2026-11-23: "why must the user pick the directory themselves to publish a local plugin?"):
 * the detail page only offers "publish to hub" for installed plugins that are not published yet, and both the
 * install package directory (`userData/plugins/<id>`) and the source directory already exist — no need to pop a
 * system directory picker and make the user hunt down their own plugin on disk again. When the installed package
 * cannot be found, the caller falls back to "pick a directory and publish".
 */
export async function publishInstalledLatticePlugin(
  pluginId: string
): Promise<LatticeUploadResult> {
  const id = String(pluginId ?? '').trim()
  if (!id) return { ok: false, error: '缺少插件 id' }
  const installed = findExternalPlugin(id)
  if (!installed) {
    return { ok: false, error: `插件 '${id}' 没有安装在本机，无法直接发布` }
  }
  try {
    return await uploadPackageDirAsLatticeResult(installed.dir, sourceDirForInstalledPublish(id))
  } catch (err) {
    const message = latticeErrorMessage(err)
    logger.warn(`[Lattice] Failed to publish installed plugin '${id}': ${message}`)
    return { ok: false, error: message }
  }
}

/** Open a directory picker and upload (user cancel returns `{ok:true,canceled:true}`, which is not a failure) */
export async function pickAndUploadLatticePackage(): Promise<LatticeUploadResult> {
  const result = await dialog.showOpenDialog({
    title: '选择要发布到插件中心的插件包目录（含 plugin.json 的构建产物目录）',
    properties: ['openDirectory']
  })
  if (result.canceled || result.filePaths.length === 0) {
    return { ok: true, canceled: true }
  }
  return await uploadLatticePackage(result.filePaths[0])
}

/**
 * Open two directory pickers: first the build output (install package), then the source directory (source package).
 *
 * This targets "a plugin inside a repository": `dist/<id>/` is the packaged output and `plugins/<id>/` the
 * TypeScript source; the two byte sets differ, so only this way does the platform's "source code" download yield
 * the real source. Canceling either dialog is treated as "publish canceled".
 */
export async function pickAndUploadLatticePackageWithSource(): Promise<LatticeUploadResult> {
  const pkg = await dialog.showOpenDialog({
    title: '选择要发布到插件中心的安装包目录（构建产物，含 plugin.json）',
    properties: ['openDirectory']
  })
  if (pkg.canceled || pkg.filePaths.length === 0) {
    return { ok: true, canceled: true }
  }
  const src = await dialog.showOpenDialog({
    title: '选择该版本的源码目录（源码工程，不含 node_modules；将与安装包分开上传）',
    properties: ['openDirectory']
  })
  if (src.canceled || src.filePaths.length === 0) {
    return { ok: true, canceled: true }
  }
  return await uploadLatticePackage(pkg.filePaths[0], src.filePaths[0])
}

/** Open a .zip install package picker and upload (goes through the same extract/manifest/publish pipeline) */
export async function pickAndUploadZipLatticePackage(): Promise<LatticeUploadResult> {
  const result = await dialog.showOpenDialog({
    title: '选择要发布到插件中心的 .zip 安装包（根目录含 plugin.json）',
    properties: ['openFile'],
    filters: [{ name: 'Lattice 插件包', extensions: ['zip'] }]
  })
  if (result.canceled || result.filePaths.length === 0) {
    return { ok: true, canceled: true }
  }
  return await uploadLatticePackage(result.filePaths[0])
}

// ---------- Download install ----------

/** Pick a version: an explicit version wins, then latest_version, then the first entry in the version list (the platform sorts newest first) */
function pickVersion(detail: HubDetail, requested?: string): HubVersion {
  const versions = detail.versions
  if (versions.length === 0) {
    throw new Error(`插件 '${detail.plugin_id}' 没有可下载的已发布版本`)
  }
  const wanted = requested?.trim()
  if (wanted) {
    const hit = versions.find((item) => item.version === wanted)
    if (!hit) {
      throw new Error(
        `插件 '${detail.plugin_id}' 不存在版本 '${wanted}'（可用：${versions.map((item) => item.version).join('、')}）`
      )
    }
    return hit
  }
  if (detail.latest_version) {
    const hit = versions.find((item) => item.version === detail.latest_version)
    if (hit) return hit
  }
  return versions[0]
}

/** Download and install (or upgrade) a plugin from the plugin hub; failures return `{ok:false,error}` */
export async function installLatticePlugin(
  pluginId: string,
  version?: string
): Promise<LatticeInstallResult> {
  const id = String(pluginId ?? '').trim()
  if (!id) return { ok: false, error: '缺少插件 id' }
  if (!hasLatticeSession()) return { ok: false, error: '未登录插件中心，请先登录' }
  if (isProfileSwitchInProgress() || !profileMatchesSession()) {
    return { ok: false, error: '账号数据空间正在切换，请稍候再安装/更新' }
  }
  try {
    return await withPluginOperation(id, '正在安装/更新', () =>
      installLatticePluginInner(id, version)
    )
  } catch (err) {
    // Lock conflict (another entry is installing/uninstalling the same plugin): reject readably instead of letting the two operations overwrite each other
    return { ok: false, error: latticeErrorMessage(err) }
  }
}

async function installLatticePluginInner(
  pluginId: string,
  version?: string
): Promise<LatticeInstallResult> {
  const id = String(pluginId ?? '').trim()
  if (!id) return { ok: false, error: '缺少插件 id' }
  try {
    const detail = await getLatticeHubDetail(id)
    if (detail.install_enabled === false) {
      return { ok: false, error: `插件 '${id}' 暂不可安装（平台已禁用该插件的安装）` }
    }
    const target = pickVersion(detail, version)
    logger.info(
      `[Lattice] Downloading ${detail.plugin_id}@${target.version} (sha256=${target.sha256.slice(0, 12)}...)`
    )

    const downloaded = await downloadLatticeFile(
      `/v1/hub/plugins/${encodeURIComponent(detail.plugin_id)}/versions/${encodeURIComponent(target.version)}/download`,
      { expectedSha256: target.sha256 }
    )

    // Materialize: temp zip → extract → install core (it validates the id/entries and checks for built-in id collisions)
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ryten-lattice-'))
    const zipPath = path.join(
      workDir,
      target.asset_name || `${detail.plugin_id}-${target.version}.zip`
    )
    let extracted: string | null = null
    let info: InstalledPackageInfo
    try {
      fs.writeFileSync(zipPath, downloaded.bytes)
      extracted = await extractZipToTemp(zipPath)
      info = installPackageDir(extracted, { expectId: detail.plugin_id })
    } finally {
      if (extracted) {
        try {
          fs.rmSync(extracted, { recursive: true, force: true })
        } catch (err) {
          logger.warn('[Lattice] Failed to clean up extraction temp directory:', err)
        }
      }
      try {
        fs.rmSync(workDir, { recursive: true, force: true })
      } catch (err) {
        logger.warn('[Lattice] Failed to clean up download temp directory:', err)
      }
    }

    // The user actively clicked "install": enable and load the main module right after installing (same
    // convention as the existing install flow). On upgrade (the same id is already running) a **reload** is
    // required: `installPackageDir` just overwrote the package on disk, and a plain load returns early because
    // the module is already loaded, leaving the main process running the old module — new channels in the new
    // version only take effect after a restart.
    setEnabledOverride(info.id, true)
    let loadError: string | null = null
    try {
      reloadExternalMain(info.id)
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err)
      logger.error(`[Lattice] Installed plugin '${info.id}' failed to load:`, err)
    }
    broadcastPluginStateChanged()

    if (loadError) {
      return {
        ok: false,
        error: `插件 '${info.id}' 已安装（v${info.version}），但装载失败：${loadError}。可在插件面板中重新启用。`
      }
    }

    // Install record (version/enabled state/device): failures only warn — the plugin is already installed locally, so this should not fail the install
    try {
      await latticeRequest(`/v1/hub/installs/${encodeURIComponent(info.id)}`, {
        method: 'PUT',
        body: {
          version: info.version,
          enabled: true,
          device_id: getLatticeDeviceId() ?? undefined
        }
      })
    } catch (err) {
      logger.warn(
        `[Lattice] Failed to write install record (already installed locally): ${latticeErrorMessage(err)}`
      )
    }

    // If the version ships source, download and extract it into the local source directory automatically (a failure does not fail the install)
    let sourcePath: string | undefined
    let sourceVersion: string | undefined
    let sourceManaged: LatticeSourceManaged | undefined
    let sourceError: string | undefined
    let sourceBackupPath: string | undefined
    if (versionHasSource(target)) {
      const installedId = detail.plugin_id
      const expectedSourceSha = target.source_sha256?.toLowerCase() || undefined
      try {
        // The same version with identical content was already downloaded → reuse it instead of downloading again
        const existing = resolvePluginSource(installedId)
        if (
          existing &&
          existing.version === target.version &&
          expectedSourceSha &&
          existing.sha256 === expectedSourceSha
        ) {
          sourcePath = existing.path
          sourceVersion = target.version
          sourceManaged = existing.managed
          logger.info(
            `[Lattice] ${installedId}@${target.version} source is already local, skipping duplicate download`
          )
        } else {
          logger.info(`[Lattice] Downloading source ${installedId}@${target.version}...`)
          const downloaded = await downloadLatticeFile(
            `/v1/hub/plugins/${encodeURIComponent(installedId)}/versions/${encodeURIComponent(target.version)}/source`,
            expectedSourceSha ? { expectedSha256: expectedSourceSha } : {}
          )
          const actualSha =
            expectedSourceSha ?? createHash('sha256').update(downloaded.bytes).digest('hex')
          const stored = await installSourceBytes({
            pluginId: installedId,
            version: target.version,
            bytes: downloaded.bytes,
            sha256: actualSha,
            ...(target.source_asset_name ? { assetName: target.source_asset_name } : {})
          })
          sourcePath = stored.path
          sourceVersion = target.version
          sourceManaged = stored.managed
          if (stored.backupPath) sourceBackupPath = stored.backupPath
          recordLatticeSourceCache(installedId, {
            path: stored.path,
            version: target.version,
            sha256: actualSha,
            managed: stored.managed
          })
          // Source landed in the user plugin path = one more draft in the plugin-mode sidebar; make the renderer refresh right away
          if (stored.managed === 'pluginsPath') broadcastWorkshopChanged()
          logger.info(`[Lattice] Source ready: ${installedId}@${target.version} -> ${stored.path}`)
        }
      } catch (err) {
        sourceError = latticeErrorMessage(err)
        logger.warn(
          `[Lattice] Failed to download source after installing '${installedId}@${target.version}' (install unaffected): ${sourceError}`
        )
      }
    }

    notifyStateChanged()
    /**
     * Pull the cloud install record once after install/update (other plugins are not auto-completed):
     * a freshly installed machine may only have default data while the cloud still holds a data snapshot for
     * this plugin — especially when reinstalling after "clear local data on uninstall" cleared the `data_rev`
     * cache; this pull writes the cloud data back to `plugin-state/<id>.json` (user 2026-11-23: "otherwise
     * what about future data sync?"). Not awaited: the install result does not depend on network sync, so let
     * it finish in the background.
     */
    // The user may have logged out during the install: skip another background pull without a session
    // (otherwise an "unauthenticated" sync result would be written into the new account space's status bar)
    if (hasLatticeSession()) void syncLattice({ direction: 'pull', installMissing: false })
    logger.info(
      `[Lattice] Install complete: ${info.id}@${info.version}${info.upgraded ? ' (upgrade)' : ''}`
    )
    return {
      ok: true,
      id: info.id,
      name: info.name,
      version: info.version,
      ...(sourcePath ? { sourcePath } : {}),
      ...(sourceVersion ? { sourceVersion } : {}),
      ...(sourceManaged ? { sourceManaged } : {}),
      ...(sourceError ? { sourceError } : {}),
      ...(sourceBackupPath ? { sourceBackupPath } : {})
    }
  } catch (err) {
    let message = latticeErrorMessage(err)
    // Convert a 404 into a user-understandable reason when the platform deleted the plugin (auto-complete failures need readable text)
    if (err instanceof LatticeApiError && err.status === 404) {
      message = `插件 '${id}' 在插件中心不存在（可能已被作者删除）：${message}`
    }
    logger.warn(`[Lattice] Failed to install '${id}' from plugin hub: ${message}`)
    return { ok: false, error: message }
  }
}

/** Result of fetching the source on demand before "open source" */
export interface EnsureLatticeSourceResult {
  ok: boolean
  path?: string
  version?: string
  error?: string
}

/**
 * **On-demand source fetch** before opening source: when this machine has no source, download it once from the
 * plugin hub for "the version installed here" and extract it into the plugin storage path.
 *
 * Why it is needed: a failed source download at install time is only recorded in `sourceError` and does not fail
 * the install, so a state can arise where the hub shows the plugin as installed and flagged as having source, but
 * clicking "modify in chat" can only fall back to the file explorer (user 2026-11-25; a reinstall fixed it). This
 * turns "reinstall once" into a recoverable on-demand download, so the user need not uninstall the plugin or
 * restart the app.
 *
 * Constraints:
 * - only fetch the source for **the version installed here**; never pair the latest source with an older install
 *   package (a version mismatch is worse than having no source);
 * - when logged out / when the platform has no source package for that version, return a readable reason for the
 *   UI to show (do not silently open a folder);
 * - when source already exists (even in the userData fallback directory), do nothing and leave migration to the caller.
 */
export async function ensureLatticePluginSource(
  pluginIdRaw: unknown
): Promise<EnsureLatticeSourceResult> {
  const pluginId = typeof pluginIdRaw === 'string' ? pluginIdRaw.trim() : ''
  if (!pluginId) return { ok: false, error: '缺少插件 id' }
  if (isPluginOperationRunning(pluginId)) {
    return { ok: false, error: '插件正在安装/更新，请等它完成后再打开源码' }
  }

  const existing = resolvePluginSource(pluginId)
  if (existing) {
    return {
      ok: true,
      path: existing.path,
      ...(existing.version ? { version: existing.version } : {})
    }
  }

  if (!hasLatticeSession()) {
    return {
      ok: false,
      error:
        '本机没有这份插件的源码，且当前未登录插件中心，无法自动下载源码。' +
        '请先登录插件中心后重试，或重新安装带源码包的新版本。'
    }
  }

  const installed = findExternalPlugin(pluginId)
  if (!installed) {
    return {
      ok: false,
      error: `本机没有安装插件 '${pluginId}'，也没有它的源码：请先在插件中心安装（会自动下载源码）`
    }
  }

  try {
    const detail = await getLatticeHubDetail(pluginId)
    const installedVersion = installed.manifest.version
    const target = detail.versions.find((item) => item.version === installedVersion)
    if (!target) {
      return {
        ok: false,
        error:
          `插件中心没有本机安装的版本 v${installedVersion}（可能已被作者删除），` +
          '无法下载与安装包一致的源码。请更新/重装一个带源码的版本。'
      }
    }
    if (!versionHasSource(target)) {
      return {
        ok: false,
        error: `插件 v${installedVersion} 没有发布源码包，无法创建插件工作区（请让作者发布源码，或安装带源码的版本）。`
      }
    }

    const expectedSourceSha = target.source_sha256?.toLowerCase() || undefined
    logger.info(
      `[Lattice] Local source is missing, downloading it on demand: ${pluginId}@${target.version}`
    )
    const downloaded = await downloadLatticeFile(
      `/v1/hub/plugins/${encodeURIComponent(pluginId)}/versions/${encodeURIComponent(target.version)}/source`,
      expectedSourceSha ? { expectedSha256: expectedSourceSha } : {}
    )
    const actualSha =
      expectedSourceSha ?? createHash('sha256').update(downloaded.bytes).digest('hex')
    const stored = await installSourceBytes({
      pluginId,
      version: target.version,
      bytes: downloaded.bytes,
      sha256: actualSha,
      ...(target.source_asset_name ? { assetName: target.source_asset_name } : {})
    })
    recordLatticeSourceCache(pluginId, {
      path: stored.path,
      version: target.version,
      sha256: actualSha,
      managed: stored.managed
    })
    if (stored.managed === 'pluginsPath') broadcastWorkshopChanged()
    logger.info(`[Lattice] On-demand source ready: ${pluginId}@${target.version} -> ${stored.path}`)
    return { ok: true, path: stored.path, version: target.version }
  } catch (err) {
    const message = latticeErrorMessage(err)
    logger.warn(`[Lattice] Failed to download the missing source on demand: ${message}`)
    return {
      ok: false,
      error: `下载源码失败：${message}。请检查网络/插件中心登录状态后重试，或重新安装该插件。`
    }
  }
}

// ---------- Source path / asset download / republish / local directory import ----------

/** `lattice:source-path`: the currently editable source directory of a plugin (null = no source on this machine) */
export function getLatticePluginSource(pluginId: string): LatticeSourcePathResult {
  const resolved = resolvePluginSource(pluginId)
  if (!resolved) return { path: null }
  return {
    path: resolved.path,
    ...(resolved.version ? { version: resolved.version } : {}),
    managed: resolved.managed
  }
}

/** `lattice:local-source-path`: the locally installed plugin package directory (`userData/plugins/<id>`, used to publish after a local install) */
export function getLatticeLocalSourcePath(pluginId: string): LatticeLocalSourcePathResult {
  const scanned = findExternalPlugin(String(pluginId ?? '').trim())
  if (!scanned) return { path: null }
  return { path: scanned.dir, version: scanned.manifest.version }
}

/** Resolve the source directory on republish: explicit argument → sourcePath → localSourcePath (installed package directory) */
function resolveRepublishRoot(pluginId: string, sourceDir?: string): string {
  const explicit = typeof sourceDir === 'string' ? sourceDir.trim() : ''
  if (explicit) {
    let stat: fs.Stats
    try {
      stat = fs.statSync(explicit)
    } catch {
      throw new Error(`源码目录不存在：${explicit}`)
    }
    if (!stat.isDirectory()) throw new Error(`源码目录不是文件夹：${explicit}`)
    assertNotInstalledPackageRoot(pluginId, explicit)
    return resolvePackageRoot(explicit)
  }
  const resolved: ResolvedPluginSource | null = resolvePluginSource(pluginId)
  if (resolved) {
    /**
     * Source in the userData fallback directory must first be promoted to the plugin storage path: only a draft
     * directory can be built/published. When promotion fails, do not use it for a `draftDir` build (different
     * paths would end in an obscure error).
     */
    const promoted = resolved.inWorkshop
      ? resolved
      : (promoteSourceToWorkshop(pluginId) ?? resolved)
    assertNotInstalledPackageRoot(pluginId, promoted.path)
    return promoted.path
  }
  /**
   * No longer falls back to "the locally installed plugin package directory" (`userData/plugins/<id>`):
   * that is build output, not source. Publishing it as source would re-upload **old code** as a new version
   * and write the new version number into the install package's plugin.json — the page then shows vNew while
   * the old artifacts are still running (user 2026-11-25: "version number does not match after publishing").
   * Refuse honestly when there is no source.
   */
  throw new Error(
    `本机没有 '${pluginId}' 的源码目录，无法发布新版本。请先在插件中心安装带源码的版本，` +
      '或在详情里用「打开源码 / 在对话中修改」自动补下源码后再试。'
  )
}

/** Reject an explicitly passed directory that is an "installed package directory": it is output, publishing it would ship old code as a new version */
function assertNotInstalledPackageRoot(pluginId: string, dir: string): void {
  const installed = installedPackageDirOf(pluginId)
  if (installed && isSamePath(dir, installed)) {
    throw new Error(
      `目录是本机已安装的插件包（构建产物），不是可编辑的源码：${dir}。` +
        '请先在插件工坊/插件中心打开源码（会下载源码包）后再发布新版本。'
    )
  }
}

/**
 * Whether the directory itself is an **already built plugin package**: `plugin.json` declares `entry.main` /
 * `entry.renderer` and both entry files really exist in the directory.
 *
 * Note the difference from a "source directory": a workshop/repository source `plugin.json` usually does **not**
 * declare entry (the build writes entry into the output), so a source directory is not an install package and
 * must not be published.
 */
function isBuiltPackageDir(dir: string): boolean {
  try {
    const raw = fs.readFileSync(path.join(dir, 'plugin.json'), 'utf-8')
    const parsed = JSON.parse(raw.replace(/^\uFEFF/u, '')) as {
      entry?: { main?: unknown; renderer?: unknown }
    }
    const main = typeof parsed?.entry?.main === 'string' ? parsed.entry.main : ''
    const renderer = typeof parsed?.entry?.renderer === 'string' ? parsed.entry.renderer : ''
    return (
      main !== '' &&
      renderer !== '' &&
      fs.existsSync(path.join(dir, main)) &&
      fs.existsSync(path.join(dir, renderer))
    )
  } catch {
    return false
  }
}

/** Read a source directory's plugin.json (a source manifest may have no entry; returns null when unreadable/invalid) */
function readSourceManifest(dir: string): LocalPackageManifest | null {
  try {
    const raw = fs.readFileSync(path.join(dir, 'plugin.json'), 'utf-8')
    const parsed = JSON.parse(raw.replace(/^\uFEFF/u, '')) as unknown
    return asRecord(parsed) ? (parsed as LocalPackageManifest) : null
  } catch {
    return null
  }
}

/**
 * Whether the source directory is a "workshop draft" (= `<id>/` under the configured plugin storage path).
 *
 * The directory is not required to already contain `workshop.json`: source packages downloaded from the plugin
 * hub only have `plugin.json` and should still be buildable/publishable directly (the build writes workshop.json
 * at the end). The old check required workshop.json, so a plugin that was just installed and never edited in chat
 * always reported "not a publishable build output" on "publish new version" — the user had to change a file first.
 */
function isWorkshopSourceRoot(pluginId: string, dir: string): boolean {
  try {
    return isSamePath(dir, draftDir(pluginId))
  } catch {
    // Without a configured plugin storage path draftDir throws: treat it as "not a draft" and let the error below explain where to go
    return false
  }
}

/** Locally installed plugin package directory (`userData/plugins/<id>`) — it is output, not source, and must not be published */
function installedPackageDirOf(pluginId: string): string | null {
  const installed = findExternalPlugin(pluginId)
  return installed ? path.resolve(installed.dir) : null
}

/** Resolve the **install package root** for publishing (a source directory ≠ an install package; this is the most confusing part of this layer) */
async function resolveRepublishPackageRoot(pluginId: string, sourceRoot: string): Promise<string> {
  // Legacy convention: the source directory is itself build output (external plugin repositories used to upload dist as the source directory)
  if (isBuiltPackageDir(sourceRoot)) return sourceRoot

  if (!isWorkshopSourceRoot(pluginId, sourceRoot)) {
    throw new Error(
      `源码目录不是可发布的**构建产物**（plugin.json 缺少 entry，或入口文件不存在）：${sourceRoot}。` +
        '插件中心只接受带 main / renderer 入口的安装包：请先在插件工坊/插件仓库里构建（生成 dist/<id>），再发布新版本。'
    )
  }

  /**
   * Workshop draft: install package = build output `dist/<id>` (the build writes entry into the output manifest),
   * source package = draft directory. When the output is missing or behind the source, **build on the spot** —
   * "publish new version" means "ship the current source"; publishing with stale output would install old code for
   * users (and the version numbers would still match, making it very hard to spot when debugging).
   */
  if (!hasBuild(pluginId) || isBuildStale(pluginId)) {
    logger.info(`[Lattice] Republish needs a fresh build for ${pluginId}, building the draft first`)
    const built = await buildDraft(pluginId)
    if (!built.info.ok) {
      throw new Error(
        `发布前构建失败：${built.info.errors.join('；') || '未知原因'}（可用插件工坊的 plugin_build 查看详细诊断）`
      )
    }
  }
  const dist = distDir(pluginId)
  if (!isBuiltPackageDir(dist)) {
    throw new Error(
      `构建产物不完整（plugin.json 的 entry 或 main.cjs / renderer.mjs 缺失）：${dist}。` +
        '请在插件工坊里重新构建后再发布。'
    )
  }
  return dist
}

/**
 * `lattice:republish`: source directory → install package root (a workshop draft is built first / reuses
 * `dist/<id>`; if it is already build output, use it as is) → **upload the install package zip and the source
 * package zip separately** → POST → PUT.
 *
 * The version is required and must be greater than the platform's current latest version; server 409s are turned
 * into readable errors (a source that cannot be replaced is also a 409).
 */
export async function republishLatticePlugin(
  input: LatticeRepublishInput
): Promise<LatticeRepublishResult> {
  try {
    const pluginId = String(input?.pluginId ?? '').trim()
    if (!PLUGIN_ID_RE.test(pluginId)) throw new Error(`插件 id 不合法：${pluginId || '（空）'}`)
    const version = String(input?.version ?? '').trim()
    if (!VERSION_RE.test(version)) {
      throw new Error(`版本号必填且必须是 semver（例如 1.4.2）：${version || '（空）'}`)
    }
    const sourceRoot = resolveRepublishRoot(pluginId, input?.sourceDir)
    /**
     * The source directory is **not** the install package: a workshop/repository source `plugin.json` has no entry
     * (entry is written into `dist/<id>` only at build time). The old implementation validated the source directory
     * as an install package, so every publish from source failed with "plugin.json's entry is missing main /
     * renderer" (user feedback 2026-11-23). Now the install package comes from the build output and the source
     * directory is only uploaded as the source package.
     */
    const packageRoot = await resolveRepublishPackageRoot(pluginId, sourceRoot)
    const files = collectPackageFiles(packageRoot)
    if (files.length === 0) throw new Error(`安装包目录是空的：${packageRoot}`)
    const { manifest } = readLocalPackageManifest(packageRoot, files)
    if (manifest.id !== pluginId) {
      throw new Error(
        `安装包的 plugin.json.id（${manifest.id}）与要发布的插件 id（${pluginId}）不一致`
      )
    }
    /**
     * Read the source manifest separately and write it back separately: the source directory's manifest may have
     * no entry (it cannot pass the install package validation); after a successful publish only the version number
     * is written back, keeping "local source version = just published version".
     */
    const sourceManifest = readSourceManifest(sourceRoot)
    if (sourceManifest && typeof sourceManifest.id === 'string' && sourceManifest.id !== pluginId) {
      throw new Error(
        `源码目录的 plugin.json.id（${sourceManifest.id}）与要发布的插件 id（${pluginId}）不一致`
      )
    }
    const changelog =
      typeof input.changelog === 'string' && input.changelog.trim() !== ''
        ? input.changelog.trim()
        : undefined
    const published = await publishPackageDir(packageRoot, {
      // Source separate from the install package: when they are the same directory (legacy convention), keep "the same zip serves as the source package"
      ...(isSamePath(packageRoot, sourceRoot)
        ? { includeSource: true }
        : { sourcePath: sourceRoot }),
      versionOverride: version,
      ...(changelog ? { changelogOverride: changelog } : {})
    })
    // Write to disk when the version differs from plugin.json on disk: keep the local source state consistent with the version just published
    const sourceVersion =
      sourceManifest && typeof sourceManifest.version === 'string' ? sourceManifest.version : ''
    if (sourceManifest && sourceVersion !== published.version) {
      try {
        fs.writeFileSync(
          path.join(sourceRoot, 'plugin.json'),
          `${JSON.stringify({ ...sourceManifest, version: published.version }, null, 2)}\n`,
          'utf-8'
        )
        logger.info(
          `[Lattice] Updated source plugin.json version for ${pluginId} to ${published.version}`
        )
      } catch (err) {
        logger.warn(
          '[Lattice] Failed to write back plugin.json version (publish itself succeeded):',
          err
        )
      }
    }
    const sourceSha = published.sourceSha256 ?? published.sha256
    recordPublishedSource(pluginId, published.version, sourceRoot, sourceSha)
    recordLatticeSourceCache(pluginId, {
      path: sourceRoot,
      version: published.version,
      sha256: sourceSha
    })
    logger.info(
      `[Lattice] Republish complete: ${pluginId}@${published.version} ` +
        `(package ${packageRoot}, source ${sourceRoot})`
    )
    return {
      ok: true,
      plugin_id: pluginId,
      version: published.version,
      status: published.status,
      sourcePath: sourceRoot
    }
  } catch (err) {
    const message = latticeErrorMessage(err)
    logger.warn(`[Lattice] Republish failed: ${message}`)
    return { ok: false, error: message }
  }
}

/** Sanitize the download file name (prevents path traversal / invalid characters; the default name uses only the basename) */
function sanitizeDownloadName(name: string): string {
  const base = path.basename(String(name ?? '').replace(/\\/g, '/'))
  // Filter Windows-invalid and control characters one by one (avoid the \x00-\x1f regex: eslint no-control-regex)
  const cleaned = Array.from(base)
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0
      if (code < 32 || code === 127) return false
      return !'<>:"/\\|?*'.includes(char)
    })
    .join('')
    .trim()
  if (cleaned === '') return 'plugin.zip'
  return cleaned.toLowerCase().endsWith('.zip') ? cleaned : `${cleaned}.zip`
}

/** `lattice:download-asset`: install package / source package → save dialog → download (sha256 check) → write to disk */
export async function downloadLatticeAsset(
  pluginIdRaw: unknown,
  versionRaw: unknown,
  kindRaw: unknown
): Promise<LatticeDownloadAssetResult> {
  try {
    const pluginId = typeof pluginIdRaw === 'string' ? pluginIdRaw.trim() : ''
    if (!pluginId) throw new Error('缺少插件 id')
    if (kindRaw !== 'package' && kindRaw !== 'source') {
      throw new Error(`下载类型不合法：${String(kindRaw)}（只支持 package / source）`)
    }
    const kind: LatticeDownloadAssetKind = kindRaw
    const detail = await getLatticeHubDetail(pluginId)
    const requested = typeof versionRaw === 'string' ? versionRaw.trim() : ''
    const target = pickVersion(detail, requested || undefined)
    if (kind === 'source' && !versionHasSource(target)) {
      throw new Error(`插件 '${pluginId}' v${target.version} 没有源码包（source_missing）`)
    }
    const expectedSha =
      kind === 'package' ? target.sha256 || undefined : target.source_sha256 || undefined
    const assetName =
      kind === 'package'
        ? target.asset_name || `${pluginId}-${target.version}.zip`
        : target.source_asset_name || `${pluginId}-${target.version}-src.zip`
    const endpoint = `/v1/hub/plugins/${encodeURIComponent(pluginId)}/versions/${encodeURIComponent(target.version)}/${kind === 'package' ? 'download' : 'source'}`
    logger.info(
      `[Lattice] Downloading ${kind === 'package' ? 'package' : 'source package'}: ${pluginId}@${target.version}`
    )
    const downloaded = await downloadLatticeFile(
      endpoint,
      expectedSha ? { expectedSha256: expectedSha } : {}
    )
    const saved = await dialog.showSaveDialog({
      title: `保存 ${pluginId} v${target.version} ${kind === 'package' ? '安装包' : '源码包'}`,
      defaultPath: path.join(app.getPath('downloads'), sanitizeDownloadName(assetName)),
      filters: [{ name: 'Zip 压缩包 (*.zip)', extensions: ['zip'] }]
    })
    if (saved.canceled || !saved.filePath) return { ok: true, canceled: true, savedPath: '' }
    fs.writeFileSync(saved.filePath, downloaded.bytes)
    logger.info(`[Lattice] Saved to ${saved.filePath} (${downloaded.bytes.length}B)`)
    return { ok: true, savedPath: saved.filePath }
  } catch (err) {
    const message = latticeErrorMessage(err)
    logger.warn(`[Lattice] Failed to download plugin asset: ${message}`)
    return { ok: false, error: message }
  }
}

/**
 * Local directory import: find "plugin directories that contain a plugin.json".
 *
 * Three layouts are supported:
 * 1. the selected directory is itself a plugin directory (plugin.json at the root);
 * 2. a direct child of the selected directory is a plugin directory (`<root>/<id>/plugin.json`, the most common
 *    plugin-repository layout);
 * 3. no direct child is a plugin but one level below is (`<root>/dist/<id>/plugin.json`) — for
 *    "repository root / build output in dist" layouts, so selecting the repository root also works;
 *    `node_modules` / `.git` / hidden directories are never scanned.
 */
function scanLocalPluginDirs(root: string): string[] {
  const looksLikePlugin = (dir: string): boolean => fs.existsSync(path.join(dir, 'plugin.json'))
  if (looksLikePlugin(root)) return [root]

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch (err) {
    throw new Error(`读取目录失败：${latticeErrorMessage(err)}`)
  }
  const candidates: fs.Dirent[] = entries.filter(
    (entry) =>
      entry.isDirectory() && !entry.name.startsWith('.') && !PACKAGE_EXCLUDED_DIRS.has(entry.name)
  )
  // ② Direct children
  const direct = candidates
    .map((entry) => path.join(root, entry.name))
    .filter((dir) => looksLikePlugin(dir))
  if (direct.length > 0) return direct.sort((a, b) => a.localeCompare(b, 'en'))

  // ③ Drill down one more level (repository root → dist/<id> / plugins/<id>)
  const nested: string[] = []
  for (const entry of candidates) {
    const container = path.join(root, entry.name)
    let children: fs.Dirent[]
    try {
      children = fs.readdirSync(container, { withFileTypes: true })
    } catch {
      continue
    }
    for (const child of children) {
      if (!child.isDirectory() || child.name.startsWith('.')) continue
      const dir = path.join(container, child.name)
      if (looksLikePlugin(dir)) nested.push(dir)
    }
  }
  return nested.sort((a, b) => a.localeCompare(b, 'en'))
}

/** `lattice:import-local-dir`: open a directory picker → batch publish the plugins under a local source directory (install package + source) */
export async function importLocalPlugins(
  explicitDir?: string
): Promise<LatticeImportLocalDirResult> {
  const preset = typeof explicitDir === 'string' ? explicitDir.trim() : ''
  if (preset) {
    // Explicit path: for "set as plugin storage path" and automation/tooling (the normal UI passes nothing and uses the system picker)
    return await importLocalPluginsFromDir(preset)
  }
  const picked = await dialog.showOpenDialog({
    title: '选择本地插件源码目录（每个子目录一个插件；也可以直接选单个插件目录）',
    properties: ['openDirectory']
  })
  if (picked.canceled || picked.filePaths.length === 0) {
    return { ok: true, canceled: true, imported: [], skipped: [] }
  }
  return await importLocalPluginsFromDir(picked.filePaths[0])
}

/**
 * Batch import by explicit path (kept for tooling/automation): publish every plugin directory that has a
 * plugin.json, taking the version from plugin.json.version and using the same zip for both the install package
 * and the source package.
 * A single failure is only recorded in skipped (with a readable reason) and does not affect the other plugins.
 */
export async function importLocalPluginsFromDir(
  dirPath: string
): Promise<LatticeImportLocalDirResult> {
  try {
    const root = path.resolve(String(dirPath ?? '').trim())
    let stat: fs.Stats
    try {
      stat = fs.statSync(root)
    } catch {
      throw new Error(`目录不存在：${root}`)
    }
    if (!stat.isDirectory()) throw new Error(`不是文件夹：${root}`)
    const candidates = scanLocalPluginDirs(root)
    if (candidates.length === 0) {
      throw new Error(
        '所选目录下没有找到带 plugin.json 的插件：可以选插件目录本身、含多个插件子目录的仓库根，' +
          '或「构建产物」容器目录（如仓库根/dist，其下每个子目录带 plugin.json）'
      )
    }
    logger.info(`[Lattice] Local directory import: ${root} (found ${candidates.length} plugins)`)
    const imported: LatticeImportLocalItem[] = []
    const skipped: LatticeImportLocalSkipped[] = []
    for (const dir of candidates) {
      try {
        const files = collectPackageFiles(dir)
        if (files.length === 0) throw new Error('插件目录是空的')
        const { manifest } = readLocalPackageManifest(dir, files)
        const version = typeof manifest.version === 'string' ? manifest.version.trim() : ''
        if (!VERSION_RE.test(version)) {
          throw new Error(`plugin.json.version 不合法（需要 semver）：${version || '（空）'}`)
        }
        // Install package and source package are both the whole-directory zip; batch imports emit no progress events (progress is meaningless across several pipelines)
        await publishPackageDir(dir, {
          includeSource: true,
          silent: true,
          changelogOverride: `从本地源码导入 v${version}`
        })
        imported.push({ plugin_id: manifest.id, version })
        logger.info(`[Lattice] Local import published: ${manifest.id}@${version} (${dir})`)
      } catch (err) {
        const reason = latticeErrorMessage(err)
        skipped.push({ dir, reason })
        logger.warn(`[Lattice] Local import skipped: ${dir} (${reason})`)
      }
    }
    notifyStateChanged()
    return { ok: true, imported, skipped, root }
  } catch (err) {
    const message = latticeErrorMessage(err)
    logger.warn(`[Lattice] Local directory import failed: ${message}`)
    return { ok: false, error: message }
  }
}
