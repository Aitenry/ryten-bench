import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import logger from 'electron-log'
import { broadcastPluginStateChanged, onPluginStateChanged } from '../ipc/plugins'
import { isEnabledPlugin, loadExternalMain, unloadExternalMain } from '../plugins/host'
import { setEnabledOverride } from '../plugins/store'
import { scanExternalPlugins } from '../plugins/scanner'
import { LatticeApiError, isLatticeLoggedIn, latticeErrorMessage, latticeRequest } from './client'
import { getLatticeAutoInstallMissing } from './settings'
import { getLatticeDeviceId } from './session'
import type {
  LatticeInstallPutBody,
  LatticeInstallResult,
  LatticeInstallSummary,
  LatticeRemoteInstall,
  LatticeResolveConflictResult,
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
 * 安装记录 + 插件数据（`userData/plugin-state/<id>.json`）的双向同步。
 *
 * 口径（契约 §4 / PL-18）：
 * - **本地视图** = `scanExternalPlugins()` + `isEnabledPlugin()`；数据 = `userData/plugin-state/<id>.json`
 *   （存在且 ≤256KiB 才带）；
 * - **push**：逐插件 `PUT /v1/hub/installs/{id}`，`data_rev` 取本地缓存（`userData/lattice-sync.json`
 *   的 `revs`）；`409 data_conflict` **记冲突不覆盖**（不静默 force）；平台 410/404（插件已被删除）→
 *   **保留本地插件目录与数据**，只把安装记录标记为 `orphaned`（同步详情可见，不自动删除用户数据）；
 * - **pull**：`GET /v1/hub/installs?include_data=1`，只写回 `data_rev` 更大的数据、应用云端启用态；
 *   **换机自动补齐**：平台有安装记录而本机没有插件包时（换机/重装/用户删了目录），按设置项
 *   （默认开启）自动调用安装、恢复安装包 + 源码，返回 `{installed,failed}` 明细；失败逐个可见、
 *   不中断其它插件；关闭时只把缺失项放进 `pending`。整个插件被平台删除的记录标记 `orphaned`；
 * - **触发**：启动/登录后 pull；插件状态变化（`plugin-state-changed`）后 5s 防抖 push。
 *
 * `lattice-sync.json` 同时缓存最近一次同步结果：状态卡/设置页冷启动也能显示「上次同步」。
 */

/** 平台单插件数据上限（设计 §17.16）：256KiB JSON */
const DATA_MAX_BYTES = 256 * 1024
const SYNC_CACHE_FILE = 'lattice-sync.json'
const PUSH_DEBOUNCE_MS = 5_000
const PLUGIN_STATE_DIR = 'plugin-state'

interface LatticeSyncCacheFile {
  revs: Record<string, number>
  last?: LatticeSyncResult
  /**
   * 未解决的 `data_rev` 冲突（push 时 409 记录，用户在插件仓库「解决冲突」里选择用哪边）。
   * 只存本地缓存；`server_data` 在列表时按需拉取，避免把 256KiB 数据长期复制一份。
   */
  conflicts?: LatticeSyncConflict[]
  /**
   * 「平台已删除」的安装记录（orphaned）。保留本地插件目录与数据，只做标记；插件重新出现或
   * push 成功后自动清除。同步详情里的「平台已删除的记录」区块读这份缓存。
   */
  orphaned?: LatticeSyncOrphanedItem[]
  /**
   * 插件源码的本机落点（v2 §2 安装/重新发布后的附件信息）。
   *
   * 只是**本地缓存**（不参与 push/pull）：`lattice:source-path` 仍以磁盘上的 source.json 为准，
   * 这份记录用于排障与「冷启动后快速知道上次源码在哪」。
   */
  sources?: Record<string, LatticeSourceCacheEntry>
}

/** 一次未解决的插件数据冲突（`data_rev` 不一致） */
export interface LatticeSyncConflict {
  plugin_id: string
  /** 本机 cached rev（push 时带上去的那个） */
  local_rev: number
  /** 服务端当前 rev（409 返回） */
  server_rev: number
  /** 本机数据快照（用户选择"用本机覆盖"时直接重推这份；无数据则 undefined） */
  local_data?: unknown
  at: number
}

/** 某插件源码的本机落点缓存（`lattice-sync.json` 的 `sources[pluginId]`） */
export interface LatticeSourceCacheEntry {
  path: string
  version?: string
  sha256?: string
  managed?: string
  at: number
}

interface LatticeSyncHooks {
  /** 一次同步结束（index.ts 接成广播 `lattice:sync-state` + 刷新状态） */
  onSyncState?: (result: LatticeSyncResult) => void
  /** 同步改动了启用态等状态（index.ts 接成广播 `lattice:state-changed`） */
  onStateChanged?: () => void
  /**
   * 换机自动补齐：调用现有安装流程（下载安装包 + 源码 + 写安装记录）。
   *
   * 用钩子注入而不是直接 import `./hub`：`hub.ts` 反向依赖本模块的 `recordLatticeSourceCache`，
   * 静态互相 import 在 CJS 打包下容易出现半初始化对象；由 `lattice/index.ts` 统一接线。
   * 未接线（独立单元测试/异常装配）时自动补齐退化为 `pending` 列表，不崩。
   */
  installPlugin?: (pluginId: string, version?: string) => Promise<LatticeInstallResult>
}

let hooks: LatticeSyncHooks = {}
let cache: LatticeSyncCacheFile | null = null
let lastResult: LatticeSyncResult | null = null
let running: Promise<LatticeSyncResult> | null = null
let debounceTimer: NodeJS.Timeout | null = null
/** pull 应用云端启用态时会广播 plugin-state-changed：抑制由此触发的防抖 push */
let suppressPush = false

/** 由 `lattice/index.ts` 在启动时接线（避免 sync → index 的循环依赖） */
export function configureLatticeSync(next: LatticeSyncHooks): void {
  hooks = next
}

// ---------- 小工具 ----------

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

/** 读 `lattice-sync.json`（坏文件退回空缓存，不阻塞同步） */
function loadSyncCache(): LatticeSyncCacheFile {
  if (cache) return cache
  let last: LatticeSyncResult | undefined
  const revs: Record<string, number> = {}
  const sources: Record<string, LatticeSourceCacheEntry> = {}
  const orphaned: LatticeSyncOrphanedItem[] = []
  let conflicts: LatticeSyncConflict[] = []
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
        ...(readOptionalString(entry?.version) ? { version: readOptionalString(entry?.version) } : {}),
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
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code
    if (code !== 'ENOENT') logger.warn('[Lattice] Failed to read lattice-sync.json, using empty cache:', err)
  }
  cache = {
    revs,
    last,
    ...(conflicts.length > 0 ? { conflicts } : {}),
    ...(orphaned.length > 0 ? { orphaned } : {}),
    ...(Object.keys(sources).length > 0 ? { sources } : {})
  }
  return cache
}

