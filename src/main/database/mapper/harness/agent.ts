import { and, asc, count, eq, sql } from 'drizzle-orm'
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core'
import logger from 'electron-log'
import type { SubAgentConfig } from '../../../services/harness/types'
import { withOrm } from '../../orm'
import { agent_config } from '../../schema'

// --- 类型定义 ---

/** 子代理配置行（字段由 schema 推导） */
export type AgentConfigRow = typeof agent_config.$inferSelect

export interface PaginatedResult<T> {
  items: T[]
  hasMore: boolean
  total: number
}

export interface AgentConfigInput {
  workspace_id: number
  name: string
  rename?: string | null
  prompt?: string | null
  description?: string | null
  skills?: string[] | null
  model?: string | null
  tools?: string[] | null
  enable?: boolean
}

// --- 内部工具 ---

export function rowToSubAgentConfig(row: AgentConfigRow): SubAgentConfig {
  return {
    name: row.name,
    ...(row.rename ? { rename: row.rename } : {}),
    description: row.description ?? '',
    systemPrompt: row.prompt ?? '',
    tools: row.tools ? JSON.parse(row.tools) : [],
    ...(row.model ? { model: row.model } : {}),
    ...(row.skills ? { skills: JSON.parse(row.skills) as string[] } : {}),
    revision: row.revision
  }
}

/** skills / tools 以 JSON 字符串存 TEXT 列；空数组按 null 存（与原实现一致） */
function toJsonColumn(value: string[] | null | undefined): string | null {
  return value && value.length > 0 ? JSON.stringify(value) : null
}

// --- CRUD ---

/** 获取指定工作区下所有代理配置 */
async function getAllAgents(workspaceId: number): Promise<AgentConfigRow[]> {
  return withOrm('getAllAgents', async (db) => {
    const rows = await db
      .select()
      .from(agent_config)
      .where(eq(agent_config.workspace_id, workspaceId))
      .orderBy(asc(agent_config.id))
    logger.info(`Query for all agents (workspace=${workspaceId}) returned ${rows.length} rows.`)
    return rows
  })
}

/** 分页获取指定工作区下代理配置 */
async function getAgentsPaginated(
  workspaceId: number,
  page: number,
  pageSize: number
): Promise<PaginatedResult<AgentConfigRow>> {
  return withOrm('getAgentsPaginated', async (db) => {
    const countRows = await db
      .select({ total: count() })
      .from(agent_config)
      .where(eq(agent_config.workspace_id, workspaceId))
    const total = Number(countRows[0]?.total) || 0

    const offset = page * pageSize
    const rows = await db
      .select()
      .from(agent_config)
      .where(eq(agent_config.workspace_id, workspaceId))
      .orderBy(asc(agent_config.id))
      .limit(pageSize)
      .offset(offset)

    logger.info(
      `Paginated agents: workspace=${workspaceId}, page=${page}, size=${pageSize}, got=${rows.length}, total=${total}`
    )
    return {
      items: rows,
      hasMore: (page + 1) * pageSize < total,
      total
    }
  })
}

/** 获取指定工作区下所有已启用的代理（转换为 SubAgentConfig 供 HarnessService 使用） */
async function getEnabledSubAgentConfigs(workspaceId: number): Promise<SubAgentConfig[]> {
  return withOrm('getEnabledSubAgentConfigs', async (db) => {
    const rows = await db
      .select()
      .from(agent_config)
      .where(and(eq(agent_config.workspace_id, workspaceId), eq(agent_config.enable, true)))
      .orderBy(asc(agent_config.id))
    logger.info(`Query for enabled agents (workspace=${workspaceId}) returned ${rows.length} rows.`)
    return rows.map(rowToSubAgentConfig)
  })
}

/** 根据 ID 获取代理（同时校验 workspace_id） */
async function getAgentById(workspaceId: number, id: number): Promise<AgentConfigRow | null> {
  return withOrm('getAgentById', async (db) => {
    const rows = await db
      .select()
      .from(agent_config)
      .where(and(eq(agent_config.workspace_id, workspaceId), eq(agent_config.id, id)))
      .limit(1)
    return rows[0] ?? null
  })
}

