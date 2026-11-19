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

// 系统托盘：品牌视觉图标（吉祥物圆角徽章，1x/2x 双表示；菜单头部同一张图内嵌在 tray-menu.html）。
// 左键单击显示主窗口；右键弹出「自绘菜单窗口」（src/main/resource/tray-menu.html，
// 编辑部风格、随应用主题明暗——原生 Menu 无法定制样式，故用独立无边框窗口实现）。
// 托盘与菜单窗口引用必须保存在模块级变量中，否则会被 GC 回收导致图标消失。

let tray: Tray | null = null
let menuWindow: BrowserWindow | null = null
let menuReadyPromise: Promise<BrowserWindow> | null = null
let menuOpening = false // 弹出过程中（等待菜单页加载）防重入
let lastMenuHideAt = 0 // 上次隐藏时间，用于抑制 blur→right-click 竞态下的重放动画
let menuFlip: 'up' | 'down' = 'up' // 最近一次弹出方向（开关刷新数据时保持动画方向）

// 菜单体尺寸；窗口 = 菜单体 + 2×MENU_PAD（四周留出 CSS 阴影区，避免阴影被窗口裁剪）
const MENU_W = 280
const MENU_H = 202
const MENU_PAD = 16
const MENU_GAP = 10 // 菜单与托盘图标的间距
const MENU_ANIMATE_GAP = 300 // 隐藏后该毫秒内再次弹出时不播放入场动画（ms）

type MenuItem =
  | { type: 'separator' }
  | { type: 'action'; id: string; label: string; danger?: boolean; icon?: 'chevron' | 'power' }
  | { type: 'checkbox'; id: string; label: string; checked: boolean }

/** 关闭窗口时是否最小化到系统托盘（默认开启） */
export function isCloseToTrayEnabled(): boolean {
  const settings = settingsStore.get('tray') as TraySettings | undefined
  return settings?.closeToTray ?? true
}

/** 更新托盘设置（持久化 + 即时同步托盘状态） */
export function setCloseToTray(enabled: boolean): void {
  settingsStore.set('tray', { closeToTray: enabled })
  syncTrayState()
}

/** 显示并聚焦主窗口（从托盘恢复） */
export function showMainWindow(): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
}

/** 隐藏主窗口到托盘 */
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

/* ---------------- 自绘菜单窗口 ---------------- */

/** 构建菜单数据（每次弹出前重建，保证文案与勾选态实时；文案随界面语言） */
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

/** 菜单主题跟随应用主题设置（auto 时跟随系统） */
function getMenuTheme(): 'light' | 'dark' {
  const theme = settingsStore.get('theme') as ThemeMode | undefined
  if (theme === 'light' || theme === 'dark') return theme
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

/** 懒创建菜单窗口（常驻隐藏，首次右键时加载） */
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
    // 透明窗口上禁用原生阴影（Windows 会渲染出白/灰边），视觉阴影由 CSS box-shadow 提供
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
      logger.info('[Tray] 托盘菜单窗口就绪')
      resolve(win)
    })
    win.webContents.once('did-fail-load', (_event, code, desc) => {
      logger.error(`[Tray] 托盘菜单加载失败 (${code}): ${desc}`)
      // 复位并销毁窗口，允许下次右键重建重试（修复：此前只 reject，窗口仍存活，
      // getMenuWindow 短路返回同一个已 reject 的 promise，托盘菜单本会话永久失效）
      const failed = menuWindow
      menuWindow = null
      menuReadyPromise = null
      if (failed && !failed.isDestroyed()) failed.destroy()
      reject(new Error(`菜单加载失败: ${desc}`))
    })
    win.loadFile(trayMenuHtml).catch((err) => {
      logger.error('[Tray] 托盘菜单 loadFile 失败:', (err as Error)?.message)
      const failed = menuWindow
      menuWindow = null
      menuReadyPromise = null
      if (failed && !failed.isDestroyed()) failed.destroy()
      reject(err as Error)
    })
  })
  return menuReadyPromise
}

