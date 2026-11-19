import { BrowserWindow } from 'electron'

// 窗口状态（只有主窗口；启动页已搬进主窗口渲染层，不再有独立加载窗口）
let mainWindow: BrowserWindow | null = null
let initComplete = false // 初始化任务是否已完成（启动页据此淡出）
let mainWindowReady = false // 主窗口渲染进程是否已就绪（ready-to-show）

export function setMainWindow(win: BrowserWindow | null): void {
  mainWindow = win
  // 新窗口（macOS activate 重建）需要等它自己的 ready-to-show，不能沿用旧状态
  if (win) mainWindowReady = false
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

/** 标记初始化完成（初始化流程结束时调用） */
export function markInitComplete(): void {
  initComplete = true
  tryShowMainWindow()
}

export function isInitComplete(): boolean {
  return initComplete
}

/** 标记主窗口渲染就绪（ready-to-show 时调用） */
export function markMainWindowReady(): void {
  mainWindowReady = true
  tryShowMainWindow()
}

/**
 * 尝试展示主窗口：只要渲染进程就绪就显示。
 *
 * 和旧版不同：不再等初始化完成——主窗口先显示，渲染层用启动页（StartupSplash）
 * 盖住界面，等初始化 + 首屏数据都就绪后再淡出进入主界面（用户 2026-11-20 口径）。
 */
export function tryShowMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindowReady) return
  if (!mainWindow.isVisible()) mainWindow.show()
}