/**
 * 记录某插件源码的本机落点（安装时下载源码 / 重新发布成功后调用）。
 *
 * 只写本地缓存，不参与 push/pull；失败只告警（源码已经在磁盘上，缓存只是附件信息）。
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
      // 清理临时文件失败无意义
    }
  }
}

/** 读插件数据文件（不存在 / 非法 JSON / 超过 256KiB 都视为「无数据」） */
function readPluginData(pluginId: string): { data: unknown; bytes: number } | null {
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
    if (code !== 'ENOENT') logger.warn(`[Lattice] Failed to read plugin-state/${pluginId}.json:`, err)
    return null
  }
}

/** 写回云端数据（原子写；超过 256KiB 的异常数据拒绝落盘） */
function writePluginData(pluginId: string, data: unknown): boolean {
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
      // 清理临时文件失败无意义
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
    // 平台对已删除插件有两种表现：明确返回 `plugin:null`，或软删后插件行仍在（`status:'removed'`）。
    // 老平台两个字段都没有时不能当「已删除」（否则会把老平台的所有记录误标 orphaned）。
    plugin_deleted:
      ('plugin' in record && record.plugin === null) ||
      readOptionalString(pluginRaw?.status) === 'removed',
    data: record.data
  }
}

// ---------- 本地视图 ----------

