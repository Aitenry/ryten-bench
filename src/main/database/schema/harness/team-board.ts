import { foreignKey, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { harness_topic } from './harness'

/**
 * Persisted snapshot of the Agent Teams shared task board (one row per topic).
 *
 * Why one row for the whole board instead of one row per task:
 * - The board is capped at 200 small tasks, so overwriting the whole board is simpler and more
 *   reliable than a 200-row upsert, and it naturally mirrors the IPC "whole-board snapshot +
 *   revision" protocol;
 * - Deletion uses tombstones (status='deleted') kept in the JSON to avoid id/counter reuse
 *   ambiguity;
 * - Unlike logging `team/task` events into the lead Session log, RytenBench has no session log
 *   facility yet: for now it only guarantees the board survives a restart, and event logging can
 *   come later when replay/audit is needed.
 */
export const team_board = pgTable(
  'team_board',
  {
    topic_id: integer().primaryKey().notNull(),
    /** Aligned with the in-memory Board.revision: incremented on every change */
    revision: integer().notNull().default(0),
    /** Task id counter (task-<n>) */
    counter: integer().notNull().default(0),
    /** JSON: TeamTask[] (including deleted tombstones) */
    tasks: text().notNull(),
    updated_at: timestamp({ mode: 'string' }).defaultNow()
  },
  (table) => [
    foreignKey({
      columns: [table.topic_id],
      foreignColumns: [harness_topic.id],
      name: 'team_board_topic_id_fkey'
    }).onDelete('cascade')
  ]
)
