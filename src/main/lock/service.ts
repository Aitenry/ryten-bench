import { BrowserWindow, powerMonitor } from 'electron'
import logger from 'electron-log'
import { settingsStore } from '../context'
import { safeSend } from '../safe-send'
import { getMainWindow } from '../windows/window-manager'
import type {
  Lock,
  LockCodeChangeResult,
  LockScreenSnapshot,
  LockUnlockResult
} from '../types/settings'
import { DEFAULT_AUTO_LOCK_MINUTES, DEFAULT_LOCK_CODE, isAutoLockMinutes } from './constants'
import { hashLockCode, isLockCode, verifyLockCode } from './credentials'

/**
 * 锁屏状态机（主进程是**唯一真源**）。
 *
 * 旧实现的三个致命问题，也是「这个功能护不住数据」的根因：
 *  1. `locked` 只是渲染层的一个 `useState`：按 Ctrl+R 刷新、或渲染进程崩溃后主窗口重建，
 *     锁屏就消失了，内容原样露出来；
 *  2. 解锁码摘要通过 IPC 下发给渲染层、校验也在渲染层 —— 摘要可被读走，6 位数字的
 *     MD5 用普通显卡几秒就能爆破；
 *  3. 只有「按 Esc」这一个入口，人离开座位时永远不会锁。
 *
 * 现在：
 *  - `locked` 由主进程持有；窗口每次 `did-finish-load` 都会收到当前状态，刷新/重建都不解锁；
 *  - 校验在主进程（加盐 scrypt + 定时恒定延迟），摘要永不出主进程；连续失败按指数退避；
 *  - 空闲自动锁屏（powerMonitor.getSystemIdleTime）、最小化/隐藏、系统锁屏/休眠都会立刻锁；
 *  - 锁屏期间开启窗口级防截屏，截屏/录屏/共享只看到黑块。
 */

/** 失败几次以内不等待（再往上开始指数退避） */
const FREE_ATTEMPTS = 3
/** 退避上限 5 分钟 */
const MAX_RETRY_DELAY_MS = 5 * 60_000
/** 哪怕校验失败得再快，单次 IPC 也至少占用这么久，压低自动化爆破速率 */
const MIN_VERIFY_MS = 180
/** 空闲检查周期（秒级精度足够，太密只是白耗电） */
const IDLE_TICK_MS = 15_000

let locked = false
let failedAttempts = 0
let blockedUntil = 0
let usingDefaultCode = false
let idleTimer: ReturnType<typeof setInterval> | null = null
let watcherStarted = false
let defaultCodeProbe: Promise<void> | null = null

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 读取落盘的 lock 对象（设置文件可能被手改成字符串/数组，统一兜底成空对象） */
function readLockObject(): Partial<Lock> {
  const raw = settingsStore.get('lock')
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Partial<Lock>) : {}
}

/** 读盘并对字段做兜底（设置文件可能来自旧版本，也可能被手改坏） */
function readStoredLock(): { code: string; view: boolean; autoLockMinutes: number } {
  const raw = readLockObject()
  const code = typeof raw.code === 'string' ? raw.code : ''
  const view = raw.view === true
  const autoLockMinutes = isAutoLockMinutes(raw.autoLockMinutes)
    ? raw.autoLockMinutes
    : DEFAULT_AUTO_LOCK_MINUTES
  return { code, view, autoLockMinutes }
}

/** 合并写回（保留其它字段，绝不整键覆盖） */
function writeStoredLock(patch: Partial<Lock>): void {
  const raw = { view: false, ...readLockObject() }
  settingsStore.set('lock', { ...raw, ...patch })
}

/** 主进程持有的锁屏快照（渲染层通过 `lock-screen-state` / `lock-screen-changed` 拿到它） */
export function getLockScreenSnapshot(): LockScreenSnapshot {
  const lock = readStoredLock()
  return {
    enabled: lock.view,
    hasCode: Boolean(lock.code),
    usingDefaultCode: Boolean(lock.code) && usingDefaultCode,
    autoLockMinutes: lock.autoLockMinutes,
    locked: locked && lock.view
  }
}

/** 通用设置通道只允许看到「开关 + 自动锁屏」，解锁码摘要不出主进程 */
export function getPublicLockSettings(): { view: boolean; autoLockMinutes: number } {
  const lock = readStoredLock()
  return { view: lock.view, autoLockMinutes: lock.autoLockMinutes }
}

