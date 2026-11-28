// ⚠️ Must be the first import: environment pins the dev/packaged userData pair at **module
// evaluation time** (dev = <appData>/ryten-bench-dev, packaged = <appData>/ryten-bench).
// The ./plugins/host import below reads app.getPath('userData') during evaluation via
// ./context (electron-store) and the database modules; one step later and
// settings/database/plugins/account/logs would be written into the other environment.
import { currentEnvironment, currentUserDataDir } from './environment'
import { app, BrowserWindow, ipcMain, crashReporter } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import logger from 'electron-log'
import { initPluginHost, pushPluginChannels } from './plugins/host'
import { registerPluginScheme, registerPluginProtocolHandler } from './plugins/protocol'
import { registerLifecycleHooks } from './lifecycle'
import { registerStartupIpc, runStartupInitialization } from './windows/startup'
import { createMainWindow } from './windows/main-window'
import { registerMermaidPreviewIpc } from './windows/mermaid-preview'
import { createTray } from './tray'
import { setupWeather } from './weather'
import { bootstrapStorageLayout } from './storage'
import { initAccountProfile } from './profiles/runtime'

// Single-instance lock: prevents multiple launches and lets the installer detect and close the
// running process. The lock key is userData, so dev (ryten-bench-dev) and packaged
// (ryten-bench) are independent and may each run one instance; two processes must never share
// a single data directory.
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  // Must end immediately via app.exit: app.quit() only queues the exit and this module's
  // whenReady chain still runs once -- PGlite has no cross-process lock, so two processes opening
  // the same data directory corrupt the database.
  // (Measured on 2026-11-24: launching a new build while an older installer is still running lets
  // the second instance briefly initialize and open the same database.)
  app.exit(0)
} else {
  app.on('second-instance', () => {
    // On a second launch, restore the main window (including when hidden in the system tray)
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    if (win) {
      if (win.isMinimized()) win.restore()
      if (!win.isVisible()) win.show()
      win.focus()
    }
  })
}

logger.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}'
logger.transports.file.fileName = 'main.log'
// Log rotation: electron-log defaults to 1MB plus a single .old file, so a long-running app
// pushes the previous crash scene out of the window. Raise it to 5MB (still one .old file, so the
// total stays bounded) to keep at least the latest crash stack / error context.
logger.transports.file.maxSize = 5 * 1024 * 1024

/**
 * Process-level crash backstop: uncaught exceptions / unhandled rejections must at least land in
 * `main.log`.
 *
 * Why it has to live here: packaged builds have no visible stderr, and the app previously had
 * zero `uncaughtException` / `unhandledRejection` handlers -- any background Promise rejection in
 * the main process could mean the window "suddenly vanished" with no traceable root cause.
 *
 * Strategy:
 * - uncaughtException logs the full stack, then **exits in a controlled way** (main-process state
 *   is no longer trustworthy; continuing could write bad data);
 * - unhandledRejection only logs and does not exit (many background tasks are fire-and-forget;
 *   exiting would upgrade a recoverable failure into a crash), with a count cap so a rejection
 *   loop cannot flood the log.
 */
process.on('uncaughtException', (err) => {
  logger.error('[Main] uncaughtException:', err)
  try {
    app.exit(1)
  } catch {
    process.exit(1)
  }
})

let loggedRejectionCount = 0
process.on('unhandledRejection', (reason) => {
  if (loggedRejectionCount < 50) {
    loggedRejectionCount += 1
    logger.error('[Main] unhandledRejection:', reason)
  } else if (loggedRejectionCount === 50) {
    loggedRejectionCount += 1
    logger.error('[Main] unhandledRejection: further rejections suppressed (50 logged)')
  }
})

// Collect crash dumps locally (previously a renderer crash left only an exitCode and no dump to
// inspect). Write to disk only, never upload: dumps live in userData/Crashpad/reports.
try {
  crashReporter.start({ uploadToServer: false })
} catch (err) {
  logger.warn('[Main] Failed to start crashReporter:', err)
}

// Save streaming data before exit / quit once all windows are closed
registerLifecycleHooks()

// plugin:// custom protocol (serves external plugin files): the scheme privilege declaration must
// happen before the app is ready
registerPluginScheme()

