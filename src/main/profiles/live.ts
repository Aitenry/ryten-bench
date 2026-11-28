import { app } from 'electron'
import logger from 'electron-log'
import {
  applyProfile,
  deriveProfileKey,
  readSessionIdentity,
  type ApplyProfileResult
} from './manager'
import {
  clearAccountScopedContentSelections,
  getActiveProfileKey,
  isAccountProfileReady,
  logApplyResult,
  requestProfileRestart,
  setActiveProfileKey,
  setProfileSwitchInProgress
} from './runtime'
import { createDatabase } from '../database/loading'
import { getDatabaseRef, setDatabaseInstance } from '../database/instance'
import { runMigrations } from '../database/orm'
import { applyWorkspaceSettings } from '../database/workspace-settings'
import { activeHarnessStreams, streamAbortControllers } from '../context'
import { reloadAllExternalMains, unloadAllExternalMains } from '../plugins/host'
import { waitForPluginOperations } from '../plugins/operation-lock'
import { closeAllMcp } from '../runtime/harness/mcp'
import { closeAllMnemon } from '../services/harness/mnemon-singleton'
import { startSystemModules, stopSystemModules } from '../system'
import { resetHarnessAccountState } from '../system/harness'
import * as sync from '../lattice/sync'
import { resumeLatticeAfterProfileSwitch } from '../lattice/index'
import { getMainWindow, isInitComplete } from '../windows/window-manager'

/**
 * **In-place switching of the account data space at runtime** (no more `app.relaunch()`).
 *
 * Background: `manager.ts`'s model is "the account data currently in use sits at the userData
 * root, other accounts sleep in `profiles/<key>/`, and switching accounts = swapping the two
 * directory sets". The first version only swapped early during startup, so logging in / out /
 * changing the base URL restarted the whole app (user feedback 2026-11-24: restarting on every
 * logout is too disruptive).
 *
 * The same swap now happens at runtime, deliberately ordered to match "one cold start":
 *
 *   (1) Quiesce - abort chat streams, pause cloud sync, stop system features (AI assistant / docs
 *       library), unload third-party plugin main modules, close PGlite;
 *   (2) Swap - `applyProfile()` (exactly the same logic as at startup, with journal protection);
 *   (3) Reconnect - DB connection for the new space + migrations + workspace settings alignment;
 *   (4) Restore - clear account-level in-memory caches -> reinstall system features -> reinstall
 *       plugins -> resume sync and pull;
 *   (5) Refresh - main window `webContents.reload()` (the renderer remounts, and the startup page
 *       covers this switch).
 *
 * Failure semantics: **any failing step falls back to `app.relaunch()`** (the old behavior). The
 * swap itself has journal + marker protection, so after a restart `initAccountProfile()` resumes or
 * rolls it back, and data is neither lost nor mixed. This fast path is taken only when "all
 * preconditions for in-place switching hold", so call sites early in startup (initialization not
 * finished, database not ready) still restart, keeping the logic from forking into two copies.
 */

let switching = false

/** Whether an in-place switch is running (used by the sync guard / sync layer) */
export function isProfileSwitchRunning(): boolean {
  return switching
}

export interface ProfileSwitchOptions {
  /** Log- and user-readable reason (e.g. `logout -> anonymous`) */
  reason: string
  /**
   * Target data space key. When omitted it is derived from the **on-disk session** (same rule as at
   * startup). Login scenarios pass the new account's key directly, avoiding the window where "the
   * session is already written to disk but the derivation rule is inconsistent".
   */
  targetKey?: string
}

