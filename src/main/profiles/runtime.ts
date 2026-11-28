import { app, dialog } from 'electron'
import logger from 'electron-log'
import { settingsStore } from '../context'
import type { HarnessSettings } from '../types/settings'
import {
  ANONYMOUS_PROFILE,
  applyProfile,
  deriveProfileKey,
  readSessionIdentity,
  type ApplyProfileResult,
  type SessionIdentity
} from './manager'

/**
 * **Runtime wiring** for the account-level local data space (all Electron-related parts are
 * collected here so manager can be unit-tested).
 *
 * - At app startup (`whenReady` at the earliest, before DB/plugin loading) call
 *   `initAccountProfile()`, making the root directory the data space of "the currently logged-in
 *   account (or the logged-out anonymous one)";
 * - when login / logout / base URL changes alter the identity, prefer `switchAccountProfile()` in
 *   `profiles/live.ts` for an **in-place switch** (no app restart); fall back to
 *   `requestProfileRestart()` only when the switch conditions do not hold (initialization has not
 *   finished) or the switch fails;
 * - `profileSyncGuard()` is for the sync layer: **pause sync** when the data space and the login
 *   identity do not match, avoiding the window "just logged in but the switch is not done yet"
 *   writing A's data into B's account.
 */

let activeKey: string | null = null
let ready = false
let restartScheduled = false
/** An in-place swap of the account data space is running (disk-writing actions such as install/uninstall/publish must avoid this period) */
let switchInProgress = false

/** Whether the account data space is being switched */
export function isProfileSwitchInProgress(): boolean {
  return switchInProgress
}

/** Set by `profiles/live.ts` before and after the switch */
export function setProfileSwitchInProgress(value: boolean): void {
  switchInProgress = value
}

/**
 * After the account data space changes, clear the sidebar's "current content per side" references.
 *
 * `activeMode` / `workContent` / `chatContent` / `pluginContent` live in the **machine-level**
 * `settings.json`, but the workspaceId / topicId they record are **account database auto-increment
 * ids**. Without clearing them, after switching accounts `restoreLastContent` queries the new
 * database with A's ids: it either creates a plugin workspace and overwrites the just-aligned active
 * workspace, or hits an unrelated conversation (cross-talk). Machine-level config such as
 * `pluginsPath` / `memoryPath` is kept; only "which content was selected" is dropped.
 *
 * Shared by startup and runtime switching (the startup swap happens in `initAccountProfile`,
 * before the renderer exists).
 */
export function clearAccountScopedContentSelections(): void {
  try {
    const harness = settingsStore.get('harness') as HarnessSettings | undefined
    if (!harness) return
    const next: HarnessSettings = { ...harness }
    delete next.activeMode
    delete next.workContent
    delete next.chatContent
    delete next.pluginContent
    settingsStore.set('harness', next)
    logger.info(
      '[Profiles] Cleared the sidebar content selection remembered for the previous account'
    )
  } catch (err) {
    logger.warn('[Profiles] Failed to clear the previous account sidebar selection:', err)
  }
}

/** Called once early at app startup (must be before initPluginHost / opening the database); returns false when the app has exited */
export function initAccountProfile(): boolean {
  const userDataDir = app.getPath('userData')
  try {
    const identity = readSessionIdentity(userDataDir)
    const desired = deriveProfileKey(identity)
    const result = applyProfile(userDataDir, desired, identity)
    activeKey = desired
    ready = true
    logApplyResult(result, desired)
    /**
     * This startup really swapped the account container (from differs from the target): the sidebar
     * content remembered by the previous run are all auto-increment ids from the old account
     * database and must be cleared before the renderer restores, otherwise they cross over into the
     * new account's conversations.
     */
    if (result.from && result.from !== desired) clearAccountScopedContentSelections()
    return true
  } catch (err) {
    activeKey = null
    ready = false
    logger.error(
      '[Profiles] 账号数据空间初始化失败：为避免串号，本次运行会暂停云同步。请检查 userData/profiles 权限或磁盘空间。',
      err
    )
    // When the data directory swap fails, do not continue starting: otherwise the UI may open with
    // an "empty/wrong account" database, which looks like data loss (it is actually still in
    // profiles waiting for the next recovery). Better to exit and let the user retry.
    try {
      dialog.showErrorBox(
        '账号数据空间初始化失败',
        '无法准备当前账号的本地数据目录（可能是文件被占用或磁盘空间不足）。\n' +
          '应用将退出，请关闭占用该目录的程序后重试；数据没有被删除。'
      )
    } catch {
      // The dialog failing must not keep it running either
    }
    app.exit(1)
    return false
  }
}

