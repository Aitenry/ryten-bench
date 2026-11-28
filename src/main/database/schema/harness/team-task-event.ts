import { foreignKey, index, integer, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core'
import { harness_topic } from './harness'

/**
 * Agent Teams task event log (append-only, per topic).
 *
 * Relation to `team_board`: `team_board` is the recoverable **current snapshot**, while this table
 * is the append-only event log of **what happened** (created / claimed / completed / updated /
 * deleted), used to show recent activity in the collaboration panel and for later audit/replay.
 * Both are assembled and written by the task board storage adapter at system startup.
 *
 * It is not used to rebuild task board state (the snapshot is sufficient); the event table stays
 * small (a few changes per task), and rows are removed via foreign key cascade when the topic is
 * deleted.
 */
export const team_task_event = pgTable(
  'team_task_event',
  {
    id: serial().primaryKey().notNull(),
    topic_id: integer().notNull(),
    task_id: text().notNull(),
    /** created / claimed / completed / updated / deleted */
    action: text().notNull(),
    actor_id: text().notNull(),
    actor_name: text().notNull(),
    /**
     * Task title at the time of the event (the task row may later be renamed/deleted, but the
     * snapshot text remains readable)
     */
    subject: text().notNull(),
    /**
     * Task revision at the time of the event (aligned with task board CAS, helps debug
     * concurrency)
     */
    task_revision: integer().notNull().default(0),
    created_at: timestamp({ mode: 'string' }).defaultNow()
  },
  (table) => [
    index('idx_team_task_event_topic').using(
      'btree',
      table.topic_id.asc().nullsLast().op('int4_ops'),
      table.id.asc().nullsLast().op('int4_ops')
    ),
    foreignKey({
      columns: [table.topic_id],
      foreignColumns: [harness_topic.id],
      name: 'team_task_event_topic_id_fkey'
    }).onDelete('cascade')
  ]
)
