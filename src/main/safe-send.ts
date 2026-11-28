import type { WebContents } from 'electron'
import logger from 'electron-log'

/**
 * Safe main-process → renderer send helper.
 *
 * Background (measured on Electron 43; fixed 2026-08-29):
 * When the renderer process crashes or the window closes, the render frame is destroyed before
 * the WebContents object, leaving a window where the frame is gone but
 * `webContents.isDestroyed()` is still false. Calling `webContents.send()` then does not throw —
 * Electron's internals (the _renderFrameDisposed guard in WebFrameMain.send) only silently print:
 *   Error sending from webFrameMain: Render frame was disposed before
 *   WebFrameMain could be accessed
 * and return. Neither try/catch nor isDestroyed() can catch that, so a streaming loop keeps
 * sending to a dead frame, floods the main-process log, and the LLM keeps burning tokens on an
 * idle stream. The reliable check: listen for render-process-gone (renderer crashed/killed) and
 * destroyed on the webContents and blacklist the dead ones.
 */

// WebContents already being watched (WeakSet, collected with the object, no leak)
const watched = new WeakSet<WebContents>()
// WebContents marked dead (renderer process gone or object destroyed; never send again)
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

/** Whether the WebContents can still be sent to safely (object alive and frame not marked dead) */
export function isSenderAlive(wc: WebContents | null | undefined): boolean {
  if (!wc || wc.isDestroyed() || dead.has(wc)) return false
  // Fallback: some Electron versions throw when mainFrame is accessed after the frame is gone
  try {
    return !!wc.mainFrame
  } catch {
    return false
  }
}

/**
 * Safe send: silently returns false when the target is unavailable.
 * Never throws and never triggers Electron's log flooding, so all main-process broadcasts and
 * pushes can use it.
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
