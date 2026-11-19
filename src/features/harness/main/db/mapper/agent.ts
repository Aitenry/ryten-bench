import { and, asc, count, eq, sql } from 'drizzle-orm'
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core'
import logger from 'electron-log'
import type { SubAgentConfig } from '../../types'
import { withOrm } from '../../../../../main/database/orm'
import { agent_config } from '../../../../../main/database/schema'

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

function rowToSubAgentConfig(row: AgentConfigRow): SubAgentConfig {
  return {
    name: row.name,
    ...(row.rename ? { rename: row.rename } : {}),
    description: row.description ?? '',
    systemPrompt: row.prompt ?? '',
    tools: row.tools ? JSON.parse(row.tools) : [],
    ...(row.model ? { model: row.model } : {}),
    ...(row.skills ? { skills: JSON.parse(row.skills) as string[] } : {})
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

/** 更新代理（同时校验 workspace_id） */
async function updateAgent(
  workspaceId: number,
  id: number,
  updates: Partial<AgentConfigInput>
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

    // updated_at 走数据库时钟，与原实现的 NOW() 一致
    patch.updated_at = sql`now()`
    const updated = await db
      .update(agent_config)
      .set(patch)
      .where(and(eq(agent_config.workspace_id, workspaceId), eq(agent_config.id, id)))
      .returning({ id: agent_config.id })

    logger.info(
      `Updated agent workspace=${workspaceId} id=${id}, ${updated.length} row(s) affected.`
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
  createAgent,
  updateAgent,
  deleteAgent
}
