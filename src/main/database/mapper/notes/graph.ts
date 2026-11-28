import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm'
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core'
import { withOrm } from '../../orm'
import { graph_build_jobs, graph_entities, graph_relations } from '../../schema'

// --- Type definitions (all inferred from the schema) ---

export type GraphEntity = typeof graph_entities.$inferSelect
export type GraphRelation = typeof graph_relations.$inferSelect
export type GraphBuildJob = typeof graph_build_jobs.$inferSelect

export interface GraphData {
  entities: GraphEntity[]
  relations: GraphRelation[]
}

/** Ensure a valid JSON array string is written to source_note_ids */
function toSourceNoteIds(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return typeof value === 'string' ? value : JSON.stringify(value)
}

// ==================== Entity CRUD ====================

/** Only show entities whose source documents are still in this knowledge base's directories (jsonb expansion cannot be expressed by the builder, so raw SQL is kept) */
function entitySourceInWiki(wikiId: number): SQL {
  return sql`
    EXISTS (
      SELECT 1 FROM jsonb_array_elements(ge.source_note_ids::jsonb) src
      WHERE (src)::int IN (
        SELECT dd.doc_id FROM directory_documents dd
        JOIN wiki_directories wd ON wd.id = dd.directory_id
        WHERE wd.wiki_id = ${wikiId}
      )
    )
  `
}

async function getEntitiesByWikiId(
  wikiId: number,
  typeFilter?: string,
  noteIds?: number[]
): Promise<GraphEntity[]> {
  return withOrm('getEntitiesByWikiId', async (db) => {
    // Always filter to only show entities whose source docs are still in this wiki
    const typeCondition = typeFilter ? sql` AND ge.type = ${typeFilter}` : sql``
    const noteCondition =
      noteIds && noteIds.length > 0
        ? sql` AND EXISTS (
              SELECT 1 FROM jsonb_array_elements(ge.source_note_ids::jsonb) a
              CROSS JOIN jsonb_array_elements(${JSON.stringify(noteIds)}::jsonb) b
              WHERE a = b
            )`
        : sql``

    const result = await db.execute<GraphEntity>(sql`
      SELECT ge.* FROM graph_entities ge
      WHERE ge.wiki_id = ${wikiId}
      AND ${entitySourceInWiki(wikiId)}
      ${typeCondition}
      ${noteCondition}
      ORDER BY ge.name
    `)
    return result.rows
  })
}

async function getEntityById(id: number): Promise<GraphEntity | null> {
  return withOrm('getEntityById', async (db) => {
    const rows = await db.select().from(graph_entities).where(eq(graph_entities.id, id)).limit(1)
    return rows[0] ?? null
  })
}

async function searchEntities(wikiId: number, query: string): Promise<GraphEntity[]> {
  return withOrm('searchEntities', async (db) => {
    // Escape LIKE wildcards (fix: searches containing %/_/\ were wrongly broadened; normal
    // characters should be treated literally)
    const escaped = query.replace(/[\\%_]/g, (m) => `\\${m}`)
    const pattern = `%${escaped}%`
    return db
      .select()
      .from(graph_entities)
      .where(
        and(
          eq(graph_entities.wiki_id, wikiId),
          or(
            ilike(graph_entities.name, pattern),
            ilike(graph_entities.aliases, pattern),
            // Also search descriptions: users often remember "the company that does RAG" rather
            // than the entity name
            ilike(graph_entities.description, pattern)
          )
        )
      )
      .orderBy(asc(graph_entities.name))
  })
}

async function upsertEntity(
  entity: Omit<GraphEntity, 'id' | 'created_at' | 'updated_at'>
): Promise<number> {
  return withOrm('upsertEntity', async (db) => {
    // Try to find existing entity by name within same wiki
    const existing = await db
      .select({ id: graph_entities.id })
      .from(graph_entities)
      .where(and(eq(graph_entities.wiki_id, entity.wiki_id), eq(graph_entities.name, entity.name)))
      .limit(1)

    if (existing.length > 0) {
      const id = existing[0].id
      await db
        .update(graph_entities)
        .set({
          type: entity.type,
          description: entity.description,
          aliases: entity.aliases,
          properties: entity.properties,
          confidence: entity.confidence,
          source_note_ids: entity.source_note_ids,
          updated_at: sql`now()`
        })
        .where(eq(graph_entities.id, id))
      return id
    }

    const rows = await db.insert(graph_entities).values(entity).returning({ id: graph_entities.id })
    return rows[0].id
  })
}

