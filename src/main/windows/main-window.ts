import { app, BrowserWindow, ipcMain, nativeTheme, screen, session, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import icon from '../../../resources/logo.png?asset'
import logger from 'electron-log'
import { safeSend } from '../safe-send'
import { getMainWindow, markMainWindowReady, setMainWindow } from './window-manager'
import { isCloseToTrayEnabled, isTrayAvailable, syncTrayState } from '../tray'
import { isQuittingNow, markQuitting } from '../lifecycle'
import { listContributions } from '../plugins/contributions'
import { APP_RENDERER_MEMORY_DUMP, type AppHook } from '../plugins/app-hooks'
import { dumpHarnessMemory } from '../system/harness'
import { syncWindowBorderColor } from './dwm-border'
import { attachLockScreen, isLockScreenLocked } from '../lock/service'

/** Maximized state per window (shared by the main and mermaid preview windows; cleared on destroy) */
const windowMaxStates = new Map<
  number,
  { isMaximized: boolean; normalBounds: Electron.Rectangle | null }
>()

/**
 * **Uniqueness guard** for per-window close cleanup registered by the window control IPC.
 *
 * Why it is needed (`MaxListenersExceededWarning: 11 closed listeners added to [BrowserWindow]`
 * observed in practice): previously `winFromEvent` attached one `once('closed', …)` cleanup per
 * window control IPC call (minimize/maximize/close/query-maximized each added one, and the
 * renderer's window buttons call them frequently) — 11 on the same window triggered Node's
 * listener limit warning. Cleanup is now registered once per window: the WeakSet does not keep
 * windows alive, and the `closed` event clears both the state and the guard.
 */
const windowCleanupWatched = new WeakSet<Electron.BrowserWindow>()

/** Register close cleanup for a window (idempotent: one listener no matter how often it is called) */
function watchWindowCleanup(win: Electron.BrowserWindow): void {
  if (windowCleanupWatched.has(win)) return
  windowCleanupWatched.add(win)
  const id = win.id
  win.once('closed', () => {
    windowCleanupWatched.delete(win)
    windowMaxStates.delete(id)
  })
}

let windowControlIpcRegistered = false

/** Memory snapshot on abnormal renderer exit: the system capability (AI assistant) plus hooks contributed by third-party plugins */
function runRendererMemoryDumpHooks(reason: string, exitCode: number): void {
  try {
    // The snapshot is a diagnostic side path: it must not block crash recovery
    dumpHarnessMemory(reason, exitCode)
  } catch (err) {
    logger.warn('[Memory] AI assistant memory snapshot failed:', err)
  }
  for (const hook of listContributions<AppHook>(APP_RENDERER_MEMORY_DUMP)) {
    try {
      // Diagnostic side path: never blocks crash recovery; async failures are only logged
      void Promise.resolve(hook.run(reason, exitCode)).catch((err) => {
        logger.warn(`[Memory] Memory snapshot hook failed (${hook.label}):`, err)
      })
    } catch (err) {
      logger.warn(`[Memory] Memory snapshot hook failed (${hook.label}):`, err)
    }
  }
}

/**
 * Persistent partition name of the built-in browser (`<webview>`), matching
 * `partition="persist:ryten-browser"` in the renderer's `BrowserPanel.tsx`.
 */
const BROWSER_PARTITION = 'persist:ryten-browser'

/**
 * Page permissions that may be requested (everything else is denied).
 *
 * Why an explicit decision is required: with **no** `setPermissionRequestHandler` installed,
 * Electron approves permission requests by default — guest pages could get the camera/microphone/
 * geolocation/notifications directly, and a persistent partition (`persist:`) keeps grants across
 * sessions. Only basic browser capabilities that do not affect privacy are allowed here:
 * fullscreen playback, pointer lock and clipboard write; camera/microphone/location/notifications/
 * MIDI/screen capture and the rest are all denied.
 */
const ALLOWED_PAGE_PERMISSIONS: ReadonlySet<string> = new Set([
  'fullscreen',
  'pointerLock',
  'clipboard-sanitized-write'
])

let sessionPermissionsConfigured = false

/** Install the same permission policy on the main window and built-in browser sessions (once globally) */
function configureSessionPermissions(win: BrowserWindow): void {
  if (sessionPermissionsConfigured) return
  sessionPermissionsConfigured = true
  const sessions = [win.webContents.session, session.fromPartition(BROWSER_PARTITION)]
  for (const target of sessions) {
    target.setPermissionRequestHandler((_webContents, permission, callback) => {
      const allowed = ALLOWED_PAGE_PERMISSIONS.has(permission)
      if (!allowed) logger.warn(`[Security] Denied page permission request: ${permission}`)
      callback(allowed)
    })
    target.setPermissionCheckHandler((_webContents, permission) =>
      ALLOWED_PAGE_PERMISSIONS.has(permission)
    )
  }
}

/** Renderer warning dedupe window (libraries such as KaTeX emit the same message hundreds of times) */
const CONSOLE_WARN_DEDUPE_WINDOW_MS = 10_000
const CONSOLE_WARN_REPEAT_SUMMARY_AT = 100
const consoleWarnSeen = new Map<string, { count: number; lastAt: number }>()

/**
 * Allowlist of external protocols that may be handed to the OS.
 *
 * Why it is needed: links in chat text / web fetch results are passed to `shell.openExternal`
 * through `setWindowOpenHandler` and `will-navigate`, and on Windows `file:`, `ms-msdt:`,
 * `search-ms:`, `smb://` etc. are taken over directly by system protocol handlers (Electron's
 * security checklist requires a scheme allowlist for openExternal). Only the three browser
 * protocols are allowed; everything else is denied and logged.
 */
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/** Parse a URL; returns null for an invalid one (no throw; callers treat it as "deny") */
function parseUrlOrNull(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

/** Same-origin check for dev renderer navigation (`startsWith` would treat `localhost:5173.evil.com` as same-origin) */
function isSameOrigin(url: string, origin: string): boolean {
  const target = parseUrlOrNull(url)
  const base = parseUrlOrNull(origin)
  return Boolean(target && base && target.origin === base.origin)
}

/**
 * Hand external links to the system browser: only allowlisted protocols pass.
 *
 * Logs record the protocol only, never the full URL: query strings may carry OAuth tokens or
 * share keys.
 */
function openExternalIfAllowed(url: string, context: string): void {
  const parsed = parseUrlOrNull(url)
  if (!parsed || !ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol)) {
    logger.warn(`[Window] Blocked external URL (${context}) protocol=${parsed?.protocol ?? 'invalid'}`)
    return
  }
  shell
    .openExternal(parsed.toString())
    .catch((err) => logger.warn(`[Window] Failed to open external link (${context}):`, err))
}

/**
 * Window control IPC (acts on the sender's window): registered only once globally.
 * Previously it was registered inside createMainWindow — on macOS, activate reopening the main
 * window after all windows were closed made ipcMain.handle throw on duplicate registration
 * (Attempted to register a second handler) and ipcMain.on bind twice (one click handled twice).
 */
function registerWindowControlIpcOnce(): void {
  if (windowControlIpcRegistered) return
  windowControlIpcRegistered = true

  const winFromEvent = (
    event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent
  ): BrowserWindow | null => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && !win.isDestroyed()) watchWindowCleanup(win)
    return win
  }

  ipcMain.on('window-minimize', (event) => {
    winFromEvent(event)?.minimize()
  })
  ipcMain.on('window-maximize', (event) => {
    const win = winFromEvent(event)
    if (!win || win.isDestroyed()) return
    let st = windowMaxStates.get(win.id)
    if (!st) {
      st = { isMaximized: false, normalBounds: null }
      windowMaxStates.set(win.id, st)
    }
    if (st.isMaximized) {
      // Restore the previous size and position
      if (st.normalBounds) win.setBounds(st.normalBounds)
      st.isMaximized = false
    } else {
      // Save the current bounds, then maximize to the work area
      st.normalBounds = win.getBounds()
      const { workArea } = screen.getPrimaryDisplay()
      win.setBounds({
        x: workArea.x,
        y: workArea.y,
        width: workArea.width,
        height: workArea.height
      })
      st.isMaximized = true
    }
    safeSend(win.webContents, 'window-maximized', st.isMaximized)
  })
  ipcMain.on('window-close', (event) => {
    winFromEvent(event)?.close()
  })
  ipcMain.handle('window-is-maximized', (event) => {
    const win = winFromEvent(event)
    return win ? (windowMaxStates.get(win.id)?.isMaximized ?? false) : false
  })

  /**
   * Window title (native title bar): the renderer updates it to `xxx - RytenBench` with the
   * current content. Only plain text is accepted and it is truncated, so overly long or multiline
   * content never ends up in the title bar.
   */
  ipcMain.on('window-set-title', (event, title: unknown) => {
    const win = winFromEvent(event)
    if (!win || win.isDestroyed() || typeof title !== 'string') return
    const clean = title
      .replace(/[\r\n\t]+/g, ' ')
      .trim()
      .slice(0, 160)
    win.setTitle(clean || 'RytenBench')
  })

  /**
   * Theme sync for the custom title bar (Window Controls Overlay, Windows / Linux): the renderer
   * sends the measured sidebar background and foreground colors, and the main process updates the
   * colors of the system-drawn window buttons. The buttons themselves remain **system-drawn** (not
   * fake buttons painted by the renderer); only their colors and background strip follow the theme.
   */
  ipcMain.on('window-titlebar-overlay', (event, payload: unknown) => {
    const win = winFromEvent(event)
    if (!win || win.isDestroyed()) return
    const data = (payload ?? {}) as { color?: unknown; symbolColor?: unknown; height?: unknown }
    const color = typeof data.color === 'string' ? data.color : undefined
    const symbolColor = typeof data.symbolColor === 'string' ? data.symbolColor : undefined
    const height = typeof data.height === 'number' ? data.height : undefined
    const overlay = {
      ...(color ? { color } : {}),
      ...(symbolColor ? { symbolColor } : {}),
      ...(height ? { height } : {})
    }
    const apply = (): void => {
      if (win.isDestroyed()) return
      try {
        win.setTitleBarOverlay(overlay)
      } catch (err) {
        // Silently degrade where WCO is unsupported (macOS / older Electron); the title bar still renders
        logger.debug('[Window] setTitleBarOverlay unavailable:', err)
      }
      // Match the system window border (the 1–2px drawn by DWM) to the title bar background, so no
      // dark edge remains at the top in light theme
      if (color) syncWindowBorderColor(win, color)
    }
    apply()
    // Windows occasionally does not repaint the WCO overlay immediately after a theme switch
    // (most visible in maximized windows); apply again on the next frame and shortly after so the
    // system button strip and the renderer-drawn title strip stay in sync.
    setTimeout(apply, 80)
    setTimeout(apply, 260)
  })

  /**
   * Make the **light/dark of the system-drawn window border/title bar** follow the app theme.
   *
   * Reported symptom: after switching the app to light, the very top edge of the window still had
   * a dark gray line — that is the DWM window border Windows draws from "system dark mode", which
   * does not follow the in-app theme. Declaring the system-side light/dark through
   * nativeTheme.themeSource keeps the DWM border/shadow in sync.
   */
  ipcMain.on('window-native-theme', (_event, mode: unknown) => {
    if (mode === 'light' || mode === 'dark' || mode === 'system') {
      nativeTheme.themeSource = mode
    }
  })

  // App menu commands (the Application / Edit dropdowns of the custom title bar): in-window
  // actions only, with no arbitrary IPC exposed
  ipcMain.on('window-reload', (event) => {
    // No reload while locked: a reload reloads the page, and the old implementation where "the
    // lock was only renderer state" unlocked with a single reload. Lock state now lives in the
    // main process and re-locks after a reload; this also blocks the content flash at the moment
    // of reload (the macOS custom title bar menu is still reachable).
    if (isLockScreenLocked()) return
    winFromEvent(event)?.webContents.reload()
  })
  ipcMain.on('app-quit', () => {
    markQuitting()
    app.quit()
  })
  ipcMain.on('window-edit-command', (event, command: unknown) => {
    const wc = event.sender
    if (!wc || wc.isDestroyed()) return
    switch (command) {
      case 'undo':
        wc.undo()
        break
      case 'redo':
        wc.redo()
        break
      case 'cut':
        wc.cut()
        break
      case 'copy':
        wc.copy()
        break
      case 'paste':
        wc.paste()
        break
      case 'selectAll':
        wc.selectAll()
        break
      default:
        break
    }
  })
}

