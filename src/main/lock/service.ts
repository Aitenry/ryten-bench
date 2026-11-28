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
 * Lock-screen state machine (the main process is the **single source of truth**).
 *
 * The three fatal problems of the old implementation, and the root cause of "this feature cannot
 * protect the data":
 *  1. `locked` was only a renderer `useState`: pressing Ctrl+R to reload, or the main window being
 *     recreated after a renderer crash, made the lock disappear and content was exposed as-is;
 *  2. the unlock-code hash was sent to the renderer over IPC and verification happened there too —
 *     the hash could be read out, and the MD5 of a 6-digit number falls to a plain GPU in seconds;
 *  3. the only entry point was "press Esc", so leaving the desk never locked anything.
 *
 * Now:
 *  - `locked` is held by the main process; the window receives the current state on every
 *    `did-finish-load`, so reload/recreate never unlocks;
 *  - verification runs in the main process (salted scrypt + a fixed minimum latency); the hash never
 *    leaves the main process; consecutive failures back off exponentially;
 *  - idle auto-lock (`powerMonitor.getSystemIdleTime`), minimize/hide, and system lock/suspend lock
 *    immediately;
 *  - while locked, window-level content protection is on: screenshots/recordings/shares show a black
 *    rectangle.
 */

/** How many failures are free before waiting (exponential backoff starts above that) */
const FREE_ATTEMPTS = 3
/** Backoff ceiling of 5 minutes */
const MAX_RETRY_DELAY_MS = 5 * 60_000
/** Even when verification fails fast, a single IPC call occupies at least this long, lowering automated brute-force rates */
const MIN_VERIFY_MS = 180
/** Idle check interval (second-level precision is enough; a tighter loop only wastes power) */
const IDLE_TICK_MS = 15_000

let locked = false
let failedAttempts = 0
let blockedUntil = 0
let usingDefaultCode = false
let idleTimer: ReturnType<typeof setInterval> | null = null
let watcherStarted = false
let defaultCodeProbe: Promise<void> | null = null

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Reads the persisted lock object (the settings file may have been hand-edited into a string/array; fall back to an empty object) */
function readLockObject(): Partial<Lock> {
  const raw = settingsStore.get('lock')
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Partial<Lock>) : {}
}

/** Reads from disk and falls back per field (the settings file may come from an older version or have been corrupted by hand) */
function readStoredLock(): { code: string; view: boolean; autoLockMinutes: number } {
  const raw = readLockObject()
  const code = typeof raw.code === 'string' ? raw.code : ''
  const view = raw.view === true
  const autoLockMinutes = isAutoLockMinutes(raw.autoLockMinutes)
    ? raw.autoLockMinutes
    : DEFAULT_AUTO_LOCK_MINUTES
  return { code, view, autoLockMinutes }
}

/** Merge write-back (keep other fields, never overwrite the whole key) */
function writeStoredLock(patch: Partial<Lock>): void {
  const raw = { view: false, ...readLockObject() }
  settingsStore.set('lock', { ...raw, ...patch })
}

/** Lock-screen snapshot held by the main process (the renderer gets it via `lock-screen-state` / `lock-screen-changed`) */
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

/** The general settings channel may only see "switch + auto-lock"; the unlock-code hash never leaves the main process */
export function getPublicLockSettings(): { view: boolean; autoLockMinutes: number } {
  const lock = readStoredLock()
  return { view: lock.view, autoLockMinutes: lock.autoLockMinutes }
}

/**
 * Refreshes the snapshot once after the startup flow has written the config.
 *
 * Why needed: `startLockScreenWatcher()` starts as soon as the app is ready, but the lock config is
 * first persisted later by an initialization task (`loadConfig`). Reading it early finds no config,
 * so `usingDefaultCode` stays false and the settings page's "still using the initial password" hint
 * would never appear. Probe again once the config is on disk.
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
 * Window-level content protection while locked.
 *
 * Windows uses `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`, macOS uses
 * `NSWindowSharingNone`: the window is a black rectangle in screenshots / recordings /
 * video-conference shares. Restored immediately on unlock so the user's own screenshots are
 * unaffected.
 */
function applyContentProtection(on: boolean): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  try {
    win.setContentProtection(on)
  } catch (error) {
    // Linux / older Electron may not support this: the lock screen itself still works, just without this layer
    logger.debug('[LockScreen] setContentProtection unavailable:', error)
  }
}

/** Enters the lock screen; returns whether it actually locked (does nothing when disabled / no unlock code) */
export function lockNow(reason: string): boolean {
  const lock = readStoredLock()
  if (locked) return false
  // Never lock without an unlock code: better that Esc does nothing than locking someone into an inaccessible screen
  if (!lock.view || !lock.code) return false

  locked = true
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    // Close the devtools before locking: while open, the page DOM stays readable and the lock is useless
    try {
      win.webContents.closeDevTools()
    } catch {
      // Not open or unsupported on this platform: ignore
    }
  }
  applyContentProtection(true)
  logger.info(`[LockScreen] Locked (${reason})`)
  broadcast()
  return true
}

/** Wait after consecutive failures: no wait for the first 3, then 5s → 10s → 20s … up to 5 minutes */
function throttleDelayMs(attempts: number): number {
  if (attempts <= FREE_ATTEMPTS) return 0
  const exponent = Math.min(attempts - FREE_ATTEMPTS - 1, 6)
  return Math.min(MAX_RETRY_DELAY_MS, 5_000 * 2 ** exponent)
}

