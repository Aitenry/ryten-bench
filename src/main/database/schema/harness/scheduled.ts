import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { harness_topic } from './harness'

/** Kinds of scheduled task triggers (corresponds to scheduled_tasks_when_kind_check) */
export type ScheduleWhenKind = 'once' | 'every' | 'daily'

/** Single run status (corresponds to the runs table check constraint) */
export type ScheduleRunStatusDb = 'completed' | 'cancelled' | 'failed'

/**
 * Scheduled task table.
 *
 * Ownership: the session in which the task was created (`topic_id`; deleting the topic cascades via
 * the foreign key); `workspace_id` is only a redundant owner, for per-workspace statistics and
 * cleanup (may be null in old data).
 *
 * Rules are stored as `when_kind` + `when_json` instead of separate columns: the three rule kinds
 * (fixed time / interval / daily) have very different fields, and separate columns would leave many
 * empty ones; the mapper deserializes them on read, and invalid data is skipped as "no rule".
 */
export const scheduled_tasks = pgTable(
  'scheduled_tasks',
  {
    id: text().primaryKey().notNull(),
    workspace_id: integer(),
    /**
     * Target session (null = create a new session on each trigger, see target_mode /
     * target_workspace_id).
     * Deleting the session deletes the task via cascade; new-session tasks bind no specific topic.
     */
    topic_id: integer(),
    /**
     * Target mode (chat / work / plugin): tasks are not bound to the mode active at creation time,
     * so sessions can be picked across modes.
     * null = old data (runs in the mode of topic_id).
     */
    target_mode: text().$type<'chat' | 'work' | 'plugin'>(),
    /** Target workspace for new-session tasks (chat mode = chat root workspace; plugin mode = plugin workspace) */
    target_workspace_id: integer(),
    /** Memory scope string for new-session tasks (chat / plugin:<id> / null = workspace) */
    target_memory_scope: text(),
    /** Task-level run selection (JSON: {tools,skills,mcpTools}; null = follow the session/defaults) */
    agent_config: text(),
    /**
     * Model override for every run, in the same `provider:model` form as subagent configs.
     * null = use the default provider (see `resolveScheduledProviderId`); a spec that no longer
     * matches an enabled provider also falls back to the default instead of failing the run.
     */
    model: text(),
    title: text().notNull(),
    prompt: text().notNull(),
    /** once / every / daily */
    when_kind: text().$type<ScheduleWhenKind>().notNull(),
    /** Rule parameters (JSON): {"at":...} / {"minutes":...} / {"time":"HH:MM"} */
    when_json: text().notNull(),
    enabled: boolean().notNull().default(true),
    /** Next trigger (UTC ISO); null = no longer triggers */
    next_run_at: timestamp({ withTimezone: true, mode: 'string' }),
    last_run_at: timestamp({ withTimezone: true, mode: 'string' }),
    /** completed / cancelled / failed (null = never run) */
    last_status: text().$type<ScheduleRunStatusDb>(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow()
  },
  (table) => [
    index('idx_scheduled_tasks_topic').using(
      'btree',
      table.topic_id.asc().nullsLast().op('int4_ops')
    ),
    index('idx_scheduled_tasks_next_run').using(
      'btree',
      table.next_run_at.asc().nullsLast().op('timestamp_ops')
    ),
    foreignKey({
      columns: [table.topic_id],
      foreignColumns: [harness_topic.id],
      name: 'scheduled_tasks_topic_id_fkey'
    }).onDelete('cascade'),
    check('scheduled_tasks_when_kind_check', sql`${table.when_kind} in ('once', 'every', 'daily')`),
    check(
      'scheduled_tasks_last_status_check',
      sql`${table.last_status} is null or ${table.last_status} in ('completed', 'cancelled', 'failed')`
    ),
    check(
      'scheduled_tasks_target_mode_check',
      sql`${table.target_mode} is null or ${table.target_mode} in ('chat', 'work', 'plugin')`
    )
  ]
)

/**
 * Scheduled task run records (**kept forever**, never pruned).
 *
 * Append-only; history is queried by `task_id` (paginated by `ran_at` descending). Deleting a task
 * clears them via foreign key cascade.
 */
export const scheduled_task_runs = pgTable(
  'scheduled_task_runs',
  {
    id: serial().primaryKey().notNull(),
    task_id: text().notNull(),
    /** completed / cancelled / failed */
    status: text().$type<ScheduleRunStatusDb>().notNull(),
    ran_at: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    /** Extra information such as the failure reason (usually empty for success/cancel) */
    detail: text(),
    /** Conversation this run executed in (new-session tasks create a fresh topic per run) */
    topic_id: integer(),
    /** Assistant dialogue row produced by this run (null when it produced no reply) */
    dialogue_id: integer(),
    /** Token usage of the turn (JSON: {inputTokens,outputTokens,totalTokens,durationMs}) */
    usage_json: text(),
    /** Tool steps of the turn in order (JSON: [{name,path,status}]) */
    steps_json: text(),
    /** Files this run wrote / delivered (JSON: [{kind,path,description}]) */
    artifacts_json: text()
  },
  (table) => [
    index('idx_scheduled_task_runs_task').using(
      'btree',
      table.task_id.asc().nullsLast().op('text_ops'),
      table.ran_at.asc().nullsLast().op('timestamp_ops')
    ),
    foreignKey({
      columns: [table.task_id],
      foreignColumns: [scheduled_tasks.id],
      name: 'scheduled_task_runs_task_id_fkey'
    }).onDelete('cascade'),
    check(
      'scheduled_task_runs_status_check',
      sql`${table.status} in ('completed', 'cancelled', 'failed')`
    )
  ]
)
