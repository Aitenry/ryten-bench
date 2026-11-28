import { foreignKey, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { harness_topic } from './harness'

/**
 * Per-session "enabled selections for this turn": tools / skills / MCP tools.
 *
 * Why a separate table instead of adding columns to `harness_topic`:
 * - These three are **runtime configuration** with a different lifecycle from the topic's
 *   display attributes (title/model/archive);
 * - A session without a row = use defaults (tools follow the main agent defaults; skills and MCP
 *   are **disabled** by default), so no backfill of old data is needed;
 * - If "subagents/workflows used this turn" selections are added later, only this table expands,
 *   not the main table.
 *
 * The columns store JSON string arrays; `*_json` being null means "no override for that
 * dimension":
 * - tools null → follow mainAgent.tools;
 * - skills null → no skills enabled (per user requirements: newly added skills must not be
 *   enabled by default);
 * - mcp_tools null → no MCP tools enabled (same reasoning).
 */
export const topic_agent_config = pgTable(
  'topic_agent_config',
  {
    topic_id: integer().primaryKey().notNull(),
    /** JSON string[] (tool names, may include MCP group entries); null = no override */
    tools: text(),
    /** JSON string[] (skill ids); null = disabled */
    skills: text(),
    /** JSON string[] (MCP tool names/groups); null = disabled */
    mcp_tools: text(),
    updated_at: timestamp({ mode: 'string' }).defaultNow()
  },
  (table) => [
    foreignKey({
      columns: [table.topic_id],
      foreignColumns: [harness_topic.id],
      name: 'topic_agent_config_topic_id_fkey'
    }).onDelete('cascade')
  ]
)
