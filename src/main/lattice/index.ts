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
 * Main-process assembly layer for the Lattice plugin hub:
 * - Aggregates status (base URL + session + last sync) and broadcasts `lattice:state-changed`;
 * - Restores the login state on startup (cold start with only a refresh token -> refresh ->
 *   fill in identity/role via `/v1/me` -> one pull);
 * - Wires hub/sync hooks to window broadcasts (modules are injected via `configure*` to avoid
 *   circular imports).
 *
 * IPC is not registered here: channels are registered in `src/main/ipc/lattice.ts`, called by
 * `registerCoreIpc()`; `initLattice()` is called once by `registerLatticeIpc()` there.
 */

let initialized = false
let lastError: string | null = null

/**
 * Emits an event to all windows (no-op before windows exist; the renderer pulls status on mount)
 */
function broadcast(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }
}

/** Builds the current status (`lattice:status` result / `lattice:state-changed` payload) */
export function getLatticeStatus(): LatticeStatus {
  const baseUrl = getLatticeBaseUrl()
  const snapshot = session.getLatticeSessionSnapshot()
  const lastSync = sync.getLastLatticeSyncResult()
  const status: LatticeStatus = {
    configured: baseUrl !== '',
    baseUrl,
    loggedIn: snapshot.loggedIn,
    // Auto-restore toggle for missing plugins (enabled by default; failures show in sync details)
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

/**
 * Broadcasts a status change (after login/logout, refresh failure, sync completion, base change)
 */
export function broadcastLatticeStatus(): void {
  broadcast(LATTICE_IPC.stateChanged, getLatticeStatus())
}

/** Broadcasts upload progress */
export function broadcastLatticeUploadProgress(progress: LatticeUploadProgress): void {
  broadcast(LATTICE_IPC.uploadProgress, progress)
}

/** Broadcasts a sync result */
export function broadcastLatticeSyncState(result: LatticeSyncResult): void {
  broadcast(LATTICE_IPC.syncState, result)
}

/** Records the most recent error (shown in status; cleared before a successful operation) */
export function setLatticeLastError(message: string | null): void {
  lastError = message
}

export function getLatticeLastError(): string | null {
  return lastError
}

/**
 * Restores / refreshes the login state: with a refresh token, refresh -> fetch `/v1/me` (fills in
 * username/display_name/role) -> one pull.
 *
 * Cold start and "switch the account data space in place while running" share this path, with two
 * differences:
 * - On cold start the old session may lack a user id, so the data space must be re-checked after
 *   `/v1/me` (switch if it does not match);
 * - After a switch the identity is decided by the caller, so pull directly in the new space.
 *
 * Failure semantics:
 * - Refresh rejected by the server (401/409) -> the client already cleared the session and
 *   broadcast logged-out;
 * - Network/5xx -> keep the refresh token (an offline start should not log the user out), record
 *   lastError in the status.
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
    // The old session may only have tokens; the user id arrives with this `/v1/me`: the data space
    // must follow the restarted identity.
    if (stage === 'startup' && !ensureProfileMatchesSession('session identity after /v1/me')) return
    // Pull once after startup/switch; push is debounced and triggered by plugin-state-changed
    await sync.syncLattice('pull')
  } catch (err) {
    const message = client.latticeErrorMessage(err)
    // When credentials expire, authLostHandler already broadcast a login-expired notice; add a
    // diagnosable lastError here as well
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
 * Called after switching the account data space while running: broadcast the new login state
 * first, then do one pull for the current session.
 *
 * Invoked by `profiles/live.ts` after the data directory swap, DB reconnect and plugin reload. It
 * does not switch data itself; it only restarts the sync layer from the new space + new session
 * (no token refresh: the state is fresh right after login/logout).
 */
export async function resumeLatticeAfterProfileSwitch(): Promise<void> {
  lastError = null
  broadcastLatticeStatus()
  await resumeLatticeSession('profile-switch')
}

/**
 * After the session is invalidated passively (refresh rejected / kicked out elsewhere), move the
 * local data space back to anonymous.
 *
 * Why this is required: `clearLatticeSession()` only clears the login state, while the account
 * data directory (RytenBenchDB / plugin-state / lattice-sync.json) still points at the old
 * account. The user sees "logged out", but subsequent plugin data and sessions keep being written
 * into the old account container; after a restart anonymous takes effect and that content seems to
 * vanish (it is actually under `profiles/u-<id>/`). Explicit logout always had this step; passive
 * invalidation did not, so it is handled here.
 *
 * Delay the switch by one tick: explicit logout also makes refresh fail first (the server revokes
 * the token), and if that switch is in progress, running into it only yields "switching". Let it
 * finish first; once it is done or started, this is skipped naturally.
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
 * Initialization (called once by `registerLatticeIpc()` before windows are created).
 *
 * Must run after app ready (it depends on `safeStorage`/`app.getPath`); the current call site
 * `initPluginHost()` satisfies that.
 */
export function initLattice(): void {
  if (initialized) return
  initialized = true

  session.loadLatticeSession()
  /**
   * The startup session was discarded (base URL changed / version mismatch / refresh token
   * undecryptable): `initAccountProfile()` selected the account container based on the session
   * still being in the file, but it is gone now, so the data space must return to anonymous.
   * Record a restart request first: the database is not ready yet, so switching in place is not
   * available; after the restart it lands on anonymous because there is no session.
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

  // Refresh rejected -> the client clears the session; this handles status broadcast + moving the
  // data space back to anonymous
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
    // Auto-restore on a new machine: plugins missing locally are detected during pull -> reuse the
    // hub install pipeline (package + source)
    installPlugin: (pluginId, version) => hub.installLatticePlugin(pluginId, version)
  })
  sync.initLatticeSync()
  // `ctx.requestSync()`: after plugin data is persisted, mark "unsynced local changes" and request
  // a debounced push (pull relies on this dirty mark to avoid overwriting unsynced local edits).
  setPluginSyncRequester((pluginId) => {
    sync.markLatticePluginDirty(pluginId)
    sync.scheduleLatticePush()
  })

  initAutoPull()
  void resumeLatticeSession('startup')
}

/**
 * "Auto pull" like an IM client: pull every 60s while logged in, plus once on window refocus
 * (5s debounce)
 */
const AUTO_PULL_INTERVAL_MS = 60_000
const FOCUS_PULL_DEBOUNCE_MS = 5_000
let autoPullTimer: NodeJS.Timeout | null = null
let focusPullTimer: NodeJS.Timeout | null = null

function pullIfLoggedIn(): void {
  if (!session.hasLatticeSession()) return
  // Background auto pull: silent when nothing changed, to avoid nagging every 60s
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