export function createMainWindow(): void {
  const isWindows = process.platform === 'win32'
  const isMac = process.platform === 'darwin'
  /** Title bar background color (first-frame fallback; also used by hiddenInset on macOS) */
  const TITLEBAR_BG = '#1b1b1d'
  /** Window title (name shown on the left of the native title bar; the renderer updates it to `xxx - RytenBench`) */
  const APP_TITLE = 'RytenBench'

  const win = new BrowserWindow({
    width: 1200,
    height: 800, // starting size equals the minimum (same as min); can be enlarged later
    minWidth: 1200,
    minHeight: 800,
    show: false,
    /**
     * Title bar style:
     *
     * Remove the content of the top area and replace it with native content — dropping the custom
     * title bar + WCO (the color sync of the Application/Edit menus was never quite right); on
     * Windows the **native system title bar** is used: dragging, minimize/maximize/close are all
     * system-drawn, and the project's own icon + name stay on the left.
     * Light/dark still follows the app theme (nativeTheme.themeSource synced by the renderer).
     * macOS keeps hiddenInset + traffic light position; Linux already has the native frame.
     */
    ...(isWindows
      ? {
          frame: true,
          title: APP_TITLE,
          backgroundColor: TITLEBAR_BG
        }
      : isMac
        ? {
            titleBarStyle: 'hiddenInset' as const,
            trafficLightPosition: { x: 16, y: 17 },
            backgroundColor: TITLEBAR_BG
          }
        : {
            frame: true,
            backgroundColor: TITLEBAR_BG
          }),
    autoHideMenuBar: true,
    ...{ icon },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      /**
       * The in-app browser panel uses `<webview>` for real web pages (not an iframe, which
       * X-Frame-Options would block). webviewTag must be enabled explicitly; guest page security
       * preferences are tightened in will-attach-webview below.
       */
      webviewTag: true
    }
  })
  setMainWindow(win)
  // Page permission policy (camera/microphone/location/notifications etc.): allowing by default is
  // Electron's historical behavior, and the built-in browser opens arbitrary sites, so the host
  // must tighten it explicitly
  configureSessionPermissions(win)

  /**
   * Security baseline for in-app browser guests: no matter how the page sets `<webview>`
   * attributes, strip preload, disable Node integration and enable context isolation and sandbox.
   */
  win.webContents.on('will-attach-webview', (_event, webPreferences) => {
    delete (webPreferences as { preload?: string }).preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
  })
  // Lock screen state machine takeover: re-send the lock state after every page load (reload or
  // crash recovery never unlocks), lock on minimize/hide, and block reload and devtools shortcuts
  // while locked.
  attachLockScreen(win)

  if (isWindows) {
    // Native title bar: no menu bar; the title is fixed to the app name (writing document.title
    // does not override it). The icon stays: the icon slot of the Windows native title bar cannot
    // be removed (clearing it falls back to the Electron default icon), so the project's own logo
    // is used (the mascot in resources/logo.png, set via BrowserWindow's icon).
    win.setMenu(null)
    win.on('page-title-updated', (event) => {
      event.preventDefault()
      win.setTitle(APP_TITLE)
    })
  }

  // Show the main window **immediately** once the renderer is ready: the startup splash
  // (StartupSplash) covers the renderer, then fades out into the main UI after initialization and
  // first-screen data finish (the main process no longer controls the handoff timing)
  win.on('ready-to-show', () => {
    logger.info('[Window] Main window ready-to-show')
    markMainWindowReady()
  })

  win.on('closed', () => {
    if (getMainWindow() === win) setMainWindow(null)
  })

  // Close interception: with "close to system tray" enabled, closing hides to the tray (a real
  // quit passes through)
  win.on('close', (event) => {
    if (isCloseToTrayEnabled() && isTrayAvailable() && !isQuittingNow()) {
      event.preventDefault()
      win.hide()
    }
  })

  // Sync tray state on show/hide (the context menu text reflects it immediately)
  win.on('show', () => syncTrayState())
  win.on('hide', () => syncTrayState())

  // System shutdown/logoff (Windows): a window event (in Electron 43 session-end is a window
  // event, not an app event). With tray residency the window never closes, and if it is not
  // allowed through, Windows can only force-kill the process, potentially losing unsaved data.
  win.on('session-end', () => {
    markQuitting()
    app.quit()
  })

  // Renderer exit diagnostics: log the reason (crash/OOM/killed/clean exit), which helps debug
  // anomalies such as a sudden blank window while running; the main process itself does not crash
  // when the renderer exits.
  // Previously a crash/OOM left the main window with only a dead frame (the app gradually became
  // unusable/stuck) — the IPC is already registered globally once, so destroy and recreate the
  // main window to recover (the new webContents is not on the safeSend dead list).
  win.webContents.on('render-process-gone', (_event, details) => {
    const abnormal = details.reason !== 'clean-exit' && details.reason !== 'killed'
    const msg = `[Window] Renderer process exited reason=${details.reason} exitCode=${details.exitCode}`
    if (abnormal) logger.error(msg)
    else logger.info(msg)
    // Capture a memory snapshot on crash/OOM (the renderer is gone, so only the samples cached
    // during streaming remain): without that number the log only shows reason=oom and there is no
    // way to tell which traffic segment raised the level.
    if (abnormal) runRendererMemoryDumpHooks(details.reason, details.exitCode)
    if (
      details.reason === 'crashed' ||
      details.reason === 'oom' ||
      details.reason === 'launch-failed' ||
      details.reason === 'integrity-failure'
    ) {
      logger.warn(
        '[Window] Renderer process exited abnormally, recreating main window in 300ms to recover...'
      )
      setTimeout(() => {
        // No self-heal while the app is quitting (quit cleanup closes the database, so a recreated
        // window would always fail to load)
        if (isQuittingNow()) return
        if (getMainWindow() === win && !win.isDestroyed()) {
          // Create the new window first, then destroy the crashed old one.
          // Previously win.destroy() ran before createMainWindow(): destroying the last window
          // triggers window-all-closed → app.quit() (Windows), and the loadURL of the window
          // created afterwards was cut off by the quit cleanup with ERR_FAILED(-2), so a single
          // renderer OOM/crash brought down the whole app; creating first keeps the window count
          // at 1→2→1 and never zero, so the quit flow does not start during self-heal.
          try {
            createMainWindow()
          } catch (err) {
            logger.error('[Window] Failed to recreate main window for self-heal:', err)
          }
          if (getMainWindow() === win && !win.isDestroyed()) {
            // If recreation failed (constructor threw), destroy the old window so the normal quit
            // path runs instead of leaving an unusable dead window
            win.destroy()
          }
        } else if (!getMainWindow()) {
          createMainWindow()
        }
      }, 300)
    }
  })

  // Forward renderer console errors/warnings to the main-process log (previously renderer
  // exceptions left no trace on disk, and after a crash only the exitCode remained, making the
  // root cause impossible to locate).
  // Libraries such as KaTeX emit the same warning hundreds of times (e.g. Chinese text entering
  // math mode); warnings are deduped within a 10s window (one count summary at the 100th repeat),
  // while errors are always forwarded one by one.
  win.webContents.on('console-message', (event, details) => {
    /**
     * Field access supports both shapes: older versions put level/message/lineNumber/sourceId
     * directly on the event, newer ones pass MessageDetails as the second argument (level is a
     * number, the URL is called sourceUrl).
     * Location info is essential: uncaught renderer exceptions used to log only
     * "Uncaught TypeError: ..." with no way to locate the source.
     */
    const info = (details ?? event) as {
      level?: string | number
      message?: string
      lineNumber?: number
      sourceId?: string
      sourceUrl?: string
    }
    const msg = info.message ?? ''
    const level = info.level
    const isError = level === 'error' || level === 3
    const isWarning = level === 'warning' || level === 2
    if (!isError && !isWarning) return
    const url = info.sourceUrl ?? info.sourceId
    const at = url ? ` @ ${url}:${info.lineNumber ?? 0}` : ''
    if (isError) {
      logger.error(`[Renderer:error] ${msg}${at}`)
      return
    }
    const key = msg
    const now = Date.now()
    const seen = consoleWarnSeen.get(key)
    if (seen && now - seen.lastAt < CONSOLE_WARN_DEDUPE_WINDOW_MS) {
      seen.count += 1
      if (seen.count === CONSOLE_WARN_REPEAT_SUMMARY_AT) {
        logger.warn(
          `[Renderer:warning] ${msg} (same message repeated ${seen.count}+ times, not forwarding again within 10s)`
        )
      }
      return
    }
    consoleWarnSeen.set(key, { count: 1, lastAt: now })
    logger.warn(`[Renderer:warning] ${msg}${at}`)
  })

  win.webContents.setWindowOpenHandler((details) => {
    // External links go through the scheme allowlist instead of handing raw URLs to system
    // protocol handlers
    openExternalIfAllowed(details.url, 'window-open')
    return { action: 'deny' }
  })

  // Intercept main window navigation: only the app's own pages are allowed (dev URL / production
  // file://). If a link in chat text lacks target="_blank", clicking it navigates the window to the
  // remote page in place; that window's preload (sandbox:false) exposes the full window.api, so the
  // remote page could call main-process IPC — it must be intercepted and handed to the system
  // browser (in-page hash navigation does not fire this event).
  win.webContents.on('will-navigate', (event, url) => {
    const devOrigin = is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined
    const allowed = devOrigin ? isSameOrigin(url, devOrigin) : url.startsWith('file://')
    if (allowed) return
    event.preventDefault()
    openExternalIfAllowed(url, 'will-navigate')
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/resource/index.html`).catch((err) => {
      logger.error('[Window] Failed to load main window:', err)
    })
  } else {
    win.loadFile(join(__dirname, '../renderer/resource/index.html')).catch((err) => {
      logger.error('[Window] Failed to load main window:', err)
    })
  }
  logger.info('[Window] Main window created, renderer loading started')

  win.webContents.once('dom-ready', () => {
    logger.info('[Window] Main window dom-ready')
    safeSend(win.webContents, 'main-window-ready')
  })

  // Window control IPC is registered only once globally (no duplicate registration when macOS
  // activate reopens a window)
  registerWindowControlIpcOnce()
}
