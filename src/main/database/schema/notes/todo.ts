import {
  pgTable,
  serial,
  text,
  timestamp,
  date,
  integer,
  index,
  foreignKey,
  unique
} from 'drizzle-orm/pg-core'

// 迁移说明：本文件原为 src/main/database/schema/todo.ts，迁到 notes 插件后由 core 的
// database/schema/index.ts 用相对路径 re-export（表结构未改，纯搬家）。

/** 待办事项表（全局数据，不按工作区隔离） */
export const todo_items = pgTable(
  'todo_items',
  {
    id: serial().primaryKey().notNull(),
    title: text().notNull(),
    /** 正文内容（Markdown，与文档正文同源：在待办页内联编辑器里编辑，不再走弹窗） */
    content: text(),
    due_date: date(),
    priority: integer().default(0),
    status: integer().default(0),
    category: text(),
    created_at: timestamp({ mode: 'string' }).defaultNow(),
    updated_at: timestamp({ mode: 'string' }).defaultNow(),
    started_at: timestamp({ mode: 'string' }),
    completed_at: timestamp({ mode: 'string' })
  },
  (table) => [
    index('idx_todo_category').using('btree', table.category.asc().nullsLast().op('text_ops')),
    index('idx_todo_created_at').using(
      'btree',
      table.created_at.asc().nullsLast().op('timestamp_ops')
    ),
    index('idx_todo_due_date').using('btree', table.due_date.asc().nullsLast().op('date_ops')),
    index('idx_todo_priority').using('btree', table.priority.asc().nullsLast().op('int4_ops')),
    index('idx_todo_status').using('btree', table.status.asc().nullsLast().op('int4_ops'))
  ]
)

/** 待办依赖关系表（甘特图 / 前置任务）；依赖已删除任务的行会被 INNER JOIN 过滤掉 */
export const task_dependencies = pgTable(
  'task_dependencies',
  {
    id: serial().primaryKey().notNull(),
    task_id: integer().notNull(),
    depends_on_task_id: integer().notNull(),
    created_at: timestamp({ mode: 'string' }).defaultNow()
  },
  (table) => [
    index('idx_task_deps_depends_on').using(
      'btree',
      table.depends_on_task_id.asc().nullsLast().op('int4_ops')
    ),
    index('idx_task_deps_task').using('btree', table.task_id.asc().nullsLast().op('int4_ops')),
    foreignKey({
      columns: [table.task_id],
      foreignColumns: [todo_items.id],
      name: 'task_dependencies_task_id_fkey'
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.depends_on_task_id],
      foreignColumns: [todo_items.id],
      name: 'task_dependencies_depends_on_task_id_fkey'
    }).onDelete('cascade'),
    unique('task_dependencies_task_id_depends_on_task_id_key').on(
      table.task_id,
      table.depends_on_task_id
    )
  ]
)
