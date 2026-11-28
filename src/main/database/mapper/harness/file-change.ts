import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm'
import { withOrm, type Orm } from '../../orm'
import { file_change } from '../../schema'

/** File change record row (fields inferred from the schema) */
export type FileChangeRow = typeof file_change.$inferSelect

/** Input for inserting a change record (statistics and snapshot flags are computed by the caller) */
export interface FileChangeInsert {
  workspace_id: number
  path: string
  rel_path: string
  kind: FileChangeRow['kind']
  source: FileChangeRow['source']
  topic_id?: number | null
  call_id?: string | null
  status?: FileChangeRow['status']
  has_before: boolean
  has_after: boolean
  added: number
  removed: number
  before_bytes: number
  after_bytes: number
  note?: string | null
}

/** Insert a change record and return the full persisted row */
async function insertFileChange(input: FileChangeInsert): Promise<FileChangeRow> {
  return withOrm('insertFileChange', async (db: Orm) => {
    const [row] = await db
      .insert(file_change)
      .values({
        workspace_id: input.workspace_id,
        path: input.path,
        rel_path: input.rel_path,
        kind: input.kind,
        source: input.source,
        topic_id: input.topic_id ?? null,
        call_id: input.call_id ?? null,
        status: input.status ?? 'pending',
        has_before: input.has_before ? 1 : 0,
        has_after: input.has_after ? 1 : 0,
        added: input.added,
        removed: input.removed,
        before_bytes: input.before_bytes,
        after_bytes: input.after_bytes,
        note: input.note ?? null,
        // Records persisted directly in a "processed" state (e.g. review results) also record the processing time
        ...(input.status && input.status !== 'pending' ? { reviewed_at: sql`now()` } : {})
      })
      .returning()
    return row
  })
}

/** All pending-review changes in a workspace (ascending by time, so the earliest can be used for whole-file rollback) */
async function listPendingChanges(workspaceId: number): Promise<FileChangeRow[]> {
  return withOrm('listPendingChanges', async (db: Orm) => {
    return db
      .select()
      .from(file_change)
      .where(and(eq(file_change.workspace_id, workspaceId), eq(file_change.status, 'pending')))
      .orderBy(file_change.id)
  })
}

/** Change history for a file (descending, newest first) */
async function listFileChanges(filePath: string, limit = 60): Promise<FileChangeRow[]> {
  return withOrm('listFileChanges', async (db: Orm) => {
    return db
      .select()
      .from(file_change)
      .where(eq(file_change.path, filePath))
      .orderBy(desc(file_change.id))
      .limit(limit)
  })
}

/** A single change record */
async function getFileChange(id: number): Promise<FileChangeRow | null> {
  return withOrm('getFileChange', async (db: Orm) => {
    const rows = await db.select().from(file_change).where(eq(file_change.id, id)).limit(1)
    return rows[0] ?? null
  })
}

/**
 * Batch-set review status (kept / reverted / obsolete).
 * Both revert and obsolete write reviewed_at: the timeline must show when a record was processed.
 */
async function markChangesStatus(ids: number[], status: FileChangeRow['status']): Promise<number> {
  if (ids.length === 0) return 0
  return withOrm('markChangesStatus', async (db: Orm) => {
    const reviewed = status === 'kept' || status === 'reverted' || status === 'obsolete'
    const rows = await db
      .update(file_change)
      .set({
        status,
        ...(reviewed ? { reviewed_at: sql`now()` } : {})
      })
      .where(inArray(file_change.id, ids))
      .returning({ id: file_change.id })
    return rows.length
  })
}

/**
 * Mark pending-review records on the same file that are "later than a given change" as obsolete.
 *
 * Revert means "go back to before this change": it discards all changes after it as well, so those
 * records can no longer be traced back individually (the file content is no longer their prior state).
 */
async function obsoleteChangesAfter(filePath: string, changeId: number): Promise<number> {
  return withOrm('obsoleteChangesAfter', async (db: Orm) => {
    const rows = await db
      .update(file_change)
      .set({ status: 'obsolete', reviewed_at: sql`now()` })
      .where(
        and(
          eq(file_change.path, filePath),
          gt(file_change.id, changeId),
          eq(file_change.status, 'pending')
        )
      )
      .returning({ id: file_change.id })
    return rows.length
  })
}

/** Pending-review changes for a file (ascending, earliest first) */
async function listPendingChangesOfFile(filePath: string): Promise<FileChangeRow[]> {
  return withOrm('listPendingChangesOfFile', async (db: Orm) => {
    return db
      .select()
      .from(file_change)
      .where(and(eq(file_change.path, filePath), eq(file_change.status, 'pending')))
      .orderBy(file_change.id)
  })
}

export {
  insertFileChange,
  listPendingChanges,
  listFileChanges,
  listPendingChangesOfFile,
  getFileChange,
  markChangesStatus,
  obsoleteChangesAfter
}