export interface ProfileSwitchResult {
  ok: boolean
  key: string
  from: string | null
  reason: string
  /** Could not switch in place; the app was restarted instead (the caller does not need to refresh the UI) */
  restarted?: boolean
  error?: string
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Bounded wait: steps like database close / sync shutdown that "may be held up by running tasks" must not block an account switch indefinitely */
async function withTimeout(task: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | null = null
  try {
    await Promise.race([
      task,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms)
      })
    ])
    return true
  } catch (err) {
    logger.warn('[Profiles] A switch step failed while waiting for it to finish:', err)
    return true
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Whether an in-place switch is possible: initialization is complete (the startup page has moved
 * to the main UI) and the database is actually connected.
 *
 * Do not force it when not satisfied - early in startup (`initLattice()` runs inside
 * `initPluginHost()`) the database may not be built yet, and swapping directories then would
 * interrupt the startup flow mid-way; restarting is the safest.
 */
function canSwitchInPlace(): boolean {
  if (!isAccountProfileReady()) return false
  if (!isInitComplete()) return false
  const db = getDatabaseRef()
  return db !== null && db.isInitialized()
}

/** (1) Quiesce: make everything that may read/write account data stop (order = dependency unload order) */
async function quiesceForSwitch(): Promise<void> {
  // Running chat streams write to the database: abort them first and wait for the writes to land
  // (5s max, same rule as the exit flow)
  if (activeHarnessStreams.size > 0) {
    logger.info(
      `[Profiles] Aborting ${activeHarnessStreams.size} active assistant stream(s) before switch`
    )
    for (const controller of streamAbortControllers.values()) {
      controller.abort()
    }
    await withTimeout(Promise.allSettled([...activeHarnessStreams]), 5000)
  }

  // Sync layer: pause the debounced push and wait for the running sync to finish (it writes
  // plugin-state / lattice-sync.json before the swap is complete). If it still has not finished
  // after the timeout, **abandon this swap**: a running sync holds the old account's cache while
  // the paths already point at the new space, and continuing would write the previous account's
  // data into the new account (account cross-talk).
  const syncSettled = await sync.pauseLatticeSync(15_000)
  if (!syncSettled) {
    throw new Error('云同步仍在进行（网络较慢），本次账号切换已取消；请等同步结束后重试')
  }

  /**
   * An in-progress plugin install/uninstall writes `userData/plugins`, `plugin-state` and
   * `lattice-sync.json`, and also reloads plugin main modules at the end (by then the database may
   * already be closed). Wait for them to finish; on timeout give up this switch (better to have the
   * user retry than to leave the directory swap half-done). New operations are rejected by
   * `isProfileSwitchInProgress()` after the switch starts and cannot keep appearing.
   */
  const pluginsSettled = await waitForPluginOperations(15_000)
  if (!pluginsSettled) {
    throw new Error('插件安装/卸载仍在进行，本次账号切换已取消；请稍后重试')
  }

  // System features (AI assistant / docs library): unregister IPC, stop workspace listeners and the workshop, close MCP clients
  try {
    stopSystemModules()
  } catch (err) {
    logger.warn('[Profiles] Failed to stop system modules before switch:', err)
  }

  // Third-party plugin main modules: they may have opened plugin-state / database handles at load time
  try {
    unloadAllExternalMains()
  } catch (err) {
    logger.warn('[Profiles] Failed to unload plugin main modules before switch:', err)
  }

  // Memory components are separate PGlite instances (their storage roots are in machine-level
  // directories, not in the swap list), but their caches are organized per account: after switching
  // they must be reloaded from the new database
  await Promise.allSettled([closeAllMnemon(), closeAllMcp()])

  // Close the database last: only after all holders have stopped can the directory be renamed (Windows handles)
  const database = getDatabaseRef()
  if (database) {
    const closed = await withTimeout(database.close(), 5000)
    if (!closed) logger.warn('[Profiles] Database close timed out; trying to swap anyway')
    setDatabaseInstance(null)
  }
}

/** (3) Reconnect: open the root directory (now the target account's data) as the database again */
async function reconnectDatabase(): Promise<void> {
  const database = await createDatabase()
  try {
    await runMigrations(database.getDatabase())
    // The active workspace lives in machine-level settings while workspace rows live in the
    // account database: after switching accounts it must be realigned, otherwise it points to a
    // nonexistent row
    await applyWorkspaceSettings(database.getDatabase())
  } catch (err) {
    await database.close().catch((closeErr) => {
      logger.warn('[Profiles] Failed to close half-opened database after switch:', closeErr)
    })
    throw err
  }
  setDatabaseInstance(database)
}

/** (4) Restore: reinstall system features and plugins so the sync layer restarts from "new space + new session" */
function restoreRuntimeAfterSwitch(): void {
  // First clear the in-memory caches indexed by account data (topicId is an auto-increment id in
  // each account's database; not clearing it causes cross-talk)
  resetHarnessAccountState()
  // "The last viewed conversation" recorded in machine-level settings is also an account database
  // id: it does not participate in restoring the new space
  clearAccountScopedContentSelections()
  /**
   * The sync cache must be swapped to the new space **before the plugin reload**: a plugin's
   * `install()` may immediately call `ctx.requestSync()` -> `markLatticePluginDirty()`; if the
   * in-memory cache is still the previous account's at that point, it writes the old account's
   * revs/conflicts wholesale into the new space's `lattice-sync.json`.
   */
  sync.reloadLatticeSyncCache()
  // Same order as startup: system features (AI assistant's tool table) -> third-party plugins
  startSystemModules()
  reloadAllExternalMains()

  sync.resumeLatticeSync()
  // Broadcast the new login state and pull once in the background (returns immediately when logged out)
  void resumeLatticeAfterProfileSwitch()
}

/** (5) Refresh the renderer: leave a frame for the IPC response, then reload the whole page (the startup page covers this) */
function scheduleRendererReload(reason: string): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  setTimeout(() => {
    if (win.isDestroyed()) return
    logger.info(`[Profiles] 账号数据空间已切换，刷新界面（不重启应用）：${reason}`)
    win.webContents.reload()
  }, 60)
}

