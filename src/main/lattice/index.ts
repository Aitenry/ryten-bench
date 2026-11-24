import { BrowserWindow } from 'electron'
import logger from 'electron-log'
import * as client from './client'
import * as hub from './hub'
import { getLatticeBaseUrl, getLatticeAutoInstallMissing } from './settings'
import * as session from './session'
import * as sync from './sync'
import { setPluginSyncRequester } from '../plugins/context'
import { ensureProfileMatchesSession } from '../profiles/runtime'
import {
  LATTICE_IPC,
  type LatticeStatus,
  type LatticeSyncResult,
  type LatticeUploadProgress
} from './types'

/**
 * Lattice 插件中心的主进程装配层：
 * - 汇总状态（基址 + 会话 + 最近同步）并广播 `lattice:state-changed`；
 * - 启动时恢复登录态（只有 refresh token 的冷启动 → 刷新 → `/v1/me` 补身份/角色 → pull 一次）；
 * - 把 hub/sync 的钩子接到窗口广播上（模块间用 `configure*` 注入，避免循环 import）。
 *
 * 不在这里注册 IPC：通道注册在 `src/main/ipc/lattice.ts`（契约 §4），
 * 由 `registerCoreIpc()` 调用；`initLattice()` 由那边的 `registerLatticeIpc()` 调用一次。
 */

let initialized = false
let lastError: string | null = null

/** 向所有窗口发事件（窗口尚未创建时是空操作；渲染层挂载后会主动拉一次 `lattice:status`） */
function broadcast(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }
}

/** 组装当前状态（`lattice:status` 返回 / `lattice:state-changed` 载荷） */
export function getLatticeStatus(): LatticeStatus {
  const baseUrl = getLatticeBaseUrl()
  const snapshot = session.getLatticeSessionSnapshot()
  const lastSync = sync.getLastLatticeSyncResult()
  const status: LatticeStatus = {
    configured: baseUrl !== '',
    baseUrl,
    loggedIn: snapshot.loggedIn,
    // 缺失插件自动补齐开关（默认开启；同步详情里展示失败明细）
    autoInstallMissing: getLatticeAutoInstallMissing()
  }
  if (snapshot.user) status.user = snapshot.user
  if (snapshot.role) status.role = snapshot.role
  if (snapshot.expiresAt) status.expiresAt = snapshot.expiresAt
  if (lastError) status.lastError = lastError
  if (lastSync) {
    status.sync = {
      at: lastSync.at,
      pushed: lastSync.pushed,
      pulled: lastSync.pulled,
      conflicts: lastSync.conflicts,
      autoInstalled: lastSync.autoInstall?.installed.length ?? 0,
      autoInstallFailed: lastSync.autoInstall?.failed.length ?? 0,
      orphaned: lastSync.orphaned?.length ?? 0,
      ...(lastSync.error ? { error: lastSync.error } : {})
    }
  }
  return status
}

/** 广播状态变化（登录/登出/刷新失败/同步完成/基址变更后调用） */
export function broadcastLatticeStatus(): void {
  broadcast(LATTICE_IPC.stateChanged, getLatticeStatus())
}

/** 广播上传阶段进度 */
export function broadcastLatticeUploadProgress(progress: LatticeUploadProgress): void {
  broadcast(LATTICE_IPC.uploadProgress, progress)
}

/** 广播同步结果 */
export function broadcastLatticeSyncState(result: LatticeSyncResult): void {
  broadcast(LATTICE_IPC.syncState, result)
}

/** 记录最近一次错误（状态里展示；成功操作前清空） */
export function setLatticeLastError(message: string | null): void {
  lastError = message
}

export function getLatticeLastError(): string | null {
  return lastError
}

