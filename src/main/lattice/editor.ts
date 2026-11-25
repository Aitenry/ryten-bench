import logger from 'electron-log'
import { settingsStore } from '../context'
import { getAllTopics } from '../database/mapper/harness/harness'
import { emitAppEvent } from '../plugins/app-events'
import { APP_EVENT_WORKSPACE_CHANGED } from '../plugins/app-hooks'
import { broadcastWorkshopChanged } from '../ipc/harness/workshop'
import { isPluginOperationRunning } from '../plugins/operation-lock'
import type { HarnessSettings } from '../types/settings'
import { ensurePluginWorkspace } from '../workshop/workspace'
import { promoteSourceToWorkshop, resolvePluginSource } from './sources'
import type { LatticeOpenSourceResult } from './types'

/**
 * 「在对话中修改插件源码」（`lattice:open-source`，契约 v2 §2）。
 *
 * 目标：把源码目录变成**真正的插件工作区**并打开插件会话（已有会话接着用，没有就是空白
 * 会话），而不是只在文件管理器里打开。复用现有 workshop / harness 机制，不另造一套：
 *
 * 1. `ensurePluginWorkspace()`：`<pluginsPath>/<id>/` 这个目录 → `kind='plugin'` 工作区行
 *    （幂等；顺带把老插件会话归位到它下面）；
 * 2. 话题：该工作区下已有 `memory_scope = 'plugin:<id>'` 的会话就复用最新一条；
 *    **没有就开一条空白会话，不自动建话题**——「在对话中修改」是打开源码工作区让人自己
 *    说改什么，不是替用户发一条请求。此前会建一条标题为「修改「X」源码」的话题，
 *    侧栏里看起来就像用户没问过却多了一条提问（用户口径 2026-11-21「插件对话莫名其妙
 *    添加这个：修改「音乐播放器」源码，我明明没有发起提问」）。空白会话在用户真正发出
 *    第一条消息时才落库，标题也由那一条消息生成；
 * 3. 切换活动工作区：写 `harness.workspacePath` + `harness.activeWorkspaceId` 并派发
 *    `app.workspace-changed`（AI 工作目录、资源管理器根、文件 IPC 边界、文件改动审查都只认它）；
 * 4. 广播 `harness:workshop-changed`（渲染层据此刷新草稿/插件工作区清单）。
 *
 * 可靠性边界（**不再假装打开了对话，也不再悄悄弹文件管理器**）：
 * - 只有源码目录真的位于用户配置的插件存放路径（= workshop 草稿目录）时才走上面的对话链路；
 * - 本机没有源码（安装时源码包下载失败、旧安装、本地安装包）时，先按**本机已安装的版本**
 *   从插件中心**按需补一次源码**（见 hub.ts 的 `ensureLatticePluginSource`）——用户点
 *   「源码/在对话中修改」的意图是打开插件工作区，而不是重装应用/重启；
 * - 补不下来（未登录、平台没有该版本的源码包、网络失败、未配置 pluginsPath）时返回
 *   `{ok:false,error}` 让界面给出可读原因；**绝不回退成 `shell.openPath`**——
 *   用户 2026-11-25 的现场就是「点源码弹出一个资源管理器窗口」；
 * - userData 回退目录里的源码会先尝试迁移到 pluginsPath（`promoteSourceToWorkshop`），
 *   迁移成功才可能走对话链路。
 */

/**
 * 把活动工作区切到插件源码目录（写设置 + 派发事件）。
 *
 * 与渲染层 `systemSettings.update({harness:{workspacePath,activeWorkspaceId}})` 完全同一条路：
 * 设置落盘后 core 派发 `app.workspace-changed`，AI 助手据此重启工作区文件监听。
 * 幂等：已经是这个工作区就什么都不做（避免重复重建文件监听）。
 *
 * 另外写 `activeMode='plugin'` + `pluginContent`：渲染层从插件中心跳到 `/harness` 时，
 * HarnessSidebar 挂载会照这两个字段回到「插件」模式；`topicId` 可能是 null（空白会话）。
 */
function activatePluginWorkspace(
  dir: string,
  workspaceId: number,
  pluginId: string,
  topicId: number | null
): void {
  const harness = settingsStore.get('harness') as HarnessSettings | undefined
  settingsStore.set('harness', {
    ...(harness ?? ({} as HarnessSettings)),
    workspacePath: dir,
    activeWorkspaceId: workspaceId,
    activeMode: 'plugin',
    pluginContent: { workspaceId, topicId, pluginId }
  })
  emitAppEvent(APP_EVENT_WORKSPACE_CHANGED, { workspaceId, workspacePath: dir })
  logger.info(
    `[Lattice] Active workspace switched to plugin source directory: ${dir} (workspace=${workspaceId})`
  )
}

