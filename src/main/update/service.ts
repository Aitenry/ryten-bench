import { createHash } from 'node:crypto'
import { createReadStream } from 'original-fs'
import { app, BrowserWindow } from 'electron'
import logger from 'electron-log'
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater'
import { safeSend } from '../safe-send'
import {
  APP_UPDATE_CHANNELS,
  type AppUpdateState,
  type AppUpdateStage
} from '../../shared/update/types'
import { createUpdateSource, type UpdateSource } from './sources'

/** Poll interval for long-running sessions; the startup check happens much sooner. */
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
/** Let the splash screen and the first render settle before touching the network. */
const STARTUP_CHECK_DELAY_MS = 8_000

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** The content fingerprint is an extra top-level key in electron-builder's latest*.yml. */
type UpdateInfoWithContentHash = UpdateInfo & { contentSha256?: unknown }

function readContentHash(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null
}

/**
 * `isUpdateAvailable` is private in electron-updater's typings but is a stable runtime method:
 * checkForUpdates consults it before emitting update-available. We wrap it so a same-version
 * rebuild whose content SHA-256 differs is treated as an update, while every other decision stays
 * with the upstream implementation.
 */
type ContentAwareUpdater = {
  isUpdateAvailable(info: UpdateInfo): Promise<boolean>
  __contentHashPolicyInstalled?: boolean
}

/**
 * Main-process update service.
 *
 * Responsibilities:
 * - own the single source of truth for update state (`idle -> available -> downloading -> ready ->
 *   restarting`);
 * - drive electron-updater (check / download / quitAndInstall) with auto-download disabled;
 * - broadcast snapshots to every renderer so the sidebar entry follows along;
 * - keep all source-specific concerns behind `UpdateSource`.
 *
 * The renderer never talks to autoUpdater directly and cannot start an update that the service has
 * not validated.
 */
class UpdateService {
  private source: UpdateSource | null = null
  private state: AppUpdateState = {
    stage: 'idle',
    currentVersion: app.getVersion()
  }
  private started = false
  private wired = false
  private checking = false
  private startupTimer: NodeJS.Timeout | null = null
  private recheckTimer: NodeJS.Timeout | null = null
  /** Lazily computed SHA-256 of the installed app.asar (only needed for same-version checks). */
  private localContentHashPromise: Promise<string | null> | null = null

  getState(): AppUpdateState {
    return { ...this.state }
  }

  /**
   * Start the updater once the app is ready and the main window exists.
   *
   * Unpackaged runs are skipped so development never replaces itself with a production build.
   * `RYTENBENCH_UPDATE_DEV=1` opts into the updater for local feed testing (requires a valid
   * dev-app-update.yml / feed URL).
   */
  async start(): Promise<void> {
    if (this.started) return
    if (!app.isPackaged && process.env.RYTENBENCH_UPDATE_DEV !== '1') {
      logger.info('[Update] Skipped: development build')
      return
    }
    this.started = true

    try {
      this.source = createUpdateSource()
      await this.configureUpdater(this.source)
      this.wireUpdater()
      this.installContentHashPolicy()
      this.updateState({ stage: 'idle', currentVersion: app.getVersion(), source: this.source.id })
      this.startupTimer = setTimeout(() => {
        void this.checkForUpdates()
      }, STARTUP_CHECK_DELAY_MS)
      this.recheckTimer = setInterval(() => {
        void this.checkForUpdates()
      }, RECHECK_INTERVAL_MS)
      this.startupTimer.unref?.()
      this.recheckTimer.unref?.()
      logger.info(`[Update] Service started with source "${this.source.id}"`)
    } catch (error) {
      logger.warn('[Update] Failed to start updater:', error)
      this.source = null
    }
  }

  /** Ask the active source for updates. Safe to call while a previous check is in flight. */
  async checkForUpdates(): Promise<AppUpdateState> {
    if (!this.started || !this.source || this.checking) return this.getState()
    // Never interrupt an in-progress download or a ready-to-install update.
    if (
      this.state.stage === 'downloading' ||
      this.state.stage === 'ready' ||
      this.state.stage === 'restarting'
    ) {
      return this.getState()
    }

    this.checking = true
    try {
      await autoUpdater.checkForUpdates()
      this.updateState({ checkedAt: new Date().toISOString() })
    } catch (error) {
      // Startup network failures are expected (offline / proxy / GitHub hiccup); stay silent in the
      // UI and let the next scheduled check retry. Only download failures surface as "Retry".
      logger.warn('[Update] Check failed:', error)
    } finally {
      this.checking = false
    }
    return this.getState()
  }

  /** Download the update offered by the last check. */
  async download(): Promise<boolean> {
    if (this.state.stage !== 'available') return false

    this.updateState({
      stage: 'downloading',
      progress: 0,
      error: undefined
    })
    try {
      await autoUpdater.downloadUpdate()
      return true
    } catch (error) {
      logger.warn('[Update] Download failed:', error)
      this.updateState({
        stage: 'available',
        progress: undefined,
        error: errorMessage(error)
      })
      return false
    }
  }

  /**
   * Hand the downloaded package to the installer and restart.
   *
   * electron-updater closes the windows, installs, and (for NSIS) relaunches the new build. The
   * short delay lets the renderer receive the "restarting" snapshot first.
   */
  async restartAndInstall(): Promise<boolean> {
    if (this.state.stage !== 'ready') return false

    this.updateState({ stage: 'restarting', error: undefined })
    setTimeout(() => {
      try {
        autoUpdater.quitAndInstall(true, true)
      } catch (error) {
        logger.warn('[Update] quitAndInstall failed:', error)
        this.updateState({
          stage: 'ready',
          error: errorMessage(error)
        })
      }
    }, 180)
    return true
  }