/**
 * 启动流程写完配置后刷新一次快照。
 *
 * 为什么需要：`startLockScreenWatcher()` 在 app ready 时就启动，而锁屏配置的首次落盘
 * 发生在其后的初始化任务里（`loadConfig`）。早读时配置还不存在，`usingDefaultCode`
 * 会停在 false，设置页的「仍是初始密码」提示就永远不出现。配置落盘后再探测一次。
 */
export function refreshLockScreenState(): void {
  probeDefaultCode()
  broadcast()
}

export function isLockScreenLocked(): boolean {
  return locked
}

function broadcast(): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    safeSend(win.webContents, 'lock-screen-changed', getLockScreenSnapshot())
  }
}

/**
 * 锁屏期间的窗口级防截屏。
 *
 * Windows 走 `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`、macOS 走
 * `NSWindowSharingNone`：截图 / 录屏 / 视频会议共享里这个窗口是黑块。
 * 解锁后立刻恢复，不影响用户自己截屏。
 */
function applyContentProtection(on: boolean): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  try {
    win.setContentProtection(on)
  } catch (error) {
    // Linux / 老版本 Electron 可能不支持：锁屏界面本身仍然生效，只是少了这层保护
    logger.debug('[LockScreen] setContentProtection unavailable:', error)
  }
}

/** 进入锁屏；返回是否真的锁上了（未启用 / 没有解锁码时不动） */
export function lockNow(reason: string): boolean {
  const lock = readStoredLock()
  if (locked) return false
  // 没有解锁码时绝不锁屏：宁可 Esc 没反应，也不能把人锁在一个进不去的界面里
  if (!lock.view || !lock.code) return false

  locked = true
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    // 锁屏前把开发者工具收掉：它开着时页面 DOM 仍然可读，锁屏就形同虚设
    try {
      win.webContents.closeDevTools()
    } catch {
      // 没开或平台不支持：忽略
    }
  }
  applyContentProtection(true)
  logger.info(`[LockScreen] Locked (${reason})`)
  broadcast()
  return true
}

/** 连续失败后的等待时长：前 3 次不等待，之后 5s → 10s → 20s … 最多 5 分钟 */
function throttleDelayMs(attempts: number): number {
  if (attempts <= FREE_ATTEMPTS) return 0
  const exponent = Math.min(attempts - FREE_ATTEMPTS - 1, 6)
  return Math.min(MAX_RETRY_DELAY_MS, 5_000 * 2 ** exponent)
}

function attemptsLeft(attempts: number): number {
  return Math.max(0, FREE_ATTEMPTS - attempts)
}

/**
 * 校验解锁码（渲染层唯一能做的解锁入口）。
 *
 * 无论成功失败都至少耗时 `MIN_VERIFY_MS`：6 位数字空间只有 100 万，若不限速，
 * 脚本跑一遍 UI 比爆破文件还快。配合指数退避，在线尝试变得不可行。
 */
export async function unlockWithCode(code: string): Promise<LockUnlockResult> {
  if (!locked) return { ok: true }

  const now = Date.now()
  if (now < blockedUntil) {
    return { ok: false, reason: 'throttled', retryAfterMs: blockedUntil - now }
  }

  const lock = readStoredLock()
  if (!lock.code) return { ok: false, reason: 'unavailable' }

  const normalized = String(code ?? '')
    .replace(/\D/g, '')
    .slice(0, 6)

  if (!isLockCode(normalized)) {
    failedAttempts += 1
    const retryAfterMs = throttleDelayMs(failedAttempts)
    if (retryAfterMs > 0) blockedUntil = Date.now() + retryAfterMs
    await sleep(MIN_VERIFY_MS)
    return {
      ok: false,
      reason: 'invalid',
      retryAfterMs,
      attemptsLeft: attemptsLeft(failedAttempts)
    }
  }

  const startedAt = Date.now()
  const { matched, legacy } = await verifyLockCode(normalized, lock.code)
  const elapsed = Date.now() - startedAt
  if (elapsed < MIN_VERIFY_MS) await sleep(MIN_VERIFY_MS - elapsed)

  if (!matched) {
    failedAttempts += 1
    const retryAfterMs = throttleDelayMs(failedAttempts)
    if (retryAfterMs > 0) blockedUntil = Date.now() + retryAfterMs
    logger.warn(`[LockScreen] Unlock failed (attempt ${failedAttempts})`)
    return {
      ok: false,
      reason: 'invalid',
      retryAfterMs,
      attemptsLeft: attemptsLeft(failedAttempts)
    }
  }

  // 旧 MD5 摘要：校验成功后原地升级为加盐 scrypt（升级失败不影响本次解锁）
  if (legacy) {
    try {
      writeStoredLock({ code: await hashLockCode(normalized) })
      logger.info('[LockScreen] Legacy code hash upgraded to scrypt')
    } catch (error) {
      logger.warn('[LockScreen] Failed to upgrade legacy code hash:', error)
    }
  }
  usingDefaultCode = normalized === DEFAULT_LOCK_CODE

  failedAttempts = 0
  blockedUntil = 0
  locked = false
  applyContentProtection(false)
  logger.info('[LockScreen] Unlocked')
  broadcast()
  return { ok: true }
}

