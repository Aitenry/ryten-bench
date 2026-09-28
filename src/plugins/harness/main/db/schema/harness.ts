import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  index,
  foreignKey,
  check,
  unique
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { workspace } from '../../../../../main/database/schema/workspace'

/** 会话目标的生命周期阶段（对应 harness_goals_phase_check 约束） */
export type GoalPhase = 'active' | 'paused' | 'blocked' | 'complete'

/** 对话角色（对应 harness_dialogue_role_check 约束） */
export type HarnessRole = 'user' | 'assistant'

/** 会话（话题）表：按工作区隔离，删除工作区时级联删除 */
export const harness_topic = pgTable(
  'harness_topic',
  {
    id: serial().primaryKey().notNull(),
    workspace_id: integer().notNull(),
    title: text().notNull(),
    model: text(),
    selected_tools: text(),
    /**
     * 记忆作用域：空 = 跟工作区走（`<memoryPath>/workspace-<id>/`）；
     * `plugin:<插件 id>` = 这份插件自己的记忆（`<memoryPath>/plugin-<id>/`，见 main/memory-scope.ts）。
     * 插件行「＋ 新建会话」建出来的话题写这个值，重开会话仍然用它自己的记忆。
     */
    memory_scope: text(),
    created_at: timestamp({ mode: 'string' }).defaultNow(),
    updated_at: timestamp({ mode: 'string' }).defaultNow()
  },
  (table) => [
    index('idx_harness_topic_updated_at').using(
      'btree',
      table.updated_at.asc().nullsLast().op('timestamp_ops')
    ),
    index('idx_harness_topic_workspace').using(
      'btree',
      table.workspace_id.asc().nullsLast().op('int4_ops')
    ),
    foreignKey({
      columns: [table.workspace_id],
      foreignColumns: [workspace.id],
      name: 'harness_topic_workspace_id_fkey'
    }).onDelete('cascade')
  ]
)

/** 对话记录表：role 仅允许 user / assistant */
export const harness_dialogue = pgTable(
  'harness_dialogue',
  {
    id: serial().primaryKey().notNull(),
    topic_id: integer().notNull(),
    role: text().$type<HarnessRole>().notNull(),
    content: text().notNull(),
    blocks: text(),
    created_at: timestamp({ mode: 'string' }).defaultNow()
  },
  (table) => [
    index('idx_harness_dialogue_topic').using(
      'btree',
      table.topic_id.asc().nullsLast().op('int4_ops')
    ),
    index('idx_harness_dialogue_topic_created').using(
      'btree',
      table.topic_id.asc().nullsLast().op('int4_ops'),
      table.created_at.asc().nullsLast().op('int4_ops')
    ),
    foreignKey({
      columns: [table.topic_id],
      foreignColumns: [harness_topic.id],
      name: 'harness_dialogue_topic_id_fkey'
    }).onDelete('cascade'),
    check('harness_dialogue_role_check', sql`role = ANY (ARRAY['user'::text, 'assistant'::text])`)
  ]
)

/**
 * 会话目标（长任务）表：每个话题一行。
 * 注意：本表与 topic_compactions 均无外键级联，删除工作区/话题时需要在事务里按 topic_id 显式清理。
 */
export const harness_goals = pgTable(
  'harness_goals',
  {
    topic_id: integer().primaryKey().notNull(),
    goal_id: text().notNull(),
    revision: integer().default(1).notNull(),
    objective: text().notNull(),
    phase: text().$type<GoalPhase>().default('active').notNull(),
    rounds_started: integer().default(0).notNull(),
    max_goal_rounds: integer().default(256).notNull(),
    blocked_reason: text(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull()
  },
  (table) => [
    index('idx_harness_goals_phase').using('btree', table.phase.asc().nullsLast().op('text_ops')),
    check(
      'harness_goals_phase_check',
      sql`phase = ANY (ARRAY['active'::text, 'paused'::text, 'blocked'::text, 'complete'::text])`
    )
  ]
)

/** 上下文压缩 checkpoint：每个话题一行，记录已摘要段的最末对话 id 与摘要正文 */
export const topic_compactions = pgTable('topic_compactions', {
  topic_id: integer().primaryKey().notNull(),
  boundary_id: integer().notNull(),
  summary: text().notNull(),
  created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull()
})

/**
 * 对话用量表：**一条助手回复一行**（dialogue_id 唯一）。
 *
 * 写入时机 = 助手消息落库之后（ipc/harness.ts 的流式收尾处）；数据来源 = 模型每次调用
 * 回传的 usage_metadata。一轮对话可能有多模型往返（工具循环），所以：
 *  - input/output/total_tokens 是**整轮累加值**，供按工作区、按模型聚合统计；
 *  - usage_metadata 存**每次调用的原始明细 JSON 数组**，保留各家不同的字段
 *    （reasoning_tokens / cached tokens / audio tokens…），前端要明细时直接读它。
 *
 * 设计取舍：
 *  - workspace_id / topic_id / dialogue_id 都是外键：删工作区、话题、消息时级联清理；
 *  - provider_id **不设外键**（只存快照）：供应商配置可能被删除或改名，
 *    而"这条回复当时是谁、用哪个模型花的钱"属于账目，不该被后续改动抹掉；
 *  - provider 存的是拉取模型时用的**供应商标记**（openai / deepseek / anthropic …），
 *    与 provider_id 并存：前者可直接读，后者用于回连供应商配置。
 */
export const harness_dialogue_usage = pgTable(
  'harness_dialogue_usage',
  {
    id: serial().primaryKey().notNull(),
    /** 所属工作区 */
    workspace_id: integer().notNull(),
    /** 会话（话题）id */
    topic_id: integer().notNull(),
    /** 对话记录 id：harness_dialogue.id，一条助手回复对应一行 */
    dialogue_id: integer().notNull(),
    /** 供应商配置 id（快照，不设外键） */
    provider_id: integer(),
    /** 供应商标记（拉取模型时的 provider 类型） */
    provider: text(),
    /** 模型名 */
    model: text(),
    /** 整轮输入 token（累加） */
    input_tokens: integer(),
    /** 整轮输出 token（累加） */
    output_tokens: integer(),
    /** 整轮合计 token（累加） */
    total_tokens: integer(),
    /** 本轮模型调用次数（工具循环会有多次） */
    calls: integer().default(0),
    /** 每次调用的 usage_metadata 原始明细（JSON 数组） */
    usage_metadata: text(),
    created_at: timestamp({ mode: 'string' }).defaultNow()
  },
  (table) => [
    unique('harness_dialogue_usage_dialogue_id_key').on(table.dialogue_id),
    index('idx_harness_dialogue_usage_topic').using(
      'btree',
      table.topic_id.asc().nullsLast().op('int4_ops')
    ),
    index('idx_harness_dialogue_usage_workspace').using(
      'btree',
      table.workspace_id.asc().nullsLast().op('int4_ops'),
      table.created_at.asc().nullsLast().op('timestamp_ops')
    ),
    foreignKey({
      columns: [table.workspace_id],
      foreignColumns: [workspace.id],
      name: 'harness_dialogue_usage_workspace_id_fkey'
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.topic_id],
      foreignColumns: [harness_topic.id],
      name: 'harness_dialogue_usage_topic_id_fkey'
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.dialogue_id],
      foreignColumns: [harness_dialogue.id],
      name: 'harness_dialogue_usage_dialogue_id_fkey'
    }).onDelete('cascade')
  ]
)
