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
 * Plugin center IPC (core, not a plugin).
 *
 * Everything goes through `ipcMain.handle`:
 * - Login/logout/me/base URL/sync/upload/install normalize failures into displayable text in the
 *   **business layer**; methods needing a transaction result return `{ok:false,error}` (exceptions
 *   are not thrown to the renderer);
 * - Read interfaces such as list/detail return data directly, and failures are thrown for the
 *   renderer to handle;
 * - Events (state-changed / upload-progress / sync-state) are broadcast in lattice/index.ts; this
 *   file only handles channel registration and argument validation.
 *
 * All arguments are validated at runtime: IPC input comes from the renderer process, so its shape
 * must not be assumed.
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

/** `lattice:login` input: `{baseUrl?,username,password}` */
function normalizeLoginInput(raw: unknown): LatticeLoginInput | null {
  const record = asRecord(raw)
  if (!record) return null
  const username = readString(record.username)
  const password = readString(record.password)
  if (username.trim() === '' || password === '') return null
  const baseUrl = readOptionalString(record.baseUrl)
  return baseUrl ? { baseUrl, username, password } : { username, password }
}

/** `lattice:hub-list` input: `{q?,category?,sort?,page?,pageSize?}` */
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
 * `lattice:sync` argument normalization:
 * - `{direction}` / bare string `'push'|'pull'|'both'`;
 * - extended form `{direction, installMissing?}` (whether this pull auto-installs missing plugins;
 *   defaults to the setting).
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

/** `lattice:uploadSource` input: `{source, sourcePath?}`; a bare path string is also accepted */
function normalizeUploadSource(raw: unknown): { source: string; sourcePath?: string } | null {
  if (typeof raw === 'string') return raw.trim() !== '' ? { source: raw } : null
  const record = asRecord(raw)
  const source = readOptionalString(record?.source)
  if (!source) return null
  const sourcePath = readOptionalString(record?.sourcePath)
  return sourcePath ? { source, sourcePath } : { source }
}

/**
 * `lattice:hub-install` input: `(pluginId, version?)`; also accepts `{pluginId|plugin_id,
 * version?}` (so alternative renderer wrappers do not break outright).
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
 * If a base URL is passed before login: persist it first and handle "server switch = old token
 * invalidated". Returning error text means this login cannot continue (e.g. the setting is locked
 * by an environment variable).
 */
