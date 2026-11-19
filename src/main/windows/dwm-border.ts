/**
 * Windows 窗口边框颜色跟随应用主题。
 *
 * 背景（用户 2026-11-20 反馈「顶部会出现这种情况」「还是不行」）：
 * 自绘标题栏只覆盖标题区域，窗口最外圈那条 1~2px 的线是 **DWM 画的系统窗口边框**，
 * 颜色由 Windows 主题决定（系统深色时是 #3a3a3a），不跟应用内的亮/暗切换——
 * 于是应用切亮色后，窗口顶部（以及四周）仍压着一条深灰边。
 *
 * Electron 没有暴露 DWMWA_BORDER_COLOR（窗口边框色）；项目里已带 koffi（沙箱 runner
 * 也在用、electron-builder 已 asarUnpack），这里直接调 dwmapi.dll 把边框色设成和
 * 标题栏/背景相同的颜色：亮色下那条深色边就消失了。
 */
import { BrowserWindow } from 'electron'
import logger from 'electron-log'

/** DwmSetWindowAttribute 的 DwmWindowAttribute 枚举值（Win11 22000+） */
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

/** 懒加载 koffi + dwmapi：只有 Windows 才需要，失败也不影响应用（边框保持系统默认） */
function loadDwmSetter(): DwmSetWindowAttribute | null {
  if (setWindowAttribute) return setWindowAttribute
  if (koffiLoadFailed) return null
  try {
    // 延迟 require：避免某些环境拿不到 koffi 时让主进程启动就崩
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi') as typeof import('koffi')
    const dwmapi = koffi.load('dwmapi.dll')
    setWindowAttribute = dwmapi.func(
      'int DwmSetWindowAttribute(intptr_t hwnd, int attr, const void *value, int size)'
    ) as unknown as DwmSetWindowAttribute
    if (!notifiedReady) {
      notifiedReady = true
      logger.info('[Window] DWM 窗口边框颜色接口已就绪（koffi → dwmapi.dll）')
    }
    return setWindowAttribute
  } catch (err) {
    koffiLoadFailed = true
    logger.warn('[Window] 加载 dwmapi.dll 失败，窗口边框颜色保持系统默认:', err)
    return null
  }
}

/** #RRGGBB → COLORREF（0x00BBGGRR） */
function toColorRef(cssColor: string): number | null {
  const hex = cssColor.trim().replace(/^#/, '')
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null
  const red = parseInt(hex.slice(0, 2), 16)
  const green = parseInt(hex.slice(2, 4), 16)
  const blue = parseInt(hex.slice(4, 6), 16)
  return ((blue << 16) | (green << 8) | red) >>> 0
}

/**
 * 把窗口的系统边框颜色同步成给定颜色（通常传标题栏底色，亮/暗主题下都与窗口边缘同色）。
 * 非 Windows、koffi 不可用或调用失败时静默跳过。
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
    if (hr !== 0) logger.debug('[Window] DwmSetWindowAttribute(DWMWA_BORDER_COLOR) 返回', hr)
  } catch (err) {
    logger.debug('[Window] 设置 DWM 窗口边框颜色失败:', err)
  }
}
