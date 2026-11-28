import { pgTable, serial, text, timestamp, integer, index, foreignKey } from 'drizzle-orm/pg-core'
// Migration note: the core `images` table (shared by knowledge base covers) is imported with a relative path (drizzle-kit does not resolve paths)
import { images } from '../common'

/** Knowledge base table (global data, not isolated per workspace) */
export const wiki = pgTable(
  'wiki',
  {
    id: serial().primaryKey().notNull(),
    title: text().notNull(),
    summary: text(),
    tags: text(),
    image_id: text(),
    created_at: timestamp({ mode: 'string' }).defaultNow(),
    updated_at: timestamp({ mode: 'string' }).defaultNow()
  },
  (table) => [
    index('idx_wiki_created_at').using(
      'btree',
      table.created_at.asc().nullsLast().op('timestamp_ops')
    ),
    index('idx_wiki_title').using('btree', table.title.asc().nullsLast().op('text_ops')),
    foreignKey({
      columns: [table.image_id],
      foreignColumns: [images.id],
      name: 'wiki_image_id_fkey'
    })
  ]
)

/**
 * Knowledge base directory table: parent_id self-references to form a tree; deleting a knowledge
 * base cascades the delete
 */
export const wiki_directories = pgTable(
  'wiki_directories',
  {
    id: serial().primaryKey().notNull(),
    wiki_id: integer().notNull(),
    parent_id: integer(),
    name: text().notNull(),
    sort_order: integer().default(0),
    level: integer().default(0),
    created_at: timestamp({ mode: 'string' }).defaultNow(),
    updated_at: timestamp({ mode: 'string' }).defaultNow()
  },
  (table) => [
    index('idx_wiki_directories_sort_order').using(
      'btree',
      table.sort_order.asc().nullsLast().op('int4_ops')
    ),
    index('idx_wiki_directories_wiki_parent').using(
      'btree',
      table.wiki_id.asc().nullsLast().op('int4_ops'),
      table.parent_id.asc().nullsLast().op('int4_ops')
    ),
    foreignKey({
      columns: [table.wiki_id],
      foreignColumns: [wiki.id],
      name: 'wiki_directories_wiki_id_fkey'
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.parent_id],
      foreignColumns: [table.id],
      name: 'wiki_directories_parent_id_fkey'
    }).onDelete('cascade')
  ]
)