/** `lattice:hub-installs` 的返回：本机已安装插件 + 本地缓存的 data_rev */
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

/** 未解决的冲突列表（给渲染层「解决冲突」弹窗用；server_data 按需补） */
export function listLatticeSyncConflicts(): LatticeSyncConflict[] {
  return [...(loadSyncCache().conflicts ?? [])]
}

// ---------- 孤儿安装记录（平台已删除插件；保留本地数据，只做标记） ----------

/** 当前仍未解决的「平台已删除」安装记录（本地插件目录与数据保留，不自动删除） */
export function listLatticeSyncOrphaned(): LatticeSyncOrphanedItem[] {
  return [...(loadSyncCache().orphaned ?? [])]
}

/**
 * 标记/更新一条孤儿记录（幂等：同插件只保留一条）。
 *
 * `at` 保留首次标记时间；`reason`/`error` 用最新一次观测覆盖（平台重新删除时可见最新原因）。
 * 清除只发生在 pull 观测到插件重新可见时（push 成功不等于插件还在，见 pushInstallRecords）。
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

/** 插件重新出现在平台上（pull 观测到 `plugin` 非 null）：清掉孤儿标记；本地数据不受影响 */
function clearLatticeOrphaned(pluginId: string): boolean {
  const id = String(pluginId ?? '').trim()
  if (!id) return false
  const store = loadSyncCache()
  const orphaned = store.orphaned ?? []
  if (!orphaned.some((entry) => entry.plugin_id === id)) return false
  store.orphaned = orphaned.filter((entry) => entry.plugin_id !== id)
  saveSyncCache()
  logger.info(`[Lattice] Install record '${id}' is no longer orphaned (plugin is back on the platform)`)
  return true
}

/** `lattice:sync-details`：同步详情弹窗的数据（最近一次同步明细 + 冲突 + 孤儿记录） */
export function getLatticeSyncDetails(): LatticeSyncDetails {
  return {
    last: getLastLatticeSyncResult(),
    conflicts: listLatticeSyncConflicts(),
    orphaned: listLatticeSyncOrphaned()
  }
}

/**
 * 补齐云端数据快照，供用户对比「用本机 / 用云端」。
 *
 * 409 响应里只有服务端 `data_rev`（不重复回传 256KiB 数据），所以这里对冲突插件单独
 * `GET /v1/hub/installs?include_data=1` 取一次；失败则只展示 rev，不阻塞弹窗。
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
 * 解决一个 `data_rev` 冲突。
 *
 * - `strategy='local'`：用本机数据覆盖云端（`PUT ...?force=1`，语义即「最后写入者赢」）；
 * - `strategy='cloud'`：用云端数据覆盖本机（写回 `plugin-state/<id>.json` 并对齐 rev；
 *   云端无数据时清空本机数据，保持"两边一致"）。
 *
 * 两种选择都必须是用户显式点击（不静默覆盖），与 ⑤ §12.7 的冲突模型一致。
 */
