import { boolean, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * Tables for ${vars.title}.
 *
 * - Table names must carry **this plugin's prefix** (`${vars.sqlName}_`): a single database holds
 *   the tables of every plugin, so a name collision is a serious incident;
 * - Column names are snake_case (same convention as the host); this file is the single source of
 *   truth for row types (`$inferSelect`);
 * - The DDL lives in `./ddl.ts` (a standalone plugin owns its own DDL; the host knows nothing
 *   about this table).
 */
export const ${vars.itemsToolName} = pgTable('${vars.itemsToolName}', {
  id: serial().primaryKey().notNull(),
  title: text().notNull(),
  note: text(),
  done: boolean().default(false),
  created_at: timestamp({ mode: 'string' }).defaultNow(),
  updated_at: timestamp({ mode: 'string' }).defaultNow()
})

/** One row (internal to the mapper; always converted to the shared/types.ts DTO across processes) */
export type ${vars.pascal}ItemRow = typeof ${vars.itemsToolName}.$inferSelect