/**
 * Dev-mode DevTools shortcut: Ctrl+Shift+I / Cmd+Alt+I toggles the panel.
 *
 * Why it needs a separate binding: when unpackaged, `watchWindowShortcuts` from
 * `@electron-toolkit/utils` **only handles F12** (and in dev it does not intercept Ctrl+Shift+I);
 * meanwhile the main window uses the native title bar on Windows and `win.setMenu(null)` removes
 * the default menu, so its "Toggle Developer Tools" entry is gone as well. The result is no entry
 * point besides F12, so people used to Ctrl+Shift+I think DevTools cannot be opened.
 *
 * Only Ctrl+Shift+I is added here (F12 is still handled by the helper above, so a single event is
 * not toggled twice). Packaged builds do not get this shortcut: DevTools is unavailable by design
 * in release builds.
 */
function installDevToolsAccelerator(win: BrowserWindow): void {
  if (app.isPackaged) return
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const key = input.key.toLowerCase()
    const toggle =
      (input.control && input.shift && key === 'i') || (input.meta && input.alt && key === 'i')
    if (!toggle) return
    event.preventDefault()
    const contents = win.webContents
    if (contents.isDevToolsOpened()) contents.closeDevTools()
    else contents.openDevTools({ mode: 'undocked' })
  })
}

app
  .whenReady()
  .then(async () => {
    // Log the environment name and userData location first, so a problem immediately shows which
    // data set is being read and written.
    const environment = currentEnvironment()
    logger.info(
      `[Environment] ${environment.name} | appName=${environment.appName} | ` +
        `userData=${currentUserDataDir()}`
    )

    electronApp.setAppUserModelId('com.ryten.bench')

    // Account-level local data space: the swap must complete before **any** database/plugin/sync
    // data is read or written. (Signed out = the anonymous container; after switching accounts and
    // restarting, this moves the previous account's data into profiles/.)
    if (!initAccountProfile()) return

    // plugin:// protocol handler (static files for external plugins; must register after ready)
    registerPluginProtocolHandler()

    // Default storage layout: <install dir>/data/{memory,plugins,skills} (falls back to
    // userData/data when not writable). Must run before initPluginHost(): during load the plugin
    // workshop reads harness.pluginsPath to inject the runtime.
    bootstrapStorageLayout()

    // The file-change snapshot dir (userData/file-history), tool-result detail dir
    // (userData/tool-output) and workspace file watching are assembled with the AI assistant
    // (`src/main/system/harness.ts`) and started by `startSystemModules()` from `initPluginHost()`
    // before the window is created.

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
      // Add Ctrl+Shift+I in dev (F12 is handled by the helper above; Windows has no other entry
      // point once the menu is removed)
      installDevToolsAccelerator(window)
      // Plugin channel allowlist: startup pushes happen before the window exists (so they are
      // always lost); push once more after the page finishes loading
      window.webContents.on('did-finish-load', () => pushPluginChannels())
    })

    // Register IPC: core (window/setting/dialog/provider/plugins) is always on, plus the plugin
    // host loaded according to enabled state (all plugins come from disk packages under
    // `userData/plugins/<id>/`; toggling is driven by plugins-set-enabled)
    initPluginHost()
    // App version (shown on the loading page)
    ipcMain.handle('app-version', () => app.getVersion())
    // Mermaid preview window (the HTML template lives at ./resource/mermaid-preview.html)
    registerMermaidPreviewIpc()

    // Startup page (per the 2026-11-20 requirement): there is no separate loading window.
    // Create the main window and show it immediately (StartupSplash is overlaid in the renderer),
    // run initialization in the background and push progress to the splash over IPC; enter the
    // main UI only once everything is complete.
    registerStartupIpc()
    createMainWindow()
    void runStartupInitialization()

    // Weather IPC and auto-refresh are registered/started exactly once (pushed to the main window;
    // previously repeated calls alongside createMainWindow registered ipcMain.handle twice and
    // threw)
    setupWeather()

    // System tray: closing the window can keep the app in the background (whether it does is
    // controlled by General settings -> System tray)
    createTray()

    // macOS activate: rebuild only the main window after all windows close (initialization runs
    // once; previously re-running createMainWindow created the database twice and re-registered
    // IPC, which crashed)
    app.on('activate', function () {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow()
      }
    })
  })
  .catch((err) => {
    logger.error('[Main] Failed to initialize main flow:', err)
  })