async function updateEntity(
  id: number,
  updates: Partial<Omit<GraphEntity, 'id' | 'created_at' | 'updated_at'>>
): Promise<boolean> {
  return withOrm('updateEntity', async (db) => {
    const patch: PgUpdateSetSource<typeof graph_entities> = {}
    if (updates.wiki_id !== undefined) patch.wiki_id = updates.wiki_id
    if (updates.name !== undefined) patch.name = updates.name
    if (updates.type !== undefined) patch.type = updates.type
    if (updates.description !== undefined) patch.description = updates.description
    if (updates.aliases !== undefined) patch.aliases = updates.aliases
    if (updates.properties !== undefined) patch.properties = updates.properties
    if (updates.confidence !== undefined) patch.confidence = updates.confidence
    if (updates.source_note_ids !== undefined) patch.source_note_ids = updates.source_note_ids

    if (Object.keys(patch).length === 0) return false

    patch.updated_at = sql`now()`
    const updated = await db
      .update(graph_entities)
      .set(patch)
      .where(eq(graph_entities.id, id))
      .returning({ id: graph_entities.id })
    return updated.length > 0
  })
}

async function deleteEntity(id: number): Promise<boolean> {
  return withOrm('deleteEntity', async (db) => {
    const deleted = await db
      .delete(graph_entities)
      .where(eq(graph_entities.id, id))
      .returning({ id: graph_entities.id })
    return deleted.length > 0
  })
}

async function deleteEntitiesByWikiId(wikiId: number): Promise<number> {
  return withOrm('deleteEntitiesByWikiId', async (db) => {
    const deleted = await db
      .delete(graph_entities)
      .where(eq(graph_entities.wiki_id, wikiId))
      .returning({ id: graph_entities.id })
    return deleted.length
  })
}

// ==================== Relation CRUD ====================

async function getRelationsByWikiId(wikiId: number, noteIds?: number[]): Promise<GraphRelation[]> {
  return withOrm('getRelationsByWikiId', async (db) => {
    // Always filter to only show relations whose source docs are still in this wiki
    const noteCondition =
      noteIds && noteIds.length > 0
        ? sql` AND EXISTS (
              SELECT 1 FROM jsonb_array_elements(gr.source_note_ids::jsonb) a
              CROSS JOIN jsonb_array_elements(${JSON.stringify(noteIds)}::jsonb) b
              WHERE a = b
            )`
        : sql``

    const result = await db.execute<GraphRelation>(sql`
      SELECT gr.* FROM graph_relations gr
      WHERE gr.wiki_id = ${wikiId}
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(gr.source_note_ids::jsonb) src
        WHERE (src)::int IN (
          SELECT dd.doc_id FROM directory_documents dd
          JOIN wiki_directories wd ON wd.id = dd.directory_id
          WHERE wd.wiki_id = ${wikiId}
        )
      )
      ${noteCondition}
    `)
    return result.rows
  })
}

/** Relation unique key: wiki_id + source_id + target_id + relation_type */
function relationKey(
  relation: Pick<GraphRelation, 'wiki_id' | 'source_id' | 'target_id' | 'relation_type'>
): SQL | undefined {
  return and(
    eq(graph_relations.wiki_id, relation.wiki_id),
    eq(graph_relations.source_id, relation.source_id),
    eq(graph_relations.target_id, relation.target_id),
    eq(graph_relations.relation_type, relation.relation_type)
  )
}

async function upsertRelation(relation: Omit<GraphRelation, 'id' | 'created_at'>): Promise<number> {
  return withOrm('upsertRelation', async (db) => {
    const existing = await db
      .select({ id: graph_relations.id })
      .from(graph_relations)
      .where(relationKey(relation))
      .limit(1)

    if (existing.length > 0) {
      const id = existing[0].id
      await db
        .update(graph_relations)
        .set({
          description: relation.description,
          properties: relation.properties,
          confidence: relation.confidence,
          source_note_ids: relation.source_note_ids
        })
        .where(eq(graph_relations.id, id))
      return id
    }

    const rows = await db
      .insert(graph_relations)
      .values(relation)
      .returning({ id: graph_relations.id })
    return rows[0].id
  })
}

