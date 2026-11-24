import { app, dialog } from 'electron'
import logger from 'electron-log'
import {
  ANONYMOUS_PROFILE,
  applyProfile,
  deriveProfileKey,
  readSessionIdentity,
  type ApplyProfileResult,
  type SessionIdentity
} from './manager'

/**
 * 账号级本地数据空间的**运行时接线**（Electron 相关部分都收在这里，便于 manager 单测）。
 *
 * - 应用一启动（`whenReady` 最早、DB/插件装载之前）调用 `initAccountProfile()`，
 *   让根目录变成「当前登录账号（或未登录 anonymous）」的数据空间；
 * - 登录 / 登出 / 改基址导致身份变化时，优先调用 `profiles/live.ts` 的
 *   `switchAccountProfile()` **原地切换**（不重启应用）；只有切换条件不满足
 *   （初始化还没跑完）或切换失败时才退回 `requestProfileRestart()` 重启；
 * - `profileSyncGuard()` 给同步层用：数据空间与登录身份不一致时**暂停同步**，
 *   避免「刚登录还没切换完」的窗口把 A 账号的数据推进 B 账号。
 */

let activeKey: string | null = null
let ready = false
let restartScheduled = false

/** 应用启动早期调用一次（必须在 initPluginHost / 打开数据库之前）；返回 false 表示已退出 */
export function initAccountProfile(): boolean {
  const userDataDir = app.getPath('userData')
  try {
    const identity = readSessionIdentity(userDataDir)
    const desired = deriveProfileKey(identity)
    const result = applyProfile(userDataDir, desired, identity)
    activeKey = desired
    ready = true
    logApplyResult(result, desired)
    return true
  } catch (err) {
    activeKey = null
    ready = false
    logger.error(
      '[Profiles] 账号数据空间初始化失败：为避免串号，本次运行会暂停云同步。请检查 userData/profiles 权限或磁盘空间。',
      err
    )
    // 数据目录对调失败时不继续启动：否则可能用「空/错账号」的库打开界面，
    // 看起来像数据丢了（其实还在 profiles 里等下次恢复）。宁可退出让用户重试。
    try {
      dialog.showErrorBox(
        '账号数据空间初始化失败',
        '无法准备当前账号的本地数据目录（可能是文件被占用或磁盘空间不足）。\n' +
          '应用将退出，请关闭占用该目录的程序后重试；数据没有被删除。'
      )
    } catch {
      // 对话框失败也不能继续跑
    }
    app.exit(1)
    return false
  }
}

/** 写一条切换结果日志（原地切换与启动期用同一条格式，便于按 key 串起整段日志） */
export function logApplyResult(result: ApplyProfileResult, key: string): void {
  const parts = [`key=${key}`]
  if (result.from) parts.push(`from=${result.from}`)
  if (result.claimedExisting) parts.push('claimedExisting=1')
  if (result.recovered) parts.push('recovered=1')
  if (result.moved.length > 0) parts.push(`moved=${result.moved.join(',')}`)
  if (result.conflicts.length > 0) parts.push(`conflicts=${result.conflicts.join(',')}`)
  logger.info(`[Profiles] 账号本地数据空间：${parts.join(' ')}`)
}

/** 原地切换成功后更新「本进程正在使用的数据空间」（`profiles/live.ts` 调用） */
export function setActiveProfileKey(key: string): void {
  activeKey = key
}

/** 本次进程使用的账号数据空间（初始化失败时为 null） */
export function getActiveProfileKey(): string | null {
  return activeKey
}

export function isAccountProfileReady(): boolean {
  return ready
}

/** 当前登录态（以**磁盘上的会话文件**为准，和启动时选空间的口径一致） */
export function currentSessionProfileKey(): string {
  const identity: SessionIdentity = readSessionIdentity(app.getPath('userData'))
  return deriveProfileKey(identity)
}

/**
 * 数据空间与登录身份是否一致。
 *
 * 不一致的两种典型时刻：刚登录/刚登出、原地切换还没做完；或旧会话启动后才补到 user id。
 * 这时同步必须停，等 `profiles/live.ts` 把数据空间换过来（或启动期按会话对调完）。
 */
export function profileMatchesSession(): boolean {
  if (!ready || activeKey === null) return false
  return currentSessionProfileKey() === activeKey
}

/**
 * 同步前的守卫：返回错误文案表示「本次不允许同步」，null 表示可以。
 *
 * - 初始化失败 → 拒绝（宁可不同步，也不能把数据写进错误账号）；
 * - 数据空间与登录身份不一致 → 拒绝（切换完成/重启后自动恢复）。
 */
export function profileSyncGuard(): string | null {
  if (!ready) return '本地账号数据空间初始化失败，已暂停同步（详见日志）'
  const identity = readSessionIdentity(app.getPath('userData'))
  // 已登录但拿不到 user id：无法判断数据该归谁，宁可不发也不串号
  if (identity.loggedIn && (identity.userId ?? '') === '') {
    return '登录账号缺少用户 id，已暂停同步（请重新登录）'
  }
  if (!profileMatchesSession()) return '账号数据空间正在切换，请稍候再同步'
  return null
}

/** 登录态是否指向未登录空间（供 IPC 判断要不要切回 anonymous） */
export function sessionIsAnonymous(): boolean {
  return currentSessionProfileKey() === ANONYMOUS_PROFILE
}

/**
 * 安排一次重启来切换本地数据空间（**回退路径**）。
 *
 * 正常路径是 `profiles/live.ts` 的原地切换；只有两种情况会走到这里：
 * - 原地切换的前置条件不满足（应用初始化还没完成、数据库还没就绪）；
 * - 原地切换失败（例如目录被别的进程占用），必须靠重启把半完成的对调收干净。
 *
 * 不在这里直接搬数据：`profiles/.active.json` 仍表示「根目录当前属于谁」，
 * 重启后 `initAccountProfile()` 按磁盘会话算出目标 key 再对调，逻辑只有一份。
 */
export function requestProfileRestart(reason: string): void {
  if (restartScheduled) return
  restartScheduled = true
  logger.info(`[Profiles] 需要重启以切换账号数据空间：${reason}（原地切换不可用或失败）`)
  // 给 IPC 响应/日志落盘留一点时间，再重启（dev 与打包版都走同一条路径）
  setTimeout(() => {
    try {
      app.relaunch()
    } catch (err) {
      logger.warn('[Profiles] app.relaunch() 失败，将直接退出（请手动重新打开应用）:', err)
    }
    app.exit(0)
  }, 600)
}

/** 会话刷新后核对身份（例如旧会话启动后才从 /v1/me 补到 user id） */
export function ensureProfileMatchesSession(reason: string): boolean {
  if (profileMatchesSession()) return true
  logger.info(`[Profiles] 当前数据空间 ${activeKey ?? 'null'} 与登录身份不一致（${reason}）`)
  requestProfileRestart(reason)
  return false
}
