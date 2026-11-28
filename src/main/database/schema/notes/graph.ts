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
// Migration note: graph tables belong to the knowledge base (same plugin, relative import within the same directory)
import { wiki } from './wiki'

/** Graph build job status */
export type GraphBuildJobStatus = 'pending' | 'running' | 'completed' | 'failed'

/**
 * Knowledge graph entity table: belongs to the knowledge base; aliases / properties /
 * source_note_ids are JSON strings
 */
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

/**
 * Knowledge graph relation table: source/target both point at entities; deleting an entity
 * cascades the delete
 */
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
    // Business unique key for relations: a knowledge base should have only one row per
    // (source, target, relation_type). It enables a true single-statement upsert (ON CONFLICT) and
    // prevents concurrent builds from writing duplicate relations.
    unique('uq_graph_relations_key').on(
      table.wiki_id,
      table.source_id,
      table.target_id,
      table.relation_type
    ),
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

/**
 * Graph build job table: at most one job per knowledge base (uq_graph_build_jobs_wiki);
 * config / processed_note_ids are JSON strings
 */
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
