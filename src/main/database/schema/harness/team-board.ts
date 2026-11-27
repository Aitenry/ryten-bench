import { foreignKey, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { harness_topic } from './harness'

/**
 * Agent Teams 共享任务板的持久化快照（每个话题一行）。
 *
 * 为什么整板一行而不是一任务一行：
 * - 任务板上限 200 条、单条很小，整板覆盖写比 200 行 upsert 简单可靠，也天然与 IPC
 *   的「整板快照 + revision」协议同构；
 * - 删除是 tombstone（status='deleted'），保留在 JSON 里避免 id/counter 复用歧义；
 * - 与 DSH 把 `team/task` 事件写进 lead Session 日志不同：RytenBench 还没有会话日志设施，
 *   这里先做到「重启后任务板不丢」，事件化留到需要回放/审计时再演进。
 */
export const team_board = pgTable(
  'team_board',
  {
    topic_id: integer().primaryKey().notNull(),
    /** 与内存 Board.revision 对齐：每次变更 +1 */
    revision: integer().notNull().default(0),
    /** 任务 id 计数器（task-<n>） */
    counter: integer().notNull().default(0),
    /** JSON：TeamTask[]（含 deleted tombstone） */
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