/** 按标识查代理（用于「同一工作区内 name 唯一」的前置校验，避免撞库唯一约束后报原始错误） */
async function getAgentByName(workspaceId: number, name: string): Promise<AgentConfigRow | null> {
  return withOrm('getAgentByName', async (db) => {
    const rows = await db
      .select()
      .from(agent_config)
      .where(and(eq(agent_config.workspace_id, workspaceId), eq(agent_config.name, name)))
      .limit(1)
    return rows[0] ?? null
  })
}

/** 创建代理 */
async function createAgent(input: AgentConfigInput): Promise<number> {
  return withOrm('createAgent', async (db) => {
    const rows = await db
      .insert(agent_config)
      .values({
        workspace_id: input.workspace_id,
        name: input.name,
        rename: input.rename || null,
        prompt: input.prompt || null,
        description: input.description || null,
        skills: toJsonColumn(input.skills),
        model: input.model || null,
        tools: toJsonColumn(input.tools),
        enable: input.enable ?? true
      })
      .returning({ id: agent_config.id })

    const newId = rows[0].id
    logger.info(`Created agent "${input.name}" (workspace=${input.workspace_id}) with ID: ${newId}`)
    return newId
  })
}

/**
 * 更新代理（同时校验 workspace_id）。
 *
 * `expectedRevision` 提供时走 CAS：版本不匹配返回 false（调用方转成可读冲突错误），
 * 与 Agent Teams 任务板的 revision 校验同一思路。每次成功更新 revision + 1。
 */
async function updateAgent(
  workspaceId: number,
  id: number,
  updates: Partial<AgentConfigInput>,
  expectedRevision?: number
): Promise<boolean> {
  return withOrm('updateAgent', async (db) => {
    const patch: PgUpdateSetSource<typeof agent_config> = {}

    if (updates.name !== undefined) patch.name = updates.name
    if (updates.rename !== undefined) patch.rename = updates.rename
    if (updates.prompt !== undefined) patch.prompt = updates.prompt
    if (updates.description !== undefined) patch.description = updates.description
    if (updates.skills !== undefined) patch.skills = toJsonColumn(updates.skills)
    if (updates.model !== undefined) patch.model = updates.model
    if (updates.tools !== undefined) patch.tools = toJsonColumn(updates.tools)
    if (updates.enable !== undefined) patch.enable = updates.enable

    if (Object.keys(patch).length === 0) {
      logger.warn('No fields to update for agent:', id)
      return false
    }

    // 版本与 updated_at 都走数据库侧：revision 用于 CAS/会话快照追溯
    patch.revision = sql`${agent_config.revision} + 1`
    patch.updated_at = sql`now()`
    const updated = await db
      .update(agent_config)
      .set(patch)
      .where(
        and(
          eq(agent_config.workspace_id, workspaceId),
          eq(agent_config.id, id),
          expectedRevision === undefined ? undefined : eq(agent_config.revision, expectedRevision)
        )
      )
      .returning({ id: agent_config.id })

    logger.info(
      `Updated agent workspace=${workspaceId} id=${id}${expectedRevision === undefined ? '' : ` (expectedRevision=${expectedRevision})`}, ${updated.length} row(s) affected.`
    )
    return updated.length > 0
  })
}

/** 删除代理（同时校验 workspace_id） */
async function deleteAgent(workspaceId: number, id: number): Promise<boolean> {
  return withOrm('deleteAgent', async (db) => {
    const deleted = await db
      .delete(agent_config)
      .where(and(eq(agent_config.workspace_id, workspaceId), eq(agent_config.id, id)))
      .returning({ id: agent_config.id })
    logger.info(
      `Deleted agent workspace=${workspaceId} id=${id}, ${deleted.length} row(s) affected.`
    )
    return deleted.length > 0
  })
}

export type { SubAgentConfig }

export {
  getAllAgents,
  getAgentsPaginated,
  getEnabledSubAgentConfigs,
  getAgentById,
  getAgentByName,
  createAgent,
  updateAgent,
  deleteAgent
}
