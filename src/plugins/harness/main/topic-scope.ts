import * as path from 'path'
import { CHAT_SCOPE, normalizeMemoryScope, pluginMemoryScope } from '../shared/memory-scope'
import { getWorkspaceById } from './db/mapper/harness'

/**
 * 建话题时**落库用**的记忆作用域字符串。
 *
 * 取值优先级：
 * 1. 调用方显式给了合法值（`plugin:<id>` / `chat`）→ 原样用（插件 id 只有渲染层知道）；
 * 2. 没给 / 给了 null → 按**工作区种类**兜底：
 *    - `chat` 工作区 → `chat`（对话模式没有工作区，记忆也不该挂到工作区上）；
 *    - `plugin` 工作区 → `plugin:<目录名>`（目录名就是插件 id，与 listPluginWorkspaces 同口径）；
 *    - `user` / 找不到 → null（= 工作区记忆，老口径）。
 *
 * 为什么必须有这层兜底：渲染层「下一条新话题的作用域」是一个挂起值，删掉当前会话、或某条
 * 会话是从别处建出来的，它可能为空；只信渲染层就会让**对话 / 插件会话的下一条话题悄悄
 * 掉回工作区记忆**（两边记忆互相串味，且不会报错）。工作区行自己的种类是落库事实，比一个
 * 可能已被清空的渲染层变量可靠。
 *
 * 为什么单独一个文件而不是塞进 main/memory-scope.ts：那个文件是**纯**作用域↔目录换算
 * （离线工装直接 import 它验目录口径，不依赖数据库）；这里要用 mapper 读工作区行，
 * 拖进去会让纯口径模块也带上数据库依赖。
 */
export async function resolveTopicMemoryScope(
  workspaceId: number,
  explicit?: unknown
): Promise<string | null> {
  const normalized = normalizeMemoryScope(explicit)
  if (normalized) return normalized
  try {
    const workspace = await getWorkspaceById(workspaceId)
    if (workspace?.kind === 'chat') return CHAT_SCOPE
    if (workspace?.kind === 'plugin' && workspace.path) {
      return pluginMemoryScope(path.basename(workspace.path))
    }
  } catch {
    // 工作区读不出来（库未就绪 / 行已删）→ 按工作区记忆处理，别让建话题失败
  }
  return null
}