  /**
   * Same-version content updates are a deliberate product rule: a small fix may be published
   * without bumping the version. electron-updater rejects equal semver by design, so we only
   * override that **one** decision when the remote latest*.yml carries a content SHA-256 and it
   * differs from the installed app.asar's SHA-256. Version upgrades / downgrades still use the
   * upstream comparison untouched.
   */
  private installContentHashPolicy(): void {
    const updater = autoUpdater as unknown as ContentAwareUpdater
    if (updater.__contentHashPolicyInstalled) return
    if (typeof updater.isUpdateAvailable !== 'function') {
      logger.warn(
        '[Update] electron-updater availability hook is missing; same-version content updates are disabled'
      )
      return
    }
    const original = updater.isUpdateAvailable.bind(updater)
    updater.isUpdateAvailable = async (info: UpdateInfo): Promise<boolean> => {
      const remoteHash = readContentHash((info as UpdateInfoWithContentHash).contentSha256)
      logger.info(
        `[Update] Availability check: version=${info.version}, remoteContentSha256=${remoteHash ? `${remoteHash.slice(0, 12)}…` : 'none'}`
      )
      if (remoteHash && info.version === app.getVersion()) {
        const localHash = await this.getLocalContentHash()
        if (localHash && localHash !== remoteHash) {
          logger.info(
            `[Update] Same-version content change: ${localHash.slice(0, 12)}… -> ${remoteHash.slice(0, 12)}…`
          )
          return true
        }
      }
      return original(info)
    }
    updater.__contentHashPolicyInstalled = true
  }

  /** SHA-256 of the packaged app.asar; null in dev / if the file cannot be read. */
  private getLocalContentHash(): Promise<string | null> {
    if (this.localContentHashPromise) return this.localContentHashPromise
    const appPath = app.getAppPath()
    if (!appPath.endsWith('.asar')) return Promise.resolve(null)

    this.localContentHashPromise = new Promise<string>((resolve, reject) => {
      const hash = createHash('sha256')
      const stream = createReadStream(appPath)
      stream.on('data', (chunk) => hash.update(chunk))
      stream.on('error', reject)
      stream.on('end', () => resolve(hash.digest('hex')))
    }).catch((error) => {
      logger.warn('[Update] Failed to hash installed app.asar:', error)
      this.localContentHashPromise = null
      return null
    })
    return this.localContentHashPromise
  }

  private async configureUpdater(source: UpdateSource): Promise<void> {
    const feed = await source.resolveFeed()
    autoUpdater.logger = logger
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.autoRunAppAfterInstall = true
    autoUpdater.allowPrerelease = source.allowPrerelease ?? false
    autoUpdater.allowDowngrade = false
    // electron-updater refuses to run in unpackaged builds unless this is set (local feed testing).
    if (!app.isPackaged) autoUpdater.forceDevUpdateConfig = true
    autoUpdater.setFeedURL(feed as Parameters<typeof autoUpdater.setFeedURL>[0])
  }

  private wireUpdater(): void {
    if (this.wired) return
    this.wired = true

    autoUpdater.on('checking-for-update', () => {
      this.updateState({ error: undefined })
    })

    autoUpdater.on('update-available', (info: UpdateInfo) => {
      // A re-check must not toss away a downloaded package or an in-flight download.
      if (
        this.state.stage === 'downloading' ||
        this.state.stage === 'ready' ||
        this.state.stage === 'restarting'
      ) {
        return
      }
      this.updateState({
        stage: 'available',
        version: info.version,
        contentUpdate: info.version === app.getVersion(),
        progress: undefined,
        error: undefined,
        checkedAt: new Date().toISOString()
      })
    })

    autoUpdater.on('update-not-available', () => {
      if (
        this.state.stage === 'downloading' ||
        this.state.stage === 'ready' ||
        this.state.stage === 'restarting'
      ) {
        return
      }
      this.updateState({
        stage: 'idle',
        version: undefined,
        contentUpdate: undefined,
        progress: undefined,
        error: undefined,
        checkedAt: new Date().toISOString()
      })
    })

    autoUpdater.on('download-progress', (info: ProgressInfo) => {
      const progress = Math.max(0, Math.min(100, Math.round(info.percent)))
      this.updateState({ stage: 'downloading', progress, error: undefined })
    })

    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      this.updateState({
        stage: 'ready',
        version: info.version,
        progress: 100,
        error: undefined
      })
    })

    autoUpdater.on('error', (error: Error) => {
      logger.warn('[Update] Updater error:', error)
      const stage = this.state.stage
      if (stage === 'downloading') {
        this.updateState({
          stage: 'available',
          progress: undefined,
          error: errorMessage(error)
        })
      } else if (stage === 'restarting') {
        this.updateState({ stage: 'ready', error: errorMessage(error) })
      }
      // A plain check failure is already logged; it must not turn the update entry into "Retry".
    })
  }

  /** Merge a patch, keep the stage valid, and push the new snapshot to every window. */
  private updateState(patch: Partial<AppUpdateState> & { stage?: AppUpdateStage }): void {
    this.state = {
      ...this.state,
      ...patch,
      currentVersion: app.getVersion(),
      source: patch.source ?? this.source?.id ?? this.state.source
    }
    const snapshot = this.getState()
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue
      safeSend(window.webContents, APP_UPDATE_CHANNELS.stateChanged, snapshot)
    }
  }
}

export const updateService = new UpdateService()
