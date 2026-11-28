import { app } from 'electron'
import logger from 'electron-log'
import { activeHarnessStreams, streamAbortControllers } from './context'
import { getDatabaseRef } from './database/instance'
import { listContributions } from './plugins/contributions'
import { APP_BEFORE_QUIT, type AppHook } from './plugins/app-hooks'
import { closeHarnessResources, stopHarness } from './system/harness'
import { stopNotes } from './system/notes'

let isQuitting = false
/** Whether resource cleanup has finished (the final quit is allowed once it has) */
let cleanupDone = false

/** Whether the app is quitting (used by the tray's "close window → hide" interceptor: let real quits through) */
export function isQuittingNow(): boolean {
  return isQuitting
}

/** Marks the app as quitting (lets the close interceptor through early, e.g. on system shutdown) */
export function markQuitting(): void {
  isQuitting = true
}

/** Pre-quit cleanup: system features (AI assistant / notes) + hooks contributed by third-party plugins (`app.before-quit`) */
async function runBeforeQuitHooks(): Promise<void> {
  try {
    closeHarnessResources()
  } catch (err) {
    logger.warn('[Lifecycle] Failed to release AI assistant resources:', err)
  }
  for (const hook of listContributions<AppHook>(APP_BEFORE_QUIT)) {
    try {
      await hook.run()
    } catch (err) {
      logger.warn(`[Lifecycle] Before-quit hook failed (${hook.label}):`, err)
    }
  }
  // Detach channels and subscriptions only after the database is flushed/closed, so no handler runs mid-quit
  try {
    stopNotes()
    stopHarness()
  } catch (err) {
    logger.warn('[Lifecycle] Failed to tear down system features:', err)
  }
}

/** Registers app lifecycle hooks: save streaming data before quit / close the database and plugin resources / quit when all windows close */
export function registerLifecycleHooks(): void {
  app.on('before-quit', (event) => {
    // Allow the final quit once cleanup is done
    if (cleanupDone) return
    // Cleanup in progress: block re-entrant quit (fix: it used to pass straight through, cutting
    // off streams still being saved and exiting before database/memory cleanup finished)
    if (isQuitting) {
      event.preventDefault()
      return
    }
    isQuitting = true
    // Intercept this quit uniformly and really quit after cleanup (fix: it used to return early when
    // no stream was active, so database.close()/closeAllMnemon() never ran)
    event.preventDefault()

    void (async () => {
      try {
        // With active streams, abort them first and wait for them to be persisted (5s max)
        if (activeHarnessStreams.size > 0) {
          for (const controller of streamAbortControllers.values()) {
            controller.abort()
          }
          await Promise.race([
            Promise.allSettled([...activeHarnessStreams]),
            new Promise((resolve) => setTimeout(resolve, 5000))
          ])
        }
      } catch (error) {
        logger.error('Error during stream abort:', error)
      } finally {
        try {
          const database = getDatabaseRef()
          if (database) {
            await database.close()
          }
        } finally {
          try {
            // Release plugin resources before quit (the `app.before-quit` contribution point, e.g.
            // harness shutting down the Mnemon singleton): await + catch each one — a single plugin
            // failing cleanup must not block process exit. Contributions are removed when a plugin is
            // disabled, so disabled plugins are never called (core knows no plugin modules).
            await runBeforeQuitHooks()
          } catch (err) {
            logger.warn('[Lifecycle] Failed to run before-quit hooks:', err)
          }
          cleanupDone = true
          app.quit()
        }
      }
    })()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