export async function resolveLatticeSyncConflict(
  pluginId: string,
  strategy: 'local' | 'cloud'
): Promise<LatticeResolveConflictResult> {
  const id = String(pluginId ?? '').trim()
  if (!id) return { ok: false, error: '缺少插件 id' }
  const store = loadSyncCache()
  const conflict = store.conflicts?.find((c) => c.plugin_id === id)
  if (!conflict) return { ok: false, error: '没有待解决的冲突' }
  const plugin = scanExternalPlugins().find((p) => p.id === id)
  if (!plugin) return { ok: false, error: '本机未安装这个插件，无法解决冲突' }

  try {
    if (strategy === 'local') {
      const dataInfo = readPluginData(id)
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
    } else {
      const raw = await latticeRequest<unknown>('/v1/hub/installs', {
        query: { include_data: '1' }
      })
      const record = asRecord(raw) ?? {}
      const items = Array.isArray(record.items) ? record.items.map(mapRemoteInstall) : []
      const item = items.find((i) => i.plugin_id === id)
      if (!item) return { ok: false, error: '云端没有这个插件的安装记录' }
      if (item.data !== undefined && item.data !== null) {
        if (!writePluginData(id, item.data)) {
          return { ok: false, error: '写入本机插件数据失败' }
        }
      } else {
        // 云端没有数据：本机也清空，避免下次 push 又把旧数据推回去
        try {
          fs.rmSync(pluginStatePath(id), { force: true })
        } catch (err) {
          logger.warn(`[Lattice] Failed to clear local plugin data: ${id}`, err)
        }
      }
      store.revs[id] = item.data_rev ?? conflict.server_rev
    }
    store.conflicts = (store.conflicts ?? []).filter((c) => c.plugin_id !== id)
    saveSyncCache()
    try {
      hooks.onStateChanged?.()
    } catch (err) {
      logger.warn('[Lattice] Error in state callback after conflict resolution:', err)
    }
    logger.info(`[Lattice] Conflict resolved: ${id} -> ${strategy === 'local' ? 'use local' : 'use cloud'}`)
    return { ok: true }
  } catch (err) {
    const message = latticeErrorMessage(err)
    logger.warn(`[Lattice] Failed to resolve conflict: ${id} -> ${strategy}: ${message}`)
    return { ok: false, error: message }
  }
}

// ---------- push / pull ----------

/** push 遇到「平台已删除」类错误（404/410） */
function isOrphanedPushError(err: unknown): err is LatticeApiError {
  return err instanceof LatticeApiError && (err.status === 404 || err.status === 410)
}

/**
 * 逐插件推安装记录（带本地数据时附 data + data_rev）。
 *
 * - 409：云端被别的设备改过 → 记冲突不覆盖（用户显式选择）；
 * - 410/404：安装记录指向的插件已在平台删除 → **保留本地插件目录与 plugin-state 数据**，
 *   只把记录标记为 `orphaned`（同步详情可见），不自动删除用户数据；不中断其它插件。
 */
