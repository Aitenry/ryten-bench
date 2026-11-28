import {
  and,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  lte,
  notExists,
  or,
  sql,
  type SQL
} from 'drizzle-orm'
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core'
import logger from 'electron-log'
import { withOrm, type Orm } from '../../orm'
import { documents, documents_content, directory_documents, images } from '../../schema'
import { saveImage } from './image'

type DocumentsTableRow = typeof documents.$inferSelect

/** Base document row (fields inferred from the schema) */
export type DocRow = DocumentsTableRow

/** Document list item: document row + body cover + word count (derived from documents_content) */
export type DocListItem = Pick<
  DocumentsTableRow,
  'id' | 'title' | 'summary' | 'tags' | 'created_at' | 'updated_at'
> & {
  image: string | null
  word_count: number
}

export type DocWithContent = DocListItem & {
  content: string | null
}

export interface PaginatedResult<T> {
  items: T[]
  hasMore: boolean
  total: number
}

/** Shared projection for list/search: body cover + word count (LENGTH returns NULL for NULL; callers fall back to 0) */
const docListColumns = {
  id: documents.id,
  title: documents.title,
  summary: documents.summary,
  tags: documents.tags,
  created_at: documents.created_at,
  updated_at: documents.updated_at,
  image: images.data,
  word_count: sql<number | null>`LENGTH(${documents_content.content})`
}

/** Fall back word_count to 0 (consistent with the original `row.word_count || 0`) and keep the row's other columns */
function normalizeListItem<T extends { word_count: number | null }>(
  row: T
): Omit<T, 'word_count'> & { word_count: number } {
  return { ...row, word_count: row.word_count || 0 }
}

/**
 * "Exclude documents already archived into a knowledge base" condition.
 * The original implementation used `LEFT JOIN directory_documents dd ... WHERE dd.doc_id IS NULL`
 * (when excludeWikiId > 0 it additionally hung wd.wiki_id = $1 on the ON clause, which had no
 * observable effect on the result); the semantics are "the document does not belong to any
 * directory". This version uses NOT EXISTS instead — identical results, and the JOIN no longer
 * has to be spliced into the SQL.
 */
function notInAnyDirectory(db: Orm): SQL {
  return notExists(
    db
      .select({ one: sql`1` })
      .from(directory_documents)
      .where(eq(directory_documents.doc_id, documents.id))
  )
}

async function getDocById(id: number): Promise<DocWithContent | null> {
  return withOrm('getDocById', async (db) => {
    const rows = await db
      .select({ ...docListColumns, content: documents_content.content })
      .from(documents)
      .leftJoin(documents_content, eq(documents.id, documents_content.doc_id))
      .leftJoin(images, eq(documents_content.image_id, images.id))
      .where(eq(documents.id, id))

    const row = rows[0]
    if (!row) return null
    return normalizeListItem(row)
  })
}

