import { foreignKey, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { harness_topic } from './harness'

/**
 * 后台子代理会话的持久化快照（冷恢复的基础）。
 *
 * 设计取舍：
 * - **一张表 + JSON 列**：会话的事件流/消息历史都是只追加的纯 JSON，单会话读写量小；
 *   不拆事件表可以避免「每 token 一行」的写放大，也便于整段事务覆盖；
 * - `id` 使用注册表生成的稳定 id（`subagent-<uuid>`），不再依赖进程内自增计数；
 * - `config` 存**创建时的子代理配置快照**：即使之后设置页改了/删了该子代理，历史会话
 *   仍能按当时的提示词/工具回放，不会因为配置漂移而看不懂旧记录（对齐 DSH 的
 *   descriptor + agent preset 语义，但去掉了 Cordis 的组合机制）；
 * - `status` 不落 running：应用崩溃/退出后没有在跑的任务，恢复时统一标记为 `inactive`，
 *   历史记录先只读可看；第一次续聊时按快照冷恢复（重建模型/工具/prompt）再转回 idle。
 */
export const subagent_session = pgTable(
  'subagent_session',
  {
    id: text().primaryKey().notNull(),
    topic_id: integer().notNull(),
    /** 子代理标识（agent_config.name） */
    name: text().notNull(),
    /** 顶部栏显示名（创建时按当时的界面语言生成） */
    label: text().notNull(),
    /** 首轮任务指令（会话视图标题/兼容旧契约） */
    prompt: text().notNull(),
    /** 子代理配置快照（JSON：SubAgentConfig） */
    config: text().notNull(),
    /** 消息历史（JSON：[{role:'human'|'ai', content}]，续聊重建上下文用） */
    messages: text().notNull(),
    /** 会话事件流（JSON：SubagentConversationEvent[]，渲染层重放用） */
    conversation: text().notNull(),
    conversation_seq: integer().notNull().default(0),
    /** spawn 时主模型描述符：provider 行 id + 模型名（冷恢复回到同一模型；空则用默认供应商） */
    main_model_provider_id: integer(),
    main_model_name: text(),
    /** 会话累计真实 token 用量（各轮模型 usage_metadata 累加；0 = 未采集到） */
    usage_input_tokens: integer().notNull().default(0),
    usage_output_tokens: integer().notNull().default(0),
    usage_total_tokens: integer().notNull().default(0),
    usage_calls: integer().notNull().default(0),
    turn_counter: integer().notNull().default(0),
    /** 最近一轮终态：completed / failed / killed */
    last_status: text(),
    last_output: text(),
    /** 排队未开始的消息（JSON: string[]；恢复后保留展示，需续聊能力再做重放） */
    inbox: text(),
    created_at: timestamp({ mode: 'string' }).defaultNow(),
    last_run_at: timestamp({ mode: 'string' }),
    updated_at: timestamp({ mode: 'string' }).defaultNow()
  },
  (table) => [
    index('idx_subagent_session_topic').using(
      'btree',
      table.topic_id.asc().nullsLast().op('int4_ops')
    ),
    foreignKey({
      columns: [table.topic_id],
      foreignColumns: [harness_topic.id],
      name: 'subagent_session_topic_id_fkey'
    }).onDelete('cascade')
  ]
)
