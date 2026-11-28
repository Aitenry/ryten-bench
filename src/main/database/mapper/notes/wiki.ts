import {
  and,
  asc,
  count,
  countDistinct,
  desc,
  eq,
  getTableColumns,
  inArray,
  notExists,
  sql
} from 'drizzle-orm'
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core'
import logger from 'electron-log'
import { withOrm } from '../../orm'
// Migration note: tables from core are accessed through core's aggregated schema entry point.
// Only import this plugin's own tables and the host's shared table (images) here — third-party plugin tables (e.g. a music plugin's playlists)
// must not and may not even exist (they are absent when the plugin is not installed), so cover cleanup is now "keep it if it cannot be deleted" (see deleteWiki).
import {
  directory_documents,
  documents,
  images,
  wiki,
  wiki_directories,
  documents_content
} from '../../schema'
import { saveImage } from './image'

type WikiTableRow = typeof wiki.$inferSelect

/** Wiki row (includes cover image data from the images join; doc_count is a derived field) */
export type WikiBaseRow = Pick<
  WikiTableRow,
  'id' | 'title' | 'summary' | 'tags' | 'created_at' | 'updated_at'
> & {
  image: string | null
}

export type WikiRow = WikiBaseRow & {
  doc_count: number
}

/** Wiki directory row (fields inferred from schema) */
export type WikiDirectoryRow = typeof wiki_directories.$inferSelect

export interface PaginatedResult<T> {
  items: T[]
  hasMore: boolean
  total: number
}

/** Projection shared by the wiki list/detail: cover image + distinct document count under the directories */
const wikiListColumns = {
  id: wiki.id,
  title: wiki.title,
  summary: wiki.summary,
  tags: wiki.tags,
  image: images.data,
  created_at: wiki.created_at,
  updated_at: wiki.updated_at,
  doc_count: countDistinct(directory_documents.doc_id)
}

async function getWikiById(id: number): Promise<WikiRow | null> {
  return withOrm('getWikiById', async (db) => {
    const rows = await db
      .select(wikiListColumns)
      .from(wiki)
      .leftJoin(images, eq(wiki.image_id, images.id))
      .leftJoin(wiki_directories, eq(wiki.id, wiki_directories.wiki_id))
      .leftJoin(directory_documents, eq(wiki_directories.id, directory_documents.directory_id))
      .where(eq(wiki.id, id))
      .groupBy(wiki.id, images.data)

    const row = rows[0]
    if (!row) return null
    return { ...row, doc_count: row.doc_count || 0 }
  })
}

async function getAllWikis(
  page: number = 1,
  pageSize: number = 10
): Promise<PaginatedResult<WikiRow>> {
  return withOrm('getAllWikis', async (db) => {
    const offset = (page - 1) * pageSize

    const countRows = await db.select({ total: count() }).from(wiki)
    const total = Number(countRows[0]?.total) || 0

    const rows = await db
      .select(wikiListColumns)
      .from(wiki)
      .leftJoin(images, eq(wiki.image_id, images.id))
      .leftJoin(wiki_directories, eq(wiki.id, wiki_directories.wiki_id))
      .leftJoin(directory_documents, eq(wiki_directories.id, directory_documents.directory_id))
      .groupBy(wiki.id, images.data)
      .orderBy(desc(wiki.updated_at))
      .limit(pageSize)
      .offset(offset)

    const items = rows.map((row) => ({ ...row, doc_count: row.doc_count || 0 }))
    const hasMore = offset + items.length < total
    return { items, hasMore, total }
  })
}

async function addWiki(
  wikiInput: Omit<WikiBaseRow, 'id' | 'created_at' | 'updated_at'>
): Promise<number> {
  return withOrm('addWiki', async (db) => {
    const { title, summary, tags, image } = wikiInput

    const imageId = await saveImage(image ?? null)

    const rows = await db
      .insert(wiki)
      .values({ title, summary: summary || null, tags: tags || null, image_id: imageId })
      .returning({ id: wiki.id })
    logger.info(`Inserted new wiki with ID: ${rows[0].id}`)
    return rows[0].id
  })
}

