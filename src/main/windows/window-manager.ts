import { BrowserWindow } from 'electron'

// 窗口状态与交接（加载窗口 → 主窗口）
let loadingWindow: BrowserWindow | null = null
let mainWindow: BrowserWindow | null = null // 预创建的主窗口（隐藏预热，初始化完成后展示）
let initComplete = false // 初始化任务是否已完成（加载窗口→主窗口交接标志）
let mainWindowReady = false // 主窗口渲染进程是否已就绪（ready-to-show）

export function setLoadingWindow(win: BrowserWindow | null): void {
  loadingWindow = win
}

export function getLoadingWindow(): BrowserWindow | null {
  return loadingWindow
}

export function setMainWindow(win: BrowserWindow | null): void {
  mainWindow = win
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

/** 标记初始化完成（初始化流程结束 / 加载页兜底回发时调用） */
export function markInitComplete(): void {
  initComplete = true
  tryShowMainWindow()
}

/**
 * 初始化是否已完成。
 *
 * 加载窗口用它决定「还要不要露脸」：热启动时初始化可能在加载页画出来之前就结束了，
 * 这时如果照样显示，用户看到的就是一块还没绘制的窗口闪一下（2026-09-27 用户报的
 * 「每次启动都闪一个窗口」）。
 */
export function isInitComplete(): boolean {
  return initComplete
}

/** 标记主窗口渲染就绪（ready-to-show 时调用） */
export function markMainWindowReady(): void {
  mainWindowReady = true
  tryShowMainWindow()
}

/**
 * 尝试展示主窗口：仅当「初始化完成」且「主窗口渲染就绪」两个条件同时满足时才展示。
 * 两个窗口直接交接（先关加载窗口再显示主窗口），避免桌面空隙。
 */
export function tryShowMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed() || !initComplete || !mainWindowReady) return
  if (loadingWindow && !loadingWindow.isDestroyed()) {
    loadingWindow.close()
    loadingWindow = null
  }
  mainWindow.show()
}
