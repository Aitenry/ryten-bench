import { pgTable, serial, text, timestamp, real, unique } from 'drizzle-orm/pg-core'

/**
 * Images table: primary key is md5(dataUrl), data holds the full data URL.
 * documents_content / wiki / music_folders / music_tracks reference it via the image_id foreign key.
 */
export const images = pgTable('images', {
  id: text().primaryKey().notNull(),
  data: text().notNull(),
  created_at: timestamp({ mode: 'string' }).defaultNow()
})

/** Canvas node position table (global; records x/y per node_id) */
export const node_positions = pgTable('node_positions', {
  node_id: text().primaryKey().notNull(),
  x: real().default(0).notNull(),
  y: real().default(0).notNull(),
  updated_at: timestamp({ mode: 'string' }).defaultNow()
})

/**
 * Early hand-written migration record table (created by 001_schema_migrations.sql).
 * Current code never reads or writes it; it is kept only for compatibility with old databases and
 * so the baseline migration does not drop the table.
 */
export const schema_migrations = pgTable(
  'schema_migrations',
  {
    id: serial().primaryKey().notNull(),
    script_name: text().notNull(),
    executed_at: timestamp({ mode: 'string' }).defaultNow(),
    version: text(),
    description: text()
  },
  (table) => [unique('schema_migrations_script_name_key').on(table.script_name)]
)
