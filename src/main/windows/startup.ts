import { app, dialog, ipcMain } from 'electron'
import { rename } from 'fs/promises'
import logger from 'electron-log'
import { createDatabase, getDatabaseDir, type Database } from '../database/loading'
import { runMigrations } from '../database/orm'
import { applyWorkspaceSettings } from '../database/workspace-settings'
import { setDatabaseInstance, setInitializationPromise } from '../database/instance'
import { initKeystore } from '../crypto/provider-key'
import { settingsStore } from '../context'
import { safeSend } from '../safe-send'
import { mainMessages } from '../i18n'
import { GraphSettings, HarnessSettings, TraySettings } from '../types/settings'
import { hashLockCode } from '../lock/credentials'
import { DEFAULT_AUTO_LOCK_MINUTES, DEFAULT_LOCK_CODE } from '../lock/constants'
import { refreshLockScreenState } from '../lock/service'
import { getIp } from '../address'
import { startWeatherAutoRefresh } from '../weather'
import { listContributions } from '../plugins/contributions'
import { APP_PRELOAD, type AppHook } from '../plugins/app-hooks'
import { preloadHarness } from '../system/harness'
import { migrateLegacyHarnessSettingsKey } from '../storage/layout'
import { getMainWindow, markInitComplete } from './window-manager'

/** Initialization progress snapshot: the later-mounted splash page (main window renderer) fetches the current state once via `init-state` */
export interface InitSnapshot {
  complete: boolean
  error: string | null
  currentTask: string
  progress: number
  taskIndex: number
  totalTasks: number
}

const initSnapshot: InitSnapshot = {
  complete: false,
  error: null,
  currentTask: '',
  progress: 0,
  taskIndex: 0,
  totalTasks: 5
}

function sendToMainWindow(channel: string, payload?: unknown): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  safeSend(win.webContents, channel, payload)
}

/** Initialization progress: update the snapshot and push it to the main window renderer (splash page) */
function sendInitProgress(
  currentTask: string,
  progress: number,
  taskIndex: number,
  totalTasks: number
): void {
  initSnapshot.currentTask = currentTask
  initSnapshot.progress = Math.round(progress)
  initSnapshot.taskIndex = taskIndex
  initSnapshot.totalTasks = totalTasks
  sendToMainWindow('init-progress', {
    currentTask,
    progress: Math.round(progress),
    taskIndex,
    totalTasks
  })
}

export function getInitSnapshot(): InitSnapshot {
  return { ...initSnapshot }
}

/** Splash page pulls the current progress (covers initialization advancing before the renderer subscribes) */
export function registerStartupIpc(): void {
  ipcMain.handle('init-state', () => getInitSnapshot())
}

/**
 * Older versions stored the AI assistant settings under the `chat` key; after the module
 * rename everything uses `harness`.
 *
 * The migration lives in `storage/layout.ts` (the earlier-starting `bootstrapStorageLayout()`
 * already calls it once; calling it again here is an idempotent safety net so the old config
 * is readable even when the initialization flow runs on its own).
 */
async function loadConfig(): Promise<void> {
  migrateLegacyHarnessSettingsKey()
  const ipConfig = settingsStore.get('ip')
  const lockPermission = settingsStore.get('lock')
  const graphConfig = settingsStore.get('graph')
  const harnessConfig = settingsStore.get('harness')
  const configPromises: Promise<void>[] = []

  if (!ipConfig) {
    // IP data is a non-critical dependency: fetch it silently in the background without
    // blocking initialization
    getIp()
      .then((ip) => {
        if (ip) {
          settingsStore.set('ip', ip)
          // Re-create the weather auto-refresh timer once the IP is ready (the main window was
          // created before the IP was available, so startWeatherAutoRefresh returned early and
          // the timer would never start in this session)
          startWeatherAutoRefresh()
        }
      })
      .catch(() => {})
  }
  if (!lockPermission) {
    configPromises.push(
      Promise.resolve().then(async () => {
        // Write a salted scrypt digest on the first persist (older versions wrote
        // MD5('123456') here; see the notes in lock/credentials.ts). The default code 123456
        // only exists for out-of-the-box trial use; the settings page prompts the user to
        // change it soon.
        settingsStore.set('lock', {
          code: await hashLockCode(DEFAULT_LOCK_CODE),
          view: false,
          autoLockMinutes: DEFAULT_AUTO_LOCK_MINUTES
        })
      })
    )
  }
  if (!graphConfig) {
    configPromises.push(
      Promise.resolve().then(() => {
        settingsStore.set('graph', {
          maxConcurrency: 8,
          enableGleaning: true,
          gleaningThreshold: 50,
          maxChunkSize: 2000
        } as GraphSettings)
      })
    )
  }
  if (!harnessConfig) {
    configPromises.push(
      Promise.resolve().then(() => {
        settingsStore.set('harness', {} as HarnessSettings)
      })
    )
  }
  if (!settingsStore.get('tray')) {
    configPromises.push(
      Promise.resolve().then(() => {
        settingsStore.set('tray', { closeToTray: true } as TraySettings)
      })
    )
  }

  try {
    await Promise.all(configPromises)
  } catch (error) {
    logger.error('Error loading config:', error)
  }
}

