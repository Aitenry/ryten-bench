import { foreignKey, index, integer, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core'
import { harness_topic } from './harness'

/**
 * Agent Teams 任务事件日志（追加写，按话题）。
 *
 * 与 `team_board` 的关系：`team_board` 是可恢复的**当前快照**，本表是**发生过什么**的
 * 追加事件（created / claimed / completed / updated / deleted），用于在协作面板展示最近
 * 活动、以及后续做审计/回放。两者都由任务板存储适配器在系统启动时装配写入。
 *
 * 不参与任务板状态重建（快照已经够用）；事件表体量很小（每个任务几次变更），
 * 话题删除时由外键级联清理。
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
    /** 事件发生时任务标题（任务行可能后续改名/删除，快照文案仍可读） */
    subject: text().notNull(),
    /** 事件发生时任务 revision（与任务板 CAS 对齐，便于排查并发） */
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
