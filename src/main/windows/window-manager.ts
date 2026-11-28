import { BrowserWindow } from 'electron'

// Window state (main window only; the splash page moved into the main window renderer, so
// there is no separate loading window anymore)
let mainWindow: BrowserWindow | null = null
let initComplete = false // Whether initialization tasks finished (the splash fades out based on this)
let mainWindowReady = false // Whether the main window renderer is ready (ready-to-show)

export function setMainWindow(win: BrowserWindow | null): void {
  mainWindow = win
  // A new window (rebuilt on macOS activate) must wait for its own ready-to-show; do not
  // reuse the old state
  if (win) mainWindowReady = false
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

/** Mark initialization complete (called at the end of the initialization flow) */
export function markInitComplete(): void {
  initComplete = true
  tryShowMainWindow()
}

export function isInitComplete(): boolean {
  return initComplete
}

/** Mark the main window renderer ready (called on ready-to-show) */
export function markMainWindowReady(): void {
  mainWindowReady = true
  tryShowMainWindow()
}

/**
 * Try to show the main window: show it as soon as the renderer is ready.
 *
 * Unlike the old version, this no longer waits for initialization to finish — the main window
 * is shown first, the renderer covers the UI with the splash page (StartupSplash), and once
 * initialization and first-screen data are ready it fades out into the main UI (per the user's
 * 2026-11-20 decision).
 */
export function tryShowMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindowReady) return
  if (!mainWindow.isVisible()) mainWindow.show()
}
