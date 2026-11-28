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

// Migration note: this file used to be src/main/database/schema/todo.ts; after moving to the notes
// plugin it is re-exported by core's database/schema/index.ts with a relative path (table structure
// unchanged, pure move).

/** Todo item table (global data, not isolated per workspace) */
export const todo_items = pgTable(
  'todo_items',
  {
    id: serial().primaryKey().notNull(),
    title: text().notNull(),
    /**
     * Body content (Markdown, same source as document bodies: edited in the inline editor on the
     * todo page, no longer via a dialog)
     */
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

/**
 * Todo dependency table (Gantt chart / predecessor tasks); rows depending on deleted tasks are
 * filtered out by the INNER JOIN
 */
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
