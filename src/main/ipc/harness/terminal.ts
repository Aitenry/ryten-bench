/**
 * 持久终端的**用户侧** IPC（右侧「终端」面板）。
 *
 * 与模型侧 `terminal_*` 工具共用同一个 `terminalSessions` 进程管理器：
 * - 模型建的会话会出现在面板里，面板里敲的命令也会进入模型之后 `terminal_read` 的视野
 *   （面板读取用非消费的 `peek`，不会抢走模型该读的未读输出）；
 * - 安全边界：**模型侧** `terminal_open` / `terminal_send` 只在 `danger-full-access` 档可用；
 *   **用户侧面板不设档位限制**——用户亲手敲命令等同直接使用操作系统终端，不该被模型档位
 *   挡住（2026-11-27 用户口径「不要限制我」）。`list` / `peek` / `close` 永远可用。
 *
 * 通道一律 `harness:terminal-*`，随 AI 助手插件启停。
 */
import { homedir } from 'node:os'
import logger from 'electron-log'
import type { IpcHandlerMap } from '../register'
import { MAX_SESSIONS_PER_TOPIC, terminalSessions } from '../../runtime/harness/terminal-sessions'
import { getTopicById, getWorkspaceById } from '../../database/mapper/harness/harness'
import { chatTopicDir, ensureChatTopicDir } from '../../services/harness/chat/workspace'

/** 解析话题对应的终端根目录 / 默认 cwd（与工具运行时注入的 workspacePath 同源） */
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

  /** 当前话题的终端会话列表（含存活状态 / 未读字符数；topicId 0 = 无会话时的全局兜底） */
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
   * 新建会话。**用户侧不设档位限制**（见文件头注释）；cwd 取当前话题对应的工作区，
   * 话题缺失/工作区未配置时落到用户主目录，保证面板永远能用。
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
   * 发送一条命令。`waitMs` 由面板传小值（命令可能长时间运行）：先等一小段拿即时输出，
   * 超时也正常返回 partial 输出；面板随后用 `terminal-peek` 轮询持续输出。
   * 用户侧同样不设档位限制。
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

  /** 只读输出快照（非消费）：面板轮询用 */
  handle('terminal-peek', (payload: { sessionId?: unknown; maxChars?: unknown }) => {
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
    if (!sessionId) return { ok: false, error: 'invalid-session' }
    const rawMax = Number(payload?.maxChars)
    const maxChars = Number.isFinite(rawMax) ? Math.max(1_000, Math.min(80_000, rawMax)) : 20_000
    return terminalSessions.peek(sessionId, maxChars)
  })

  /** 关闭一个会话（整树终止；幂等） */
  handle('terminal-close', (payload: { sessionId?: unknown }) => {
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
    if (!sessionId) return { ok: false, error: 'invalid-session' }
    return terminalSessions.close(sessionId)
  })

  /** 关闭当前话题的全部会话（面板「全部关闭」/切话题清理） */
  handle('terminal-close-topic', (payload: { topicId?: unknown }) => {
    const topicId = Number(payload?.topicId)
    if (!Number.isFinite(topicId) || topicId <= 0) return { ok: false, error: 'invalid-topic' }
    terminalSessions.closeTopic(Math.floor(topicId))
    return { ok: true }
  })

  return handlers
}
