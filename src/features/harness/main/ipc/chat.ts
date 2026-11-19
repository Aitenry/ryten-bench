import logger from 'electron-log'
import type { MainIpcHandlers } from '../../../../main/plugins/context'
import {
  findChatWorkspace,
  listChatWorkspaceIds,
  removeChatTopicDir
} from '../chat/workspace'
import { activateChatRoot, activateChatTopic } from '../chat/activation'

/**
 * 「对话」模式的 IPC（harness 插件的第 7 个域）。
 *
 * 这个模式**没有工作区概念**：用户直接开一条会话就聊。但模型的文件工具需要一根可写根目录
 * （虚拟 `/` 挂的就是它），资源管理器也需要一个根——所以模式自带一个应用初始化的目录，
 * 见 main/chat/workspace.ts。
 *
 * 两条纪律：
 * - **一律不抛错**：动作统一返回 `{ ok, error?, data? }`，渲染层据此提示（与工坊同一套约定）；
 * - **切换只走「写设置 + 广播」这一条路**：AI 工作目录、资源管理器根、文件 IPC 边界、
 *   文件改动审查、记忆作用域全都认 `harness.workspacePath` + `activeWorkspaceId`，
 *   与插件会话切到插件目录是同一个机制（见 workshop/workspace.ts）。
 */
export function chatIpcHandlers(): MainIpcHandlers {
  const handlers: MainIpcHandlers = {}
  /** 收通道：本插件的命名空间前缀只在这里出现 */
  const handle = (channel: string, handler: (...args: never[]) => unknown): void => {
    handlers[`plugin:harness:${channel}`] = handler
  }

  /**
   * 进入「对话」模式（或在该模式里新建会话）：确保目录与工作区行存在，并把它设为活动工作区。
   *
   * 返回**会话目录**（`dir`）而不是工作区行：新建的空白会话用的是「对话」根目录，
   * 打开已有会话用的是它自己的子目录——两种情况下调用方要写的 `workspacePath` 都是 `dir`。
   */
  handle('chat-ensure-workspace', async () => {
    try {
      const activation = await activateChatRoot()
      return { ok: true, data: activation }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn('[Chat] 初始化对话工作目录失败:', message)
      return { ok: false, error: message }
    }
  })

  /**
   * 打开「对话」模式里的**某一条会话**：把活动工作区切到这条会话自己的目录
   * （`<userData>/chat/<话题 id>/`，不存在则创建）。
   *
   * 为什么要按会话分目录：同一个模式里换会话时，模型看到的文件、资源管理器的根、
   * 文件改动审查的边界都该是**这条会话的**——共用一个目录会让两条会话互相踩对方的文件。
   */
  handle('chat-activate-topic', async (topicId: number) => {
    try {
      const activation = await activateChatTopic(Number(topicId))
      return { ok: true, data: activation }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn('[Chat] 切换会话工作目录失败:', message)
      return { ok: false, error: message }
    }
  })

  /**
   * 目前所有「对话」工作区 id（侧栏：把「对话」的行从「工作」列表里滤掉，并认出自己的那一行）。
   *
   * 渲染层不自己拼路径判种类（`<userData>/chat` 只有主进程知道怎么解析），
   * 与 `workshop-state.pluginWorkspaces` 同一套做法。
   */
  handle('chat-workspaces', async () => {
    try {
      const ids = await listChatWorkspaceIds()
      const workspace = await findChatWorkspace()
      return { ok: true, data: { ids, rootWorkspaceId: workspace?.id ?? null } }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn('[Chat] 读取对话工作区失败:', message)
      return { ok: false, error: message }
    }
  })

  /**
   * 删掉某条会话的目录（删话题之后由渲染层调用；**失败不影响删话题**）。
   *
   * 主进程只按话题 id 推导路径，并且只允许删「对话根目录的直接数字子目录」
   * （两道闸在 chat/workspace.ts 里）。这里只额外确认「对话工作区确实存在」——
   * 没有它，这个带 `recursive: true` 的动作就失去上下文了。
   */
  handle('chat-remove-topic-dir', async (topicId: number) => {
    try {
      const workspace = await findChatWorkspace()
      if (!workspace) return { ok: true, data: false }
      return { ok: true, data: removeChatTopicDir(Number(topicId)) }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn('[Chat] 清理会话目录失败:', message)
      return { ok: false, error: message }
    }
  })

  return handlers
}