/**
 * Switch the account data space in place (login / logout / base URL change all go here).
 *
 * The caller can simply `await` it: on success it returns `{ok:true}` (the main window then
 * refreshes automatically); when a restart is needed (initialization incomplete / switch failed) it
 * returns `{restarted:true}` and the app restarts within a few hundred milliseconds.
 */
export async function switchAccountProfile(
  options: ProfileSwitchOptions
): Promise<ProfileSwitchResult> {
  const { reason } = options
  const userDataDir = app.getPath('userData')
  const identity = readSessionIdentity(userDataDir)
  const desired = options.targetKey ?? deriveProfileKey(identity)
  const current = getActiveProfileKey()

  if (switching) {
    return {
      ok: false,
      key: desired,
      from: current,
      reason,
      error: '账号数据空间正在切换，请稍候'
    }
  }
  if (current === desired) {
    return { ok: true, key: desired, from: current, reason }
  }
  if (!canSwitchInPlace()) {
    logger.info(`[Profiles] 初始化未完成，改为重启切换账号数据空间：${reason}`)
    requestProfileRestart(reason)
    return { ok: false, key: desired, from: current, reason, restarted: true }
  }

  switching = true
  setProfileSwitchInProgress(true)
  logger.info(
    `[Profiles] 原地切换账号数据空间：${current ?? 'null'} -> ${desired}（${reason}），不重启应用`
  )
  try {
    await quiesceForSwitch()

    // (2) Swap: the same logic as at startup (marker / journal protection both live in manager)
    const result: ApplyProfileResult = applyProfile(userDataDir, desired, identity)
    logApplyResult(result, desired)
    setActiveProfileKey(desired)

    await reconnectDatabase()
    restoreRuntimeAfterSwitch()
    scheduleRendererReload(reason)

    logger.info(
      `[Profiles] 账号数据空间已在运行中切换完成：${current ?? 'null'} -> ${desired}（${reason}）`
    )
    return { ok: true, key: desired, from: result.from ?? current, reason }
  } catch (err) {
    logger.error(
      '[Profiles] 原地切换失败，回退为重启应用（数据没有删除；启动时会按 journal 续做/回滚）:',
      err
    )
    requestProfileRestart(`switch failed: ${reason}`)
    return {
      ok: false,
      key: desired,
      from: current,
      reason,
      restarted: true,
      error: errorText(err)
    }
  } finally {
    switching = false
    setProfileSwitchInProgress(false)
  }
}