async function deleteRelation(id: number): Promise<boolean> {
  return withOrm('deleteRelation', async (db) => {
    const deleted = await db
      .delete(graph_relations)
      .where(eq(graph_relations.id, id))
      .returning({ id: graph_relations.id })
    return deleted.length > 0
  })
}

async function deleteRelationsByWikiId(wikiId: number): Promise<number> {
  return withOrm('deleteRelationsByWikiId', async (db) => {
    const deleted = await db
      .delete(graph_relations)
      .where(eq(graph_relations.wiki_id, wikiId))
      .returning({ id: graph_relations.id })
    return deleted.length
  })
}

// ==================== Build Job CRUD ====================

/**
 * Upsert a build job (only one record per wiki).
 * Resets the wiki's existing job to pending, otherwise creates a new one.
 */
async function upsertBuildJob(wikiId: number, config?: Record<string, unknown>): Promise<number> {
  return withOrm('upsertBuildJob', async (db) => {
    const configValue = config ? JSON.stringify(config) : null
    const rows = await db
      .insert(graph_build_jobs)
      .values({ wiki_id: wikiId, status: 'pending', config: configValue })
      .onConflictDoUpdate({
        target: graph_build_jobs.wiki_id,
        set: {
          status: 'pending',
          config: configValue,
          total_notes: 0,
          processed_notes: 0,
          entity_count: 0,
          relation_count: 0,
          error_message: null,
          started_at: null,
          completed_at: null,
          created_at: sql`now()`
        }
      })
      .returning({ id: graph_build_jobs.id })
    return rows[0].id
  })
}

async function updateBuildJob(
  id: number,
  updates: Partial<
    Pick<
      GraphBuildJob,
      | 'status'
      | 'total_notes'
      | 'processed_notes'
      | 'entity_count'
      | 'relation_count'
      | 'error_message'
      | 'processed_note_ids'
      | 'started_at'
      | 'completed_at'
    >
  >
): Promise<boolean> {
  return withOrm('updateBuildJob', async (db) => {
    const patch: PgUpdateSetSource<typeof graph_build_jobs> = {}
    if (updates.status !== undefined) patch.status = updates.status
    if (updates.total_notes !== undefined) patch.total_notes = updates.total_notes
    if (updates.processed_notes !== undefined) patch.processed_notes = updates.processed_notes
    if (updates.entity_count !== undefined) patch.entity_count = updates.entity_count
    if (updates.relation_count !== undefined) patch.relation_count = updates.relation_count
    if (updates.error_message !== undefined) patch.error_message = updates.error_message
    if (updates.processed_note_ids !== undefined) {
      patch.processed_note_ids = updates.processed_note_ids
    }

    if (updates.status === 'running' && !updates.started_at) {
      patch.started_at = sql`now()`
    }
    if (updates.status === 'completed' || updates.status === 'failed') {
      patch.completed_at = sql`now()`
    }

    if (Object.keys(patch).length === 0) return false

    const updated = await db
      .update(graph_build_jobs)
      .set(patch)
      .where(eq(graph_build_jobs.id, id))
      .returning({ id: graph_build_jobs.id })
    return updated.length > 0
  })
}

async function getBuildJobByWikiId(wikiId: number): Promise<GraphBuildJob | null> {
  return withOrm('getBuildJobByWikiId', async (db) => {
    const rows = await db
      .select()
      .from(graph_build_jobs)
      .where(eq(graph_build_jobs.wiki_id, wikiId))
      .limit(1)
    return rows[0] ?? null
  })
}

async function getLatestBuildJob(wikiId: number): Promise<GraphBuildJob | null> {
  return withOrm('getLatestBuildJob', async (db) => {
    const rows = await db
      .select()
      .from(graph_build_jobs)
      .where(eq(graph_build_jobs.wiki_id, wikiId))
      .orderBy(desc(graph_build_jobs.created_at))
      .limit(1)
    return rows[0] ?? null
  })
}