function attemptsLeft(attempts: number): number {
  return Math.max(0, FREE_ATTEMPTS - attempts)
}

/**
 * Verifies the unlock code (the only unlock entry point the renderer has).
 *
 * It takes at least `MIN_VERIFY_MS` whether it succeeds or fails: the 6-digit space is only a
 * million values, and without rate limiting a script driving the UI would be faster than
 * brute-forcing the file. Combined with exponential backoff, online attempts become infeasible.
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

  // Legacy MD5 hash: upgrade it in place to salted scrypt after a successful verification (an upgrade failure does not affect this unlock)
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

/** Settings-page switch / auto-lock duration (both can be changed through dedicated channels besides the general settings channel) */
export function configureLock(patch: {
  enabled?: boolean
  autoLockMinutes?: number
}): LockScreenSnapshot {
  const next: Partial<Lock> = {}
  if (typeof patch.enabled === 'boolean') {
    // Do not allow enabling without an unlock code: otherwise the lock screen is a screen you cannot get into
    next.view = patch.enabled && Boolean(readStoredLock().code)
  }
  if (patch.autoLockMinutes !== undefined && isAutoLockMinutes(patch.autoLockMinutes)) {
    next.autoLockMinutes = patch.autoLockMinutes
  }
  if (Object.keys(next).length > 0) writeStoredLock(next)

  // Re-check "still using 123456" when the user enables the lock screen; the settings page shows a warning based on it
  if (next.view === true) probeDefaultCode()

  if (next.view === false && locked) {
    locked = false
    applyContentProtection(false)
    logger.info('[LockScreen] Unlocked by disabling lock screen')
  }
  broadcast()
  return getLockScreenSnapshot()
}

/** Changes the unlock code: the old code is verified in the main process and the hash is never sent out */
export async function changeLockCode(
  oldCode: string,
  newCode: string
): Promise<LockCodeChangeResult> {
  if (!isLockCode(newCode)) return { ok: false, reason: 'invalid-new' }

  const lock = readStoredLock()
  if (!lock.code) {
    // Never set before: allow setting a new code directly (there is no "original password" to speak of)
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
  // Changing the password does not change whether the screen is locked, but usingDefaultCode may have changed, so broadcast once to refresh the settings-page hint
  broadcast()
  logger.info('[LockScreen] Code changed')
  return { ok: true }
}

/** Probes whether the current hash is the factory-default code (only the settings-page hint needs it; cached, recomputed when the code changes) */
function probeDefaultCode(): void {
  if (defaultCodeProbe) return
  defaultCodeProbe = (async () => {
    const lock = readStoredLock()
    if (!lock.code) {
      usingDefaultCode = false
      return
    }
    const { matched } = await verifyLockCode(DEFAULT_LOCK_CODE, lock.code)
    // The user may change the code during the probe: only trust this result if the hash is unchanged, so a stale result does not overwrite the new state
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
    // Some platforms / headless sessions cannot read idle time: auto-lock degrades to off, manual locking is unaffected
    logger.debug('[LockScreen] getSystemIdleTime unavailable:', error)
  }
}

/**
 * Locks at startup (called once per app launch, before the window is created).
 *
 * Why required: `locked` is only main-process memory and resets when the process exits — with the
 * old behavior "locked → quit from the tray / close the app → reopen" exposed everything, so a
 * single action bypassed the lock and it might as well not exist. As long as the user has enabled
 * the lock screen and an unlock code exists, the first frame of every launch should be the lock
 * screen.
 *
 * Called before the window is created: the snapshot re-sent by the main window's `attachLockScreen`
 * on the first `did-finish-load` is already `locked=true`, so the UI never flashes the content
 * before the overlay covers it.
 */
export function lockOnStartup(): boolean {
  return lockNow('startup')
}

/** Starts the auto-lock watcher (idempotent; registerLockIpc calls it once after the app is ready) */
export function startLockScreenWatcher(): void {
  if (watcherStarted) return
  watcherStarted = true

  probeDefaultCode()
  // Lock on every launch: otherwise "quit the app and reopen it" is a shortcut around the lock screen
  lockOnStartup()

  idleTimer = setInterval(checkIdleLock, IDLE_TICK_MS)
  // Do not keep the process alive
  idleTimer.unref?.()

  // System lock / suspend: clear signals that the user left, lock immediately
  try {
    powerMonitor.on('lock-screen', () => lockNow('system-lock'))
    powerMonitor.on('suspend', () => lockNow('suspend'))
  } catch (error) {
    logger.debug('[LockScreen] powerMonitor system events unavailable:', error)
  }
}

/** Blocks reload / devtools shortcuts while locked (the content is already in the DOM, so the UI cannot be the only defense) */
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
 * Wires the main window into the lock-screen state machine (rewired when the window is recreated):
 * - re-send the current state whenever a page finishes loading — a reload / crash recovery is still
 *   locked;
 * - lock immediately on minimize or hide-to-tray;
 * - block reload and devtools shortcuts while locked.
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

  // In dev, F12 opens DevTools directly through electron-toolkit's shortcut helper (its
  // before-input-event is registered earlier than ours, so we cannot intercept it). While locked,
  // close DevTools as soon as it opens: the text in the DOM is CSS-blurred, but the Elements panel
  // can still read it, so this backdoor must not stay open.
  win.webContents.on('devtools-opened', () => {
    if (!locked) return
    try {
      win.webContents.closeDevTools()
    } catch {
      // Ignore
    }
  })
}
