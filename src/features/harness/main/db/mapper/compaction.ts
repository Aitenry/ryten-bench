import { eq, sql } from 'drizzle-orm'
import { withOrm } from '../../../../../main/database/orm'
import { topic_compactions } from '../../../../../main/database/schema'

// --- 类型定义 ---

/** 压缩 checkpoint 行（字段直接由 schema 推导，不再手工与 SQL 对齐） */
export type CompactionRow = typeof topic_compactions.$inferSelect

/** 读取话题的压缩 checkpoint（无则 null） */
export async function getCompactionByTopic(topicId: number): Promise<CompactionRow | null> {
  return withOrm('getCompactionByTopic', async (db) => {
    const rows = await db
      .select()
      .from(topic_compactions)
      .where(eq(topic_compactions.topic_id, topicId))
      .limit(1)
    return rows[0] ?? null
  })
}

/** 写入/覆盖话题的压缩 checkpoint（每个话题一行） */
export async function upsertCompaction(row: {
  topic_id: number
  boundary_id: number
  summary: string
}): Promise<CompactionRow> {
  return withOrm('upsertCompaction', async (db) => {
    const rows = await db
      .insert(topic_compactions)
      .values(row)
      .onConflictDoUpdate({
        target: topic_compactions.topic_id,
        // updated_at 走数据库时钟，避免客户端时间漂移
        set: { boundary_id: row.boundary_id, summary: row.summary, updated_at: sql`now()` }
      })
      .returning()
    return rows[0]
  })
}

/** 删除话题的压缩 checkpoint（话题删除时清理） */
export async function deleteCompactionByTopic(topicId: number): Promise<void> {
  await withOrm('deleteCompactionByTopic', async (db) => {
    await db.delete(topic_compactions).where(eq(topic_compactions.topic_id, topicId))
  })
}
