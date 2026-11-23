import { app } from 'electron'
import { createHash } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import logger from 'electron-log'
import { extractZipToTemp } from '../plugins/package-install'
import { assertDraftId, draftDir, hasPluginsRoot } from '../workshop/paths'
import type { LatticeSourceManaged } from './types'

/**
 * 插件**源码**在本机的生命周期（契约 v2 §2）：
 *
 * - 下载的源码目录优先级（用户 2026-11-21 追加口径）：
 *   1. 用户配置的「插件存放路径」`<pluginsPath>/<插件 id>/`（= workshop 草稿目录）——
 *      插件模式侧栏能看到它、能开「插件」会话让模型改代码；
 *   2. 未配置 pluginsPath（或该目录已被用户自己的同名源码占用）时回退
 *      `userData/plugin-sources/<插件 id>/<版本>/`。
 * - 每个源码目录根写 `source.json`（plugin_id/version/sha256/downloaded_at/layout/dir_sha256），
 *   它是「这份源码是应用下载并托管的」的标记，也用于判断之后是否被用户改过；
 * - `userData/lattice-sources.json` 是**快速索引**（插件 id → 当前源码目录/版本/sha），
 *   索引丢失/损坏时按目录里的 source.json 重新扫回来；
 * - 换入新源码前：同插件旧版本目录清掉（只保留当前）；目标目录里已有用户改过的内容时，
 *   先整份备份到 `userData/plugin-source-backups/<id>/<时间戳>/` 再替换（可恢复，不静默丢改动）。
 *
 * 安全边界：
 * - 解压复用 `extractZipToTemp()`（拒绝绝对路径 / `..` 穿越 / 空包，剥「压缩整个文件夹」的顶层目录）；
 * - 插件 id / 版本号都只允许安全字符，禁止拼出 `../`；
 * - 所有删除动作都只针对本模块算出来的绝对路径（userData 下的源码根 / 插件存放路径下的单个插件目录）。
 */

/** 应用数据目录下的源码根（未配置 pluginsPath 时的回退位置） */
const SOURCE_ROOT_DIR = 'plugin-sources'
/** 替换前备份根（不在源码根里，避免被当成「旧版本目录」清掉） */
const BACKUP_ROOT_DIR = 'plugin-source-backups'
/** 插件 id → 当前源码目录的索引文件 */
const REGISTRY_FILE = 'lattice-sources.json'
/** 每个源码目录根里的元数据文件名 */
const SOURCE_META_FILE = 'source.json'
/** source.json 的归属标记（没有这个标记的目录不认为是应用托管的） */
const SOURCE_META_MARKER = 'ryten-bench-lattice'
/** source.json 结构版本（当前只是透传记录，不做迁移） */
const SOURCE_META_VERSION = 1

/** 压缩工具/版本库产生的噪音条目（与 package-install.ts 同口径；.git 不算源码内容） */
const NOISE_NAMES: ReadonlySet<string> = new Set([
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  '__MACOSX',
  '.git'
])

/** 插件 id 安全规则（与平台一致；同时保证能作为目录名） */
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/
/** 版本号作为目录名的安全规则（semver 及其预发布/构建标记，不允许路径分隔符） */
const VERSION_SAFE_RE = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/

/** 源码目录里的元数据（契约 §2 要求 plugin_id/version/sha256/downloaded_at） */
export interface PluginSourceMeta {
  plugin_id: string
  version: string
  /** 平台源码 zip 的 sha256（小写 hex） */
  sha256: string
  /** 下载时间（ISO 字符串） */
  downloaded_at: string
  /** 归属标记；不是这个值的 source.json 视为用户自己的文件 */
  managed_by: string
  /** 落地位置（pluginsPath / userData） */
  layout: LatticeSourceManaged
  /** 平台源码包的 asset_name（有就记下来，下载/排障用） */
  source_asset_name?: string
  /**
   * 解压完成那一刻的目录内容指纹。
   * 之后重新下载/更新时对比它判断「用户改过没有」：改过就先备份再替换。
   */
  dir_sha256?: string
  meta_version?: number
}

/** 解析出来的「某插件当前源码」 */
export interface ResolvedPluginSource {
  path: string
  version?: string
  managed: LatticeSourceManaged
  /** true = 该目录就是 workshop 草稿目录（插件模式侧栏可见、可开插件会话） */
  inWorkshop: boolean
  /** 平台源码 zip 的 sha256（有元数据时） */
  sha256?: string
}

/** `installSourceBytes` 入参 */
export interface InstallSourceOptions {
  pluginId: string
  version: string
  /** 平台源码 zip 的原始字节 */
  bytes: Buffer
  /** 实际下载字节的 sha256（小写 hex；调用方已校验过） */
  sha256: string
  /** 平台源码包 asset_name（可选） */
  assetName?: string
}

