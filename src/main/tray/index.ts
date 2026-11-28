import { app, BrowserWindow, ipcMain, nativeImage, nativeTheme, screen, Tray } from 'electron'
import logger from 'electron-log'
import { join } from 'path'
import tray16Icon from '../../../resources/tray-16.png?asset'
import tray32Icon from '../../../resources/tray-32.png?asset'
import trayMenuHtml from '../resource/tray-menu.html?asset'
import { settingsStore } from '../context'
import { getMainWindow } from '../windows/window-manager'
import { safeSend } from '../safe-send'
import { mainMessages } from '../i18n'
import { ThemeMode, TraySettings } from '../types/settings'

// System tray: brand icon (mascot rounded badge, 1x/2x representations; the same image is
// embedded in the menu header of tray-menu.html).
// Left click shows the main window; right click opens the custom menu window
// (src/main/resource/tray-menu.html, editorial style, follows the app theme light/dark — the
// native Menu cannot be styled, hence a separate frameless window).
// Tray and menu window references must be kept in module-level variables, otherwise they are
// garbage-collected and the icon disappears.

let tray: Tray | null = null
let menuWindow: BrowserWindow | null = null
let menuReadyPromise: Promise<BrowserWindow> | null = null
let menuOpening = false // re-entrancy guard while opening (waiting for the menu page to load)
let lastMenuHideAt = 0 // last hide time; suppresses animation replay in the blur→right-click race
let menuFlip: 'up' | 'down' = 'up' // most recent popup direction (kept when data is refreshed)

// Menu body size; window = menu body + 2×MENU_PAD (padding for the CSS shadow so it is not clipped)
const MENU_W = 280
const MENU_H = 202
const MENU_PAD = 16
const MENU_GAP = 10 // gap between the menu and the tray icon
const MENU_ANIMATE_GAP = 300 // reopened within this many ms after hiding: skip the entry animation

type MenuItem =
  | { type: 'separator' }
  | { type: 'action'; id: string; label: string; danger?: boolean; icon?: 'chevron' | 'power' }
  | { type: 'checkbox'; id: string; label: string; checked: boolean }

/** Whether closing the window minimizes to the system tray (enabled by default) */
export function isCloseToTrayEnabled(): boolean {
  const settings = settingsStore.get('tray') as TraySettings | undefined
  return settings?.closeToTray ?? true
}

/** Update the tray setting (persist + sync tray state immediately) */
export function setCloseToTray(enabled: boolean): void {
  settingsStore.set('tray', { closeToTray: enabled })
  syncTrayState()
}

/** Show and focus the main window (restore from tray) */
export function showMainWindow(): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
}

/** Hide the main window to the tray */
export function hideMainWindow(): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed() || !win.isVisible()) return
  win.hide()
}

function toggleMainWindow(): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed() && win.isVisible()) {
    hideMainWindow()
  } else {
    showMainWindow()
  }
}

/* ---------------- Custom menu window ---------------- */

/** Build the menu data (rebuilt before every popup so labels and check state stay fresh; localized) */
function buildMenuItems(): MenuItem[] {
  const win = getMainWindow()
  const visible = !!win && !win.isDestroyed() && win.isVisible()
  const m = mainMessages()
  return [
    {
      type: 'action',
      id: 'toggle-window',
      label: visible ? m.tray.hideWindow : m.tray.showWindow,
      icon: 'chevron'
    },
    { type: 'separator' },
    {
      type: 'checkbox',
      id: 'toggle-tray',
      label: m.tray.closeToTray,
      checked: isCloseToTrayEnabled()
    },
    { type: 'separator' },
    { type: 'action', id: 'quit', label: m.tray.quit, danger: true, icon: 'power' }
  ]
}

