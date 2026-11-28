import { app } from 'electron'
import * as fs from 'fs'
import { hasUserDataDirOverride, resolveEnvironment, type AppEnvironment } from './resolve'

export * from './resolve'

/**
 * Early-startup environment setup: determine the "development / packaged" data directories and apply them to Electron.
 *
 * **Timing is a hard constraint**, not a preference: the electron-store in `context.ts` and the database directory in
 * `database/loading.ts` both resolve `app.getPath('userData')` during **module evaluation**. Waiting until
 * `app.whenReady()` would be too late — they have already pinned the paths to the old directory. This module therefore
 * runs `applyEnvironment()` immediately when imported, and requires `src/main/index.ts` to place it as the **first
 * import** (see the comment there).
 *
 * Override rule: when the command line carries `--user-data-dir` (automation isolation), only the app name is changed and
 * userData is left alone, so the temporary directory handed to the test tooling takes effect as-is.
 */

let applied: AppEnvironment | null = null

export function applyEnvironment(): AppEnvironment {
  if (applied) return applied

  const environment = resolveEnvironment({
    packaged: app.isPackaged,
    appDataDir: app.getPath('appData')
  })

  // Must happen before ready: app.name affects the system menu, the About panel, and the macOS log directory.
  // The dev build carries a Dev suffix so the two environments are easy to tell apart in the desktop and logs.
  app.setName(environment.appName)

  const overridden = hasUserDataDirOverride(process.argv, app.commandLine)
  if (!overridden) {
    try {
      // Electron's setPath requires the directory to exist, otherwise it throws directly.
      fs.mkdirSync(environment.userDataDir, { recursive: true })
      app.setPath('userData', environment.userDataDir)
    } catch (error) {
      // Never silently fall back to the default directory: it belongs to the other environment's data, which is exactly what this module guards against.
      throw new Error(
        `无法准备 ${environment.name} 环境的用户数据目录 ${environment.userDataDir}：` +
          (error instanceof Error ? error.message : String(error))
      )
    }
  }

  applied = environment
  return environment
}

/** Environment used by the current process (already applied when this module is imported; applying once more here is idempotent) */
export function currentEnvironment(): AppEnvironment {
  return applied ?? applyEnvironment()
}

/** userData root actually in use by the current process (respects the `--user-data-dir` override) */
export function currentUserDataDir(): string {
  currentEnvironment()
  return app.getPath('userData')
}

applyEnvironment()
