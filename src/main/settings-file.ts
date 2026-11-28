import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * Startup self-check and backup for `settings.json` (pure file operations, no electron import —
 * unit tests can run it directly).
 *
 * Background (2026-11-24): someone deleted `%APPDATA%/ryten-bench/settings.json`, so the app rebuilt
 * it with defaults on its next start: the lock screen was disabled, the default password reverted to
 * 123456, and the theme / workspace path / tray settings were all lost. The database (RytenBenchDB),
 * memory, skills and plugins were still intact; only this "application settings" file was lost.
 *
 * Two things happen here:
 * - After every settings change, atomically write the **currently effective content** to
 *   `settings.backup.json`;
 * - On startup, if settings.json is missing or not valid JSON, try to restore it from the backup;
 *   invalid files are renamed and archived, never deleted outright (so they can be inspected later).
 *
 * Note: the backup lives in the same directory under the same Windows permissions as the main file,
 * so this guards against accidental or casual deletion, but not against someone with local file
 * permissions deleting both and reading the database directly. Real confidentiality relies on OS
 * accounts / BitLocker / application-level database encryption; this layer only keeps the lock-screen
 * configuration from silently lapsing when a single file disappears (after a restore, startup enforces
 * the lock screen).
 */

export interface SettingsFilePaths {
  /** Current settings file */
  settings: string
  /** Most recent valid settings */
  backup: string
}

export interface SettingsRecovery {
  /** settings.json existed and was a valid JSON object at startup */
  settingsExisted: boolean
  /** Path the invalid file was renamed to (null when there was no invalid file) */
  quarantined: string | null
  /** Whether settings were restored from settings.backup.json */
  restoredFromBackup: boolean
  /** Backup file exists but is not valid JSON itself (restore failed) */
  backupInvalid: boolean
}

/** Paths of both files (tests may pass any directory; no Electron dependency) */
export function settingsFilePaths(userDataDir: string): SettingsFilePaths {
  return {
    settings: path.join(userDataDir, 'settings.json'),
    backup: path.join(userDataDir, 'settings.backup.json')
  }
}

/** Read a file and parse it into an object; returns null when missing, unreadable or not a JSON object */
export function readSettingsObject(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function quarantinePath(settings: string, now: number): string {
  const dir = path.dirname(settings)
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
  return path.join(dir, `settings.invalid-${stamp}.json`)
}

/**
 * Call before booting the store: make sure settings.json is usable.
 *
 * - Present and valid: use it as-is;
 * - Missing / invalid: restore from a valid backup if there is one; invalid files are first renamed
 *   and archived (not deleted);
 * - Restore failed: leave it missing and let the app start with defaults (the caller uses this to
 *   decide whether to enforce the lock screen).
 */
export function restoreSettingsFile(userDataDir: string, now = Date.now()): SettingsRecovery {
  const { settings, backup } = settingsFilePaths(userDataDir)
  const result: SettingsRecovery = {
    settingsExisted: false,
    quarantined: null,
    restoredFromBackup: false,
    backupInvalid: false
  }

  try {
    fs.mkdirSync(userDataDir, { recursive: true })
  } catch {
    return result
  }

  if (readSettingsObject(settings)) {
    result.settingsExisted = true
    return result
  }

  if (fs.existsSync(settings)) {
    // Invalid JSON: rename it aside so electron-store does not throw on startup, and so the evidence
    // is not simply deleted
    const target = quarantinePath(settings, now)
    try {
      fs.renameSync(settings, target)
      result.quarantined = target
    } catch {
      // Rename failed (file busy, etc.): the restore below will overwrite it; the original file is
      // still kept, nothing extra is destroyed
    }
  }

  if (!fs.existsSync(backup)) return result

  if (!readSettingsObject(backup)) {
    result.backupInvalid = true
    return result
  }

  try {
    // The backup is complete JSON, so overwrite directly (this creates the file when the invalid one
    // was renamed away)
    fs.copyFileSync(backup, settings)
    result.restoredFromBackup = true
  } catch {
    // Disk read-only / file busy: leave it missing and let the app start with defaults
  }
  return result
}

/** Copy the currently valid settings.json into the backup file; returns success */
export function writeSettingsBackup(userDataDir: string): boolean {
  const { settings, backup } = settingsFilePaths(userDataDir)
  const raw = (() => {
    try {
      return fs.readFileSync(settings, 'utf8')
    } catch {
      return null
    }
  })()
  if (raw === null) return false
  // Validate before writing the backup: never copy truncated JSON / a corrupt file into the
  // "most recent valid settings"
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
  } catch {
    return false
  }

  const temp = `${backup}.tmp`
  try {
    fs.writeFileSync(temp, raw, 'utf8')
    // On Windows, rename replaces an existing target; a same-directory rename is atomic and never
    // leaves a partial backup
    fs.renameSync(temp, backup)
    return true
  } catch {
    try {
      fs.rmSync(temp, { force: true })
    } catch {
      // Ignore cleanup failures
    }
    return false
  }
}