/** Menu theme follows the app theme setting (auto follows the system) */
function getMenuTheme(): 'light' | 'dark' {
  const theme = settingsStore.get('theme') as ThemeMode | undefined
  if (theme === 'light' || theme === 'dark') return theme
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

/** Lazily create the menu window (kept hidden; loaded on the first right click) */
function getMenuWindow(): Promise<BrowserWindow> {
  if (menuWindow && !menuWindow.isDestroyed() && menuReadyPromise) {
    return menuReadyPromise
  }
  menuWindow = new BrowserWindow({
    width: MENU_W + MENU_PAD * 2,
    height: MENU_H + MENU_PAD * 2,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // Disable the native shadow on the transparent window (Windows renders white/gray edges);
    // the visual shadow comes from CSS box-shadow
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })
  menuWindow.on('blur', () => hideTrayMenu())
  menuWindow.on('closed', () => {
    menuWindow = null
    menuReadyPromise = null
  })
  menuReadyPromise = new Promise((resolve, reject) => {
    const win = menuWindow!
    win.webContents.once('did-finish-load', () => {
      logger.info('[Tray] Tray menu window ready')
      resolve(win)
    })
    win.webContents.once('did-fail-load', (_event, code, desc) => {
      logger.error(`[Tray] Failed to load tray menu (${code}): ${desc}`)
      // Reset and destroy the window so the next right click can rebuild and retry (previously it
      // only rejected while the window stayed alive, so getMenuWindow short-circuited on the same
      // rejected promise and the tray menu was dead for the rest of the session)
      const failed = menuWindow
      menuWindow = null
      menuReadyPromise = null
      if (failed && !failed.isDestroyed()) failed.destroy()
      reject(new Error(`菜单加载失败: ${desc}`))
    })
    win.loadFile(trayMenuHtml).catch((err) => {
      logger.error('[Tray] Failed to load tray menu file:', (err as Error)?.message)
      const failed = menuWindow
      menuWindow = null
      menuReadyPromise = null
      if (failed && !failed.isDestroyed()) failed.destroy()
      reject(err as Error)
    })
  })
  return menuReadyPromise
}

/** Position the menu window next to the tray icon (up by default, down when space is short); returns the direction */
function positionMenuWindow(): 'up' | 'down' {
  if (!tray || !menuWindow || menuWindow.isDestroyed()) return 'up'
  const trayBounds = tray.getBounds()
  const display = screen.getDisplayMatching(trayBounds)
  const wa = display.workArea
  // Position the menu body (excluding the shadow padding) around the tray icon's horizontal center
  const bodyX = Math.round(trayBounds.x + trayBounds.width / 2 - MENU_W / 2)
  const bodyY = Math.round(trayBounds.y - MENU_H - MENU_GAP)
  let flip: 'up' | 'down' = 'up'
  let bodyYFinal = bodyY
  if (bodyY < wa.y) {
    bodyYFinal = Math.round(trayBounds.y + trayBounds.height + MENU_GAP)
    flip = 'down'
  }
  // Clamp into the display work area (including the shadow padding)
  const winW = MENU_W + MENU_PAD * 2
  const winH = MENU_H + MENU_PAD * 2
  const x = Math.round(Math.min(Math.max(bodyX - MENU_PAD, wa.x), wa.x + wa.width - winW))
  const y = Math.round(Math.min(Math.max(bodyYFinal - MENU_PAD, wa.y), wa.y + wa.height - winH))
  menuWindow.setPosition(x, y)
  menuFlip = flip
  return flip
}

/** Send the latest data to the menu window (shared by popup-prep and toggle changes)
 *  force=true: the window is not shown yet (data is sent before showing to avoid a blank frame),
 *  skip the visibility check */
function sendMenuData(force = false): void {
  if (!menuWindow || menuWindow.isDestroyed()) return
  if (!force && !menuWindow.isVisible()) return
  // Always go through safeSend (a bare webContents.send does not throw while the frame is invalid
  // and cannot be intercepted, and violates the main-process push convention)
  safeSend(menuWindow.webContents, 'tray-menu-data', {
    items: buildMenuItems(),
    subtitle: mainMessages().tray.subtitle,
    theme: getMenuTheme(),
    flip: menuFlip,
    version: app.getVersion()
  })
}

/** Pop up the custom menu next to the tray icon */
export async function showTrayMenu(): Promise<void> {
  if (!tray || !isTrayAvailable()) return
  // Already visible / currently opening: ignore, so repeated right clicks do not flicker
  if (menuOpening) return
  if (menuWindow && !menuWindow.isDestroyed() && menuWindow.isVisible()) return
  menuOpening = true
  try {
    const win = await getMenuWindow()
    if (win.isDestroyed()) return
    positionMenuWindow()
    // Send data before show: the window appears with full content, never a blank frame
    sendMenuData(true)
    win.show()
    win.focus()
    // Reopening right after closing (the blur→right-click race when clicking the tray icon) skips
    // the animation to avoid flicker; only a popup at a normal interval plays the entry animation
    if (Date.now() - lastMenuHideAt > MENU_ANIMATE_GAP) {
      safeSend(win.webContents, 'tray-menu-open')
    }
  } catch (error) {
    logger.error('[Tray] Failed to open tray menu:', error)
  } finally {
    menuOpening = false
  }
}

/** Hide the custom menu (the window is kept for reuse) */
export function hideTrayMenu(): void {
  if (menuWindow && !menuWindow.isDestroyed() && menuWindow.isVisible()) {
    menuWindow.hide()
    lastMenuHideAt = Date.now()
  }
}

/** Handle a menu item click (the menu window sends the id back over IPC) */
function handleMenuClick(id: string): void {
  switch (id) {
    case 'toggle-window':
      // Action item: close the menu after executing
      hideTrayMenu()
      toggleMainWindow()
      break
    case 'toggle-tray':
      // Checkbox item: keep the menu open after toggling and refresh the check state
      setCloseToTray(!isCloseToTrayEnabled())
      sendMenuData()
      break
    case 'quit':
      hideTrayMenu()
      app.quit()
      break
    default:
      hideTrayMenu()
      logger.warn(`[Tray] Unknown menu item: ${id}`)
  }
}

/* ---------------- Tray ---------------- */

/** Create the system tray (called after app ready; nulls out and logs on failure) */
export function createTray(): void {
  if (tray) return
  try {
    const image = nativeImage.createEmpty()
    // Multiple resolutions: the Windows taskbar picks 1x(16) / 2x(32) automatically based on DPI
    image.addRepresentation({
      scaleFactor: 1,
      width: 16,
      height: 16,
      buffer: nativeImage.createFromPath(tray16Icon).toPNG()
    })
    image.addRepresentation({
      scaleFactor: 2,
      width: 32,
      height: 32,
      buffer: nativeImage.createFromPath(tray32Icon).toPNG()
    })
    tray = new Tray(image)
    tray.setToolTip(mainMessages().tray.tooltip)
    tray.on('click', () => {
      hideTrayMenu()
      showMainWindow()
    })
    tray.on('double-click', () => showMainWindow())
    tray.on('right-click', () => void showTrayMenu())

    ipcMain.on('tray-menu-click', (_event, id: string) => handleMenuClick(id))
    logger.info('[Tray] System tray created')
  } catch (error) {
    logger.error('[Tray] Failed to create system tray:', error)
    tray = null
  }
}

/** Whether the tray is available (if creation failed, closing the window must quit instead of hiding) */
export function isTrayAvailable(): boolean {
  return tray !== null
}

/** Sync tray state (called by others on setting changes / window show-hide; menu data is rebuilt per popup) */
export function syncTrayState(): void {
  if (!tray) return
  tray.setToolTip(mainMessages().tray.tooltip)
}
