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
import { loadExternalMain } from '../plugins/host'
import {
  extractZipToTemp,
  installPackageDir,
  resolvePackageRoot,
  type InstalledPackageInfo
} from '../plugins/package-install'
import { findExternalPlugin } from '../plugins/scanner'
import {
  LatticeApiError,
  downloadLatticeFile,
  latticeErrorMessage,
  latticeRequest,
  uploadLatticeBytes
} from './client'
import { getLatticeDeviceId } from './session'
import {
  installSourceBytes,
  recordPublishedSource,
  resolvePluginSource,
  type ResolvedPluginSource
} from './sources'
import { recordLatticeSourceCache } from './sync'
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
 * 插件中心（`/v1/hub`）主进程业务：目录 / 详情 / 发布上传 / 下载安装。
 *
 * 上传链路（契约 §4）：
 *   选目录 → `resolvePackageRoot()` → 读 plugin.json + README.md → JSZip 打包（plugin.json 在根）
 *   → sha256 → `POST /v1/hub/plugins` 元数据 → `PUT {upload.path}` 原始字节（`X-Content-SHA256`）
 * 每个阶段向渲染层发 `lattice:upload-progress`。
 *
 * 下载安装链路：
 *   详情选版本 → `GET .../download`（302 → 预签名）→ sha256 校验 → 解压临时目录
 *   → `installPackageDir({expectId})` → 启用 + 装载主模块 + 广播 → `PUT /v1/hub/installs/{id}`。
 * 失败一律返回 `{ok:false,error}`，不把异常抛到渲染层。
 *
 * 源码生命周期（契约 v2 §2，见 `./sources.ts`）：
 * - 安装时该版本带源码（`has_source`）→ 下载 `.../source`（302 → 预签名）→ 解压到
 *   `<pluginsPath>/<id>/`（未配置时回退 `userData/plugin-sources/<id>/<version>/`）→ source.json；
 *   源码失败**不判安装失败**，只在结果里带 `sourceError`；
 * - `republish`：源码目录 → 校验 plugin.json → 整包 zip（安装包）→ 同一份字节当源码包
 *   → POST（带 source 元数据）→ PUT 安装包 → PUT source；
 * - `downloadAsset`：安装包/源码包弹保存框下载到本机（sha256 校验）；
 * - `importLocalPlugins`：弹目录选择框，把本地源码目录下带 plugin.json 的插件逐个发布到平台。
 */

/** 平台取值（设计 §17.16）：包 ≤20MiB、readme ≤16KiB、manifest ≤16KiB */
const PACKAGE_MAX_BYTES = 20 * 1024 * 1024
const README_MAX_BYTES = 16 * 1024
const MANIFEST_MAX_BYTES = 16 * 1024
const NAME_MAX_CHARS = 64
const DESCRIPTION_MAX_CHARS = 500
const CHANGELOG_MAX_CHARS = 2000
const ICON_MAX_CHARS = 512
const CATEGORY_VALUES = new Set(['productivity', 'ai', 'media', 'devtools', 'data', 'other'])
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]{1,32})?$/
/** 压缩工具产出的噪音条目（与 package-install.ts 同口径，不上传） */
const NOISE_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '__MACOSX'])
/**
 * 打包时整目录跳过的目录：版本库与依赖目录不属于插件包内容，
 * 打进去只会撑爆 20MiB 上限（v2 的「源码目录整包 zip」尤其容易撞上用户自己的工程目录）。
 */
const PACKAGE_EXCLUDED_DIRS = new Set(['.git', 'node_modules'])
/** 插件包根目录里不属于包内容的宿主元数据文件（workshop 草稿 / 源码下载标记） */
const PACKAGE_ROOT_META_FILES = new Set(['source.json', 'workshop.json'])

interface LatticeHubHooks {
  onUploadProgress?: (progress: LatticeUploadProgress) => void
  /** 发布/安装后状态变化（index.ts 接成广播 `lattice:state-changed`） */
  onStateChanged?: () => void
}

let hooks: LatticeHubHooks = {}

/** 由 `lattice/index.ts` 在启动时接线（避免 hub → index 的循环依赖） */
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

// ---------- 通用小工具 ----------

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

/** 按「字符」截断（平台上限按字符数校验；Array.from 不切坏代理对） */
function clampChars(value: string, maxChars: number): string {
  const chars = Array.from(value)
  return chars.length <= maxChars ? value : chars.slice(0, maxChars).join('')
}