/** 设置页的开关 / 自动锁屏时长（两者都可以通过通用设置通道之外的专用通道修改） */
export function configureLock(patch: {
  enabled?: boolean
  autoLockMinutes?: number
}): LockScreenSnapshot {
  const next: Partial<Lock> = {}
  if (typeof patch.enabled === 'boolean') {
    // 没有解锁码时不允许启用：否则锁屏 = 进不去的界面
    next.view = patch.enabled && Boolean(readStoredLock().code)
  }
  if (patch.autoLockMinutes !== undefined && isAutoLockMinutes(patch.autoLockMinutes)) {
    next.autoLockMinutes = patch.autoLockMinutes
  }
  if (Object.keys(next).length > 0) writeStoredLock(next)

  // 用户开启锁屏时重新确认一次「是不是还在用 123456」，设置页据此显示警告
  if (next.view === true) probeDefaultCode()

  if (next.view === false && locked) {
    locked = false
    applyContentProtection(false)
    logger.info('[LockScreen] Unlocked by disabling lock screen')
  }
  broadcast()
  return getLockScreenSnapshot()
}

/** 修改解锁码：旧码在主进程校验，摘要永不下发 */
export async function changeLockCode(
  oldCode: string,
  newCode: string
): Promise<LockCodeChangeResult> {
  if (!isLockCode(newCode)) return { ok: false, reason: 'invalid-new' }

  const lock = readStoredLock()
  if (!lock.code) {
    // 从未设置过：允许直接设新码（此时没有「原密码」可言）
    writeStoredLock({ code: await hashLockCode(newCode) })
    usingDefaultCode = newCode === DEFAULT_LOCK_CODE
    broadcast()
    return { ok: true }
  }

  const normalizedOld = String(oldCode ?? '')
    .replace(/\D/g, '')
    .slice(0, 6)
  const { matched } = await verifyLockCode(normalizedOld, lock.code)
  if (!matched) return { ok: false, reason: 'wrong-old' }

  try {
    writeStoredLock({ code: await hashLockCode(newCode) })
  } catch (error) {
    logger.error('[LockScreen] Failed to persist new code:', error)
    return { ok: false, reason: 'unavailable' }
  }
  usingDefaultCode = newCode === DEFAULT_LOCK_CODE
  // 修改密码不改变「是否锁屏」，但 usingDefaultCode 可能变了，仍广播一次让设置页刷新提示
  broadcast()
  logger.info('[LockScreen] Code changed')
  return { ok: true }
}

/** 探测当前摘要是不是出厂默认码（只有设置页的提示需要它；结果缓存，改码时重算） */
function probeDefaultCode(): void {
  if (defaultCodeProbe) return
  defaultCodeProbe = (async () => {
    const lock = readStoredLock()
    if (!lock.code) {
      usingDefaultCode = false
      return
    }
    const { matched } = await verifyLockCode(DEFAULT_LOCK_CODE, lock.code)
    // 探测期间用户可能刚好改了码：只有摘要没变才采信这次结果，避免旧结果覆盖新状态
    if (readStoredLock().code !== lock.code) return
    usingDefaultCode = matched
    broadcast()
  })()
    .catch((error) => {
      logger.warn('[LockScreen] Failed to probe default code:', error)
    })
    .finally(() => {
      defaultCodeProbe = null
    })
}