/**
 * Detecting a database startup failure: when PGlite cannot start, drizzle only throws
 * "Failed query: CREATE SCHEMA …" while the real cause hides in the cause chain (e.g.
 * RuntimeError: Aborted(); the Postgres-side "could not locate a valid checkpoint record"
 * is only written to stdout). Print the whole cause chain here, otherwise the log is left
 * with a single SQL line that gives no clue where to start.
 */
function describeErrorChain(err: unknown): string {
  const parts: string[] = []
  let current: unknown = err
  for (let depth = 0; current instanceof Error && depth < 5; depth += 1) {
    parts.push(`${current.name}: ${current.message}`)
    current = (current as { cause?: unknown }).cause
  }
  return parts.length > 0 ? parts.join(' ← ') : String(err)
}

/** Typical signs that the database cannot start (local cluster corruption / crash recovery needed but impossible) */
function looksLikeDatabaseStartupFailure(err: unknown): boolean {
  const text = describeErrorChain(err)
  return (
    /Failed query/i.test(text) ||
    /Aborted\(\)/i.test(text) ||
    /PGlite failed to initialize/i.test(text) ||
    /could not locate a valid checkpoint record/i.test(text) ||
    /incorrect checksum in control file/i.test(text)
  )
}

/**
 * Fallback for a corrupt database: rename the corrupt directory to keep it on record (do not
 * delete it) so the app can stay usable with an empty database.
 *
 * Why this is needed: PGlite is an embedded Postgres with **no repair tools such as
 * pg_resetwal**. Once the checkpoint record in pg_control/WAL is corrupted (abnormal exit, or
 * two processes opening the same directory at once), the cluster can never start again, and
 * until then the app simply stayed stuck on the "initialization failed" splash page (the main
 * window never shows), leaving the user with neither the reason nor a way to recover.
 *
 * Archive rather than delete: the data pages in the corrupt directory are usually intact, so
 * `node scripts/recover-pglite.mjs` can rescue sessions/documents and other data (that script
 * is the recovery flow actually used in the 2026-09-18 incident).
 */
async function offerDatabaseReset(
  err: unknown
): Promise<'recovered' | 'declined' | 'not-applicable'> {
  const text = describeErrorChain(err)
  if (!looksLikeDatabaseStartupFailure(err)) return 'not-applicable'

  const m = mainMessages().dialog
  logger.error(`[Init] Database failed to start, data directory may be corrupted: ${text}`)
  const { response } = await dialog.showMessageBox({
    type: 'error',
    noLink: true,
    title: m.dbStartupFailedTitle,
    message: m.dbStartupFailedMessage,
    detail: m.dbStartupFailedDetail,
    buttons: [m.dbStartupFailedReset, m.dbStartupFailedQuit],
    defaultId: 0,
    cancelId: 1
  })
  if (response !== 0) return 'declined'

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = `${getDatabaseDir()}.corrupt-${stamp}`
  try {
    await rename(getDatabaseDir(), backupDir)
    logger.warn(`[Init] Corrupt database directory archived: ${backupDir}`)
  } catch (renameErr) {
    logger.error(
      '[Init] Failed to archive corrupt directory (may be in use by another process):',
      renameErr
    )
    return 'declined'
  }
  return 'recovered'
}

/**
 * Run the "splash preload": preload of system features (AI assistant) plus hooks contributed
 * by third-party plugins (`app.preload`).
 *
 * Each one is wrapped in try/catch: a preload failure is only logged — preload is an optional
 * accelerator and must not hold an otherwise working startup flow on the splash page.
 */
async function runPreloadHooks(): Promise<void> {
  try {
    await preloadHarness()
  } catch (err) {
    logger.warn('[Init] AI assistant preload failed:', err)
  }
  for (const hook of listContributions<AppHook>(APP_PRELOAD)) {
    try {
      await hook.run()
    } catch (err) {
      logger.warn(`[Init] Preload hook failed (${hook.label}):`, err)
    }
  }
}