function applyLoginBaseUrl(baseUrl: string): string | null {
  const previous = settings.getLatticeBaseUrl()
  const normalized = settings.setLatticeBaseUrl(baseUrl)
  if (normalized !== previous) {
    const hadSession = session.hasLatticeSession()
    session.clearLatticeSession()
    // lattice-sync.json is not cleared: account-level data spaces are partitioned by "base URL +
    // user", so the old account's rev cache stays in the old container and switching servers does
    // not pollute the new account; the space switch happens on restart.
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
 * Single plugin id input: a bare string; `{pluginId|plugin_id}` is also accepted (so alternative
 * renderer wrappers do not break).
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
 * `lattice:republish` input: `{pluginId, version, changelog?, sourceDir?}`.
 *
 * Underscore naming (`plugin_id`/`source_dir`) is also accepted; whether the version is valid /
 * increasing is validated by the business layer and the platform (business-layer errors are
 * readable text and are returned to the UI directly).
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
      // Account switch: revoke the old account's refresh token on a best-effort basis (a failure
      // does not block the new login)
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

      // Account switch (including logged out -> login, A -> B): the local data space must change
      // along with the new account. This can now happen **in place** (no app restart):
      // suspend/swap/reconnect, then refresh the main window; when preconditions are not met
      // (initialization not finished) or the switch fails, live.ts falls back to app.relaunch().
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
        // Rare cases such as a switch already in progress (concurrent login): report the error
        // honestly instead of letting the UI believe the account was switched
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

      // Pull once after login (in the background; the result is broadcast via lattice:sync-state)
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
    // After logout there must not be another failed "logged out" push that overwrites the state
    sync.cancelPendingLatticePush()
    setLatticeLastError(null)
    broadcastLatticeStatus()
    // Logout = return to the logged-out local space (anonymous): swap in place and refresh the UI
    // without restarting the app. If the switch fails or preconditions are unmet, live.ts falls
    // back to restarting the app, as before.
    const active = getActiveProfileKey()
    if (isAccountProfileReady() && active !== null && active !== ANONYMOUS_PROFILE) {
      const switched = await switchAccountProfile({
        reason: 'logout -> anonymous',
        targetKey: ANONYMOUS_PROFILE
      })
      /**
       * A failed switch (not "restart required") must not be reported as success: the local session
       * is already cleared but the data space still belongs to the old account, so the UI must tell
       * the user the logout did not finish; otherwise they keep writing into the old account
       * container while logged out. The restart path (restarted) counts as success: the app comes
       * right back and lands in anonymous at startup because there is no session.
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
   * Changing the base URL also switches back to the anonymous data space (possibly awaiting an
   * in-place switch), so this is declared separately with an explicit return type and the
   * registration site only forwards once (a very long signature would make the ipcMain.handle line
   * wrap into three lines).
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
        // Account-level data spaces are partitioned by "base URL + user": the old account's data
        // and rev stay in the old container, so return to the anonymous space in place (no app
        // restart) and then refresh the main window.
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
         * 404 = the plugin was not published to the platform (installed locally / removed from the
         * platform), which is a normal state of the detail page, not an IPC failure: return null so
         * the page renders it as "not yet published". Throwing here made Electron log an
         * `Error occurred in handler for 'lattice:hub-detail': ... 404` line on every open of a
         * local plugin's details, flooding the main-process log.
         */
        if (err instanceof client.LatticeApiError && err.status === 404) return null
        throw err
      }
    }
  )

  /**
   * Publish a **locally installed** plugin directly (package + source): the detail page's "publish
   * to plugin center" uses this instead of showing a system directory picker and making the user
   * find the install directory again.
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

  /**
   * Pick both the package directory and the source directory, then publish (the source and the
   * package are two separate zips).
   */
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

  // ---------- Source lifecycle ----------

  /** Current source directory (path/version/managed; `{path:null}` when there is no source) */
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

  /**
   * Locally installed plugin package directory (userData/plugins/<id>; used for publishing after a
   * local install).
   */
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
   * Edit in a conversation: create or reuse a plugin workspace for the source directory and open a
   * plugin topic; fall back to the file manager if that is not possible. Returns
   * `{ok:true,workspaceId,topicId}` or `{ok:true,opened:'folder'}` (honest: it never pretends a
   * conversation was opened).
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

  /**
   * Republish a new version (package + source uploaded together; a 409 becomes a readable error).
   */
  ipcMain.handle(
    LATTICE_IPC.republish,
    async (_event, raw: unknown): Promise<LatticeRepublishResult> => {
      const input = normalizeRepublishInput(raw)
      if (!input) return { ok: false, error: '参数非法：需要 {pluginId, version}' }
      return await hub.republishLatticePlugin(input)
    }
  )

  /**
   * Download the package / source archive locally (shows a save dialog; cancel is not a failure).
   */
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
   * Show a directory picker and batch-publish the plugins under a local source directory to the
   * platform (package + source). The second argument is an **explicit path** (normally not passed
   * by the UI; used by automation/tooling and also for setting the local plugin source root in one
   * step after an import).
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
   * Explicitly set the plugin storage path and apply it immediately (called after importing a local
   * directory in the plugin center).
   *
   * Only a non-empty string is accepted and resolved to an absolute path; omitting it is an error
   * (clearing the path goes through the settings page, not here, so a misclick cannot wipe the
   * whole plugin list).
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
   * Sync details: automatic-install success/failure details and orphan records from the last sync
   * (failure reasons are not silent). The plugin repository's "sync details" dialog calls this when
   * the sync bar shows automatic installs or orphan records.
   */
  ipcMain.handle(LATTICE_IPC.syncDetails, async (): Promise<LatticeSyncDetails> => {
    return sync.getLatticeSyncDetails()
  })

  /**
   * "Auto-install missing plugins" toggle (persisted; on by default).
   * When off, a pull only puts missing plugins into `pending` instead of installing them; orphan
   * records already marked remain in the details.
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

  /**
   * Unresolved plugin data conflicts (including cloud snapshots from the extra pull, for "use
   * local/use cloud" comparison).
   */
  ipcMain.handle(LATTICE_IPC.syncConflicts, async (): Promise<LatticeSyncConflict[]> => {
    return await sync.listLatticeSyncConflictsDetailed()
  })

  /**
   * Resolve one conflict explicitly: local = local overwrites cloud (force), cloud = cloud
   * overwrites local.
   */
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

  /**
   * Merge the cloud snapshot of every installed, merge-capable plugin into the local side
   * (non-destructive), then push it back to the cloud.
   */
  ipcMain.handle(
    LATTICE_IPC.mergeData,
    async (): Promise<LatticeMergeDataResult> => await sync.mergeAllLatticePluginData()
  )

  // Initialize only after the channels are registered, so startup restore/background pull never
  // lands on unregistered IPC
  initLattice()
}