/** 按 UTF-8 字节截断（readme 上限按字节；丢掉可能在边界被截断的半个字符） */
function clampUtf8Bytes(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, 'utf8')
  if (buffer.length <= maxBytes) return value
  return buffer
    .subarray(0, maxBytes)
    .toString('utf8')
    .replace(/\uFFFD+$/u, '')
}

// ---------- 目录 / 详情 ----------

function mapOwner(raw: unknown): HubEntry['owner'] {
  const record = asRecord(raw) ?? {}
  return {
    id: readString(record.id),
    username: readString(record.username),
    display_name: readOptionalString(record.display_name) ?? null
  }
}

/** 平台目录条目 → 共享 HubEntry（字段缺失一律兜底，坏数据不该把面板搞崩） */
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

/** 该版本是否带源码包（v2 详情有 has_source；旧平台的 source_sha256 也视为有） */
function versionHasSource(version: HubVersion): boolean {
  return version.has_source === true || Boolean(version.source_sha256)
}

/** 目录：`GET /v1/hub/plugins`（渲染层驼峰参数 → 平台下划线） */
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

/** 详情：`GET /v1/hub/plugins/{plugin_id}` */
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

// ---------- 上传 ----------

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
  builtin?: boolean
  [key: string]: unknown
}

interface CollectedPackageFile {
  abs: string
  rel: string
  size: number
}

/**
 * 清单里的品牌图标：优先 `icon`（外部插件可以是 plugin:// 或 data:），
 * 没写 `icon` 时退回 `menu.icon`（内置插件与旧版插件只有这一处写图标）。
 *
 * 平台 `hub_plugins.icon` 只有一个字段，卡片/详情都读它；只取 `manifest.icon`
 * 会让所有"只有 menu.icon"的插件在插件仓库里变成默认拼图（用户 2026-11-21 反馈）。
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

/** 读并校验包内 plugin.json（必须字段 + 入口文件真实存在 + 不是内置插件） */
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
    // 少数构建脚本会带 UTF-8 BOM：JSON.parse 不认 BOM，先剥掉再解析
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
  if (manifest.builtin === true) {
    throw new Error(
      `'${manifest.id}' 是随应用分发的内置插件（builtin=true），不能发布到插件中心：` +
        '其他用户在插件中心装不了内置 id 的包'
    )
  }
  return { manifest, rawText }
}

/** 读 README.md（≤16KiB，超出按字节截断） */
function readReadme(root: string): string {
  for (const name of ['README.md', 'readme.md', 'Readme.md']) {
    const file = path.join(root, name)
    try {
      if (!fs.statSync(file).isFile()) continue
      return clampUtf8Bytes(fs.readFileSync(file, 'utf-8'), README_MAX_BYTES)
    } catch {
      // 没有这个文件名就试下一个
    }
  }
  return ''
}

/** 发布用的 manifest 快照（≤16KiB；超了就只发最小字段） */
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

/** zip 打包选项（重新发布时把包内 plugin.json 的 version 换成用户填的新版本号） */
interface ZipDirOptions {
  overrides?: Map<string, Buffer>
  /** 不向渲染层发进度（批量导入多条流水线时进度没有意义） */
  silent?: boolean
}

/** 目录 → zip 原始字节（相对路径平铺，plugin.json 在根；按百分比发 zip 阶段进度） */
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
  /** v2：源码包上传地址（POST 里带 `source` 元数据时平台才给） */
  source_upload?: { path?: unknown; headers?: unknown; max_bytes?: unknown } | null
  idempotent_reused?: unknown
}

interface ApiUploadResponse {
  status?: unknown
  download_path?: unknown
}

/** 发布目录的选项（v2：重新发布/本地导入都会把同一份 zip 作为源码包一起上传） */
interface PublishPackageOptions {
  /** 同时把同一个 zip 作为源码包上传（契约 v2：安装包 = 源码目录整包 zip，源码包 = 同一份字节） */
  includeSource?: boolean
  /** 覆盖 plugin.json 里的版本号（重新发布时用户填的新版本号；包内清单同步改写） */
  versionOverride?: string
  /** 覆盖更新说明（未给时沿用 plugin.json.changelog / `发布 v<version>`） */
  changelogOverride?: string
  /** 不向渲染层发进度（批量导入多条流水线时进度没有意义） */
  silent?: boolean
}

