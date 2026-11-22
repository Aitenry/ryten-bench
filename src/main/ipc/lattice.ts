import { ipcMain } from 'electron'
import * as path from 'path'
import logger from 'electron-log'
import { broadcastWorkshopChanged } from './harness/workshop'
import { applyPluginsRoot } from '../workshop/wiring'
import * as client from '../lattice/client'
import { openLatticePluginSource } from '../lattice/editor'
import * as hub from '../lattice/hub'
import * as session from '../lattice/session'
import * as settings from '../lattice/settings'
import * as sync from '../lattice/sync'
import {
  broadcastLatticeStatus,
  getLatticeStatus,
  initLattice,
  setLatticeLastError
} from '../lattice/index'
import {
  LATTICE_IPC,
  type LatticeAutoInstallSettingResult,
  type LatticeDownloadAssetResult,
  type LatticeImportLocalDirResult,
  type LatticeListQuery,
  type LatticeLoginInput,
  type LatticeLoginResult,
  type LatticeLocalSourcePathResult,
  type LatticeOpenSourceResult,
  type LatticeRepublishInput,
  type LatticeRepublishResult,
  type LatticeSetPluginRootResult,
  type LatticeSetBaseUrlResult,
  type LatticeSourcePathResult,
  type LatticeSyncDetails,
  type LatticeSyncOptions,
  type LatticeSyncResult,
  type LatticeSyncConflict,
  type LatticeResolveConflictResult,
  type LatticeUploadResult
} from '../lattice/types'

/**
 * 插件中心 IPC（core，非插件；契约 §3）。
 *
 * 全部走 `ipcMain.handle`：
 * - 登录/登出/me/基址/同步/上传/安装在**业务层**就把失败归一成可展示文本，
 *   需要事务结果的方法返回 `{ok:false,error}`（不把异常抛到渲染层）；
 * - 列表/详情这类「读」接口按契约直接返回数据，失败抛错由渲染层兜；
 * - 事件（state-changed / upload-progress / sync-state）在 lattice/index.ts 广播，
 *   这里只负责通道注册与参数校验。
 *
 * 参数一律做运行时校验：IPC 入参来自渲染进程，不能假设形状正确。
 */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** `lattice:login` 入参：`{baseUrl?,username,password}` */
function normalizeLoginInput(raw: unknown): LatticeLoginInput | null {
  const record = asRecord(raw)
  if (!record) return null
  const username = readString(record.username)
  const password = readString(record.password)
  if (username.trim() === '' || password === '') return null
  const baseUrl = readOptionalString(record.baseUrl)
  return baseUrl ? { baseUrl, username, password } : { username, password }
}

/** `lattice:hub-list` 入参：`{q?,category?,sort?,page?,pageSize?}` */
function normalizeListQuery(raw: unknown): LatticeListQuery {
  const record = asRecord(raw)
  if (!record) return {}
  const query: LatticeListQuery = {}
  const q = readOptionalString(record.q)
  if (q) query.q = q
  const category = readOptionalString(record.category)
  if (category) query.category = category
  const sort = readOptionalString(record.sort)
  if (sort === 'recent' || sort === 'popular' || sort === 'name') query.sort = sort
  const page = Number(record.page)
  if (Number.isFinite(page) && page >= 1) query.page = Math.floor(page)
  const pageSize = Number(record.pageSize ?? record.page_size)
  if (Number.isFinite(pageSize) && pageSize >= 1) query.pageSize = Math.floor(pageSize)
  return query
}

/**
 * `lattice:sync` 入参归一化：
 * - 契约 v1 `{direction}` / 裸字符串 `'push'|'pull'|'both'`；
 * - v3 扩展 `{direction, installMissing?}`（本次 pull 是否自动补齐缺失插件；缺省跟随设置项）。
 */
function normalizeSyncInput(raw: unknown): LatticeSyncOptions {
  if (typeof raw === 'string') {
    return raw === 'push' || raw === 'pull' || raw === 'both' ? { direction: raw } : {}
  }
  const record = asRecord(raw)
  if (!record) return {}
  const directionRaw = typeof record.direction === 'string' ? record.direction : ''
  const options: LatticeSyncOptions = {}
  if (directionRaw === 'push' || directionRaw === 'pull' || directionRaw === 'both') {
    options.direction = directionRaw
  }
  if (typeof record.installMissing === 'boolean') {
    options.installMissing = record.installMissing
  } else if (typeof record.install_missing === 'boolean') {
    options.installMissing = record.install_missing
  }
  return options
}