/** `installSourceBytes` 返回值 */
export interface InstalledPluginSource {
  path: string
  version: string
  managed: LatticeSourceManaged
  sha256: string
  /** 覆盖前备份到的目录（没触发备份则没有） */
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

// ---------- 基础工具 ----------

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

/** 插件 id 校验（非法直接抛可读错误） */
export function assertSourcePluginId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!id) throw new Error('缺少插件 id')
  if (!PLUGIN_ID_RE.test(id))
    throw new Error(`插件 id 不合法（平台要求小写字母/数字/./_/-）：${id}`)
  return id
}

/** 版本号校验（作为目录名用；合法但非 semver 的由平台在发布时再校验） */
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

/** 迁移目录（跨盘时 rename 会 EXDEV，退回拷贝 + 删除） */
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

/**
 * 目录内容指纹：排序后的（相对路径 + 内容）拼起来算 sha256（逐文件读，50MiB 上限可接受）。
 *
 * 跳过 `source.json`：它记录的是「解压那一刻」的指纹，之后会被重写（新下载/发布成功），
 * 把它算进去会让指纹永远对不上、每次更新都误判成「用户改过」而多备份一份。
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

/** 读目录里的 plugin.json（拿版本/名称；缺失或坏 JSON 返回 null） */
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

/** 目录里是否有源码内容（有 source.json / plugin.json / workshop.json 任一即算） */
function dirHasSourceContent(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, SOURCE_META_FILE)) ||
    fs.existsSync(path.join(dir, 'plugin.json')) ||
    fs.existsSync(path.join(dir, 'workshop.json'))
  )
}

// ---------- 位置约定 ----------

/** 应用数据目录下的源码根（`userData/plugin-sources`） */
export function pluginSourcesRoot(): string {
  const root = path.join(app.getPath('userData'), SOURCE_ROOT_DIR)
  fs.mkdirSync(root, { recursive: true })
  return root
}

/**
 * 该插件在「插件存放路径」里的目录（`<pluginsPath>/<id>`），不可用返回 null。
 *
 * 不可用的两种情况：用户还没配置 pluginsPath；插件 id 不满足 workshop 的目录名规则
 * （平台允许点号/下划线，workshop 只允许小写 kebab——这类插件只能落在 userData）。
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

/** 读目录里的 source.json（不存在/损坏/缺字段返回 null） */
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

/** 这个源码目录是本应用下载并托管的吗（有归属标记且 plugin_id 匹配） */
function isManagedSourceDir(dir: string, pluginId: string): boolean {
  const meta = readSourceMeta(dir)
  return meta !== null && meta.managed_by === SOURCE_META_MARKER && meta.plugin_id === pluginId
}

/**
 * 这个目录能不能被应用当成「插件源码/草稿」使用。
 *
 * 判据与 `resolvePluginSource` 的草稿分支一致：有 `source.json`（应用托管）、
 * 有 `plugin.json`（插件包/草稿）、或有 `workshop.json`（工坊草稿）。
 *
 * 为什么需要它：用户删源码时经常只删掉文件（甚至删一半），目录里只剩空文件夹或
 * 零散文件——这样的目录既不是可用草稿，又会被「不是本应用托管的，别覆盖」的保护挡住，
 * 导致重装后的源码被放到 userData、`在对话中修改` 永远走「打开文件夹」回退
 * （用户 2026-11-23：「卸载并删除源码后重装，在对话中修改会失败，重启才好」）。
 */
function isUsableDraftDir(dir: string): boolean {
  return (
    readSourceMeta(dir) !== null ||
    readManifestInfo(dir) !== null ||
    fs.existsSync(path.join(dir, 'workshop.json'))
  )
}

// ---------- 索引文件（userData/lattice-sources.json） ----------

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

// ---------- 目标位置 / 备份 / 清理 ----------

interface SourceTargetPlan {
  target: string
  managed: LatticeSourceManaged
  existing: boolean
  existingMeta: PluginSourceMeta | null
}

/**
 * 决定这次源码落哪：优先 `<pluginsPath>/<id>/`，否则 `<userData>/plugin-sources/<id>/<version>/`。
 *
 * 若 `<pluginsPath>/<id>/` 已存在且**不是**应用托管的源码目录（用户自己的草稿/别的工具建的），
 * 不覆盖它（那是用户的工作，可能没提交）——本次源码改存 userData，并告警。
 */
function planSourceTarget(pluginId: string, version: string): SourceTargetPlan {
  const draft = workshopDraftDirFor(pluginId)
  if (draft) {
    if (!dirExists(draft)) {
      return { target: draft, managed: 'pluginsPath', existing: false, existingMeta: null }
    }
    /**
     * 只保护「能被应用认出来的草稿」（plugin.json / workshop.json / source.json）。
     * 只剩空文件夹/半删文件的残留目录不是可用草稿，直接当本次安装的落点：
     * `installSourceBytes` 会先备份再替换，既不会丢用户数据，也不会把源码挤到
     * userData 导致后续「在对话中修改」失败。
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

/** 把旧源码目录整份备份到 `userData/plugin-source-backups/<id>/<时间戳>/`（返回备份路径） */
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
 * 清掉同插件 userData 源码根下的旧版本目录。
 *
 * @param keepDirName 保留的版本目录名；null = 全部清掉（源码已迁到 pluginsPath 时用）
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
      // 不空/不存在都无所谓
    }
  }
}

