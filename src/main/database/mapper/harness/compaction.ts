import { eq, sql } from 'drizzle-orm'
import { withOrm } from '../../orm'
import { topic_compactions } from '../../schema'

// --- Type definitions ---

/** Compaction checkpoint row (fields inferred directly from the schema, no manual SQL alignment) */
export type CompactionRow = typeof topic_compactions.$inferSelect

/** Read a topic's compaction checkpoint (null if none) */
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

/** Write/overwrite a topic's compaction checkpoint (one row per topic) */
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
        // updated_at uses the database clock to avoid client-side clock drift
        set: { boundary_id: row.boundary_id, summary: row.summary, updated_at: sql`now()` }
      })
      .returning()
    return rows[0]
  })
}

/** Delete a topic's compaction checkpoint (cleaned up when the topic is deleted) */
export async function deleteCompactionByTopic(topicId: number): Promise<void> {
  await withOrm('deleteCompactionByTopic', async (db) => {
    await db.delete(topic_compactions).where(eq(topic_compactions.topic_id, topicId))
  })
}
