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

/** 定时任务触发规则种类（对应 scheduled_tasks_when_kind_check） */
export type ScheduleWhenKind = 'once' | 'every' | 'daily'

/** 单次执行状态（对应 runs 表的 check 约束） */
export type ScheduleRunStatusDb = 'completed' | 'cancelled' | 'failed'

/**
 * 定时任务表。
 *
 * 归属：创建时所在的会话（`topic_id`，话题删除随外键级联清理）；`workspace_id` 只是
 * 冗余归属，便于按工作区统计/清理（旧数据可能为 null）。
 *
 * 规则存成 `when_kind` + `when_json` 而不是拆列：三种规则字段差异大（定点 / 间隔 / 每日），
 * 拆列会留下大量空列；读取时由 mapper 反序列化，非法数据按「无规则」跳过。
 */
export const scheduled_tasks = pgTable(
  'scheduled_tasks',
  {
    id: text().primaryKey().notNull(),
    workspace_id: integer(),
    topic_id: integer().notNull(),
    title: text().notNull(),
    prompt: text().notNull(),
    /** once / every / daily */
    when_kind: text().$type<ScheduleWhenKind>().notNull(),
    /** 规则参数（JSON）：{"at":...} / {"minutes":...} / {"time":"HH:MM"} */
    when_json: text().notNull(),
    enabled: boolean().notNull().default(true),
    /** 下一次触发（UTC ISO）；null = 不再触发 */
    next_run_at: timestamp({ mode: 'string' }),
    last_run_at: timestamp({ mode: 'string' }),
    /** completed / cancelled / failed（null = 从未执行） */
    last_status: text().$type<ScheduleRunStatusDb>(),
    created_at: timestamp({ mode: 'string' }).defaultNow(),
    updated_at: timestamp({ mode: 'string' }).defaultNow()
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
    check(
      'scheduled_tasks_when_kind_check',
      sql`${table.when_kind} in ('once', 'every', 'daily')`
    ),
    check(
      'scheduled_tasks_last_status_check',
      sql`${table.last_status} is null or ${table.last_status} in ('completed', 'cancelled', 'failed')`
    )
  ]
)

/**
 * 定时任务执行记录（**永久保存**，不裁剪）。
 *
 * 只追加、不更新；按 `task_id` 查历史（`ran_at` 倒序分页）。任务删除时随外键级联清理。
 */
export const scheduled_task_runs = pgTable(
  'scheduled_task_runs',
  {
    id: serial().primaryKey().notNull(),
    task_id: text().notNull(),
    /** completed / cancelled / failed */
    status: text().$type<ScheduleRunStatusDb>().notNull(),
    ran_at: timestamp({ mode: 'string' }).notNull(),
    /** 失败原因等补充信息（成功/取消通常为空） */
    detail: text()
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
