import { app } from 'electron'
import { dirname, join, resolve } from 'path'
import type { PGlite } from '@electric-sql/pglite'
import { and, asc, eq, sql } from 'drizzle-orm'
import logger from 'electron-log'
import { ormForClient, type Orm } from './orm'
import { agent_config, harness_topic, workspace } from './schema'

export interface WorkspaceMigrationResult {
  /** 迁移后确定的活动工作区 id；null 表示当前没有任何工作区（等待用户在对话页配置） */
  activeWorkspaceId: number | null
  /** 活动工作区的目录路径（与 id 同步写回设置，避免两者不一致） */
  activeWorkspacePath: string | null
}

/** 旧版本自动生成的默认工作区路径（Documents 下，用户曾明确不喜欢，识别后回滚） */
function legacyAutoPath(): string {
  return join(app.getPath('documents'), 'RytenBench 工作区')
}

/** 旧版本自动生成的默认工作区路径（userData 下，现已改为「不自动创建工作区」） */
function legacyUserDataAutoPath(): string {
  return join(app.getPath('userData'), 'workspaces', 'default')
}

/**
 * 回滚旧版本自动创建的「默认工作区」（幂等）。
 *
 * 应用不再在初始化时自动创建工作区，因此历史上自动生成的那两个默认工作区
 * 需要清掉，让用户回到「未配置工作区」状态，由对话页引导配置。
 * 仅在该工作区**没有任何会话与智能体配置**时删除，避免误删用户真正在用的工作区。
 */
async function revertAutoCreatedWorkspace(db: Orm, path: string, label: string): Promise<void> {
  const found = await db
    .select({
      id: workspace.id,
      topics: sql<number>`(SELECT COUNT(*)::int FROM ${harness_topic} t WHERE t.workspace_id = ${workspace.id})`,
      agents: sql<number>`(SELECT COUNT(*)::int FROM ${agent_config} a WHERE a.workspace_id = ${workspace.id})`
    })
    .from(workspace)
    .where(and(eq(workspace.name, '默认工作区'), eq(workspace.path, path)))
    .orderBy(asc(workspace.id))
    .limit(1)

  const row = found[0]
  if (!row) return
  if (row.topics > 0 || row.agents > 0) {
    logger.info(
      `[WorkspaceMigration] Keep ${label} default workspace id=${row.id} (topics=${row.topics}, agents=${row.agents})`
    )
    return
  }
  await db.delete(workspace).where(eq(workspace.id, row.id))
  logger.info(`[WorkspaceMigration] Reverted ${label} auto-created default workspace id=${row.id}`)
}

/**
 * 把历史上那批**插件工作区**从默认的 'user' 就地分类成 'plugin'（幂等，只跑一次有实际效果）。
 *
 * 为什么需要：`workspace.kind` 是 0010 才加的列，老库里的插件工作区全是默认值；认不出来
 * 它们就会漏进侧栏的「工作」列表（用户口径 2026-09-28「插件目录不进『工作』列表」）。
 * 判据与运行时那条（harness 的 `listPluginWorkspaces`）必须一致：**插件源码目录的直接子目录**。
 *
 * 为什么放在 core 的启动迁移里而不是插件安装时：这是一次性的数据搬迁，一次 UPDATE 就完事；
 * 放在这里能保证「第一次打开新版本就已经是对的」，不必等助手插件被打开过。
 * 只动 kind，不动名字与路径（也不刷 updated_at——那是侧栏排序用的，搬家不该把行顶到前面）。
 */
async function classifyLegacyPluginWorkspaces(db: Orm, pluginsRoot?: string): Promise<void> {
  if (!pluginsRoot) return
  const root = resolve(pluginsRoot)
  const rows = await db
    .select({ id: workspace.id, path: workspace.path })
    .from(workspace)
    .where(eq(workspace.kind, 'user'))
  let classified = 0
  for (const row of rows) {
    if (!row.path) continue
    const resolved = resolve(row.path)
    // 大小写不敏感（Windows）：两侧都小写后比父目录
    if (dirname(resolved).toLowerCase() !== root.toLowerCase()) continue
    await db.update(workspace).set({ kind: 'plugin' }).where(eq(workspace.id, row.id))
    classified += 1
  }
  if (classified > 0) {
    logger.info(`[WorkspaceMigration] Classified ${classified} legacy plugin workspace(s)`)
  }
}

/**
 * 工作区数据迁移（启动时执行，幂等）：
 * 1. 回滚旧版本自动创建的「默认工作区」（Documents 路径与 userData 路径各一次，
 *    仅当其没有会话与智能体配置时）；
 * 2. 分类历史上的插件工作区（`kind` = 'plugin'，见上）；
 * 3. 确定活动工作区：沿用设置里的 activeWorkspaceId（若仍存在），否则取第一个；
 *    一个工作区都没有时返回 null —— 应用不再自动创建，由对话页的引导让用户选择目录。
 *
 * 注意：文档 / 知识库 / 待办已是全局数据（无 workspace_id 列），不参与任何回填或归属处理。
 */
export async function migrateWorkspaceData(
  client: PGlite,
  getActiveWorkspaceId: () => number | undefined,
  /** 插件存放路径（分类历史插件工作区用；未配置 = 跳过该步） */
  pluginsRoot?: string
): Promise<WorkspaceMigrationResult> {
  const db = ormForClient(client)

  await revertAutoCreatedWorkspace(db, legacyAutoPath(), 'legacy-documents')
  await revertAutoCreatedWorkspace(db, legacyUserDataAutoPath(), 'legacy-userData')
  await classifyLegacyPluginWorkspaces(db, pluginsRoot)

  // 确定活动工作区（不创建）
  const workspaces = await db
    .select({ id: workspace.id, path: workspace.path })
    .from(workspace)
    .orderBy(asc(workspace.created_at), asc(workspace.id))

  if (workspaces.length === 0) {
    logger.info('[WorkspaceMigration] No workspace configured — waiting for user setup')
    return { activeWorkspaceId: null, activeWorkspacePath: null }
  }

  const storedActive = getActiveWorkspaceId()
  const stored = workspaces.find((w) => w.id === storedActive) ?? workspaces[0]
  return { activeWorkspaceId: stored.id, activeWorkspacePath: stored.path }
}
