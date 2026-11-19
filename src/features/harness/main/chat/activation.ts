import { settingsStore } from '../../../../main/context'
import { syncWorkspaceWatcher } from '../workspace/index'
import type { HarnessSettings } from '../../../../main/types/settings'
import { ensureChatTopicDir, ensureChatWorkspace } from './workspace'

/**
 * 把「对话」模式的目录写成**活动工作区**（AI 工作目录 / 资源管理器根 / 文件 IPC 边界都认它）。
 *
 * 为什么单独一个模块：对话目录的**计算**在 chat/workspace.ts（纯文件系统 + 数据库），
 * 而「切换活动工作区」要写 electron-store 并让文件监听换根——那是主进程环境的事。
 * 拆开之后离线工装只 import workspace.ts 就能验目录规则，不必把设置存储 / 监听器拖进来。
 *
 * 两条纪律（与工坊的插件工作区切换完全同款）：
 * - 只走「写设置 + 重新同步监听」这一条路：文件工具、资源管理器、改动审查、记忆作用域
 *   全都只看 `harness.workspacePath` + `activeWorkspaceId`；
 * - **幂等**：目录 / 工作区没变就什么都不做，避免每次进会话都重建文件监听。
 */
export interface ChatActivation {
  workspaceId: number
  /** 这条会话（或空白会话）的工作目录 */
  dir: string
}

/** 写设置 + 让监听换根（没变化时不重复写） */
export function activateChatWorkspace(dir: string, workspaceId: number): void {
  const harness = settingsStore.get('harness') as HarnessSettings | undefined
  if (harness?.workspacePath === dir && harness?.activeWorkspaceId === workspaceId) return
  settingsStore.set('harness', {
    ...(harness ?? ({} as HarnessSettings)),
    workspacePath: dir,
    activeWorkspaceId: workspaceId
  })
  syncWorkspaceWatcher()
}

/** 进入「对话」模式的空白会话：活动工作区 = 模式根目录（`<userData>/chat/`） */
export async function activateChatRoot(): Promise<ChatActivation> {
  const workspace = await ensureChatWorkspace()
  activateChatWorkspace(workspace.path, workspace.id)
  return { workspaceId: workspace.id, dir: workspace.path }
}

/**
 * 打开某条会话：活动工作区 = 它自己的子目录（`<userData>/chat/<话题 id>/`）。
 *
 * 目录是**按需创建**的：重开应用后点开会话、或目录被用户手动删掉，这里都会补回来，
 * 否则模型的文件工具一调就是 ENOENT（「文件内容不可操作」）。
 */
export async function activateChatTopic(topicId: number): Promise<ChatActivation> {
  const workspace = await ensureChatWorkspace()
  const dir = await ensureChatTopicDir(Number(topicId))
  activateChatWorkspace(dir, workspace.id)
  return { workspaceId: workspace.id, dir }
}
