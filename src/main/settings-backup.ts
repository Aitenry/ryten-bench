import { app } from 'electron'
import logger from 'electron-log'
import { currentUserDataDir } from './environment'
import { restoreSettingsFile, writeSettingsBackup, type SettingsRecovery } from './settings-file'

/**
 * Startup self-healing and continuous backup for `settings.json` (Electron-side glue).
 *
 * The pure file logic lives in `settings-file.ts` (unit-testable); this file only:
 * - repairs a missing/corrupt settings file **before** `context.ts` constructs electron-store;
 * - refreshes `settings.backup.json` after every store change;
 * - does one more pass before quitting, so the last change is not left unbacked.
 *
 * The recovery result is passed to the startup flow: if this was "settings file lost, restored from backup" and
 * the lock screen is still enabled, startup must lock immediately (see windows/startup.ts); otherwise deleting
 * the file would still be a way around the lock screen.
 */

let recovery: SettingsRecovery | null = null
let watcherStarted = false

/** Call before `new Store()` (idempotent) */
export function recoverSettingsAtStartup(): SettingsRecovery {
  if (recovery) return recovery
  try {
    const result = restoreSettingsFile(currentUserDataDir())
    recovery = result
    if (result.quarantined) {
      logger.warn(`[Settings] Invalid settings.json archived: ${result.quarantined}`)
    }
    if (result.restoredFromBackup) {
      logger.warn(
        '[Settings] settings.json was missing or invalid; restored from settings.backup.json'
      )
    }
    if (result.backupInvalid) {
      logger.warn(
        '[Settings] settings.backup.json is not valid JSON; settings started from defaults'
      )
    }
    return result
  } catch (error) {
    logger.error('[Settings] Failed to inspect settings.json at startup:', error)
    recovery = {
      settingsExisted: false,
      quarantined: null,
      restoredFromBackup: false,
      backupInvalid: false
    }
    return recovery
  }
}

/** Whether a "settings file lost/corrupt" recovery happened at startup (the startup flow forces a lock screen from it) */
export function getSettingsRecovery(): SettingsRecovery | null {
  return recovery
}

/** Attach backup after the store is constructed: one initial + one per change + one before quitting */
export function startSettingsBackupWatcher(store: {
  onDidAnyChange?: (callback: () => void) => unknown
}): void {
  if (watcherStarted) return
  watcherStarted = true

  const backup = (): void => {
    // Early in startup the store may not have written to disk yet (loadConfig has not written defaults); that is
    // not an error. A failed write is only worth investigating when the file exists yet cannot be backed up, so
    // log at debug level only.
    if (!writeSettingsBackup(currentUserDataDir())) {
      logger.debug(
        '[Settings] settings.backup.json not written yet (settings.json missing or invalid)'
      )
    }
  }

  backup()
  try {
    store.onDidAnyChange?.(backup)
  } catch (error) {
    logger.warn('[Settings] Failed to subscribe settings backup watcher:', error)
  }
  app.on('before-quit', backup)
}
