import * as path from 'path'
import * as fs from 'fs'
import { app } from 'electron'
import logger from 'electron-log'
import {
  createWorkspace,
  findWorkspaceByPath,
  getWorkspacesByKind,
  setWorkspaceKind
} from '../db/mapper/harness'
import type { WorkspaceRow } from '../db/mapper/harness'
import { isSameFsPath } from '../../shared/workshop'

/**
 * 「对话」模式的**工作目录**：该模式没有工作区概念，但模型的文件工具需要一个可写根目录
 * （虚拟 `/` 挂的就是它），否则 read/write/edit 一调就是越界，资源管理器也没根可显示。
 *
 * 目录布局（按操作系统自动解析，不需要用户配置）：
 *
 * ```
 * <userData>/chat/            ← 对话模式的工作区根（workspace 行 kind='chat'）
 *   └── <会话 id>/            ← 每个会话一个子目录，就是这条会话的工作目录
 * ```
 *
 * 为什么放 `userData` 而不是「文档」目录：应用**刻意不自动创建用户可见的目录**
 * （历史上那个 Documents 下的「RytenBench 工作区」已被 workspace-migration 回滚掉），
 * 对话模式的目录是应用的运行数据，跟着数据库/日志一起待在应用数据目录里最合适；
 * 用户想看文件就从右侧资源管理器面板打开，或点「打开目录」。
 *
 * 为什么做成真正的工作区行：与插件工作区同一个理由（见 workshop/workspace.ts）——
 * AI 工作目录（Runtime 的 workspacePath）、资源管理器根、文件 IPC 边界（`assertInsideWorkspace`）、
 * 文件改动审查、按工作区隔离的记忆，全都只认 `harness.workspacePath` + `activeWorkspaceId`。
 * 让活动工作区真的指向这个目录，整条链路一行都不用改。
 *
 * 这些行**不算用户的工作区**：侧栏「工作」列表按 `kind` 把它们滤掉，
 * 它们只出现在「对话」那一侧（`kind='chat'`）。
 */

/** 对话模式的目录名（`<userData>/chat/`） */
const CHAT_DIR_NAME = 'chat'

/**
 * 对话模式的根目录（按系统解析）。
 *
 * `app.getPath('userData')` 在各平台分别是
 * `%APPDATA%\ryten-bench`（Win）/ `~/Library/Application Support/ryten-bench`（mac）/
 * `~/.config/ryten-bench`（Linux）——本函数是这条规则的**唯一**出口，别处一律用它，
 * 免得渲染层/工装各拼一份路径。
 */
export function chatWorkspaceRoot(): string {
  return path.join(app.getPath('userData'), CHAT_DIR_NAME)
}

/** 某条会话的工作目录（话题 id；0 = 还没有话题的空白会话 → 就用根目录） */
export function chatTopicDir(topicId: number): string {
  const root = chatWorkspaceRoot()
  return topicId > 0 ? path.join(root, String(topicId)) : root
}

/** 确保目录存在（幂等；模型/资源管理器一进来就能用） */
export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

/** 已存在的对话工作区行（没有则 null，不创建） */
export async function findChatWorkspace(): Promise<WorkspaceRow | null> {
  const rows = await getWorkspacesByKind('chat')
  return rows[0] ?? null
}

/** 当前所有对话工作区 id（侧栏据此把「对话」的行从「工作」列表里滤掉、并认出自己的那一行） */
export async function listChatWorkspaceIds(): Promise<number[]> {
  return (await getWorkspacesByKind('chat')).map((row) => row.id)
}

/**
 * 取（必要时创建）对话模式的根工作区。
 *
 * 幂等：`<userData>/chat` 这个路径永远只对应一行（表上 `workspace_path_key` 唯一）。
 * 路径被占但种类不对（理论上不会发生：这个路径只有这里会建）就地改成 'chat'，
 * 而不是再插一行——插会撞唯一约束。
 */
export async function ensureChatWorkspace(): Promise<WorkspaceRow> {
  const root = chatWorkspaceRoot()
  ensureDir(root)
  const existing = await findWorkspaceByPath(root)
  if (existing) {
    if (existing.kind !== 'chat') await setWorkspaceKind(existing.id, 'chat')
    return { ...existing, kind: 'chat' }
  }
  const name = '对话'
  const id = await createWorkspace(name, root, 'chat')
  const created = await findWorkspaceByPath(root)
  if (!created) {
    // 刚建完必然查得到；查不到说明库出了别的问题，如实抛出去而不是编一行假数据
    throw new Error(`对话工作区创建后读不回来（id=${id}，path=${root}）`)
  }
  logger.info(`[Chat] created chat workspace id=${id} at ${root}`)
  return created
}

/**
 * 某条会话的工作目录（取（必要时创建）它的子目录）。
 *
 * 话题 id 为准而不是话题标题：标题会被模型改、也可能重名，目录名必须稳定且**已经过校验**
 * （id 是自增整数，天然不含路径分隔符）。
 *
 * @param topicId 话题 id；≤0 = 还没有话题 → 返回根目录本身（新建的空白会话先用它）
 */
export async function ensureChatTopicDir(topicId: number): Promise<string> {
  const dir = chatTopicDir(topicId)
  ensureDir(dir)
  return dir
}

/**
 * 删除一条对话会话的目录（删话题时顺手清理）。
 *
 * 两道闸，任何一道不满足就什么都不做——
 * 这函数带 `recursive: true`，路径算错就是删用户目录：
 * ① 目标必须是**对话根目录的直接子目录**（且不是根目录本身）；
 * ② 名字必须是纯数字（话题 id）。
 */
export function removeChatTopicDir(topicId: number): boolean {
  if (!(topicId > 0)) return false
  const root = path.resolve(chatWorkspaceRoot())
  const target = path.resolve(chatTopicDir(topicId))
  if (path.dirname(target) !== root) {
    logger.warn(`[Chat] 拒绝删除非直接子目录：${target}`)
    return false
  }
  if (!/^\d+$/.test(path.basename(target))) {
    logger.warn(`[Chat] 拒绝删除非话题目录：${target}`)
    return false
  }
  try {
    fs.rmSync(target, { recursive: true, force: true })
    logger.info(`[Chat] removed conversation dir ${target}`)
    return true
  } catch (err) {
    logger.warn(`[Chat] 会话目录删除失败（不影响删话题）：${target}`, err)
    return false
  }
}

/**
 * 启动时的**兜底分类**：把历史上那批插件工作区从默认的 'user' 认成 'plugin'。
 *
 * 0010 之前没有 kind 列，老库里的插件工作区全是默认值；认不出来它们就会漏进「工作」列表
 * （2026-09-28 用户明确要求「插件目录不进『工作』列表」）。判据与 listPluginWorkspaces 一致：
 * 路径是插件存放路径的**直接子目录**。只动 kind='user' 的行，不动名字与路径，也不刷 updated_at。
 *
 * 对话工作区不必在这里分类：它由 ensureChatWorkspace 自己写 'chat'。
 */
export async function classifyLegacyPluginWorkspaces(
  pluginsRoot: string | undefined
): Promise<number> {
  if (!pluginsRoot) return 0
  const rows = await getWorkspacesByKind('user')
  let classified = 0
  for (const row of rows) {
    if (!row.path) continue
    if (!isSameFsPath(path.dirname(path.resolve(row.path)), pluginsRoot)) continue
    if (await setWorkspaceKind(row.id, 'plugin')) classified += 1
  }
  if (classified > 0) {
    logger.info(`[Chat] classified ${classified} legacy workspace(s) as kind=plugin`)
  }
  return classified
}