/** `lattice:uploadSource` 入参：契约是 `{source}`；也接受裸路径字符串 */
function normalizeUploadSource(raw: unknown): string | null {
  if (typeof raw === 'string') return raw.trim() !== '' ? raw : null
  const source = readOptionalString(asRecord(raw)?.source)
  return source ?? null
}

/**
 * `lattice:hub-install` 入参：契约是 `(pluginId, version?)`；同时兼容
 * `{pluginId|plugin_id, version?}`（渲染层封装不同写法时不至于直接失效）。
 */
function normalizeInstallArgs(
  pluginIdRaw: unknown,
  versionRaw: unknown
): { pluginId: string; version?: string } | null {
  if (typeof pluginIdRaw === 'string') {
    const pluginId = pluginIdRaw.trim()
    if (pluginId === '') return null
    return { pluginId, version: readOptionalString(versionRaw) }
  }
  const record = asRecord(pluginIdRaw)
  if (!record) return null
  const pluginId = readOptionalString(record.pluginId) ?? readOptionalString(record.plugin_id)
  if (!pluginId) return null
  return { pluginId, version: readOptionalString(record.version) ?? readOptionalString(versionRaw) }
}

/**
 * 登录前若传了基址：先落地，并处理「换服务器 = 旧 token 作废」。
 * 返回错误文本表示这次登录不能继续（如设置被环境变量锁死）。
 */
function applyLoginBaseUrl(baseUrl: string): string | null {
  const previous = settings.getLatticeBaseUrl()
  const normalized = settings.setLatticeBaseUrl(baseUrl)
  if (normalized !== previous) {
    const hadSession = session.hasLatticeSession()
    session.clearLatticeSession()
    sync.resetLatticeSyncCache()
    logger.info(
      `[Lattice] Base URL switched before login: ${previous} -> ${normalized}${hadSession ? ' (old session cleared)' : ''}`
    )
  }
  if (settings.isLatticeBaseUrlLockedByEnv()) {
    const effective = settings.getLatticeBaseUrl()
    if (normalized !== effective) {
      return `当前基址由环境变量 RB_LATTICE_URL 固定为 ${effective}，无法登录到 ${normalized}`
    }
  }
  return null
}

/**
 * 单个插件 id 入参：契约是裸字符串；也兼容 `{pluginId|plugin_id}`（渲染层封装不同写法时不至于失效）。
 */
function normalizePluginIdArg(raw: unknown): string | null {
  if (typeof raw === 'string') {
    const id = raw.trim()
    return id === '' ? null : id
  }
  const record = asRecord(raw)
  if (!record) return null
  return readOptionalString(record.pluginId) ?? readOptionalString(record.plugin_id) ?? null
}

/**
 * `lattice:republish` 入参：`{pluginId, version, changelog?, sourceDir?}`。
 *
 * 同时兼容下划线写法（`plugin_id`/`source_dir`）；版本号是否合法/递增由业务层与平台校验
 * （业务层的错误是可读中文，直接返回给界面）。
 */
function normalizeRepublishInput(raw: unknown): LatticeRepublishInput | null {
  const record = asRecord(raw)
  if (!record) return null
  const pluginId =
    readOptionalString(record.pluginId) ?? readOptionalString(record.plugin_id) ?? null
  const version = readOptionalString(record.version) ?? null
  if (!pluginId || !version) return null
  const changelog = readOptionalString(record.changelog)
  const sourceDir = readOptionalString(record.sourceDir) ?? readOptionalString(record.source_dir)
  return {
    pluginId,
    version,
    ...(changelog ? { changelog } : {}),
    ...(sourceDir ? { sourceDir } : {})
  }
}

