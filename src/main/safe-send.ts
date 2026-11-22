import type { WebContents } from 'electron'
import logger from 'electron-log'

/**
 * 主进程 → 渲染进程安全发送工具。
 *
 * 背景（Electron 43 实测结论，2026-08-29 修复）：
 * 渲染进程崩溃或窗口关闭时，「渲染帧」先于「WebContents 对象」销毁，存在一段
 * 帧已失效但 `webContents.isDestroyed()` 仍为 false 的窗口期。此时调用
 * `webContents.send()` 不会抛异常——Electron 内部（WebFrameMain.send 的
 * _renderFrameDisposed 守卫）只会静默打印：
 *   Error sending from webFrameMain: Render frame was disposed before
 *   WebFrameMain could be accessed
 * 并返回。因此 try/catch 与 isDestroyed() 都无法拦截，流式循环会持续向死帧
 * 发送，主进程日志刷屏，且 LLM 还在为空转的流烧 token。
 * 可靠检测手段：监听 webContents 的 render-process-gone（渲染进程崩溃/被杀）
 * 与 destroyed 事件，把失效的 WebContents 记入黑名单。
 */

// 已注册监听的 WebContents（WeakSet，随对象回收，无泄漏）
const watched = new WeakSet<WebContents>()
// 已被判死的 WebContents（渲染进程消失或对象销毁，之后不可再发送）
const dead = new WeakSet<WebContents>()

function watchLiveness(wc: WebContents): void {
  if (watched.has(wc)) return
  watched.add(wc)
  const markDead = (): void => {
    dead.add(wc)
  }
  wc.on('render-process-gone', markDead)
  wc.once('destroyed', markDead)
}

/** 判断 WebContents 是否仍可安全发送（对象存活且帧未被判死） */
export function isSenderAlive(wc: WebContents | null | undefined): boolean {
  if (!wc || wc.isDestroyed() || dead.has(wc)) return false
  // 兜底：部分 Electron 版本在帧失效时访问 mainFrame 会抛错
  try {
    return !!wc.mainFrame
  } catch {
    return false
  }
}

/**
 * 安全发送：目标不可用时静默返回 false。
 * 不抛错、不触发 Electron 内部刷屏日志，供主进程所有广播/推送使用。
 */
export function safeSend(
  wc: WebContents | null | undefined,
  channel: string,
  payload?: unknown
): boolean {
  if (!wc) return false
  watchLiveness(wc)
  if (!isSenderAlive(wc)) return false
  try {
    wc.send(channel, payload)
    return true
  } catch (err) {
    logger.warn(`[safe-send] Failed to send "${channel}" (renderer frame is gone):`, err)
    return false
  }
}
