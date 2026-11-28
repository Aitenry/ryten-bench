/**
 * **User-side** IPC for persistent terminals (the right-side "Terminal" panel).
 *
 * Shares the same `terminalSessions` process manager as the model-side `terminal_*` tools:
 * - sessions created by the model show up in the panel, and commands typed in the panel also
 *   enter the model's later `terminal_read` view
 *   (the panel reads with the non-consuming `peek`, so it doesn't steal unread output the model
 *   should read);
 * - safety boundary: **model-side** `terminal_open` / `terminal_send` are available only in the
 *   `danger-full-access` tier; **the user-side panel has no tier restriction** — a user typing
 *   commands by hand is equivalent to using the OS terminal directly and should not be blocked
 *   by the model tier (2026-11-27 user wording: "don't restrict me"). `list` / `peek` / `close`
 *   are always available.
 *
 * Channels are always `harness:terminal-*`, following the AI assistant plugin's lifecycle.
 */
import { homedir } from 'node:os'
import logger from 'electron-log'
import type { IpcHandlerMap } from '../register'
import { MAX_SESSIONS_PER_TOPIC, terminalSessions } from '../../runtime/harness/terminal-sessions'
import { getTopicById, getWorkspaceById } from '../../database/mapper/harness/harness'
import { chatTopicDir, ensureChatTopicDir } from '../../services/harness/chat/workspace'

/** Resolve the terminal root directory / default cwd for a topic (same source as the workspacePath injected by the tool runtime) */
async function resolveScope(
  topicId: number
): Promise<{ ok: true; workspaceRoot: string; cwd: string }> {
  const home = homedir()
  const fallback = { ok: true as const, workspaceRoot: home, cwd: home }
  if (!Number.isFinite(topicId) || topicId <= 0) return fallback
  const topics = await getTopicById(Math.floor(topicId)).catch(() => [])
  const topic = topics[0]
  if (!topic) return fallback
  const workspace = await getWorkspaceById(topic.workspace_id).catch(() => null)
  if (!workspace?.path) return fallback
  if (workspace.kind === 'chat') {
    const cwd = await ensureChatTopicDir(topic.id).catch(() => chatTopicDir(topic.id))
    return { ok: true, workspaceRoot: workspace.path, cwd }
  }
  return { ok: true, workspaceRoot: workspace.path, cwd: workspace.path }
}

export function terminalIpcHandlers(): IpcHandlerMap {
  const handlers: IpcHandlerMap = {}
  const handle = (channel: string, handler: (...args: never[]) => unknown): void => {
    handlers[`harness:${channel}`] = handler
  }

  /** Terminal sessions for the current topic (including liveness / unread char count; topicId 0 = global fallback when there are no sessions) */
  handle('terminal-list', async (payload: { topicId?: unknown }) => {
    const raw = Number(payload?.topicId)
    const topicId = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0
    return {
      ok: true,
      sessions: terminalSessions.list(topicId),
      maxSessions: MAX_SESSIONS_PER_TOPIC
    }
  })

  /**
   * Create a session. **No tier restriction on the user side** (see the file header comment);
   * cwd uses the workspace of the current topic, falling back to the user's home directory when
   * the topic is missing or no workspace is configured, so the panel always works.
   */
  handle(
    'terminal-open',
    async (payload: { topicId?: unknown; cwd?: unknown; shell?: unknown }) => {
      const raw = Number(payload?.topicId)
      const topicId = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0
      const scope = await resolveScope(topicId)
      const shell =
        payload?.shell === 'pwsh' || payload?.shell === 'cmd' || payload?.shell === 'sh'
          ? payload.shell
          : undefined
      const cwd = typeof payload?.cwd === 'string' && payload.cwd.trim() ? payload.cwd : undefined
      try {
        const result = await terminalSessions.open({
          topicId,
          workspaceRoot: scope.workspaceRoot,
          cwd,
          shell
        })
        return result
      } catch (error) {
        logger.warn('Error in terminal-open:', error)
        return { ok: false, error: 'spawn-failed' }
      }
    }
  )

  /**
   * Send a command. `waitMs` is passed small by the panel (commands may run for a long time):
   * wait a short while for immediate output, and on timeout still return partial output
   * normally; the panel then polls for ongoing output with `terminal-peek`.
   * The user side likewise has no tier restriction.
   */
  handle(
    'terminal-send',
    async (payload: {
      topicId?: unknown
      sessionId?: unknown
      command?: unknown
      waitMs?: unknown
    }) => {
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
      if (!sessionId) {
        return { ok: false, error: 'invalid-session' }
      }
      const command = typeof payload?.command === 'string' ? payload.command : ''
      const rawWait = Number(payload?.waitMs)
      const waitMs = Number.isFinite(rawWait) ? Math.max(0, Math.min(5_000, rawWait)) : 300
      try {
        return await terminalSessions.send(sessionId, command, waitMs)
      } catch (error) {
        logger.warn('Error in terminal-send:', error)
        return { ok: false, error: 'spawn-failed' }
      }
    }
  )

  /** Read-only output snapshot (non-consuming): used for panel polling */
  /** Read-only output snapshot (non-consuming): used for panel polling; `raw: true` keeps ANSI for xterm rendering */
  handle(
    'terminal-peek',
    (payload: { sessionId?: unknown; maxChars?: unknown; raw?: unknown }) => {
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
      if (!sessionId) return { ok: false, error: 'invalid-session' }
      const rawMax = Number(payload?.maxChars)
      const maxChars = Number.isFinite(rawMax) ? Math.max(1_000, Math.min(80_000, rawMax)) : 20_000
      return terminalSessions.peek(sessionId, maxChars, { raw: payload?.raw === true })
    }
  )

  /** Close a session (terminates the whole tree; idempotent) */
  handle('terminal-close', (payload: { sessionId?: unknown }) => {
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
    if (!sessionId) return { ok: false, error: 'invalid-session' }
    return terminalSessions.close(sessionId)
  })

  /** Close all sessions of the current topic (panel "Close all" / cleanup on topic switch) */
  handle('terminal-close-topic', (payload: { topicId?: unknown }) => {
    const topicId = Number(payload?.topicId)
    if (!Number.isFinite(topicId) || topicId <= 0) return { ok: false, error: 'invalid-topic' }
    terminalSessions.closeTopic(Math.floor(topicId))
    return { ok: true }
  })

  return handlers
}