// ==================== Batch Operations ====================

/**
 * Batch upsert entities (completed in a single transaction, greatly improving performance).
 * Returns a mapping of entity name → entity id.
 */
async function batchUpsertEntities(
  entities: Omit<GraphEntity, 'id' | 'created_at' | 'updated_at'>[]
): Promise<Map<string, number>> {
  const nameToId = new Map<string, number>()
  if (entities.length === 0) return nameToId

  return withOrm('batchUpsertEntities', async (db) => {
    await db.transaction(async (tx) => {
      const wikiIds = [...new Set(entities.map((e) => e.wiki_id))]
      const names = entities.map((e) => e.name)

      const existingRows = await tx
        .select({
          id: graph_entities.id,
          name: graph_entities.name,
          wiki_id: graph_entities.wiki_id
        })
        .from(graph_entities)
        .where(and(inArray(graph_entities.wiki_id, wikiIds), inArray(graph_entities.name, names)))

      const existingMap = new Map<string, number>()
      for (const row of existingRows) {
        existingMap.set(`${row.wiki_id}:${row.name}`, row.id)
      }

      for (const entity of entities) {
        const key = `${entity.wiki_id}:${entity.name}`
        const existingId = existingMap.get(key)
        if (existingId !== undefined) {
          nameToId.set(entity.name, existingId)
          // Union source_note_ids (fix: previously the whole column was overwritten, so
          // cross-document sources kept only the last document and the "remove doc_id, delete when
          // empty" cleanup could delete entities still supported by other documents)
          await tx
            .update(graph_entities)
            .set({
              type: entity.type,
              description: entity.description,
              aliases: entity.aliases,
              properties: entity.properties,
              confidence: entity.confidence,
              source_note_ids: sql`COALESCE((
                SELECT jsonb_agg(DISTINCT elem)::text
                FROM jsonb_array_elements(
                  COALESCE(${graph_entities.source_note_ids}::jsonb, '[]'::jsonb) || ${toSourceNoteIds(entity.source_note_ids)}::jsonb
                ) AS elem
              ), '[]')`,
              updated_at: sql`now()`
            })
            .where(eq(graph_entities.id, existingId))
        } else {
          const rows = await tx
            .insert(graph_entities)
            .values(entity)
            .returning({ id: graph_entities.id })
          const id = rows[0].id
          nameToId.set(entity.name, id)
          // Fix: a second same-named entity in the batch (different chunks extracting the same
          // entity is common) must not go through INSERT again, otherwise the canvas shows
          // duplicate nodes
          existingMap.set(key, id)
        }
      }
    })
    return nameToId
  })
}

/**
 * Merge two `source_note_ids` segments (JSON array strings) and return a JSON string deduplicated
 * by element.
 * Preserves each element's original type (document ids are numbers and must not be stringified here).
 */
