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
import { withOrm, type Orm } from '../../../../../main/database/orm'
import {
  documents,
  documents_content,
  directory_documents,
  images
} from '../../../../../main/database/schema'
import { saveImage } from './image'

type DocumentsTableRow = typeof documents.$inferSelect

/** 文档基础行（字段由 schema 推导） */
export type DocRow = DocumentsTableRow

/** 文档列表项：文档行 + 正文封面 + 字数（派生自 documents_content） */
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

/** 列表/搜索共用投影：正文封面 + 字数（LENGTH 对 NULL 返回 NULL，由调用方兜底为 0） */
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

/** 把 word_count 兜底为 0（与原实现 `row.word_count || 0` 一致），并保留行上的其它列 */
function normalizeListItem<T extends { word_count: number | null }>(
  row: T
): Omit<T, 'word_count'> & { word_count: number } {
  return { ...row, word_count: row.word_count || 0 }
}

/**
 * 「排除已归档到知识库的文档」条件。
 * 原实现用 `LEFT JOIN directory_documents dd ... WHERE dd.doc_id IS NULL`（excludeWikiId > 0 时
 * 额外在 ON 上挂 wd.wiki_id = $1，实测对结果无影响），语义等价于「该文档不属于任何目录」，
 * 这里改用 NOT EXISTS —— 结果完全一致，且不再需要把 JOIN 拼进 SQL。
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

    // 与原实现一致：只要有任意字段更新就刷新 documents.updated_at
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
 * 从 graph_entities / graph_relations 的 source_note_ids（JSON 数组字符串）里摘除某个文档 ID。
 * 保留原 SQL：jsonb_array_elements + jsonb_agg 这套写法无法用查询构造器表达。
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

/** source_note_ids 变空的实体/关系已经没有任何来源文档，直接删除 */
const DELETE_EMPTY_GRAPH_ROWS: SQL[] = [
  sql`DELETE FROM graph_entities WHERE source_note_ids = '[]' OR source_note_ids IS NULL OR source_note_ids = ''`,
  sql`DELETE FROM graph_relations WHERE source_note_ids = '[]' OR source_note_ids IS NULL OR source_note_ids = ''`
]

/** 在事务内对一批文档做图谱引用清理（单删与按时间段删共用） */
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
      // 1. 删除文档内容
      await tx.delete(documents_content).where(eq(documents_content.doc_id, id))

      // 2. 删除文档本身
      const deleted = await tx
        .delete(documents)
        .where(eq(documents.id, id))
        .returning({ id: documents.id })
      const changes = deleted.length

      // 3. 清理图谱实体/关系里对该文档的引用（source_note_ids 变空则删除整行）
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

/** 查询某个时间范围内创建的文档 ID（供 IPC 层在删除前清理关联节点位置） */
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

      // 与单删路径（deleteDoc）一致的图谱清理（修复：此前两条 DELETE 各自提交且完全
      // 绕过图谱引用清理，实体/关系保留悬空引用；现在整体事务 + 逐 doc 摘除来源）
      await cleanGraphRefs(tx, ids)
    })
    logger.info(`Deleted ${deleted} docs in time range [${startTime}, ${endTime}]`)
    return deleted
  })
}

export {
  getDocById,
  getAllDocs,
  getDocPage,
  addDoc,
  updateDoc,
  deleteDoc,
  getDocIdsByTimeRange,
  deleteDocsByTimeRange
}