export function registerLatticeIpc(): void {
  ipcMain.handle(LATTICE_IPC.status, () => getLatticeStatus())

  ipcMain.handle(LATTICE_IPC.login, async (_event, raw: unknown): Promise<LatticeLoginResult> => {
    const input = normalizeLoginInput(raw)
    if (!input) return { ok: false, error: '登录参数非法：需要账号与密码' }
    try {
      if (input.baseUrl) {
        const blocked = applyLoginBaseUrl(input.baseUrl)
        if (blocked) {
          setLatticeLastError(blocked)
          broadcastLatticeStatus()
          return { ok: false, error: blocked }
        }
      }
      // 换号场景：先尽力吊销旧账号的 refresh（失败不影响新登录）
      if (session.hasLatticeSession()) {
        try {
          await client.logoutLattice()
        } catch (err) {
          logger.warn('[Lattice] Failed to log out old account before login (continuing with new login):', err)
        }
      }
      const result = await client.loginLattice(input.username, input.password)
      setLatticeLastError(null)
      broadcastLatticeStatus()
      // 登录后 pull 一次（后台执行；结果通过 lattice:sync-state 广播）
      void sync.syncLattice('pull')
      logger.info(`[Lattice] IPC login succeeded: ${result.user.username}`)
      return {
        ok: true,
        user: result.user,
        ...(result.role ? { role: result.role } : {})
      }
    } catch (err) {
      const message = client.latticeErrorMessage(err)
      setLatticeLastError(message)
      broadcastLatticeStatus()
      logger.warn(`[Lattice] Login failed: ${message}`)
      return { ok: false, error: message }
    }
  })

  ipcMain.handle(LATTICE_IPC.logout, async () => {
    try {
      await client.logoutLattice()
    } catch (err) {
      logger.warn('[Lattice] Logout error (local session already cleared):', err)
    }
    // 登出后不该再有一次「未登录」的失败 push 冲掉状态
    sync.cancelPendingLatticePush()
    setLatticeLastError(null)
    broadcastLatticeStatus()
    return { ok: true as const }
  })

  ipcMain.handle(LATTICE_IPC.me, async () => {
    try {
      const me = await client.fetchLatticeMe()
      setLatticeLastError(null)
      broadcastLatticeStatus()
      return me
    } catch (err) {
      const message = client.latticeErrorMessage(err)
      setLatticeLastError(message)
      broadcastLatticeStatus()
      throw new Error(message)
    }
  })

  ipcMain.handle(LATTICE_IPC.setBaseUrl, (_event, raw: unknown): LatticeSetBaseUrlResult => {
    if (typeof raw !== 'string' || raw.trim() === '') {
      return { ok: false, error: '基址不能为空', status: getLatticeStatus() }
    }
    try {
      const previous = settings.getLatticeBaseUrl()
      const normalized = settings.setLatticeBaseUrl(raw)
      if (normalized !== previous) {
        const hadSession = session.hasLatticeSession()
        if (hadSession) session.clearLatticeSession()
        sync.resetLatticeSyncCache()
        setLatticeLastError(null)
        logger.info(
          `[Lattice] Base URL switched: ${previous} -> ${normalized}${hadSession ? ' (old session cleared)' : ''}`
        )
      }
      broadcastLatticeStatus()
      if (settings.isLatticeBaseUrlLockedByEnv()) {
        const effective = settings.getLatticeBaseUrl()
        if (normalized !== effective) {
          return {
            ok: false,
            status: getLatticeStatus(),
            error: `当前基址由环境变量 RB_LATTICE_URL 固定为 ${effective}，设置已保存但不生效`
          }
        }
      }
      return { ok: true, status: getLatticeStatus() }
    } catch (err) {
      const message = client.latticeErrorMessage(err)
      broadcastLatticeStatus()
      return { ok: false, error: message, status: getLatticeStatus() }
    }
  })

  ipcMain.handle(LATTICE_IPC.hubList, async (_event, raw: unknown) => {
    const query = normalizeListQuery(raw)
    return await hub.listLatticeHub(query)
  })

  ipcMain.handle(LATTICE_IPC.hubDetail, async (_event, pluginId: unknown) => {
    if (typeof pluginId !== 'string' || pluginId.trim() === '') {
      throw new Error('缺少插件 id')
    }
    return await hub.getLatticeHubDetail(pluginId.trim())
  })

  ipcMain.handle(LATTICE_IPC.hubPickUpload, async (): Promise<LatticeUploadResult> => {
    try {
      return await hub.pickAndUploadLatticePackage()
    } catch (err) {
      const message = client.latticeErrorMessage(err)
      logger.warn('[Lattice] Failed to select and upload plugin package:', err)
      return { ok: false, error: message }
    }
  })

  ipcMain.handle(LATTICE_IPC.hubPickUploadZip, async (): Promise<LatticeUploadResult> => {
    try {
      return await hub.pickAndUploadZipLatticePackage()
    } catch (err) {
      const message = client.latticeErrorMessage(err)
      logger.warn('[Lattice] Failed to select and upload plugin zip:', err)
      return { ok: false, error: message }
    }
  })

  ipcMain.handle(
    LATTICE_IPC.hubUpload,
    async (_event, raw: unknown): Promise<LatticeUploadResult> => {
      const source = normalizeUploadSource(raw)
      if (!source) return { ok: false, error: '缺少插件包路径（source）' }
      return await hub.uploadLatticePackage(source)
    }
  )

  ipcMain.handle(
    LATTICE_IPC.hubInstall,
    async (_event, pluginIdRaw: unknown, versionRaw?: unknown) => {
      const args = normalizeInstallArgs(pluginIdRaw, versionRaw)
      if (!args) return { ok: false, error: '缺少插件 id' }
      return await hub.installLatticePlugin(args.pluginId, args.version)
    }
  )

  ipcMain.handle(LATTICE_IPC.hubInstalls, () => ({ items: sync.listLatticeLocalInstalls() }))

  // ---------- 源码生命周期（契约 v2 §2） ----------

  /** 当前源码目录（path/version/managed；没有源码返回 `{path:null}`） */
  ipcMain.handle(
    LATTICE_IPC.sourcePath,
    (_event, pluginIdRaw: unknown): LatticeSourcePathResult => {
      const pluginId = normalizePluginIdArg(pluginIdRaw)
      if (!pluginId) return { path: null }
      try {
        return hub.getLatticePluginSource(pluginId)
      } catch (err) {
        logger.warn(`[Lattice] Failed to read source directory (${pluginId}):`, err)
        return { path: null }
      }
    }
  )

  /** 本机已安装插件包目录（userData/plugins/<id>，本地安装后发布用） */
  ipcMain.handle(
    LATTICE_IPC.localSourcePath,
    (_event, pluginIdRaw: unknown): LatticeLocalSourcePathResult => {
      const pluginId = normalizePluginIdArg(pluginIdRaw)
      if (!pluginId) return { path: null }
      try {
        return hub.getLatticeLocalSourcePath(pluginId)
      } catch (err) {
        logger.warn(`[Lattice] Failed to read local plugin directory (${pluginId}):`, err)
        return { path: null }
      }
    }
  )

  /**
   * 在对话中修改：为源码目录建/复用插件工作区并开一条插件会话；做不到就回退文件管理器。
   * 返回 `{ok:true,workspaceId,topicId}` 或 `{ok:true,opened:'folder'}`（如实，不假装开了对话）。
   */
  ipcMain.handle(
    LATTICE_IPC.openSource,
    async (_event, pluginIdRaw: unknown): Promise<LatticeOpenSourceResult> => {
      const pluginId = normalizePluginIdArg(pluginIdRaw)
      if (!pluginId) return { ok: false, error: '缺少插件 id' }
      try {
        return await openLatticePluginSource(pluginId)
      } catch (err) {
        const message = client.latticeErrorMessage(err)
        logger.warn(`[Lattice] Failed to open source (${pluginId}): ${message}`)
        return { ok: false, error: message }
      }
    }
  )

  /** 重新发布新版本（安装包 + 源码同包上传；409 转可读错误） */
  ipcMain.handle(
    LATTICE_IPC.republish,
    async (_event, raw: unknown): Promise<LatticeRepublishResult> => {
      const input = normalizeRepublishInput(raw)
      if (!input) return { ok: false, error: '参数非法：需要 {pluginId, version}' }
      return await hub.republishLatticePlugin(input)
    }
  )

  /** 下载安装包 / 源码包到本机（弹保存框；用户取消不是失败） */
  ipcMain.handle(
    LATTICE_IPC.downloadAsset,
    async (
      _event,
      pluginIdRaw: unknown,
      versionRaw: unknown,
      kindRaw: unknown
    ): Promise<LatticeDownloadAssetResult> => {
      return await hub.downloadLatticeAsset(pluginIdRaw, versionRaw, kindRaw)
    }
  )

  /**
   * 弹目录选择框，把本地源码目录下的插件批量发布到平台（安装包 + 源码）。
   * 第二个参数是**显式路径**（正常 UI 不传，给自动化/工装用；也用于导入后一键设为本机插件源根）。
   */
  ipcMain.handle(
    LATTICE_IPC.importLocalDir,
    async (_event, dirRaw?: unknown): Promise<LatticeImportLocalDirResult> => {
      try {
        const dir = typeof dirRaw === 'string' ? dirRaw : ''
        return await hub.importLocalPlugins(dir)
      } catch (err) {
        const message = client.latticeErrorMessage(err)
        logger.warn(`[Lattice] Local directory import failed: ${message}`)
        return { ok: false, error: message }
      }
    }
  )

  /**
   * 显式设置「插件存放路径」并立即生效（插件中心导入本地目录后调用）。
   *
   * 只接受非空字符串并 resolve 成绝对路径；不传 = 报错（清除路径走设置页，不走这里，
   * 避免误点把整个插件列表清空）。
   */
  ipcMain.handle(
    LATTICE_IPC.setPluginRoot,
    async (_event, dirRaw: unknown): Promise<LatticeSetPluginRootResult> => {
      try {
        const dir = typeof dirRaw === 'string' ? dirRaw.trim() : ''
        if (!dir) return { ok: false, error: '插件存放路径不能为空' }
        applyPluginsRoot(dir)
        broadcastWorkshopChanged()
        return { ok: true, dir: path.resolve(dir) }
      } catch (err) {
        return { ok: false, error: client.latticeErrorMessage(err) }
      }
    }
  )

  ipcMain.handle(LATTICE_IPC.sync, async (_event, raw: unknown): Promise<LatticeSyncResult> => {
    const options = normalizeSyncInput(raw)
    return await sync.syncLattice(options)
  })

  /**
   * 同步详情：最近一次同步的自动补齐成功/失败明细与孤儿记录（失败原因不静默）。
   * 插件仓库的「同步详情」弹窗在同步条出现自动补齐/孤儿记录时调用。
   */
  ipcMain.handle(LATTICE_IPC.syncDetails, async (): Promise<LatticeSyncDetails> => {
    return sync.getLatticeSyncDetails()
  })

  /**
   * 「缺失插件自动补齐」开关（持久化；默认开启）。
   * 关闭后 pull 只把缺失插件放进 `pending`，不再自动安装；已标记的孤儿记录仍保留在详情里。
   */
  ipcMain.handle(
    LATTICE_IPC.setAutoInstallMissing,
    (_event, enabledRaw: unknown): LatticeAutoInstallSettingResult => {
      if (typeof enabledRaw !== 'boolean') {
        return { ok: false, enabled: settings.getLatticeAutoInstallMissing(), error: '参数不合法：需要布尔值' }
      }
      try {
        const enabled = settings.setLatticeAutoInstallMissing(enabledRaw)
        broadcastLatticeStatus()
        return { ok: true, enabled, status: getLatticeStatus() }
      } catch (err) {
        const message = client.latticeErrorMessage(err)
        logger.warn(`[Lattice] Failed to save automatic restore toggle: ${message}`)
        return { ok: false, enabled: settings.getLatticeAutoInstallMissing(), error: message }
      }
    }
  )

  /** 未解决的插件数据冲突（含补拉的云端数据快照，供"用本机/用云端"对比） */
  ipcMain.handle(LATTICE_IPC.syncConflicts, async (): Promise<LatticeSyncConflict[]> => {
    return await sync.listLatticeSyncConflictsDetailed()
  })

  /** 显式解决一个冲突：local=用本机覆盖云端（force），cloud=用云端覆盖本机 */
  ipcMain.handle(
    LATTICE_IPC.resolveConflict,
    async (_event, pluginIdRaw: unknown, strategyRaw: unknown): Promise<LatticeResolveConflictResult> => {
      const pluginId = typeof pluginIdRaw === 'string' ? pluginIdRaw.trim() : ''
      const strategy = strategyRaw === 'local' || strategyRaw === 'cloud' ? strategyRaw : null
      if (!pluginId || !strategy) return { ok: false, error: '参数不合法' }
      return await sync.resolveLatticeSyncConflict(pluginId, strategy)
    }
  )

  // 通道注册完再初始化：启动恢复/后台 pull 不会跑到未注册的 IPC 上
  initLattice()
}