async function updateWiki(
  id: number,
  updates: Partial<Omit<WikiBaseRow, 'id' | 'created_at'>>
): Promise<boolean> {
  return withOrm('updateWiki', async (db) => {
    const patch: PgUpdateSetSource<typeof wiki> = {}

    if (updates.title !== undefined) patch.title = updates.title
    if (updates.summary !== undefined) patch.summary = updates.summary
    if (updates.tags !== undefined) patch.tags = updates.tags
    if (updates.image !== undefined) patch.image_id = await saveImage(updates.image ?? null)

    if (Object.keys(patch).length === 0) {
      logger.warn('No fields to update for wiki with id:', id)
      return false
    }

    patch.updated_at = sql`now()`
    const updated = await db
      .update(wiki)
      .set(patch)
      .where(eq(wiki.id, id))
      .returning({ id: wiki.id })

    const hasChanges = updated.length > 0
    if (hasChanges) {
      logger.info(`Updated wiki with ID: ${id}`)
    }
    return hasChanges
  })
}

async function deleteWiki(id: number): Promise<boolean> {
  return withOrm('deleteWiki', async (db) => {
    // 1. Find all document IDs under the wiki (through directory links)
    const docIdRows = await db
      .selectDistinct({ doc_id: directory_documents.doc_id })
      .from(directory_documents)
      .innerJoin(wiki_directories, eq(wiki_directories.id, directory_documents.directory_id))
      .where(eq(wiki_directories.wiki_id, id))
    const docIds = docIdRows.map((r) => r.doc_id)

    // 2. Record the cover image id (it is unreachable once the wiki is deleted), then delete the documents and the wiki in a transaction
    const wikiImageId =
      (await db.select({ image_id: wiki.image_id }).from(wiki).where(eq(wiki.id, id)).limit(1))[0]
        ?.image_id ?? null

    await db.transaction(async (tx) => {
      if (docIds.length > 0) {
        // Fix: documents are workspace-level entities that can be shared by multiple wiki directories — only delete
        // documents no longer referenced by any wiki directory (previously the whole row was deleted, silently dropping docs used by other wikis)
        await tx.delete(documents).where(
          and(
            inArray(documents.id, docIds),
            notExists(
              tx
                .select({ one: sql`1` })
                .from(directory_documents)
                .where(eq(directory_documents.doc_id, documents.id))
            )
          )
        )
      }
      await tx.delete(wiki).where(eq(wiki.id, id))
    })

    // 3. Clean up the cover (images row) outside the transaction and **catch foreign-key errors separately**:
    //    `images` is the host's shared table, also referenced by other plugins (e.g. a music plugin's playlist cover).
    //    Earlier this counted references in `music_folders` / `music_tracks` inside the transaction first —
    //    that forced notes to know third-party plugin table names, and the query errored outright when the music plugin was not installed (tables absent).
    //    Now it counts only **this plugin's own** references, then attempts one delete; if another plugin still references the image, the foreign key rejects it,
    //    and we just swallow the error (keeping the image row is harmless, and far better than failing the whole "delete wiki" operation).
    if (wikiImageId) {
      const [inWiki, inDocContent] = [
        await db.select({ c: count() }).from(wiki).where(eq(wiki.image_id, wikiImageId)),
        await db
          .select({ c: count() })
          .from(documents_content)
          .where(eq(documents_content.image_id, wikiImageId))
      ]
      const refs = Number(inWiki[0]?.c ?? 0) + Number(inDocContent[0]?.c ?? 0)
      if (refs === 0) {
        try {
          await db.delete(images).where(eq(images.id, wikiImageId))
        } catch (err) {
          // Still referenced by another plugin (e.g. a music plugin's cover): the foreign key rejects deletion, so keep this image row
          logger.info(
            `[notes] Cover ${wikiImageId} still referenced by other plugins, kept (not deleted)`,
            err
          )
        }
      }
    }

    logger.info(`Deleted wiki ${id}; ${docIds.length} associated doc(s) handled (shared kept).`)
    return true
  })
}

async function getDirectoriesByWikiId(wikiId: number): Promise<WikiDirectoryRow[]> {
  return withOrm('getDirectoriesByWikiId', async (db) => {
    return db
      .select()
      .from(wiki_directories)
      .where(eq(wiki_directories.wiki_id, wikiId))
      .orderBy(asc(wiki_directories.sort_order), asc(wiki_directories.id))
  })
}

/** Get a directory by ID (validates that the source/target directory exists and belongs to the same wiki when moving documents) */
async function getDirectoryById(id: number): Promise<WikiDirectoryRow | null> {
  return withOrm('getDirectoryById', async (db) => {
    const rows = await db
      .select()
      .from(wiki_directories)
      .where(eq(wiki_directories.id, id))
      .limit(1)
    return rows[0] ?? null
  })
}