/** Write a switch result log (in-place switch and startup use the same format, so a whole log stretch can be followed by key) */
export function logApplyResult(result: ApplyProfileResult, key: string): void {
  const parts = [`key=${key}`]
  if (result.from) parts.push(`from=${result.from}`)
  if (result.claimedExisting) parts.push('claimedExisting=1')
  if (result.recovered) parts.push('recovered=1')
  if (result.moved.length > 0) parts.push(`moved=${result.moved.join(',')}`)
  if (result.conflicts.length > 0) parts.push(`conflicts=${result.conflicts.join(',')}`)
  logger.info(`[Profiles] 账号本地数据空间：${parts.join(' ')}`)
}

/** Update "the data space this process is using" after a successful in-place switch (called by `profiles/live.ts`) */
export function setActiveProfileKey(key: string): void {
  activeKey = key
}

/** The account data space used by this process (null when initialization failed) */
export function getActiveProfileKey(): string | null {
  return activeKey
}

export function isAccountProfileReady(): boolean {
  return ready
}

/** Current login state (based on the **on-disk session file**, consistent with how the space is chosen at startup) */
export function currentSessionProfileKey(): string {
  const identity: SessionIdentity = readSessionIdentity(app.getPath('userData'))
  return deriveProfileKey(identity)
}

/**
 * Whether the data space matches the login identity.
 *
 * Two typical mismatched moments: just logged in / just logged out with the in-place switch not yet
 * done; or the user id only arrives after an old session started. Sync must stop then, until
 * `profiles/live.ts` swaps the data space (or startup finishes swapping per the session).
 */
export function profileMatchesSession(): boolean {
  if (!ready || activeKey === null) return false
  return currentSessionProfileKey() === activeKey
}

/**
 * Guard before syncing: an error message means "this sync is not allowed", null means it is.
 *
 * - initialization failed -> reject (better not to sync than to write data into the wrong account);
 * - data space and login identity mismatch -> reject (recovers automatically after the switch
 *   completes / restart).
 */
export function profileSyncGuard(): string | null {
  if (!ready) return '本地账号数据空间初始化失败，已暂停同步（详见日志）'
  const identity = readSessionIdentity(app.getPath('userData'))
  // Logged in but no user id: cannot tell which account the data belongs to, better not to send
  // than to cross accounts
  if (identity.loggedIn && (identity.userId ?? '') === '') {
    return '登录账号缺少用户 id，已暂停同步（请重新登录）'
  }
  if (!profileMatchesSession()) return '账号数据空间正在切换，请稍候再同步'
  return null
}

/** Whether the login state points to the logged-out space (for IPC to decide whether to switch back to anonymous) */
export function sessionIsAnonymous(): boolean {
  return currentSessionProfileKey() === ANONYMOUS_PROFILE
}

/**
 * Schedule a restart to switch the local data space (**fallback path**).
 *
 * The normal path is the in-place switch in `profiles/live.ts`; only two cases get here:
 * - the preconditions for in-place switching do not hold (app initialization not done, database not
 *   ready);
 * - the in-place switch failed (e.g. the directory is held by another process), and a restart is
 *   needed to clean up the half-done swap.
 *
 * This does not move data directly: `profiles/.active.json` still says "who the root directory
 * currently belongs to", and after the restart `initAccountProfile()` derives the target key from
 * the on-disk session and swaps then, so the logic exists only once.
 */
export function requestProfileRestart(reason: string): void {
  if (restartScheduled) return
  restartScheduled = true
  logger.info(`[Profiles] 需要重启以切换账号数据空间：${reason}（原地切换不可用或失败）`)
  // Leave a little time for the IPC response / logs to hit disk, then restart (dev and packaged
  // builds take the same path)
  setTimeout(() => {
    try {
      app.relaunch()
    } catch (err) {
      logger.warn('[Profiles] app.relaunch() 失败，将直接退出（请手动重新打开应用）:', err)
    }
    app.exit(0)
  }, 600)
}

/** Whether a "restart the app" to switch the data space has been scheduled (so the same flow does not start another switch) */
export function isProfileRestartScheduled(): boolean {
  return restartScheduled
}

/** Verify identity after a session refresh (e.g. the user id only arrives from /v1/me after an old session started) */
export function ensureProfileMatchesSession(reason: string): boolean {
  if (profileMatchesSession()) return true
  logger.info(`[Profiles] 当前数据空间 ${activeKey ?? 'null'} 与登录身份不一致（${reason}）`)
  requestProfileRestart(reason)
  return false
}
