/**
 * Windows window border color follows the app theme.
 *
 * Background: the custom title bar only covers the title area; the 1–2px line around the outer
 * edge of the window is the **system window border drawn by DWM**, whose color comes from the
 * Windows theme (#3a3a3a in system dark mode) and does not follow the in-app light/dark switch —
 * so after the app switches to light, a dark gray edge remains along the top (and around) the
 * window.
 *
 * Electron does not expose DWMWA_BORDER_COLOR (the window border color); the project already
 * bundles koffi (also used by the sandbox runner and asarUnpacked by electron-builder), so it calls
 * dwmapi.dll directly to set the border color to match the title bar/background: in light mode the
 * dark edge disappears.
 */
import { BrowserWindow } from 'electron'
import logger from 'electron-log'

/** DwmWindowAttribute enum value for DwmSetWindowAttribute (Win11 22000+) */
const DWMWA_BORDER_COLOR = 34

type DwmSetWindowAttribute = (
  hwnd: number,
  attribute: number,
  value: Buffer,
  size: number
) => number

let setWindowAttribute: DwmSetWindowAttribute | null = null
let koffiLoadFailed = false
let notifiedReady = false

/** Lazily load koffi + dwmapi: only needed on Windows; a failure does not affect the app (border keeps the system default) */
function loadDwmSetter(): DwmSetWindowAttribute | null {
  if (setWindowAttribute) return setWindowAttribute
  if (koffiLoadFailed) return null
  try {
    // Deferred require: keeps the main process from crashing at startup where koffi is unavailable
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi') as typeof import('koffi')
    const dwmapi = koffi.load('dwmapi.dll')
    setWindowAttribute = dwmapi.func(
      'int DwmSetWindowAttribute(intptr_t hwnd, int attr, const void *value, int size)'
    ) as unknown as DwmSetWindowAttribute
    if (!notifiedReady) {
      notifiedReady = true
      logger.info('[Window] DWM window border color API ready (koffi -> dwmapi.dll)')
    }
    return setWindowAttribute
  } catch (err) {
    koffiLoadFailed = true
    logger.warn('[Window] Failed to load dwmapi.dll, keeping system default window border color:', err)
    return null
  }
}

/** #RRGGBB → COLORREF (0x00BBGGRR) */
function toColorRef(cssColor: string): number | null {
  const hex = cssColor.trim().replace(/^#/, '')
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null
  const red = parseInt(hex.slice(0, 2), 16)
  const green = parseInt(hex.slice(2, 4), 16)
  const blue = parseInt(hex.slice(4, 6), 16)
  return ((blue << 16) | (green << 8) | red) >>> 0
}

/**
 * Sync the window's system border color to the given color (usually the title bar background, so
 * the window edge matches in both light and dark themes).
 * Silently skipped on non-Windows, when koffi is unavailable, or when the call fails.
 */
export function syncWindowBorderColor(win: BrowserWindow, cssColor: string): void {
  if (process.platform !== 'win32' || win.isDestroyed()) return
  const colorRef = toColorRef(cssColor)
  if (colorRef === null) return
  const setter = loadDwmSetter()
  if (!setter) return
  try {
    const handle = win.getNativeWindowHandle()
    const hwnd = handle.length === 8 ? Number(handle.readBigUInt64LE(0)) : handle.readUInt32LE(0)
    const value = Buffer.alloc(4)
    value.writeUInt32LE(colorRef, 0)
    const hr = setter(hwnd, DWMWA_BORDER_COLOR, value, 4)
    if (hr !== 0) logger.debug('[Window] DwmSetWindowAttribute(DWMWA_BORDER_COLOR) returned', hr)
  } catch (err) {
    logger.debug('[Window] Failed to set DWM window border color:', err)
  }
}
