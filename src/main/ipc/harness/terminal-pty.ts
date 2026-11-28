/**
 * **User-side real terminal** (node-pty) IPC: used by the right-side terminal panel.
 *
 * Completely independent of the model-side `terminal_*` line-mode channels; here there are only
 * human actions: create, type, resize the window, close, read the replay buffer. Output is
 * pushed to the renderer's xterm via the `harness:pty-terminal-data` event.
 */
import { BrowserWindow } from 'electron'
import type { IpcHandlerMap } from '../register'
import type { PtyShellKind } from '../../runtime/harness/pty-terminal'
import { ptyTerminals } from '../../runtime/harness/pty-terminal'
import { safeSend } from '../../safe-send'

export const PTY_EVENTS = {
  data: 'harness:pty-terminal-data',
  exit: 'harness:pty-terminal-exit',
  changed: 'harness:pty-sessions-changed'
} as const

/** Wire PTY output/exit streams to all windows (output is batched per ~12ms to avoid per-character IPC jitter) */
export function wirePtyTerminalEvents(): () => void {
  const pending = new Map<string, { data: string; timer: NodeJS.Timeout }>()
  const flush = (sessionId: string): void => {
    const entry = pending.get(sessionId)
    if (!entry) return
    pending.delete(sessionId)
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        safeSend(win.webContents, PTY_EVENTS.data, { sessionId, data: entry.data })
      }
    }
  }
  ptyTerminals.onData = (sessionId, data) => {
    const existing = pending.get(sessionId)
    if (existing) {
      existing.data += data
      return
    }
    pending.set(sessionId, {
      data,
      timer: setTimeout(() => flush(sessionId), 12)
    })
  }
  ptyTerminals.onExit = (sessionId, exitCode) => {
    const entry = pending.get(sessionId)
    if (entry) {
      clearTimeout(entry.timer)
      pending.delete(sessionId)
    }
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        safeSend(win.webContents, PTY_EVENTS.exit, { sessionId, exitCode })
      }
    }
  }
  ptyTerminals.onSessionsChanged = () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) safeSend(win.webContents, PTY_EVENTS.changed, {})
    }
  }
  return () => {
    for (const entry of pending.values()) clearTimeout(entry.timer)
    pending.clear()
    ptyTerminals.onData = undefined
    ptyTerminals.onExit = undefined
    ptyTerminals.onSessionsChanged = undefined
  }
}

export function ptyTerminalIpcHandlers(): IpcHandlerMap {
  const handlers: IpcHandlerMap = {}
  const handle = (channel: string, handler: (...args: never[]) => unknown): void => {
    handlers[`harness:${channel}`] = handler
  }

  handle('pty-terminal-list', (payload: { topicId?: unknown }) => {
    const raw = Number(payload?.topicId)
    const topicId = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0
    return { ok: true, sessions: ptyTerminals.list(topicId) }
  })

  handle(
    'pty-terminal-open',
    (payload: {
      topicId?: unknown
      cwd?: unknown
      shell?: unknown
      cols?: unknown
      rows?: unknown
    }) => {
      const raw = Number(payload?.topicId)
      const topicId = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0
      const shell =
        payload?.shell === 'pwsh' || payload?.shell === 'cmd' || payload?.shell === 'sh'
          ? (payload.shell as PtyShellKind)
          : undefined
      return ptyTerminals.open({
        topicId,
        cwd: typeof payload?.cwd === 'string' ? payload.cwd : undefined,
        shell,
        cols: Number(payload?.cols),
        rows: Number(payload?.rows)
      })
    }
  )

  handle('pty-terminal-write', (payload: { sessionId?: unknown; data?: unknown }) => {
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
    const data = typeof payload?.data === 'string' ? payload.data : ''
    if (!sessionId) return { ok: false }
    return { ok: ptyTerminals.write(sessionId, data) }
  })

  handle(
    'pty-terminal-resize',
    (payload: { sessionId?: unknown; cols?: unknown; rows?: unknown }) => {
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
      if (!sessionId) return { ok: false }
      return { ok: ptyTerminals.resize(sessionId, payload?.cols, payload?.rows) }
    }
  )

  handle('pty-terminal-close', (payload: { sessionId?: unknown }) => {
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
    if (!sessionId) return { ok: false, found: false }
    return ptyTerminals.close(sessionId)
  })

  handle('pty-terminal-buffer', (payload: { sessionId?: unknown }) => {
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
    return { ok: true, data: sessionId ? ptyTerminals.buffer(sessionId) : '' }
  })

  /** Global stats: the start page / sidebar badge shows "N running" */
  handle('pty-terminal-stats', () => {
    return { ok: true, ...ptyTerminals.stats() }
  })

  handle('pty-terminal-close-topic', (payload: { topicId?: unknown }) => {
    const raw = Number(payload?.topicId)
    const topicId = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0
    ptyTerminals.closeTopic(topicId)
    return { ok: true }
  })

  return handlers
}
