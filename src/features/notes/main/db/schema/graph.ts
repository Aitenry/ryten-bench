import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  real,
  index,
  foreignKey,
  unique
} from 'drizzle-orm/pg-core'
// 迁移说明：图谱表挂在知识库下（同一插件，同目录内相对 import）
import { wiki } from './wiki'

/** 图谱构建任务状态 */
export type GraphBuildJobStatus = 'pending' | 'running' | 'completed' | 'failed'

/** 知识图谱实体表：挂在知识库下，aliases / properties / source_note_ids 为 JSON 字符串 */
export const graph_entities = pgTable(
  'graph_entities',
  {
    id: serial().primaryKey().notNull(),
    wiki_id: integer().notNull(),
    name: text().notNull(),
    type: text().notNull(),
    description: text(),
    aliases: text(),
    properties: text(),
    confidence: real().default(1),
    source_note_ids: text(),
    created_at: timestamp({ mode: 'string' }).defaultNow(),
    updated_at: timestamp({ mode: 'string' }).defaultNow()
  },
  (table) => [
    index('idx_graph_entities_name').using('btree', table.name.asc().nullsLast().op('text_ops')),
    index('idx_graph_entities_type').using('btree', table.type.asc().nullsLast().op('text_ops')),
    index('idx_graph_entities_wiki').using('btree', table.wiki_id.asc().nullsLast().op('int4_ops')),
    foreignKey({
      columns: [table.wiki_id],
      foreignColumns: [wiki.id],
      name: 'graph_entities_wiki_id_fkey'
    }).onDelete('cascade')
  ]
)

/** 知识图谱关系表：source/target 均指向实体，删除实体时级联删除 */
export const graph_relations = pgTable(
  'graph_relations',
  {
    id: serial().primaryKey().notNull(),
    wiki_id: integer().notNull(),
    source_id: integer().notNull(),
    target_id: integer().notNull(),
    relation_type: text().notNull(),
    description: text(),
    properties: text(),
    confidence: real().default(1),
    source_note_ids: text(),
    created_at: timestamp({ mode: 'string' }).defaultNow()
  },
  (table) => [
    index('idx_graph_relations_source').using(
      'btree',
      table.source_id.asc().nullsLast().op('int4_ops')
    ),
    index('idx_graph_relations_target').using(
      'btree',
      table.target_id.asc().nullsLast().op('int4_ops')
    ),
    index('idx_graph_relations_wiki').using(
      'btree',
      table.wiki_id.asc().nullsLast().op('int4_ops')
    ),
    foreignKey({
      columns: [table.wiki_id],
      foreignColumns: [wiki.id],
      name: 'graph_relations_wiki_id_fkey'
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.source_id],
      foreignColumns: [graph_entities.id],
      name: 'graph_relations_source_id_fkey'
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.target_id],
      foreignColumns: [graph_entities.id],
      name: 'graph_relations_target_id_fkey'
    }).onDelete('cascade')
  ]
)

/** 图谱构建任务表：每个知识库最多一个任务（uq_graph_build_jobs_wiki），config / processed_note_ids 为 JSON 字符串 */
export const graph_build_jobs = pgTable(
  'graph_build_jobs',
  {
    id: serial().primaryKey().notNull(),
    wiki_id: integer().notNull(),
    status: text().$type<GraphBuildJobStatus>().default('pending').notNull(),
    total_notes: integer().default(0),
    processed_notes: integer().default(0),
    entity_count: integer().default(0),
    relation_count: integer().default(0),
    error_message: text(),
    config: text(),
    processed_note_ids: text(),
    started_at: timestamp({ mode: 'string' }),
    completed_at: timestamp({ mode: 'string' }),
    created_at: timestamp({ mode: 'string' }).defaultNow()
  },
  (table) => [
    foreignKey({
      columns: [table.wiki_id],
      foreignColumns: [wiki.id],
      name: 'graph_build_jobs_wiki_id_fkey'
    }).onDelete('cascade'),
    unique('uq_graph_build_jobs_wiki').on(table.wiki_id)
  ]
)
