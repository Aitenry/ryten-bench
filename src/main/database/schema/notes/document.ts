import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  index,
  foreignKey,
  unique
} from 'drizzle-orm/pg-core'
// Migration note: the core `images` table (shared by document images) is imported with a
// **relative path** because drizzle-kit does not resolve tsconfig paths; the notes' own tables are
// aggregated by core's database/schema/index.ts via reverse re-export.
import { images } from '../common'
import { wiki_directories } from './wiki'

/** Documents table (global data, not isolated per workspace) */
export const documents = pgTable(
  'documents',
  {
    id: serial().primaryKey().notNull(),
    title: text().notNull(),
    summary: text(),
    tags: text(),
    created_at: timestamp({ mode: 'string' }).defaultNow(),
    updated_at: timestamp({ mode: 'string' }).defaultNow()
  },
  (table) => [
    index('idx_documents_created_at').using(
      'btree',
      table.created_at.asc().nullsLast().op('timestamp_ops')
    ),
    index('idx_documents_title').using('btree', table.title.asc().nullsLast().op('text_ops')),
    index('idx_documents_updated_at').using(
      'btree',
      table.updated_at.asc().nullsLast().op('timestamp_ops')
    )
  ]
)

/**
 * Document content table: one-to-one with documents (doc_id is unique); images in the content
 * reference images via the image_id foreign key
 */
export const documents_content = pgTable(
  'documents_content',
  {
    id: serial().primaryKey().notNull(),
    doc_id: integer().notNull(),
    image_id: text(),
    content: text(),
    chunk_key: text(),
    created_at: timestamp({ mode: 'string' }).defaultNow(),
    updated_at: timestamp({ mode: 'string' }).defaultNow()
  },
  (table) => [
    foreignKey({
      columns: [table.image_id],
      foreignColumns: [images.id],
      name: 'documents_content_image_id_fkey'
    }),
    foreignKey({
      columns: [table.doc_id],
      foreignColumns: [documents.id],
      name: 'documents_content_doc_id_fkey'
    }).onDelete('cascade'),
    unique('documents_content_doc_id_key').on(table.doc_id)
  ]
)

/**
 * Directory-document link table: attaches global documents under knowledge base directories
 * (a document can be attached to the same directory only once)
 */
export const directory_documents = pgTable(
  'directory_documents',
  {
    id: serial().primaryKey().notNull(),
    directory_id: integer().notNull(),
    doc_id: integer().notNull(),
    sort_order: integer().default(0),
    created_at: timestamp({ mode: 'string' }).defaultNow()
  },
  (table) => [
    index('idx_directory_documents_dir').using(
      'btree',
      table.directory_id.asc().nullsLast().op('int4_ops')
    ),
    index('idx_directory_documents_doc').using(
      'btree',
      table.doc_id.asc().nullsLast().op('int4_ops')
    ),
    foreignKey({
      columns: [table.directory_id],
      foreignColumns: [wiki_directories.id],
      name: 'directory_documents_directory_id_fkey'
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.doc_id],
      foreignColumns: [documents.id],
      name: 'directory_documents_doc_id_fkey'
    }).onDelete('cascade'),
    unique('directory_documents_directory_id_doc_id_key').on(table.doc_id, table.directory_id)
  ]
)
