import { foreignKey, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { harness_topic } from './harness'

/**
 * 每个会话的「本轮启用选择」：工具 / 技能 / MCP 工具。
 *
 * 为什么单独一张表而不是加列到 `harness_topic`：
 * - 这三项是**运行配置**，与话题的展示属性（标题/模型/归档）生命周期不同；
 * - 没有行的会话 = 用默认值（工具跟随主智能体默认；技能与 MCP 默认**不启用**），
 *   不需要在旧数据上做回填；
 * - 将来若再加「本轮使用的子代理/工作流」等选择，只扩这张表，不动主表。
 *
 * 列里存 JSON 字符串数组；`*_json` 为 null 表示「该维度没有覆盖」：
 * - tools 为 null → 跟随 mainAgent.tools；
 * - skills 为 null → 不启用任何技能（用户口径：新增技能不能默认开启）；
 * - mcp_tools 为 null → 不启用任何 MCP 工具（同理）。
 */
export const topic_agent_config = pgTable(
  'topic_agent_config',
  {
    topic_id: integer().primaryKey().notNull(),
    /** JSON string[]（工具名，可含 MCP 分组项）；null = 不覆盖 */
    tools: text(),
    /** JSON string[]（技能 id）；null = 不启用 */
    skills: text(),
    /** JSON string[]（MCP 工具名/分组）；null = 不启用 */
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