async function performInitializationTasks(): Promise<void> {
  // Flattened initialization steps: config / keystore / connect database / run migrations /
  // workspace migration. The progress bar advances evenly per step and grows gradually instead
  // of jumping to 25% in one go. Step names are the copy visible on the splash page and follow
  // the UI language (fetching them once is enough; the language does not change during startup).
  const m = mainMessages()
  let database: Database | null = null
  const steps: { name: string; execute: () => Promise<void> | void }[] = [
    {
      name: m.splash.stepLoadConfig,
      execute: async () => {
        await loadConfig()
        // The lock-screen config may have been persisted for the first time just now: refresh
        // the snapshot (default-code hint / toggle state). "Lock on startup" is handled in one
        // place by startLockScreenWatcher() (before the window is created), and restoring the
        // settings file from a backup happens even earlier (restore runs during context module
        // evaluation), so do not call lockNow separately here — doing both would make it hard
        // to tell who triggers the lock screen.
        refreshLockScreenState()
      }
    },
    {
      name: m.splash.stepInitKeystore,
      execute: async () => {
        initKeystore()
      }
    },
    {
      name: m.splash.stepConnectDatabase,
      execute: async () => {
        database = await createDatabase()
      }
    },
    {
      name: m.splash.stepRunMigrations,
      execute: async () => {
        await runMigrations(database!.getDatabase())
      }
    },
    {
      name: m.splash.stepInitWorkspace,
      execute: async () => {
        await applyWorkspaceSettings(database!.getDatabase())
      }
    }
  ]

  const runSteps = async (): Promise<void> => {
    for (let i = 0; i < steps.length; i++) {
      // Progress at the start of the step: i steps done / total steps, so each step advances
      // a small notch
      sendInitProgress(steps[i].name, (i / steps.length) * 100, i + 1, steps.length)
      await steps[i].execute()
    }
  }

  try {
    await runSteps()
  } catch (err) {
    // Database failed to start: close the failed instance first (on Windows an unreleased
    // handle makes renaming the directory fail), then offer the user an actionable way out;
    // other errors are rethrown as-is (the splash page shows a failure notice)
    logger.error(`[Init] Initialization failed (cause chain): ${describeErrorChain(err)}`)
    try {
      // Explicit assertion: database is only assigned inside the step callbacks, so TS
      // control-flow analysis narrows it to null
      const failedDb = database as Database | null
      await Promise.race([
        failedDb ? failedDb.close() : Promise.resolve(),
        new Promise((resolve) => setTimeout(resolve, 2000))
      ])
    } catch (closeErr) {
      logger.warn('[Init] Error while closing failed database instance:', closeErr)
    }
    const outcome = await offerDatabaseReset(err)
    if (outcome !== 'recovered') {
      // User chose to quit: tell the splash page to show the error, then quit immediately
      if (outcome === 'declined') {
        initSnapshot.error = describeErrorChain(err)
        sendToMainWindow('init-error', initSnapshot.error)
        setTimeout(() => app.quit(), 300)
      }
      throw err
    }
    database = null
    await runSteps()
  }
  // Expose database access only after table creation and workspace migration have finished:
  // during warm-up the renderer may already issue queries, and exposing it early causes
  // "relation ... does not exist".
  setDatabaseInstance(database)

  // All steps completed
  sendInitProgress(m.splash.stepCompleted, 100, steps.length, steps.length)
}

/**
 * Run startup initialization (database / config / keystore / workspace migration / plugin
 * preload).
 *
 * Per the user's 2026-11-20 decision: **no separate loading window is created anymore** — the
 * main window is created first and shown immediately, the splash page lives in the main window
 * renderer (StartupSplash), and the main UI appears once all data has loaded. So this only runs
 * the initialization tasks; progress is exposed to the renderer through the `init-progress`
 * event plus the `init-state` snapshot.
 */
export function runStartupInitialization(): Promise<void> {
  const initPromise = performInitializationTasks()
    .then(async () => {
      logger.info('All initialization tasks completed.')
      // Preload data (done during the splash phase): the AI assistant preload is called
      // directly, while third-party plugin preload is provided by the `app.preload` hooks they
      // contribute — disabling a plugin stops its preload.
      await runPreloadHooks()
      initSnapshot.complete = true
      initSnapshot.progress = 100
      initSnapshot.error = null
      sendToMainWindow('init-complete')
      markInitComplete()
    })
    .catch((err) => {
      logger.error('Initialization failed:', err)
      initSnapshot.error = describeErrorChain(err)
      sendToMainWindow('init-error', initSnapshot.error)
    })
  setInitializationPromise(initPromise)
  return initPromise
}
