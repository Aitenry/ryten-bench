/**
 * 会话级运行选择（工具 / 技能 / MCP 工具）的 mapper。
 *
 * 没有行的会话 = 全部维度「不覆盖/不启用」；写入时值为 null 的维度存 null。
 */
import { eq } from 'drizzle-orm'
import { withOrm } from '../orm'
import { topic_agent_config } from '../schema'
import type { AgentSelection } from '../../../shared/harness/agent-config'
import { normalizeAgentSelection } from '../../../shared/harness/agent-config'

/** JSON 列 → 字符串数组（非法按 null） */
function parseNames(raw: string | null): string[] | null {
  if (!raw) return null
  try {
    return normalizeAgentSelection({ tools: JSON.parse(raw) })?.tools ?? null
  } catch {
    return null
  }
}

/** 读取会话级选择；没有行返回 null */
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

/** 写入会话级选择（三列各写 JSON 或 null） */
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

/** 删除会话级选择（回到默认） */
export async function clearTopicAgentSelection(topicId: number): Promise<void> {
  await withOrm('clearTopicAgentSelection', async (db) => {
    await db.delete(topic_agent_config).where(eq(topic_agent_config.topic_id, topicId))
  })
}
