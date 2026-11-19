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
// 迁移说明：core 的 images 表（文档配图共用）用**相对路径** import——drizzle-kit 不解析
// tsconfig paths；notes 自己的表由 core 的 database/schema/index.ts 反向 re-export 汇总。
import { images } from '../../../../../main/database/schema/common'
import { wiki_directories } from './wiki'

/** 文档表（全局数据，不按工作区隔离） */
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

/** 文档正文表：与 documents 一对一（doc_id 唯一），正文里的配图以 image_id 外键指向 images */
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

/** 目录-文档关联表：把全局文档挂到知识库目录下（同一目录同一文档只能挂一次） */
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
