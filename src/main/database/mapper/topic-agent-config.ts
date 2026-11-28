/**
 * Mapper for the session-level agent selection (tools / skills / MCP tools).
 *
 * A session without a row means every dimension is "no override / not enabled"; dimensions whose value is null are stored as null.
 */
import { eq } from 'drizzle-orm'
import { withOrm } from '../orm'
import { topic_agent_config } from '../schema'
import type { AgentSelection } from '../../../shared/harness/agent-config'
import { normalizeAgentSelection } from '../../../shared/harness/agent-config'

/** JSON column → string array (invalid data becomes null) */
function parseNames(raw: string | null): string[] | null {
  if (!raw) return null
  try {
    return normalizeAgentSelection({ tools: JSON.parse(raw) })?.tools ?? null
  } catch {
    return null
  }
}

/** Read the session-level selection; returns null when there is no row */
export async function getTopicAgentSelection(topicId: number): Promise<AgentSelection | null> {
  return withOrm('getTopicAgentSelection', async (db) => {
    const rows = await db
      .select()
      .from(topic_agent_config)
      .where(eq(topic_agent_config.topic_id, topicId))
    const row = rows[0]
    if (!row) return null
    return {
      tools: parseNames(row.tools),
      skills: parseNames(row.skills),
      mcpTools: parseNames(row.mcp_tools)
    }
  })
}

/** Write the session-level selection (each of the three columns stores JSON or null) */
export async function setTopicAgentSelection(
  topicId: number,
  selection: AgentSelection
): Promise<void> {
  await withOrm('setTopicAgentSelection', async (db) => {
    const values = {
      topic_id: topicId,
      tools: selection.tools === null ? null : JSON.stringify(selection.tools),
      skills: selection.skills === null ? null : JSON.stringify(selection.skills),
      mcp_tools: selection.mcpTools === null ? null : JSON.stringify(selection.mcpTools),
      updated_at: new Date().toISOString()
    }
    await db
      .insert(topic_agent_config)
      .values(values)
      .onConflictDoUpdate({
        target: topic_agent_config.topic_id,
        set: {
          tools: values.tools,
          skills: values.skills,
          mcp_tools: values.mcp_tools,
          updated_at: values.updated_at
        }
      })
  })
}

/** Delete the session-level selection (back to defaults) */
export async function clearTopicAgentSelection(topicId: number): Promise<void> {
  await withOrm('clearTopicAgentSelection', async (db) => {
    await db.delete(topic_agent_config).where(eq(topic_agent_config.topic_id, topicId))
  })
}
