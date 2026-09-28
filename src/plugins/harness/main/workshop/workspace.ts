import * as path from 'path'
import {
  createWorkspace,
  getAllWorkspaces,
  reparentPluginTopics,
  updateWorkspace
} from '../db/mapper/harness'
import type { WorkspaceRow } from '../db/mapper/harness'
import { isSameFsPath } from '../../shared/workshop'
import { draftDir, pluginsRootPath } from './paths'
import { draftSummary } from './service'

/**
 * 插件会话的**工作目录**：这份插件自己的源码目录（`<插件存放路径>/<插件 id>/`）。
 *
 * 为什么做成真正的工作区行，而不是只在渲染层换个根：
 * AI 工作目录（Runtime 的 workspacePath）、资源管理器根、文件 IPC 的边界
 * （`assertInsideWorkspace`）、文件改动审查，全都只认 `harness.workspacePath` +
 * `activeWorkspaceId`——把插件目录做成一个工作区、开会话时切过去，这一整条链路就都不用改，
 * 而且话题行记着 `workspace_id`，**重开这个会话（甚至重启应用）仍然回到插件目录**。
 *
 * 用户口径（2026-09-28「在插件模式下新建会话，其工作区还是之前工作模式下选中的工作区，
 * 资源管理器也一样」）：插件会话不该占用工作模式选中的那个工作区。
 *
 * 这些工作区**不算用户的工作区**：侧栏「工作」列表按路径把它们过滤掉，它们只出现在插件模式下
 * （插件行展开就是这份插件自己的会话；用户口径同一天「插件目录不进『工作』列表，只属于那份插件」）。
 *
 * 生命周期：**按需创建**（第一次给这份插件开会话时），插件改名时同步名字；
 * 删除草稿**不动**这一行与它下面的会话（删源码不等于删对话，与卸载插件的口径一致：
 * 代码移除 / 数据保留是两件事）——重建同名草稿后这些会话会重新出现在插件行下。
 */

/** 某份插件的插件工作区（没有则 null，不创建） */
export async function findPluginWorkspace(pluginId: string): Promise<WorkspaceRow | null> {
  const dir = draftDir(pluginId)
  const rows = await getAllWorkspaces()
  return rows.find((row) => isSameFsPath(row.path, dir)) ?? null
}

/**
 * 当前所有「插件工作区」：工作区行 → 它对应的插件 id。
 *
 * 侧栏靠这份清单做两件事，两件都**只认这一个来源**（不在渲染层再算一遍路径）：
 * - 把插件行和它自己的会话对上（`draftId` → `workspaceId`）；
 * - 把插件工作区从「工作」列表里滤掉（用户口径 2026-09-28「插件目录不进『工作』列表」）。
 *
 * 判定 = 「路径是插件存放路径的直接子目录」：这样连**草稿已经删掉**的插件工作区也认得出来
 * （否则它会漏进工作列表），也不需要读草稿目录。
 */
export async function listPluginWorkspaces(): Promise<
  { draftId: string; workspaceId: number; path: string }[]
> {
  const root = pluginsRootPath()
  if (!root) return []
  const rows = await getAllWorkspaces()
  const result: { draftId: string; workspaceId: number; path: string }[] = []
  for (const row of rows) {
    if (!row.path) continue
    const resolved = path.resolve(row.path)
    if (!isSameFsPath(path.dirname(resolved), root)) continue
    result.push({ draftId: path.basename(resolved), workspaceId: row.id, path: row.path })
  }
  return result
}

/**
 * 取（必要时创建）某份插件的「插件工作区」。幂等：一个插件目录永远只对应一行。
 *
 * 顺带**归位老会话**：插件工作目录上线（2026-09-28）之前开的插件会话，话题上已经是
 * `plugin:<id>`，但 workspace_id 还指着当时的工作区——把它们收拢到插件工作区下，
 * 用户下次打开这些会话就落在插件目录上（见 mapper 的 `reparentPluginTopics`）。
 */
export async function ensurePluginWorkspace(pluginId: string): Promise<WorkspaceRow> {
  const dir = draftDir(pluginId)
  const name = draftSummary(pluginId).title || pluginId
  const existing = await findPluginWorkspace(pluginId)
  if (existing) {
    if (existing.name !== name) {
      // 插件改过名：工作区名跟着走（这些行不在「工作」列表里，用户不会自己去改名）
      await updateWorkspace(existing.id, { name })
    }
    await reparentPluginTopics(existing.id, `plugin:${pluginId}`)
    return { ...existing, name }
  }
  const id = await createWorkspace(name, dir)
  const created = await findPluginWorkspace(pluginId)
  if (!created) {
    // 刚建完必然查得到；查不到说明库出了别的问题，如实抛出去而不是编一行假数据
    throw new Error(`插件工作区创建后读不回来（id=${id}，path=${dir}）`)
  }
  await reparentPluginTopics(created.id, `plugin:${pluginId}`)
  return created
}

/** 插件改名后同步工作区名（没有对应工作区就什么都不做） */
export async function syncPluginWorkspaceName(pluginId: string, name: string): Promise<void> {
  try {
    const existing = await findPluginWorkspace(pluginId)
    if (existing && existing.name !== name) await updateWorkspace(existing.id, { name })
  } catch {
    // 插件存放路径没配置 / 读库失败：改名本身已完成，不同步工作区名不影响任何功能
  }
}
