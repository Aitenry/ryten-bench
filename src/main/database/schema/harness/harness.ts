import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  boolean,
  index,
  foreignKey,
  check,
  unique
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { workspace } from '../workspace'

/** Lifecycle phase of a session goal (corresponds to the harness_goals_phase_check constraint) */
export type GoalPhase = 'active' | 'paused' | 'blocked' | 'complete'

/** Dialogue role (corresponds to the harness_dialogue_role_check constraint) */
export type HarnessRole = 'user' | 'assistant'

/** Session (topic) table: isolated per workspace; deleting a workspace cascades the delete */
export const harness_topic = pgTable(
  'harness_topic',
  {
    id: serial().primaryKey().notNull(),
    workspace_id: integer().notNull(),
    title: text().notNull(),
    model: text(),
    selected_tools: text(),
    /**
     * Memory scope: empty = follow the workspace (`<memoryPath>/workspace-<id>/`);
     * `plugin:<plugin id>` = this plugin's own memory (`<memoryPath>/plugin-<id>/`, see
     * main/memory-scope.ts).
     * Topics created via the plugin row's "+ New session" write this value, so reopening the
     * session still uses its own memory.
     */
    memory_scope: text(),
    created_at: timestamp({ mode: 'string' }).defaultNow(),
    updated_at: timestamp({ mode: 'string' }).defaultNow(),
    /**
     * Pinned time (null = not pinned). The list orders pinned items first, the rest by activity
     * time; pinning/unpinning **does not touch updated_at**: that is the activity time, and after
     * unpinning the item must return to its original position.
     */
    pinned_at: timestamp({ mode: 'string' }),
    /**
     * Archive time (null = not archived). Archived sessions move from the main session list into
     * the "Archived" group without deleting data; updated_at is likewise untouched (unarchiving
     * returns the session to its original position).
     */
    archived_at: timestamp({ mode: 'string' }),
    /**
     * Plan mode: persisted per topic, so it survives a restart.
     *
     * When active, the topic's system prompt gains a planning guidance section and an extra
     * exit_plan_mode tool is provided: the model first explores and designs, hands the plan to the
     * user for review, and only continues after approval. It only affects the prompt and tool set,
     * not the permission level (sandboxing and approval work as usual).
     */
    plan_mode: boolean().notNull().default(false),

    /** Agent Teams collaboration toggle (opt-in): when off, team_task_* tools and the team prompt section are not injected */
    team_mode: boolean().notNull().default(false)
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

/** Dialogue record table: role only allows user / assistant */
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
 * Session goal (long-running task) table: one row per topic.
 * Note: this table and topic_compactions both lack foreign key cascades, so deleting a
 * workspace/topic requires explicitly cleaning up by topic_id inside a transaction.
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

/** Context compaction checkpoint: one row per topic, recording the last dialogue id of the summarized span and the summary text */
export const topic_compactions = pgTable('topic_compactions', {
  topic_id: integer().primaryKey().notNull(),
  boundary_id: integer().notNull(),
  summary: text().notNull(),
  created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull()
})

/**
 * Dialogue usage table: **one row per assistant reply** (dialogue_id unique).
 *
 * Written after the assistant message is persisted (the stream finalization in ipc/harness.ts);
 * the data comes from the usage_metadata returned by each model call. One dialogue round may
 * involve multiple model round-trips (tool loop), so:
 *  - input/output/total_tokens are **whole-round aggregates**, for statistics by workspace and by
 *    model;
 *  - usage_metadata stores the **raw per-call detail JSON array**, preserving each vendor's
 *    different fields (reasoning_tokens / cached tokens / audio tokens…); the frontend reads it
 *    directly when it needs details.
 *
 * Design tradeoffs:
 *  - workspace_id / topic_id / dialogue_id are all foreign keys: deleting a workspace, topic, or
 *    message cascades the cleanup;
 *  - provider_id has **no foreign key** (snapshot only): provider configs may be deleted or renamed,
 *    but "who spent what, with which model, on this reply" is accounting that later changes must
 *    not erase;
 *  - provider stores the **provider tag** used when fetching models (openai / deepseek / anthropic
 *    …), coexisting with provider_id: the former is directly readable, the latter links back to the
 *    provider config.
 */
export const harness_dialogue_usage = pgTable(
  'harness_dialogue_usage',
  {
    id: serial().primaryKey().notNull(),
    /** Owning workspace */
    workspace_id: integer().notNull(),
    /** Session (topic) id */
    topic_id: integer().notNull(),
    /** Dialogue record id: harness_dialogue.id, one row per assistant reply */
    dialogue_id: integer().notNull(),
    /** Provider config id (snapshot, no foreign key) */
    provider_id: integer(),
    /** Provider tag (provider type used when fetching models) */
    provider: text(),
    /** Model name */
    model: text(),
    /** Whole-round input tokens (aggregated) */
    input_tokens: integer(),
    /** Whole-round output tokens (aggregated) */
    output_tokens: integer(),
    /** Whole-round total tokens (aggregated) */
    total_tokens: integer(),
    /** Number of model calls in this round (the tool loop may call several times) */
    calls: integer().default(0),
    /** Raw per-call usage_metadata details (JSON array) */
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