/** 将菜单窗口定位到托盘图标旁（默认向上弹出，空间不足时向下），返回弹出方向 */
function positionMenuWindow(): 'up' | 'down' {
  if (!tray || !menuWindow || menuWindow.isDestroyed()) return 'up'
  const trayBounds = tray.getBounds()
  const display = screen.getDisplayMatching(trayBounds)
  const wa = display.workArea
  // 菜单体（不含阴影区）定位：以托盘图标水平中心为基准
  const bodyX = Math.round(trayBounds.x + trayBounds.width / 2 - MENU_W / 2)
  const bodyY = Math.round(trayBounds.y - MENU_H - MENU_GAP)
  let flip: 'up' | 'down' = 'up'
  let bodyYFinal = bodyY
  if (bodyY < wa.y) {
    bodyYFinal = Math.round(trayBounds.y + trayBounds.height + MENU_GAP)
    flip = 'down'
  }
  // 夹紧到显示器工作区内（含阴影留白）
  const winW = MENU_W + MENU_PAD * 2
  const winH = MENU_H + MENU_PAD * 2
  const x = Math.round(Math.min(Math.max(bodyX - MENU_PAD, wa.x), wa.x + wa.width - winW))
  const y = Math.round(Math.min(Math.max(bodyYFinal - MENU_PAD, wa.y), wa.y + wa.height - winH))
  menuWindow.setPosition(x, y)
  menuFlip = flip
  return flip
}

/** 向菜单窗口发送最新数据（弹出前 / 开关状态变化时共用）
 *  force=true：窗口尚未 show（弹出流程中先发数据再显示，避免空白帧），跳过可见性检查 */
function sendMenuData(force = false): void {
  if (!menuWindow || menuWindow.isDestroyed()) return
  if (!force && !menuWindow.isVisible()) return
  // 统一走 safeSend（修复：裸 webContents.send 在帧失效窗口期不抛异常、无法拦截，
  // 且违反项目「主进程推送统一走 safeSend」约定）
  safeSend(menuWindow.webContents, 'tray-menu-data', {
    items: buildMenuItems(),
    subtitle: mainMessages().tray.subtitle,
    theme: getMenuTheme(),
    flip: menuFlip,
    version: app.getVersion()
  })
}

/** 在托盘图标旁弹出自绘菜单 */
export async function showTrayMenu(): Promise<void> {
  if (!tray || !isTrayAvailable()) return
  // 已可见 / 正在弹出中：直接忽略，避免重复右键反复 hide→show 造成闪屏
  if (menuOpening) return
  if (menuWindow && !menuWindow.isDestroyed() && menuWindow.isVisible()) return
  menuOpening = true
  try {
    const win = await getMenuWindow()
    if (win.isDestroyed()) return
    positionMenuWindow()
    // 先发数据再 show：窗口首次显示即带完整内容，不出现空白帧
    sendMenuData(true)
    win.show()
    win.focus()
    // 刚关闭又立刻弹出（点击托盘图标时的 blur→right-click 竞态）不重放动画，避免闪屏；
    // 正常间隔弹出才播放入场动画
    if (Date.now() - lastMenuHideAt > MENU_ANIMATE_GAP) {
      safeSend(win.webContents, 'tray-menu-open')
    }
  } catch (error) {
    logger.error('[Tray] 弹出托盘菜单失败:', error)
  } finally {
    menuOpening = false
  }
}

/** 隐藏自绘菜单（窗口保留复用） */
export function hideTrayMenu(): void {
  if (menuWindow && !menuWindow.isDestroyed() && menuWindow.isVisible()) {
    menuWindow.hide()
    lastMenuHideAt = Date.now()
  }
}

/** 处理菜单项点击（菜单窗口经 IPC 回传 id） */
function handleMenuClick(id: string): void {
  switch (id) {
    case 'toggle-window':
      // 操作项：执行后关闭菜单
      hideTrayMenu()
      toggleMainWindow()
      break
    case 'toggle-tray':
      // 开关项：切换后保持菜单打开，并实时刷新勾选状态
      setCloseToTray(!isCloseToTrayEnabled())
      sendMenuData()
      break
    case 'quit':
      hideTrayMenu()
      app.quit()
      break
    default:
      hideTrayMenu()
      logger.warn(`[Tray] 未知菜单项: ${id}`)
  }
}

/* ---------------- 托盘 ---------------- */

/** 创建系统托盘（app ready 后调用，失败时置空并记录日志） */
export function createTray(): void {
  if (tray) return
  try {
    const image = nativeImage.createEmpty()
    // 多分辨率表示：Windows 任务栏按 DPI 自动选用 1x(16) / 2x(32)
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
    logger.info('[Tray] 系统托盘已创建')
  } catch (error) {
    logger.error('[Tray] 创建系统托盘失败:', error)
    tray = null
  }
}

/** 托盘是否可用（创建失败时关闭窗口应直接退出而非隐藏，避免窗口无处找回） */
export function isTrayAvailable(): boolean {
  return tray !== null
}

/** 同步托盘状态（设置变化 / 窗口显隐时由外部调用；菜单数据在每次弹出时重建，天然保持最新） */
export function syncTrayState(): void {
  if (!tray) return
  tray.setToolTip(mainMessages().tray.tooltip)
}