async function addDirectory(
  directory: Omit<WikiDirectoryRow, 'id' | 'created_at' | 'updated_at'>
): Promise<number> {
  return withOrm('addDirectory', async (db) => {
    const { wiki_id, parent_id, name, sort_order, level } = directory

    const rows = await db
      .insert(wiki_directories)
      .values({
        wiki_id,
        parent_id: parent_id || null,
        name,
        sort_order: sort_order || 0,
        level: level || 0
      })
      .returning({ id: wiki_directories.id })
    logger.info(`Inserted new directory with ID: ${rows[0].id}`)
    return rows[0].id
  })
}

async function updateDirectory(
  id: number,
  updates: Partial<Omit<WikiDirectoryRow, 'id' | 'created_at'>>
): Promise<boolean> {
  return withOrm('updateDirectory', async (db) => {
    const patch: PgUpdateSetSource<typeof wiki_directories> = {}

    if (updates.name !== undefined) patch.name = updates.name
    if (updates.parent_id !== undefined) patch.parent_id = updates.parent_id
    if (updates.sort_order !== undefined) patch.sort_order = updates.sort_order
    if (updates.level !== undefined) patch.level = updates.level

    if (Object.keys(patch).length === 0) {
      logger.warn('No fields to update for directory with id:', id)
      return false
    }

    patch.updated_at = sql`now()`
    const updated = await db
      .update(wiki_directories)
      .set(patch)
      .where(eq(wiki_directories.id, id))
      .returning({ id: wiki_directories.id })

    const hasChanges = updated.length > 0
    if (hasChanges) {
      logger.info(`Updated directory with ID: ${id}`)
    }
    return hasChanges
  })
}

async function deleteDirectory(id: number): Promise<boolean> {
  return withOrm('deleteDirectory', async (db) => {
    const deleted = await db
      .delete(wiki_directories)
      .where(eq(wiki_directories.id, id))
      .returning({ id: wiki_directories.id })
    if (deleted.length > 0) {
      logger.info(`Deleted directory with ID: ${id}, ${deleted.length} row(s) affected.`)
    }
    return deleted.length > 0
  })
}

async function getDocsByDirectoryId(
  directoryId: number
): Promise<{ doc_id: number; sort_order: number | null }[]> {
  return withOrm('getDocsByDirectoryId', async (db) => {
    return db
      .select({ doc_id: directory_documents.doc_id, sort_order: directory_documents.sort_order })
      .from(directory_documents)
      .where(eq(directory_documents.directory_id, directoryId))
      .orderBy(asc(directory_documents.sort_order), asc(directory_documents.id))
  })
}

async function addDocToDirectory(
  directoryId: number,
  docId: number,
  sortOrder: number = 0
): Promise<number> {
  return withOrm('addDocToDirectory', async (db) => {
    const rows = await db
      .insert(directory_documents)
      .values({ directory_id: directoryId, doc_id: docId, sort_order: sortOrder })
      .returning({ id: directory_documents.id })
    logger.info(`Added doc ${docId} to directory ${directoryId} with ID: ${rows[0].id}`)
    return rows[0].id
  })
}

async function removeDocFromDirectory(directoryId: number, docId: number): Promise<boolean> {
  return withOrm('removeDocFromDirectory', async (db) => {
    const deleted = await db
      .delete(directory_documents)
      .where(
        and(
          eq(directory_documents.directory_id, directoryId),
          eq(directory_documents.doc_id, docId)
        )
      )
      .returning({ id: directory_documents.id })
    if (deleted.length > 0) {
      logger.info(`Removed doc ${docId} from directory ${directoryId}`)
    }
    return deleted.length > 0
  })
}

async function getDirectoriesByDocId(docId: number): Promise<WikiDirectoryRow[]> {
  return withOrm('getDirectoriesByDocId', async (db) => {
    return db
      .select({ ...getTableColumns(wiki_directories) })
      .from(wiki_directories)
      .innerJoin(directory_documents, eq(wiki_directories.id, directory_documents.directory_id))
      .where(eq(directory_documents.doc_id, docId))
      .orderBy(asc(wiki_directories.sort_order), asc(wiki_directories.id))
  })
}

export {
  getWikiById,
  getAllWikis,
  addWiki,
  updateWiki,
  deleteWiki,
  getDirectoriesByWikiId,
  getDirectoryById,
  addDirectory,
  updateDirectory,
  deleteDirectory,
  getDocsByDirectoryId,
  addDocToDirectory,
  removeDocFromDirectory,
  getDirectoriesByDocId
}