/** 清掉之前安装中断留下的 staging 目录（只清本插件前缀的隐藏目录） */
function cleanupStaleStaging(parent: string, pluginId: string): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true })
  } catch {
    return
  }
  const prefix = `.lattice-source-stage-${pluginId}-`
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue
    try {
      fs.rmSync(path.join(parent, entry.name), { recursive: true, force: true })
    } catch {
      // 清不掉就留着，不影响本次
    }
  }
}

/**
 * 源码包根目录没有 plugin.json 时，用**已安装包**的清单补一份。
 *
 * 为什么：插件模式的侧栏只列 `<pluginsPath>` 下「有 plugin.json 或 workshop.json」的目录
 * （见 workshop/store.listDraftIds）。契约允许源码包是工程目录（不强制带 plugin.json），
 * 不补的话这份源码在插件模式里根本看不见，用户也就没法「在对话中修改」。
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

// ---------- 安装（下载后的字节 → 本机源码目录） ----------

/**
 * 把平台源码 zip 解压到本机源码目录（契约 §2）。
 *
 * 流程：解压（拒绝路径穿越/剥顶层目录）→ 拷到目标同盘 staging → 补 plugin.json →
 * 算目录指纹 + 写 source.json → （必要时备份旧目录）→ 换入 → 清理旧版本/更新索引。
 *
 * 失败会抛可读错误（调用方把它记成安装结果的 `sourceError`，不影响插件安装本身）。
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
  const zipPath = path.join(workDir, `${pluginId}-${version}-src.zip`)
  let extracted: string | null = null
  let staging: string | null = null
  try {
    fs.writeFileSync(zipPath, options.bytes)
    extracted = await extractZipToTemp(zipPath)

    const parent = path.dirname(plan.target)
    fs.mkdirSync(parent, { recursive: true })
    cleanupStaleStaging(parent, pluginId)
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
      fs.rmSync(plan.target, { recursive: true, force: true })
    }
    moveDir(staging, plan.target)
    staging = null

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
    if (staging) {
      try {
        fs.rmSync(staging, { recursive: true, force: true })
      } catch {
        // staging 是隐藏临时目录，清不掉也不影响
      }
    }
    if (extracted) {
      try {
        fs.rmSync(extracted, { recursive: true, force: true })
      } catch {
        // 临时目录清不掉无所谓
      }
    }
    try {
      fs.rmSync(workDir, { recursive: true, force: true })
    } catch {
      // 同上
    }
  }
}

// ---------- 查询 / 迁移 / 记录 ----------

/** 扫 `userData/plugin-sources/<id>/<version>/`，按 downloaded_at 取最新一份 */
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
 * 某插件当前可用的源码目录（找不到返回 null）。
 *
 * 优先级：workshop 草稿目录（`<pluginsPath>/<id>`，用户可编辑面）→ 索引 → 扫 userData 版本目录。
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
 * 把 userData 回退目录里的源码**迁移**到用户配置的插件存放路径（`<pluginsPath>/<id>/`）。
 *
 * 触发时机：用户在安装之后才配置 pluginsPath，再点「在对话中修改」。只有迁移过去，
 * 它才是 workshop 草稿、才能在插件模式里开对话。
 *
 * 返回迁移后/当前可用的源码（迁移失败返回原目录，不阻塞「打开文件夹」回退）。
 */
export function promoteSourceToWorkshop(rawPluginId: unknown): ResolvedPluginSource | null {
  const pluginId = typeof rawPluginId === 'string' ? rawPluginId.trim() : ''
  if (!pluginId) return null
  const draft = workshopDraftDirFor(pluginId)
  if (!draft) return null
  if (dirExists(draft)) {
    // 可用草稿（用户自己的源码 / 已托管源码）：不动它，直接用现有源码
    if (isUsableDraftDir(draft)) return resolvePluginSource(pluginId)
    /**
     * 不可用的残留目录（用户删源码后只剩空文件夹/零散文件）：它会让下面的迁移
     * 直接放弃，于是「在对话中修改」永远只打开文件夹（用户 2026-11-23 的现场）。
     * 备份后清掉，把 userData 里的源码迁回插件存放路径；清不掉就退回现有源码。
     */
    try {
      const backup = isDirEmpty(draft) ? null : backupExistingSource(pluginId, draft)
      fs.rmSync(draft, { recursive: true, force: true })
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
    moveDir(current.path, draft)
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
 * 发布成功后记录源码的版本/指纹（republish 用）：
 * - 目录里已有 source.json（应用托管的源码）→ 更新 version/sha256/目录指纹；
 * - 只有 workshop 草稿目录或 userData 源码根下的目录才写索引（**不碰用户自己的任意工程目录**）。
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