async function pushInstallRecords(): Promise<{
  pushed: number
  conflicts: number
  orphaned: LatticeSyncOrphanedItem[]
}> {
  const store = loadSyncCache()
  const deviceId = getLatticeDeviceId() ?? undefined
  let pushed = 0
  let conflicts = 0
  for (const plugin of scanExternalPlugins()) {
    const dataInfo = readPluginData(plugin.id)
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
      // 成功推送说明该插件已无冲突（例如用户选了"用本机覆盖"后重试成功）
      if (store.conflicts?.some((c) => c.plugin_id === plugin.id)) {
        store.conflicts = store.conflicts.filter((c) => c.plugin_id !== plugin.id)
      }
      // 注意：push 成功只代表平台接受了安装记录，**不代表插件还在插件中心**
      // （平台对已删除插件也接受 installs upsert）。所以孤儿标记只由 pull 观测到
      // 「插件重新可见（plugin 字段非 null）」时清除——见 pullInstallRecords。
      pushed += 1
    } catch (err) {
      if (isOrphanedPushError(err)) {
        // 平台已删除该插件：保留本地记录并标记 orphaned（不删数据、不中断其它插件）
        markLatticeOrphaned(
          plugin.id,
          plugin.manifest.version,
          err.status === 410 ? 'plugin_deleted' : 'not_found',
          latticeErrorMessage(err)
        )
        continue
      }
      if (err instanceof LatticeApiError && err.status === 409) {
        // 云端被别的设备改过：记冲突，不 force 覆盖（用户需要自己选「用哪边」）
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
  return { pushed, conflicts, orphaned: listLatticeSyncOrphaned() }
}

/** 自动补齐一个插件的单向结果（成功带恢复信息，失败带可读原因） */
type AutoInstallOutcome =
  | { ok: true; item: LatticeSyncAutoInstallItem }
  | { ok: false; failure: LatticeSyncAutoInstallFailure }

/**
 * 自动补齐一个「平台有安装记录、本机没有插件包」的插件（换机/重装/用户删了目录）。
 *
 * 复用现有安装流程（下载安装包 → sha256 校验 → 解压安装 → 下载源码 → 写安装记录）；
 * 这里只多做两件事：按云端安装记录应用启用态、按 pull 口径写回云端更新的数据。
 * **不吞错**：失败原因原样返回给同步结果（autoInstall.failed），由 UI 逐条展示。
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
      logger.warn(`[Lattice] Failed to auto-restore ${pluginId} (other plugins unaffected): ${result.error}`)
      return failure(result.error || '安装失败')
    }
    // 启用态：安装默认启用；云端记录明确停用时按云端关掉（不擅自启用用户停用过的插件）
    if (typeof item.enabled === 'boolean' && item.enabled !== isEnabledPlugin(pluginId)) {
      setEnabledOverride(pluginId, item.enabled)
      try {
        if (item.enabled) loadExternalMain(pluginId)
        else unloadExternalMain(pluginId)
        logger.info(`[Lattice] Applied cloud enabled state to ${pluginId} after auto-restore: ${item.enabled}`)
      } catch (err) {
        logger.warn(`[Lattice] Failed to load/unload main module of ${pluginId} after auto-restore:`, err)
      }
    }
    // 数据：补齐后本机没有数据，沿用 pull 口径写回云端 rev 更大的数据
    const serverRev = item.data_rev ?? 0
    if (serverRev > (store.revs[pluginId] ?? 0)) {
      if (item.data !== undefined && item.data !== null) {
        if (writePluginData(pluginId, item.data)) store.revs[pluginId] = serverRev
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
      }
    }
  } catch (err) {
    const message = latticeErrorMessage(err)
    logger.warn(`[Lattice] Error while auto-restoring ${pluginId} (other plugins unaffected): ${message}`)
    return failure(message)
  }
}

/**
 * 拉取安装记录：只写回云端更新的数据；应用启用态；自动补齐缺失插件。
 *
 * - 平台返回 `plugin:null` 的记录 = 插件已被删除 → 标记 orphaned（本地数据保留，不自动安装）；
 * - 本机没有插件包的记录：`installMissing=true` 时逐个自动安装（失败逐个记录、不中断其它插件），
 *   关闭时只放进 `pending` 让用户手动处理；
 * - 只写回 `data_rev > 本地缓存 rev` 的数据（不覆盖本地较新的数据，冲突仍走 push 的 409 机制）。
 */
async function pullInstallRecords(installMissing: boolean): Promise<{
  pulled: number
  pending: string[]
  autoInstall: LatticeSyncAutoInstallResult
  orphaned: LatticeSyncOrphanedItem[]
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

  for (const item of items) {
    if (!item.plugin_id) continue
    if (item.plugin_deleted) {
      // 平台已删除该插件（安装记录还在）：保留本地插件目录与数据，只标记 orphaned。
      // 这类记录不尝试安装（平台上已没有可下载版本），也不删用户数据。
      markLatticeOrphaned(
        item.plugin_id,
        item.version,
        'plugin_deleted',
        '平台已删除该插件（本机安装记录与数据已保留）'
      )
      continue
    }
    // 插件在平台可见：历史 orphaned 标记自动消除（作者重新发布后恢复）
    clearLatticeOrphaned(item.plugin_id)

    if (!localIds.has(item.plugin_id)) {
      // 换机/重装/用户删了插件目录：平台有安装记录但本机没有插件包
      if (installMissing) {
        autoInstall.attempted += 1
        const outcome = await autoInstallMissingPlugin(item, store)
        if (outcome.ok) {
          autoInstall.installed.push(outcome.item)
          localIds.add(item.plugin_id)
        } else {
          autoInstall.failed.push(outcome.failure)
        }
        continue
      }
      pending.push(item.plugin_id)
      continue
    }

    // ① 启用态：云端为准；只在真的不同时才写 + load/unload（避免每次同步都重载插件）
    if (typeof item.enabled === 'boolean' && item.enabled !== isEnabledPlugin(item.plugin_id)) {
      setEnabledOverride(item.plugin_id, item.enabled)
      try {
        if (item.enabled) loadExternalMain(item.plugin_id)
        else unloadExternalMain(item.plugin_id)
        appliedEnabled.push(item.plugin_id)
        logger.info(`[Lattice] Applied cloud enabled state to ${item.plugin_id}: ${item.enabled}`)
      } catch (err) {
        logger.warn(`[Lattice] Failed to load/unload main module of ${item.plugin_id} per cloud enabled state:`, err)
      }
    }

    // ② 数据：只写回更新的版本
    const serverRev = item.data_rev ?? 0
    const localRev = store.revs[item.plugin_id] ?? 0
    if (serverRev > localRev) {
      if (item.data !== undefined && item.data !== null) {
        if (writePluginData(item.plugin_id, item.data)) {
          store.revs[item.plugin_id] = serverRev
          pulled += 1
        }
      } else {
        store.revs[item.plugin_id] = serverRev
      }
    }
  }

  // 平台安装记录已被删除（用户在别处删记录 / 平台清理）→ 对应孤儿标记也清掉，避免本地缓存残留
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
  return { pulled, pending, autoInstall, orphaned: listLatticeSyncOrphaned() }
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
  const result: LatticeSyncResult = { at: Date.now(), pushed: 0, pulled: 0, conflicts: 0 }
  if (!isLatticeLoggedIn()) {
    result.error = '未登录插件中心，请先登录'
    return finishSync(result)
  }
  // 未显式传 installMissing 时跟设置项走（默认开启）：启动/登录后的后台 pull 也能换机自动补齐
  const installMissing = options.installMissing ?? getLatticeAutoInstallMissing()
  try {
    // 先 pull 再 push：先把云端更新拉下来（rev 对齐），再推本地最新的安装态/数据；
    // 这样多设备场景下不会把刚拉到的云端数据当成「本地脏数据」再推回去。
    if (direction === 'pull' || direction === 'both') {
      const pulled = await pullInstallRecords(installMissing)
      result.pulled = pulled.pulled
      if (pulled.pending.length > 0) result.pending = pulled.pending
      if (pulled.autoInstall.attempted > 0) result.autoInstall = pulled.autoInstall
      if (pulled.orphaned.length > 0) result.orphaned = pulled.orphaned
    }
    if (direction === 'push' || direction === 'both') {
      const pushed = await pushInstallRecords()
      result.pushed = pushed.pushed
      result.conflicts = pushed.conflicts
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
 * 执行一次同步（push / pull / both，可带自动补齐选项）。
 *
 * 入参兼容两种写法（契约 §3 的 `{direction}` 与裸字符串）：
 * - `syncLattice('pull')`；
 * - `syncLattice({ direction: 'pull', installMissing: true })` —— 显式要求本次 pull 自动补齐
 *   缺失插件（否则跟随设置项，默认开启）。
 *
 * 并发调用共享同一次运行的 Promise（同一时刻只跑一份，避免请求风暴与 rev 竞争）。
 * 错误不抛：失败写进结果的 `error` 字段（渲染层按状态条展示）。
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

/** 5s 防抖 push（插件启用态/安装态变化后触发；登录态变化时由调用方再触发一次） */
export function scheduleLatticePush(delayMs = PUSH_DEBOUNCE_MS): void {
  if (suppressPush) return
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
 * 取消尚未触发的防抖 push（退出登录/切换基址时用）。
 *
 * 不清 rev 缓存：本地 plugin-state 数据还在，下次登录后 push 仍需用「上次看到的 rev」
 * 做冲突检测——清掉会退化成 rev=0 覆盖，可能丢掉本机未同步的修改。
 */
export function cancelPendingLatticePush(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
}

/** 启动接线：旁听 `plugin-state-changed`（安装/卸载/启停/数据文件变化统一走这条广播） */
export function initLatticeSync(): void {
  onPluginStateChanged(() => {
    scheduleLatticePush()
  })
}

/** 基址切换后清空 rev 缓存（不同节点的 data_rev 不可比） */
export function resetLatticeSyncCache(): void {
  cache = { revs: {} }
  lastResult = null
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  saveSyncCache()
  logger.info('[Lattice] Sync revision cache cleared (plugin hub base URL changed)')
}
