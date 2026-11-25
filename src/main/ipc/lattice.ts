import { ipcMain } from 'electron'
import logger from 'electron-log'
import { broadcastWorkshopChanged } from './harness/workshop'
import { applyPluginsRoot } from '../workshop/wiring'
import { remapWorkspacePathsUnderRoot } from '../storage/workspace-refs'
import * as client from '../lattice/client'
import { openLatticePluginSource } from '../lattice/editor'
import * as hub from '../lattice/hub'
import * as session from '../lattice/session'
import * as settings from '../lattice/settings'
import * as sync from '../lattice/sync'
import { ANONYMOUS_PROFILE, deriveProfileKey } from '../profiles/manager'
import { getActiveProfileKey, isAccountProfileReady } from '../profiles/runtime'
import { switchAccountProfile } from '../profiles/live'
import {
  broadcastLatticeStatus,
  getLatticeStatus,
  initLattice,
  setLatticeLastError
} from '../lattice/index'
import {
  LATTICE_IPC,
  type HubDetail,
  type LatticeAutoInstallSettingResult,
  type LatticeDownloadAssetResult,
  type LatticeImportLocalDirResult,
  type LatticeListQuery,
  type LatticeLoginInput,
  type LatticeLoginResult,
  type LatticeLocalSourcePathResult,
  type LatticeMergeDataResult,
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

/** `lattice:uploadSource` 入参：契约是 `{source, sourcePath?}`；也接受裸路径字符串 */
function normalizeUploadSource(raw: unknown): { source: string; sourcePath?: string } | null {
  if (typeof raw === 'string') return raw.trim() !== '' ? { source: raw } : null
  const record = asRecord(raw)
  const source = readOptionalString(record?.source)
  if (!source) return null
  const sourcePath = readOptionalString(record?.sourcePath)
  return sourcePath ? { source, sourcePath } : { source }
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
    // 不清 lattice-sync.json：账号级数据空间按「基址+用户」分容器，
    // 旧账号的 rev 缓存留在旧容器里，换服务器不会污染新账号；切空间在重启时完成。
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
          logger.warn(
            '[Lattice] Failed to log out old account before login (continuing with new login):',
            err
          )
        }
      }
      const result = await client.loginLattice(input.username, input.password)
      setLatticeLastError(null)
      broadcastLatticeStatus()
      logger.info(`[Lattice] IPC login succeeded: ${result.user.username}`)

      // 换号（包括未登录 → 登录、A → B）：本机数据空间要按新账号换一套。
      // 现在可以**原地切换**（不重启应用）：先悬停/对调/重连，再刷新主窗口；
      // 条件不满足（初始化还没完成）或切换失败时，live.ts 内部会回退成 app.relaunch()。
      const nextKey = deriveProfileKey({
        loggedIn: true,
        userId: result.user.id,
        username: result.user.username,
        baseUrl: settings.getLatticeBaseUrl()
      })
      if (isAccountProfileReady() && nextKey !== getActiveProfileKey()) {
        logger.info(
          `[Lattice] Account data space switches in place: ${getActiveProfileKey() ?? 'null'} -> ${nextKey}`
        )
        const switched = await switchAccountProfile({
          reason: `login ${result.user.username}`,
          targetKey: nextKey
        })
        // 正在切换（并发登录）等罕见情况：如实报错，别让界面以为已经换好号了
        if (!switched.ok && !switched.restarted) {
          return { ok: false, error: switched.error ?? '账号数据空间切换失败' }
        }
        return {
          ok: true,
          user: result.user,
          ...(result.role ? { role: result.role } : {}),
          restarting: switched.restarted === true,
          switching: switched.ok
        }
      }

      // 登录后 pull 一次（后台执行；结果通过 lattice:sync-state 广播）
      void sync.syncLattice('pull')
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
    // 登出 = 回未登录的本地空间（anonymous）：原地对调 + 刷新界面，不重启应用。
    // 切换失败/条件不满足时 live.ts 回退成重启（旧行为）。
    const active = getActiveProfileKey()
    if (isAccountProfileReady() && active !== null && active !== ANONYMOUS_PROFILE) {
      const switched = await switchAccountProfile({
        reason: 'logout -> anonymous',
        targetKey: ANONYMOUS_PROFILE
      })
      /**
       * 切换失败（不是「需要重启」）时不能报成功：本地会话已经清了，但数据空间仍停在
       * 旧账号上——界面必须告诉用户「退出没完成」，否则他会在未登录状态继续写旧账号容器。
       * 需要重启的路径（restarted）算成功：应用马上回来，启动时会按无会话落到 anonymous。
       */
      if (!switched.ok && !switched.restarted) {
        return {
          ok: false as const,
          error: switched.error ?? '退出登录失败：账号数据空间切换未完成，请重试'
        }
      }
      return { ok: true as const, restarting: switched.restarted === true, switching: switched.ok }
    }
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

  /**
   * 基址变更会连带切回 anonymous 数据空间（可能 await 原地切换），所以单独声明并标注返回类型，
   * 注册处只做一次转发（超长签名会让 ipcMain.handle 那行被格式化拆成三行）。
   */
  const handleSetBaseUrl = async (raw: unknown): Promise<LatticeSetBaseUrlResult> => {
    if (typeof raw !== 'string' || raw.trim() === '') {
      return { ok: false, error: '基址不能为空', status: getLatticeStatus() }
    }
    try {
      const previous = settings.getLatticeBaseUrl()
      const normalized = settings.setLatticeBaseUrl(raw)
      if (normalized !== previous) {
        const hadSession = session.hasLatticeSession()
        if (hadSession) session.clearLatticeSession()
        // 账号级数据空间按「基址+用户」分容器：旧账号的数据/rev 留在旧容器里，
        // 这里原地回到 anonymous 空间（不重启应用），随后刷新主窗口。
        setLatticeLastError(null)
        logger.info(
          `[Lattice] Base URL switched: ${previous} -> ${normalized}${hadSession ? ' (old session cleared)' : ''}`
        )
        const active = getActiveProfileKey()
        if (isAccountProfileReady() && active !== null && active !== ANONYMOUS_PROFILE) {
          const switched = await switchAccountProfile({
            reason: 'base url changed -> anonymous',
            targetKey: ANONYMOUS_PROFILE
          })
          if (switched.restarted) {
            return { ok: true, status: getLatticeStatus(), restarting: true }
          }
        }
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
  }
  ipcMain.handle(LATTICE_IPC.setBaseUrl, (_event, raw: unknown) => handleSetBaseUrl(raw))

  ipcMain.handle(LATTICE_IPC.hubList, async (_event, raw: unknown) => {
    const query = normalizeListQuery(raw)
    return await hub.listLatticeHub(query)
  })

  ipcMain.handle(
    LATTICE_IPC.hubDetail,
    async (_event, pluginId: unknown): Promise<HubDetail | null> => {
      if (typeof pluginId !== 'string' || pluginId.trim() === '') {
        throw new Error('缺少插件 id')
      }
      try {
        return await hub.getLatticeHubDetail(pluginId.trim())
      } catch (err) {
        /**
         * 404 = 这个插件没有发布到平台（本地安装 / 平台已删除），是详情页的正常状态，
         * 不是 IPC 故障：返回 null 让页面按「尚未发布」渲染。
         * 之前直接抛错，Electron 会把每次打开本地插件详情都打成一条
         * `Error occurred in handler for 'lattice:hub-detail': ... 404`，刷满主进程日志。
         */
        if (err instanceof client.LatticeApiError && err.status === 404) return null
        throw err
      }
    }
  )

  /**
   * 直接发布**本机已安装**的插件（安装包 + 源码）：详情页「发布到插件中心」走这里，
   * 不再弹系统目录选择框让用户自己找一遍安装目录。
   */
  ipcMain.handle(
    LATTICE_IPC.hubPublishInstalled,
    async (_event, pluginIdRaw: unknown): Promise<LatticeUploadResult> => {
      const pluginId = typeof pluginIdRaw === 'string' ? pluginIdRaw.trim() : ''
      if (!pluginId) return { ok: false, error: '缺少插件 id' }
      try {
        return await hub.publishInstalledLatticePlugin(pluginId)
      } catch (err) {
        const message = client.latticeErrorMessage(err)
        logger.warn(`[Lattice] Failed to publish installed plugin '${pluginId}':`, err)
        return { ok: false, error: message }
      }
    }
  )

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

  /** 选「安装包目录 + 源码目录」两个目录后发布（源码与安装包是两份不同的 zip） */
  ipcMain.handle(LATTICE_IPC.hubPickUploadWithSource, async (): Promise<LatticeUploadResult> => {
    try {
      return await hub.pickAndUploadLatticePackageWithSource()
    } catch (err) {
      const message = client.latticeErrorMessage(err)
      logger.warn('[Lattice] Failed to select and upload plugin package with source:', err)
      return { ok: false, error: message }
    }
  })

  ipcMain.handle(
    LATTICE_IPC.hubUpload,
    async (_event, raw: unknown): Promise<LatticeUploadResult> => {
      const input = normalizeUploadSource(raw)
      if (!input) return { ok: false, error: '缺少插件包路径（source）' }
      return await hub.uploadLatticePackage(input.source, input.sourcePath)
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
        const applied = applyPluginsRoot(dir)
        if (applied.previousDir) {
          await remapWorkspacePathsUnderRoot(applied.previousDir, applied.dir)
        }
        broadcastWorkshopChanged()
        return { ok: true, dir: applied.dir }
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
        return {
          ok: false,
          enabled: settings.getLatticeAutoInstallMissing(),
          error: '参数不合法：需要布尔值'
        }
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
    async (
      _event,
      pluginIdRaw: unknown,
      strategyRaw: unknown
    ): Promise<LatticeResolveConflictResult> => {
      const pluginId = typeof pluginIdRaw === 'string' ? pluginIdRaw.trim() : ''
      const strategy =
        strategyRaw === 'local' || strategyRaw === 'cloud' || strategyRaw === 'merge'
          ? strategyRaw
          : null
      if (!pluginId || !strategy) return { ok: false, error: '参数不合法' }
      return await sync.resolveLatticeSyncConflict(pluginId, strategy)
    }
  )

  /** 把每个已安装且支持合并的插件的云端快照并进本机（非破坏性），再推回云端 */
  ipcMain.handle(
    LATTICE_IPC.mergeData,
    async (): Promise<LatticeMergeDataResult> => await sync.mergeAllLatticePluginData()
  )

  // 通道注册完再初始化：启动恢复/后台 pull 不会跑到未注册的 IPC 上
  initLattice()
}