interface PublishPackageResult {
  plugin_id: string
  version: string
  /** 本次包体（= 源码包）的 sha256 */
  sha256: string
  /** 平台是否接受了源码包（返回 source_upload 且 PUT 成功） */
  sourceUploaded: boolean
  /** 幂等复用：同版本同 sha 已发布过，没有上传任何字节 */
  reused: boolean
}

/** 把发布阶段的平台错误转成给用户看的话（尤其是 409：版本必须递增 / 源码不可替换） */
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

/** 把包目录发布到插件中心：元数据 → 安装包体 →（可选）源码包体 */
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

  // 版本覆盖（重新发布）：包内 plugin.json 的 version 必须与发布版本一致，否则平台清单对不上
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
  if (options.includeSource) {
    // v2：源码包与安装包是**同一份字节**（安装包 = 源码目录整包 zip）
    meta.source = {
      asset_name: `${pluginId}-${version}-src.zip`,
      size: buffer.length,
      sha256
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
      `${options.includeSource ? ', with source package' : ''})`
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
  if (!uploadPath) {
    // 幂等重试命中：同版本同 sha 已经在平台发布过，不需要再传包体
    logger.info(`[Lattice] ${pluginId}@${version} already exists with identical content (idempotent reuse), skipping package upload`)
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
        // 上传响应不是 JSON 也不影响 2xx 已成功的事实
      }
      if (typeof uploadResult?.status === 'string' && uploadResult.status !== 'published') {
        throw new Error(`插件包上传后状态异常：${uploadResult.status}（期望 published）`)
      }
    } catch (err) {
      throw publishPhaseError(err, 'package', pluginId, version)
    }
  }

  if (options.includeSource) {
    const sourceUploadPath =
      typeof publish.source_upload?.path === 'string' ? publish.source_upload.path : ''
    if (sourceUploadPath) {
      const sourceHeaders = normalizeHeaders(publish.source_upload?.headers)
      if (!sourceHeaders['Content-Type']) sourceHeaders['Content-Type'] = 'application/zip'
      if (!sourceHeaders['X-Content-SHA256']) sourceHeaders['X-Content-SHA256'] = sha256
      emit({ phase: 'upload', sent: 0, total: buffer.length })
      try {
        await uploadLatticeBytes(sourceUploadPath, buffer, sourceHeaders, (sent, total) => {
          emit({ phase: 'upload', sent, total })
        })
        sourceUploaded = true
      } catch (err) {
        throw publishPhaseError(err, 'source', pluginId, version)
      }
    } else {
      // 平台没给源码上传地址（旧平台 / 幂等复用）：源码状态未知，如实记录，但安装包已发布成功
      logger.warn(
        `[Lattice] Platform returned no source upload URL (source_upload): ${pluginId}@${version} may have no source package`
      )
    }
  }

  logger.info(
    `[Lattice] Published ${pluginId}@${version} (${(buffer.length / 1024).toFixed(1)}KiB` +
      `${options.includeSource ? ', with source package' : ''})`
  )
  notifyStateChanged()
  return { plugin_id: pluginId, version, sha256, sourceUploaded, reused }
}

/** 上传插件包（v2 起安装包与源码包一起上传）并归一成 IPC 结果形状 */
async function uploadPackageDirAsLatticeResult(root: string): Promise<LatticeUploadResult> {
  // v2：用户口径「需要版本管理、源代码管理、安装包」——从本机上传的插件同样必须带源码，
  // 否则别的机器装上以后无法查看/修改源码（安装包只是 bundle）。
  const result = await publishPackageDir(root, { includeSource: true })
  return { ok: true, plugin_id: result.plugin_id, version: result.version }
}

/** 上传来源解析：目录 / .zip（压缩包先解到临时目录） */
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

/** 按显式路径上传（目录或 zip） */
export async function uploadLatticePackage(source: string): Promise<LatticeUploadResult> {
  const trimmed = String(source ?? '').trim()
  if (!trimmed) return { ok: false, error: '缺少插件包路径' }
  try {
    const resolved = await resolveUploadRoot(trimmed)
    try {
      return await uploadPackageDirAsLatticeResult(resolved.root)
    } finally {
      resolved.cleanup?.()
    }
  } catch (err) {
    const message = latticeErrorMessage(err)
    logger.warn(`[Lattice] Failed to upload plugin package (${trimmed}): ${message}`)
    return { ok: false, error: message }
  }
}

/** 弹目录选择框并上传（用户取消返回 `{ok:true,canceled:true}`，不是失败） */
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

/** 弹 .zip 安装包选择框并上传（走同一套解压/清单/发布流水线） */
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