function checkIdleLock(): void {
  const lock = readStoredLock()
  if (locked || !lock.view || !lock.code || lock.autoLockMinutes <= 0) return
  try {
    const idleSeconds = powerMonitor.getSystemIdleTime()
    if (idleSeconds >= lock.autoLockMinutes * 60) lockNow('idle')
  } catch (error) {
    // 个别平台 / 无桌面会话拿不到空闲时间：自动锁屏降级为关闭，不影响手动锁屏
    logger.debug('[LockScreen] getSystemIdleTime unavailable:', error)
  }
}

/**
 * 启动锁屏（应用每次启动调用一次，且在窗口创建之前）。
 *
 * 为什么必须有：`locked` 只是主进程的内存态，进程一退出就归零——旧行为下
 * 「锁着屏 → 托盘退出 / 关掉应用 → 重新打开」就能直接看到全部内容，这个锁屏
 * 被一步操作就绕过了，等于没有。只要用户启用了锁屏且存在解锁码，每次启动的
 * 第一帧就应该是锁屏界面。
 *
 * 放在窗口创建之前调用：主窗口 `attachLockScreen` 在首次 `did-finish-load`
 * 补发的快照已经是 `locked=true`，界面不会先闪一下正文再被蒙层盖住。
 */
export function lockOnStartup(): boolean {
  return lockNow('startup')
}

/** 启动自动锁屏监听（幂等；registerLockIpc 在 app ready 后调用一次） */
export function startLockScreenWatcher(): void {
  if (watcherStarted) return
  watcherStarted = true

  probeDefaultCode()
  // 每次启动都先锁上：否则「退出应用再打开」就是绕过锁屏的捷径
  lockOnStartup()

  idleTimer = setInterval(checkIdleLock, IDLE_TICK_MS)
  // 不阻止进程退出
  idleTimer.unref?.()

  // 系统锁屏 / 休眠：用户离开的明确信号，立即锁
  try {
    powerMonitor.on('lock-screen', () => lockNow('system-lock'))
    powerMonitor.on('suspend', () => lockNow('suspend'))
  } catch (error) {
    logger.debug('[LockScreen] powerMonitor system events unavailable:', error)
  }
}

/** 锁屏期间屏蔽刷新 / 开发者工具快捷键（内容已在 DOM 里，不能靠 UI 挡住绕过） */
function isBlockedShortcut(input: Electron.Input): boolean {
  if (input.type !== 'keyDown' && input.type !== 'rawKeyDown') return false
  const key = (input.key || '').toLowerCase()
  const ctrl = input.control || input.meta
  if (key === 'f5' || key === 'f12') return true
  if (ctrl && (key === 'r' || key === 'j')) return true
  if (ctrl && input.shift && (key === 'i' || key === 'c' || key === 'r')) return true
  if (ctrl && input.alt && (key === 'i' || key === 'j')) return true
  return false
}

/**
 * 把主窗口接到锁屏状态机上（窗口重建时会重新接一次）：
 * - 每次页面加载完成都补发当前状态 —— 刷新 / 崩溃自愈后仍然是锁屏；
 * - 最小化、隐藏到托盘时立刻锁；
 * - 锁屏期间拦截刷新与开发者工具快捷键。
 */
export function attachLockScreen(win: BrowserWindow): void {
  applyContentProtection(locked)

  win.webContents.on('did-finish-load', () => {
    safeSend(win.webContents, 'lock-screen-changed', getLockScreenSnapshot())
  })

  win.on('minimize', () => {
    lockNow('minimize')
  })
  win.on('hide', () => {
    lockNow('hide')
  })

  win.webContents.on('before-input-event', (event, input) => {
    if (!locked) return
    if (isBlockedShortcut(input)) event.preventDefault()
  })

  // 开发态 F12 由 electron-toolkit 的快捷键助手直接打开 DevTools（它的 before-input-event
  // 比我们早注册，拦不住）。锁屏期间 DevTools 一开就关：DOM 里的文字虽然被 CSS 模糊，
  // Elements 面板仍然能读到，不能留这个后门。
  win.webContents.on('devtools-opened', () => {
    if (!locked) return
    try {
      win.webContents.closeDevTools()
    } catch {
      // 忽略
    }
  })
}