/**
 * 该插件工作区下已经存在的插件会话：有就返回最新一条，没有返回 `null`。
 *
 * **只找不建**：打开源码是「让用户说改什么」，不是替用户提问。没有会话时返回 null，
 * 渲染层据此开一条空白插件会话（首个话题等用户真正发消息时再建，标题由那条消息生成）。
 *
 * 只认 `memory_scope = 'plugin:<id>'` 的话题：插件会话必须用这份插件自己的记忆
 * （用户口径 2026-09-28「插件里面的记忆应该是独立的」），复用一个 null 作用域的话题
 * 会把插件记忆串到工作记忆上。
 */
async function findPluginTopic(workspaceId: number, pluginId: string): Promise<number | null> {
  const scope = `plugin:${pluginId}`
  const topics = await getAllTopics(workspaceId)
  const existing = topics.find((topic) => topic.memory_scope === scope)
  return existing ? existing.id : null
}

/**
 * `lattice:open-source` 的业务实现（详见文件头注释）。
 *
 * 返回：
 * - 真开对话：`{ok:true,workspaceId,topicId?,mode:'conversation',path}`（topicId 缺省 = 空白会话）
 * - 失败：`{ok:false,error}`（**没有「悄悄打开文件管理器」这种成功**）
 */
export async function openLatticePluginSource(
  rawPluginId: unknown
): Promise<LatticeOpenSourceResult> {
  const pluginId = typeof rawPluginId === 'string' ? rawPluginId.trim() : ''
  if (!pluginId) return { ok: false, error: '缺少插件 id' }
  /**
   * 安装/更新正在改写源码目录：此时打开源码只会拿到半套文件，甚至把用户带进一个
   * 马上被替换的工作区。明确拒绝，等安装结束再点。
   */
  if (isPluginOperationRunning(pluginId)) {
    return { ok: false, error: '插件正在安装/更新，请等它完成后再打开源码' }
  }

  let resolved = resolvePluginSource(pluginId)
  // userData 回退目录里的源码：先尝试迁到用户配置的插件存放路径，迁移成功才能开插件会话
  if (resolved && !resolved.inWorkshop) {
    resolved = promoteSourceToWorkshop(pluginId) ?? resolved
  }

  /**
   * 本机完全没有源码：按需补一次（安装时源码下载失败是已知状态，见 hub.ts）。
   * 用户点「源码」的意图是打开插件工作区，不该因为一次历史下载失败就让他卸载重装。
   */
  let ensureError: string | null = null
  if (!resolved) {
    // 动态导入避免 editor ↔ hub 的模块环（hub 也引用了源码/会话相关模块）
    const { ensureLatticePluginSource } = await import('./hub')
    const ensured = await ensureLatticePluginSource(pluginId)
    if (ensured.ok) {
      resolved = resolvePluginSource(pluginId)
      if (resolved && !resolved.inWorkshop) {
        resolved = promoteSourceToWorkshop(pluginId) ?? resolved
      }
    } else {
      ensureError = ensured.error ?? '自动下载源码失败'
    }
  }

  if (resolved?.inWorkshop) {
    try {
      const workspace = await ensurePluginWorkspace(pluginId)
      // 有既有的插件会话就接着用；没有就留空（topicId 缺省）——渲染层开一条空白插件会话，
      // 绝不替用户生成「修改「X」源码」这种像提问的话题（用户口径 2026-11-21）。
      const topicId = await findPluginTopic(workspace.id, pluginId)
      activatePluginWorkspace(workspace.path, workspace.id, pluginId, topicId)
      // 工作区清单可能刚建出来 / 草稿可能刚出现：让渲染层刷新插件侧栏
      broadcastWorkshopChanged()
      logger.info(
        topicId == null
          ? `[Lattice] Opened plugin source (blank session, waiting for the user to speak): ${pluginId} (workspace=${workspace.id})`
          : `[Lattice] Opened plugin source session: ${pluginId} (workspace=${workspace.id}, topic=${topicId})`
      )
      return {
        ok: true,
        workspaceId: workspace.id,
        ...(topicId == null ? {} : { topicId }),
        mode: 'conversation',
        path: workspace.path
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn(`[Lattice] Failed to create/reuse plugin workspace for '${pluginId}': ${message}`)
      return {
        ok: false,
        error: `创建插件工作区失败：${message}。请检查插件的源码目录是否还在（${resolved.path}）。`
      }
    }
  }

  // 源码存在但不在插件存放路径下（未配置 pluginsPath / 迁移失败）：如实报错，不打开文件夹
  if (resolved) {
    return {
      ok: false,
      error:
        `源码已在本机（${resolved.path}），但它不在「插件存放路径」下，无法创建插件工作区。` +
        '请到 设置 → 助手 → 插件工坊 配置插件存放路径后重试。'
    }
  }

  return {
    ok: false,
    error:
      ensureError ?? `本机没有 '${pluginId}' 的源码目录：请先在插件中心安装（会自动下载源码）后再试`
  }
}