// ---------- 下载安装 ----------

/** 选版本：显式 version 优先，否则 latest_version，再退回版本清单第一条（平台已按时间倒序） */
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

/** 从插件中心下载并安装（或升级）一个插件；失败返回 `{ok:false,error}` */
export async function installLatticePlugin(
  pluginId: string,
  version?: string
): Promise<LatticeInstallResult> {
  const id = String(pluginId ?? '').trim()
  if (!id) return { ok: false, error: '缺少插件 id' }
  try {
    const detail = await getLatticeHubDetail(id)
    const target = pickVersion(detail, version)
    logger.info(
      `[Lattice] Downloading ${detail.plugin_id}@${target.version} (sha256=${target.sha256.slice(0, 12)}...)`
    )

    const downloaded = await downloadLatticeFile(
      `/v1/hub/plugins/${encodeURIComponent(detail.plugin_id)}/versions/${encodeURIComponent(target.version)}/download`,
      { expectedSha256: target.sha256 }
    )

    // 落地：临时 zip → 解压 → 安装内核（校验 id/入口/是否撞内置 id 都由它兜底）
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

    // 用户是主动点「安装」的：装完即启用并装载主模块（与既有安装流程同口径）
    setEnabledOverride(info.id, true)
    let loadError: string | null = null
    try {
      loadExternalMain(info.id)
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

    // 安装记录（带版本/启用态/设备）：失败只告警——本地已经装好，不该因此把这次安装判失败
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
      logger.warn(`[Lattice] Failed to write install record (already installed locally): ${latticeErrorMessage(err)}`)
    }

    // v2：该版本带源码就自动下载并解压到本机源码目录（失败不判安装失败，见契约 §2）
    let sourcePath: string | undefined
    let sourceVersion: string | undefined
    let sourceManaged: LatticeSourceManaged | undefined
    let sourceError: string | undefined
    let sourceBackupPath: string | undefined
    if (versionHasSource(target)) {
      const installedId = detail.plugin_id
      const expectedSourceSha = target.source_sha256?.toLowerCase() || undefined
      try {
        // 已经下过同一版本且内容一致 → 复用，不重复下载
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
          logger.info(`[Lattice] ${installedId}@${target.version} source is already local, skipping duplicate download`)
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
          // 源码进了用户插件存放路径 = 插件模式侧栏多了一份草稿，让渲染层立刻刷新
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
    logger.info(`[Lattice] Install complete: ${info.id}@${info.version}${info.upgraded ? ' (upgrade)' : ''}`)
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
    // 平台已删除该插件时把 404 转成用户能懂的原因（自动补齐失败要展示可读文本）
    if (err instanceof LatticeApiError && err.status === 404) {
      message = `插件 '${id}' 在插件中心不存在（可能已被作者删除）：${message}`
    }
    logger.warn(`[Lattice] Failed to install '${id}' from plugin hub: ${message}`)
    return { ok: false, error: message }
  }
}

// ---------- 源码路径 / 资产下载 / 重新发布 / 本地目录导入（契约 v2 §2） ----------

/** `lattice:source-path`：某插件当前可编辑的源码目录（null = 本机没有源码） */
export function getLatticePluginSource(pluginId: string): LatticeSourcePathResult {
  const resolved = resolvePluginSource(pluginId)
  if (!resolved) return { path: null }
  return {
    path: resolved.path,
    ...(resolved.version ? { version: resolved.version } : {}),
    managed: resolved.managed
  }
}

/** `lattice:local-source-path`：本机已安装插件包目录（`userData/plugins/<id>`，本地安装后发布用） */
export function getLatticeLocalSourcePath(pluginId: string): LatticeLocalSourcePathResult {
  const scanned = findExternalPlugin(String(pluginId ?? '').trim())
  if (!scanned) return { path: null }
  return { path: scanned.dir, version: scanned.manifest.version }
}

/** 重新发布时解析源码目录：显式参数 → sourcePath → localSourcePath（已安装包目录） */
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
    return resolvePackageRoot(explicit)
  }
  const resolved: ResolvedPluginSource | null = resolvePluginSource(pluginId)
  if (resolved) return resolved.path
  const local = getLatticeLocalSourcePath(pluginId)
  if (local.path) return local.path
  throw new Error(
    `本机没有 '${pluginId}' 的源码目录：请先从插件中心安装（会自动下载源码），或在详情里用「打开源码」后再发布`
  )
}