async function getAllDocs(
  page: number = 1,
  pageSize: number = 10,
  excludeWikiId?: number,
  search?: string
): Promise<PaginatedResult<DocListItem>> {
  return withOrm('getAllDocs', async (db) => {
    const offset = (page - 1) * pageSize
    const hasExclude = excludeWikiId != null && (excludeWikiId === -1 || excludeWikiId > 0)

    const conditions: SQL[] = []
    if (hasExclude) conditions.push(notInAnyDirectory(db))
    if (search) {
      const pattern = `%${search}%`
      conditions.push(
        or(
          ilike(documents.title, pattern),
          ilike(documents.summary, pattern),
          ilike(documents.tags, pattern)
        )!
      )
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined

    const countRows = await db.select({ total: count() }).from(documents).where(where)
    const total = Number(countRows[0]?.total) || 0

    const rows = await db
      .select(docListColumns)
      .from(documents)
      .leftJoin(documents_content, eq(documents.id, documents_content.doc_id))
      .leftJoin(images, eq(documents_content.image_id, images.id))
      .where(where)
      .orderBy(desc(documents.updated_at))
      .limit(pageSize)
      .offset(offset)

    const items = rows.map(normalizeListItem)
    const hasMore = offset + items.length < total
    return { items, hasMore, total }
  })
}

/** Batch-fetch titles by ID (for displaying graph source documents: only title, no body) */
async function getDocTitlesByIds(ids: number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map()
  return withOrm('getDocTitlesByIds', async (db) => {
    const rows = await db
      .select({ id: documents.id, title: documents.title })
      .from(documents)
      .where(inArray(documents.id, ids))
    return new Map(rows.map((row) => [row.id, row.title]))
  })
}

async function getDocPage(
  query: string,
  page: number = 1,
  pageSize: number = 20
): Promise<PaginatedResult<DocListItem>> {
  return withOrm('getDocPage', async (db) => {
    const offset = (page - 1) * pageSize

    // Use ILIKE-based search across title, summary, tags, and doc content.
    const pattern = `%${query}%`
    const matches = (): SQL =>
      or(
        ilike(documents.title, pattern),
        ilike(documents.summary, pattern),
        ilike(documents.tags, pattern),
        ilike(documents_content.content, pattern)
      )!

    const countRows = await db
      .select({ total: count() })
      .from(documents)
      .leftJoin(documents_content, eq(documents.id, documents_content.doc_id))
      .where(matches())
    const total = Number(countRows[0]?.total) || 0

    if (total === 0) {
      return { items: [], hasMore: false, total: 0 }
    }

    const rows = await db
      .select(docListColumns)
      .from(documents)
      .leftJoin(documents_content, eq(documents.id, documents_content.doc_id))
      .leftJoin(images, eq(documents_content.image_id, images.id))
      .where(matches())
      .orderBy(desc(documents.updated_at))
      .limit(pageSize)
      .offset(offset)

    const items = rows.map(normalizeListItem)
    const hasMore = offset + items.length < total
    return { items, hasMore, total }
  })
}

async function addDoc(
  doc: Omit<DocRow, 'id' | 'created_at' | 'updated_at'> & {
    image?: string | null
    content?: string | null
  }
): Promise<number> {
  return withOrm('addDoc', async (db) => {
    const { title, summary, tags, image, content } = doc

    const imageId = await saveImage(image ?? null)

    const rows = await db
      .insert(documents)
      .values({ title, summary: summary || null, tags: tags || null })
      .returning({ id: documents.id })

    const docId = rows[0].id

    await db
      .insert(documents_content)
      .values({ doc_id: docId, image_id: imageId, content: content || null })

    logger.info(`Inserted new doc with ID: ${docId}`)
    return docId
  })
}

async function updateDoc(
  id: number,
  updates: Partial<
    Omit<DocRow, 'id' | 'created_at'> & {
      image?: string | null
      content?: string | null
    }
  >
): Promise<boolean> {
  return withOrm('updateDoc', async (db) => {
    const docPatch: PgUpdateSetSource<typeof documents> = {}
    if (updates.title !== undefined) docPatch.title = updates.title
    if (updates.summary !== undefined) docPatch.summary = updates.summary
    if (updates.tags !== undefined) docPatch.tags = updates.tags

    const contentPatch: PgUpdateSetSource<typeof documents_content> = {}
    if (updates.image !== undefined) contentPatch.image_id = await saveImage(updates.image ?? null)
    if (updates.content !== undefined) contentPatch.content = updates.content

    if (Object.keys(docPatch).length === 0 && Object.keys(contentPatch).length === 0) {
      logger.warn('No fields to update for doc with id:', id)
      return false
    }

    // Consistent with the original implementation: any field update refreshes documents.updated_at
    docPatch.updated_at = sql`now()`

    let hasChanges = false

    const docUpdated = await db
      .update(documents)
      .set(docPatch)
      .where(eq(documents.id, id))
      .returning({ id: documents.id })
    hasChanges = hasChanges || docUpdated.length > 0

    if (Object.keys(contentPatch).length > 0) {
      // Check if content row exists
      const existing = await db
        .select({ id: documents_content.id })
        .from(documents_content)
        .where(eq(documents_content.doc_id, id))
        .limit(1)

      if (existing.length > 0) {
        contentPatch.updated_at = sql`now()`
        const contentResult = await db
          .update(documents_content)
          .set(contentPatch)
          .where(eq(documents_content.doc_id, id))
          .returning({ id: documents_content.id })
        hasChanges = hasChanges || contentResult.length > 0
      } else {
        const imageId = await saveImage(updates.image ?? null)
        const content = updates.content || null

        await db.insert(documents_content).values({ doc_id: id, image_id: imageId, content })
        hasChanges = true
      }
    }

    if (hasChanges) {
      logger.info(`Updated doc with ID: ${id}`)
      return true
    }

    logger.warn(`No rows updated for doc with ID: ${id}`)
    return false
  })
}

/**
 * Remove a document ID from graph_entities / graph_relations source_note_ids (JSON array strings).
 * Keeps the raw SQL: jsonb_array_elements + jsonb_agg cannot be expressed with the query builder.
 */
function stripSourceNoteId(table: 'graph_entities' | 'graph_relations', docId: number): SQL {
  return sql`
    UPDATE ${sql.identifier(table)}
    SET source_note_ids = COALESCE((
      SELECT jsonb_agg(elem)::text
      FROM jsonb_array_elements(source_note_ids::jsonb) AS elem
      WHERE (elem)::int != CAST(${docId} AS int)
    ), '[]')
    WHERE EXISTS (
      SELECT 1 FROM jsonb_array_elements(source_note_ids::jsonb) a
      WHERE (a)::int = CAST(${docId} AS int)
    )
  `
}

/** Entities/relations whose source_note_ids became empty have no source documents left; delete them outright */
const DELETE_EMPTY_GRAPH_ROWS: SQL[] = [
  sql`DELETE FROM graph_entities WHERE source_note_ids = '[]' OR source_note_ids IS NULL OR source_note_ids = ''`,
  sql`DELETE FROM graph_relations WHERE source_note_ids = '[]' OR source_note_ids IS NULL OR source_note_ids = ''`
]

/** Clean up graph references for a batch of documents inside a transaction (shared by single and time-range deletion) */
async function cleanGraphRefs(tx: Orm, docIds: number[]): Promise<void> {
  for (const docId of docIds) {
    await tx.execute(stripSourceNoteId('graph_entities', docId))
    await tx.execute(stripSourceNoteId('graph_relations', docId))
  }
  for (const stmt of DELETE_EMPTY_GRAPH_ROWS) {
    await tx.execute(stmt)
  }
}

async function deleteDoc(id: number): Promise<boolean> {
  return withOrm('deleteDoc', async (db) => {
    await db.transaction(async (tx) => {
      // 1. Delete the document content
      await tx.delete(documents_content).where(eq(documents_content.doc_id, id))

      // 2. Delete the document itself
      const deleted = await tx
        .delete(documents)
        .where(eq(documents.id, id))
        .returning({ id: documents.id })
      const changes = deleted.length

      // 3. Remove references to this document from graph entities/relations (delete the row when
      // source_note_ids becomes empty)
      await cleanGraphRefs(tx, [id])

      if (changes > 0) {
        logger.info(`Deleted doc with ID: ${id}, ${changes} row(s) affected.`)
      } else {
        logger.warn(`No rows deleted for doc with ID: ${id}`)
      }
    })

    return true
  })
}

/** Query document IDs created in a time range (so the IPC layer can clean up related node positions before deletion) */
async function getDocIdsByTimeRange(startTime: string, endTime: string): Promise<number[]> {
  return withOrm('getDocIdsByTimeRange', async (db) => {
    const rows = await db
      .select({ id: documents.id })
      .from(documents)
      .where(and(gte(documents.created_at, startTime), lte(documents.created_at, endTime)))
    return rows.map((r) => r.id)
  })
}

async function deleteDocsByTimeRange(startTime: string, endTime: string): Promise<number> {
  return withOrm('deleteDocsByTimeRange', async (db) => {
    let deleted = 0
    await db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: documents.id })
        .from(documents)
        .where(and(gte(documents.created_at, startTime), lte(documents.created_at, endTime)))
      const ids = rows.map((r) => r.id)
      if (ids.length === 0) return

      await tx.delete(documents_content).where(inArray(documents_content.doc_id, ids))
      const result = await tx
        .delete(documents)
        .where(inArray(documents.id, ids))
        .returning({ id: documents.id })
      deleted = result.length

      // Graph cleanup consistent with the single-delete path (deleteDoc) (fix: previously the two
      // DELETEs committed separately and bypassed graph reference cleanup entirely, leaving
      // dangling references on entities/relations; now it is one transaction with per-doc removal)
      await cleanGraphRefs(tx, ids)
    })
    logger.info(`Deleted ${deleted} docs in time range [${startTime}, ${endTime}]`)
    return deleted
  })
}

export {
  getDocById,
  getAllDocs,
  getDocTitlesByIds,
  getDocPage,
  addDoc,
  updateDoc,
  deleteDoc,
  getDocIdsByTimeRange,
  deleteDocsByTimeRange
}
