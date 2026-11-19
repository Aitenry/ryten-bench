import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm'
import { withOrm, type Orm } from '../../../../../main/database/orm'
import { file_change } from '../../../../../main/database/schema'

/** 文件改动记录行（字段由 schema 推导） */
export type FileChangeRow = typeof file_change.$inferSelect

/** 新增一条改动记录的入参（统计与快照标记由调用方算好） */
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

/** 插入一条改动记录，返回落库后的整行 */
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
        // 直接以「已处理」状态落库的记录（如审查结果）同时记下处理时间
        ...(input.status && input.status !== 'pending' ? { reviewed_at: sql`now()` } : {})
      })
      .returning()
    return row
  })
}

/** 某工作区下所有待审查的改动（按时间正序，便于「最早的一次」做整文件回滚） */
async function listPendingChanges(workspaceId: number): Promise<FileChangeRow[]> {
  return withOrm('listPendingChanges', async (db: Orm) => {
    return db
      .select()
      .from(file_change)
      .where(and(eq(file_change.workspace_id, workspaceId), eq(file_change.status, 'pending')))
      .orderBy(file_change.id)
  })
}

/** 某个文件的改动历史（倒序，最新在前） */
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

/** 单条改动记录 */
async function getFileChange(id: number): Promise<FileChangeRow | null> {
  return withOrm('getFileChange', async (db: Orm) => {
    const rows = await db.select().from(file_change).where(eq(file_change.id, id)).limit(1)
    return rows[0] ?? null
  })
}

/**
 * 批量置审查状态（保留 / 撤销 / 失效）。
 * 撤销与失效都写 reviewed_at：时间线里要能看出「什么时候被处理过」。
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
 * 把同一文件上「晚于某次改动」的待审查记录标记为失效。
 *
 * 撤销是「回到这次改动之前」的语义：它一并丢掉了该次之后的所有改动，
 * 那些记录不能再单独回溯（文件内容已经不是它们的前置状态了）。
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

/** 某个文件的待审查改动（正序，最早在前） */
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
