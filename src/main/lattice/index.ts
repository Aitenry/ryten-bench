import { app, BrowserWindow } from 'electron'
import logger from 'electron-log'
import * as client from './client'
import * as hub from './hub'
import { getLatticeBaseUrl, getLatticeAutoInstallMissing } from './settings'
import * as session from './session'
import * as sync from './sync'
import { setPluginSyncRequester } from '../plugins/context'
import { ANONYMOUS_PROFILE } from '../profiles/manager'
import {
  ensureProfileMatchesSession,
  getActiveProfileKey,
  isAccountProfileReady,
  isProfileRestartScheduled,
  requestProfileRestart
} from '../profiles/runtime'
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
      pushedRows: lastSync.pushedRows ?? 0,
      pulledRows: lastSync.pulledRows ?? 0,
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
 * 会话被动失效（refresh 被拒 / 被别处踢下线）后，把本地数据空间切回 anonymous。
 *
 * 为什么必须做：`clearLatticeSession()` 只清登录态，账号数据目录（RytenBenchDB /
 * plugin-state / lattice-sync.json）仍停在原账号上。用户看到「未登录」，后续的插件数据、
 * 会话却继续写进旧账号容器；重启后 anonymous 生效，这段内容就像凭空消失（其实在
 * `profiles/u-<id>/` 里）。显式退出登录一直有这一步，被动失效没有——这里补齐。
 *
 * 延迟一拍再切：显式退出登录也会先让 refresh 失败（服务端吊销 token），如果那次正在
 * 切空间，直接撞上去只会得到「正在切换」。等它先走，切完/切起来后这里自然跳过。
 */
let authLostAlignmentTimer: NodeJS.Timeout | null = null

function alignProfileAfterAuthLost(): void {
  if (authLostAlignmentTimer) return
  authLostAlignmentTimer = setTimeout(() => {
    authLostAlignmentTimer = null
    void (async () => {
      try {
        if (session.hasLatticeSession()) return
        if (isProfileRestartScheduled()) return
        const active = getActiveProfileKey()
        if (!isAccountProfileReady() || active === null || active === ANONYMOUS_PROFILE) return
        const live = await import('../profiles/live')
        const switched = await live.switchAccountProfile({
          reason: 'auth lost -> anonymous',
          targetKey: ANONYMOUS_PROFILE
        })
        if (switched.ok || switched.restarted) return
        if (switched.error?.includes('正在切换')) return
        logger.warn(
          `[Lattice] Failed to move to the anonymous data space after auth loss, restarting: ${switched.error ?? 'unknown'}`
        )
        requestProfileRestart('auth lost -> anonymous')
      } catch (err) {
        logger.warn('[Lattice] Failed to align the data space after auth loss:', err)
        requestProfileRestart('auth lost -> anonymous')
      }
    })()
  }, 700)
  authLostAlignmentTimer.unref?.()
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
  /**
   * 启动期会话被丢弃（换了基址 / 版本不符 / refresh token 解不开）：`initAccountProfile()`
   * 是按**文件里还有会话**选的账号容器，现在会话没了，数据空间必须回到 anonymous。
   * 先落一条重启请求：数据库还没就绪，原地切换不可用；重启后会按无会话落到 anonymous。
   */
  if (
    !session.hasLatticeSession() &&
    getActiveProfileKey() !== null &&
    getActiveProfileKey() !== ANONYMOUS_PROFILE
  ) {
    logger.warn(
      '[Lattice] Startup session was discarded (base URL changed / unreadable token); restarting into the anonymous data space'
    )
    requestProfileRestart('startup session discarded -> anonymous')
  }

  // 刷新被拒 → client 清会话；这里负责状态广播 + 把数据空间切回 anonymous
  client.setLatticeAuthLostHandler(() => {
    lastError = '登录已过期，请重新登录'
    broadcastLatticeStatus()
    alignProfileAfterAuthLost()
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

  initAutoPull()
  void resumeLatticeSession('startup')
}

/** 像 IM 一样「自动拉取」：登录期间每 60s pull 一次，窗口重新聚焦时也补一次（5s 防抖） */
const AUTO_PULL_INTERVAL_MS = 60_000
const FOCUS_PULL_DEBOUNCE_MS = 5_000
let autoPullTimer: NodeJS.Timeout | null = null
let focusPullTimer: NodeJS.Timeout | null = null

function pullIfLoggedIn(): void {
  if (!session.hasLatticeSession()) return
  // 后台自动 pull：没有数据变化时不弹提示（silent），避免每 60s 打扰
  void sync.syncLattice({ direction: 'pull', silent: true })
}

function initAutoPull(): void {
  if (autoPullTimer) return
  autoPullTimer = setInterval(pullIfLoggedIn, AUTO_PULL_INTERVAL_MS)
  autoPullTimer.unref?.()
  app.on('browser-window-focus', () => {
    if (!session.hasLatticeSession() || focusPullTimer) return
    focusPullTimer = setTimeout(() => {
      focusPullTimer = null
      pullIfLoggedIn()
    }, FOCUS_PULL_DEBOUNCE_MS)
    focusPullTimer.unref?.()
  })
}