/**
 * `lattice:republish`：源码目录 → 校验 plugin.json（id/版本/入口）→ 整包 zip 同时作为安装包与源码包
 * → POST（带 source 元数据）→ PUT 安装包 → PUT 源码。
 *
 * 版本号必填且必须大于平台当前最新版本；服务端 409 会转成可读错误（源码不可替换同样是 409）。
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
    const root = resolveRepublishRoot(pluginId, input?.sourceDir)
    const files = collectPackageFiles(root)
    if (files.length === 0) throw new Error(`源码目录是空的：${root}`)
    const { manifest } = readLocalPackageManifest(root, files)
    if (manifest.id !== pluginId) {
      throw new Error(
        `源码目录的 plugin.json.id（${manifest.id}）与要发布的插件 id（${pluginId}）不一致`
      )
    }
    const changelog =
      typeof input.changelog === 'string' && input.changelog.trim() !== ''
        ? input.changelog.trim()
        : undefined
    const published = await publishPackageDir(root, {
      includeSource: true,
      versionOverride: version,
      ...(changelog ? { changelogOverride: changelog } : {})
    })
    // 版本号与磁盘 plugin.json 不一致时落盘：本地源码状态与刚发布的版本保持一致
    if (manifest.version !== published.version) {
      try {
        fs.writeFileSync(
          path.join(root, 'plugin.json'),
          `${JSON.stringify({ ...manifest, version: published.version }, null, 2)}\n`,
          'utf-8'
        )
        logger.info(`[Lattice] Updated plugin.json version for ${pluginId} to ${published.version}`)
      } catch (err) {
        logger.warn('[Lattice] Failed to write back plugin.json version (publish itself succeeded):', err)
      }
    }
    recordPublishedSource(pluginId, published.version, root, published.sha256)
    recordLatticeSourceCache(pluginId, {
      path: root,
      version: published.version,
      sha256: published.sha256
    })
    logger.info(`[Lattice] Republish complete: ${pluginId}@${published.version} (source ${root})`)
    return { ok: true, plugin_id: pluginId, version: published.version, sourcePath: root }
  } catch (err) {
    const message = latticeErrorMessage(err)
    logger.warn(`[Lattice] Republish failed: ${message}`)
    return { ok: false, error: message }
  }
}

/** 下载文件名安全化（防路径穿越/非法字符；默认名只取 basename） */
function sanitizeDownloadName(name: string): string {
  const base = path.basename(String(name ?? '').replace(/\\/g, '/'))
  // 逐字符过滤 Windows 非法字符与控制字符（不用正则里的 \x00-\x1f：eslint no-control-regex）
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

/** `lattice:download-asset`：安装包 / 源码包 → 弹保存框 → 下载（sha256 校验）→ 落盘 */
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
 * 本地目录导入：找出「带 plugin.json 的插件目录」。
 *
 * 支持三种选法：
 * 1. 所选目录本身就是插件目录（根有 plugin.json）；
 * 2. 所选目录的直接子目录是插件目录（`<root>/<id>/plugin.json`，最常见的插件仓库布局）；
 * 3. 直接子目录都不是插件、但它下面**一层**是（`<root>/dist/<id>/plugin.json`）——
 *    「仓库根 / 构建产物在 dist」这类布局，用户按仓库根选也能导入；
 *    `node_modules` / `.git` / 隐藏目录一律不扫。
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
  // ② 直接子目录
  const direct = candidates
    .map((entry) => path.join(root, entry.name))
    .filter((dir) => looksLikePlugin(dir))
  if (direct.length > 0) return direct.sort((a, b) => a.localeCompare(b, 'en'))

  // ③ 再下钻一层（仓库根 → dist/<id> / plugins/<id>）
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

/** `lattice:import-local-dir`：弹目录选择框 → 批量发布本地源码目录下的插件（安装包 + 源码） */
export async function importLocalPlugins(explicitDir?: string): Promise<LatticeImportLocalDirResult> {
  const preset = typeof explicitDir === 'string' ? explicitDir.trim() : ''
  if (preset) {
    // 显式路径：给「设为插件存放路径」与自动化/工装用（正常 UI 不传，走系统选择框）
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
 * 按显式路径批量导入（为工装/自动化保留）：发布每个带 plugin.json 的插件目录，
 * 版本取 plugin.json.version，安装包与源码包用同一份 zip。
 * 单个失败只记 skipped（reason 可读），不影响其余插件。
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
        // 安装包与源码包都是这个目录的整包 zip；批量导入不发进度事件（多条流水线进度没有意义）
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