/**
 * 恢复 / 刷新登录态：有 refresh token 就刷新 → 取 `/v1/me`（补 username/display_name/role）→ pull 一次。
 *
 * 冷启动和「运行中原地切换账号数据空间」共用这一条路径，区别只在两处：
 * - 冷启动时旧会话可能还没补到 user id，取完 `/v1/me` 要重新核对数据空间（不一致就切）；
 * - 切换后身份已由调用方确定，直接按新空间 pull 即可。
 *
 * 失败语义：
 * - 刷新被服务端拒绝（401/409）→ client 已清会话并广播未登录；
 * - 网络/5xx → 保留 refresh token（离线启动不该把用户登出），状态里记 lastError。
 */
async function resumeLatticeSession(stage: 'startup' | 'profile-switch'): Promise<void> {
  if (!session.hasLatticeSession()) return
  try {
    await client.ensureLatticeAccessToken()
    const me = await client.fetchLatticeMe()
    lastError = null
    logger.info(
      stage === 'startup'
        ? `[Lattice] Restored login state on startup: ${me.user.username} (${me.role || 'unknown role'})`
        : `[Lattice] Login state refreshed after account data space switch: ${me.user.username} (${me.role || 'unknown role'})`
    )
    broadcastLatticeStatus()
    // 旧会话可能只有 token、这次 /v1/me 才补到 user id：数据空间要以重启后的身份为准。
    if (stage === 'startup' && !ensureProfileMatchesSession('session identity after /v1/me')) return
    // 启动/切换后 pull 一次（契约 §4）；push 由 plugin-state-changed 防抖触发
    await sync.syncLattice('pull')
  } catch (err) {
    const message = client.latticeErrorMessage(err)
    // 凭证失效时 authLostHandler 已广播过「登录已过期」；这里再补一条可诊断的 lastError
    if (client.isLatticeAuthError(err)) {
      lastError = '登录已过期，请重新登录'
    } else {
      lastError = message
    }
    logger.warn(`[Lattice] Failed to restore login state (${stage}): ${message}`)
    broadcastLatticeStatus()
  }
}

/**
 * 运行中切换账号数据空间后调用：先把新登录态广播出去，再按当前会话补一次 pull。
 *
 * 由 `profiles/live.ts` 在数据目录对调、DB 重连、插件重载之后调用——它不负责切数据，
 * 只负责让同步层从「新空间 + 新会话」重新起步（不刷新 token：刚登录/刚登出都是新鲜的）。
 */
export async function resumeLatticeAfterProfileSwitch(): Promise<void> {
  lastError = null
  broadcastLatticeStatus()
  await resumeLatticeSession('profile-switch')
}

/**
 * 初始化（由 `registerLatticeIpc()` 在窗口创建前调用一次）。
 *
 * 必须在 app ready 之后（`safeStorage`/`app.getPath` 依赖），当前调用点
 * `initPluginHost()` 正好满足。
 */
export function initLattice(): void {
  if (initialized) return
  initialized = true

  session.loadLatticeSession()

  // 刷新被拒 → client 清会话；这里负责状态广播
  client.setLatticeAuthLostHandler(() => {
    lastError = '登录已过期，请重新登录'
    broadcastLatticeStatus()
  })

  hub.configureLatticeHub({
    onUploadProgress: (progress) => broadcastLatticeUploadProgress(progress),
    onStateChanged: () => broadcastLatticeStatus()
  })

  sync.configureLatticeSync({
    onSyncState: (result) => broadcastLatticeSyncState(result),
    onStateChanged: () => broadcastLatticeStatus(),
    // 换机自动补齐：pull 时检测到本机缺失插件 → 复用 hub 的安装流水线（安装包 + 源码）
    installPlugin: (pluginId, version) => hub.installLatticePlugin(pluginId, version)
  })
  sync.initLatticeSync()
  // `ctx.requestSync()`：插件数据落库后标记「本机有未同步修改」并请求一次防抖 push
  // （pull 侧靠这个 dirty 标记避免用云端覆盖本机未同步的编辑）。
  setPluginSyncRequester((pluginId) => {
    sync.markLatticePluginDirty(pluginId)
    sync.scheduleLatticePush()
  })

  void resumeLatticeSession('startup')
}