function mergeSourceNoteIds(a: string | null, b: string | null): string | null {
  const parse = (value: string | null): unknown[] => {
    if (!value) return []
    try {
      const parsed: unknown = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  const merged = new Map<string, unknown>()
  for (const item of [...parse(a), ...parse(b)]) {
    if (item === null || item === undefined) continue
    const key = typeof item === 'object' ? JSON.stringify(item) : String(item)
    if (!merged.has(key)) merged.set(key, item)
  }
  return merged.size > 0 ? JSON.stringify([...merged.values()]) : null
}

/**
 * Batch upsert relations (in a single statement).
 *
 * The old implementation did "SELECT then UPDATE/INSERT per relation", which on PGlite's
 * single connection meant 2N serial statements; the last stage of graph building often involves
 * thousands of relations, queueing every UI query meanwhile. It now relies on
 * `uq_graph_relations_key` (unique index on wiki_id/source_id/target_id/relation_type) to do the
 * work in one `INSERT ... ON CONFLICT DO UPDATE`; duplicates within the batch are deduplicated by
 * business key first and their source_note_ids merged (Postgres does not allow the same statement
 * to hit the same row twice).
 *
 * Returns the number of relations actually written (deduplicated row count).
 */
async function batchUpsertRelations(
  relations: Omit<GraphRelation, 'id' | 'created_at'>[]
): Promise<number> {
  if (relations.length === 0) return 0

  return withOrm('batchUpsertRelations', async (db) => {
    const deduped = new Map<string, Omit<GraphRelation, 'id' | 'created_at'>>()
    for (const relation of relations) {
      const key = `${relation.wiki_id}:${relation.source_id}:${relation.target_id}:${relation.relation_type}`
      const next: Omit<GraphRelation, 'id' | 'created_at'> = {
        ...relation,
        source_note_ids: toSourceNoteIds(relation.source_note_ids)
      }
      const previous = deduped.get(key)
      deduped.set(
        key,
        previous
          ? {
              ...next,
              source_note_ids: mergeSourceNoteIds(
                previous.source_note_ids,
                next.source_note_ids
              )
            }
          : next
      )
    }

    const values = [...deduped.values()]
    await db
      .insert(graph_relations)
      .values(values)
      .onConflictDoUpdate({
        target: [
          graph_relations.wiki_id,
          graph_relations.source_id,
          graph_relations.target_id,
          graph_relations.relation_type
        ],
        set: {
          description: sql`excluded.description`,
          properties: sql`excluded.properties`,
          confidence: sql`excluded.confidence`,
          source_note_ids: sql`excluded.source_note_ids`
        }
      })
    return values.length
  })
}

// ==================== Aggregate ====================

async function getFullGraphData(
  wikiId: number,
  typeFilter?: string,
  noteIds?: number[]
): Promise<GraphData> {
  const [entities, relations] = await Promise.all([
    getEntitiesByWikiId(wikiId, typeFilter, noteIds),
    getRelationsByWikiId(wikiId, noteIds)
  ])
  return { entities, relations }
}

async function batchUpdateEntityConfidence(
  updates: Array<{ id: number; confidence: number }>
): Promise<void> {
  if (updates.length === 0) return

  await withOrm('batchUpdateEntityConfidence', async (db) => {
    await db.transaction(async (tx) => {
      // Group by confidence, one UPDATE ... IN (...) per group: during merging the number of
      // updates equals the number of distinct confidence levels (usually single digits), not entities.
      const byConfidence = new Map<number, number[]>()
      for (const { id, confidence } of updates) {
        const bucket = byConfidence.get(confidence)
        if (bucket) bucket.push(id)
        else byConfidence.set(confidence, [id])
      }
      for (const [confidence, ids] of byConfidence) {
        await tx
          .update(graph_entities)
          .set({ confidence, updated_at: sql`now()` })
          .where(inArray(graph_entities.id, ids))
      }
    })
  })
}

/**
 * Persist entity merge results (used by the disambiguation merge stage of build-graph):
 * - If a row for the canonical name exists, update it (source_note_ids becomes the union of its
 *   own and all merged rows); otherwise insert it.
 * - Before deleting a merged-away old-name row, repoint the relations referencing it
 *   (source_id/target_id) to the canonical row (graph_relations has ON DELETE CASCADE to
 *   entities, so leaving them unrepointed would delete the relations too).
 * - Old names not covered by renameMap are conservatively kept and not deleted.
 * Returns the post-merge "entity name → id" map (including newly created canonical names), used
 * by confidence updates and relation saves.
 */
async function persistEntityMerges(
  wikiId: number,
  merged: Array<{
    name: string
    type: string
    description: string
    aliases: string[]
    confidence: number
    source_doc_ids: number[]
  }>,
  renameMap: Map<string, string>
): Promise<Map<string, number>> {
  const nameToId = new Map<string, number>()
  if (merged.length === 0) return nameToId

  return withOrm('persistEntityMerges', async (db) => {
    await db.transaction(async (tx) => {
      const existingRows = await tx
        .select({
          id: graph_entities.id,
          name: graph_entities.name,
          source_note_ids: graph_entities.source_note_ids
        })
        .from(graph_entities)
        .where(eq(graph_entities.wiki_id, wikiId))

      const rowsByName = new Map<string, { id: number; sourceIds: number[] }>()
      for (const row of existingRows) {
        let sourceIds: number[] = []
        if (row.source_note_ids) {
          try {
            const parsed = JSON.parse(row.source_note_ids)
            if (Array.isArray(parsed)) sourceIds = parsed as number[]
          } catch {
            sourceIds = []
          }
        }
        rowsByName.set(row.name, { id: row.id, sourceIds })
      }

      // Canonical name → list of merged-away old names
      const removedByCanonical = new Map<string, string[]>()
      for (const [oldName, canonical] of renameMap) {
        if (oldName === canonical) continue
        const list = removedByCanonical.get(canonical)
        if (list) list.push(oldName)
        else removedByCanonical.set(canonical, [oldName])
      }

      for (const entity of merged) {
        const canonical = entity.name
        const existing = rowsByName.get(canonical)
        const removed = removedByCanonical.get(canonical) ?? []

        // Source union: own + existing row + merged rows' source_note_ids
        const unionSourceIds = new Set<number>(entity.source_doc_ids)
        if (existing) {
          for (const id of existing.sourceIds) unionSourceIds.add(id)
        }
        for (const oldName of removed) {
          const oldRow = rowsByName.get(oldName)
          if (oldRow) {
            for (const id of oldRow.sourceIds) unionSourceIds.add(id)
          }
        }
        const sourceIds = [...unionSourceIds]

        let canonicalId: number
        if (existing) {
          canonicalId = existing.id
          await tx
            .update(graph_entities)
            .set({
              type: entity.type,
              description: entity.description,
              aliases: JSON.stringify(entity.aliases),
              properties: null,
              confidence: entity.confidence,
              source_note_ids: JSON.stringify(sourceIds),
              updated_at: sql`now()`
            })
            .where(eq(graph_entities.id, canonicalId))
        } else {
          const inserted = await tx
            .insert(graph_entities)
            .values({
              wiki_id: wikiId,
              name: canonical,
              type: entity.type,
              description: entity.description,
              aliases: JSON.stringify(entity.aliases),
              properties: null,
              confidence: entity.confidence,
              source_note_ids: JSON.stringify(sourceIds)
            })
            .returning({ id: graph_entities.id })
          canonicalId = inserted[0].id
          rowsByName.set(canonical, { id: canonicalId, sourceIds })
        }
        nameToId.set(canonical, canonicalId)

        // Old-name row: repoint the relations referencing it first, then delete the row itself
        // (the FK is CASCADE, so leaving them unrepointed deletes the relations too)
        for (const oldName of removed) {
          const oldRow = rowsByName.get(oldName)
          if (!oldRow || oldRow.id === canonicalId) continue
          await tx
            .update(graph_relations)
            .set({ source_id: canonicalId })
            .where(
              and(eq(graph_relations.wiki_id, wikiId), eq(graph_relations.source_id, oldRow.id))
            )
          await tx
            .update(graph_relations)
            .set({ target_id: canonicalId })
            .where(
              and(eq(graph_relations.wiki_id, wikiId), eq(graph_relations.target_id, oldRow.id))
            )
          await tx.delete(graph_entities).where(eq(graph_entities.id, oldRow.id))
          rowsByName.delete(oldName)
        }
      }

      // Repointing may create self-loop relations (A→B while B merges into A); extraction already
      // filters self-loops, so this is a safety cleanup
      await tx
        .delete(graph_relations)
        .where(
          and(
            eq(graph_relations.wiki_id, wikiId),
            sql`${graph_relations.source_id} = ${graph_relations.target_id}`
          )
        )
    })
    return nameToId
  })
}

export {
  getEntitiesByWikiId,
  getEntityById,
  searchEntities,
  upsertEntity,
  updateEntity,
  deleteEntity,
  deleteEntitiesByWikiId,
  getRelationsByWikiId,
  upsertRelation,
  deleteRelation,
  deleteRelationsByWikiId,
  getFullGraphData,
  upsertBuildJob,
  updateBuildJob,
  getBuildJobByWikiId,
  getLatestBuildJob,
  batchUpsertEntities,
  persistEntityMerges,
  batchUpsertRelations,
  batchUpdateEntityConfidence
}
