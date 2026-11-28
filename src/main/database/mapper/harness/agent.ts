import { and, asc, count, eq, sql } from 'drizzle-orm'
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core'
import logger from 'electron-log'
import type { SubAgentConfig } from '../../../services/harness/types'
import { withOrm } from '../../orm'
import { agent_config } from '../../schema'

// --- Type definitions ---

/** Sub-agent configuration row (fields inferred from the schema) */
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

// --- Internal helpers ---

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

/** skills / tools are stored as JSON strings in TEXT columns; empty arrays are stored as null (matching the previous implementation) */
function toJsonColumn(value: string[] | null | undefined): string | null {
  return value && value.length > 0 ? JSON.stringify(value) : null
}

// --- CRUD ---

/** Get all agent configurations in the given workspace */
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

/** Get agent configurations in the given workspace, paginated */
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

/** Get all enabled agents in the given workspace (converted to SubAgentConfig for HarnessService) */
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

/** Get an agent by ID (also validates workspace_id) */
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

/** Look up an agent by name (pre-check for "name is unique within a workspace" to avoid raw unique-constraint errors) */
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

/** Create an agent */
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
 * Update an agent (also validates workspace_id).
 *
 * When `expectedRevision` is provided, this runs as a CAS: a revision mismatch returns false (the
 * caller turns that into a readable conflict error), following the same idea as the revision check
 * on the team task board. Every successful update increments revision by 1.
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

    // Both revision and updated_at are handled database-side: revision for CAS/session snapshot tracing
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

/** Delete an agent (also validates workspace_id) */
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
