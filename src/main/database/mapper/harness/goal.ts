import { eq, sql } from 'drizzle-orm'
import { withOrm } from '../../orm'
import { harness_goals } from '../../schema'

// --- Type definitions ---

/** Session goal row (the union type of phase is provided by the schema's $type) */
export type GoalRow = typeof harness_goals.$inferSelect

/** Read the current goal for a topic (null if absent) */
export async function getGoalByTopic(topicId: number): Promise<GoalRow | null> {
  return withOrm('getGoalByTopic', async (db) => {
    const rows = await db
      .select()
      .from(harness_goals)
      .where(eq(harness_goals.topic_id, topicId))
      .limit(1)
    return rows[0] ?? null
  })
}

/**
 * Write/overwrite the goal (one row per topic).
 * Returns the written row.
 */
export async function upsertGoal(
  row: Omit<GoalRow, 'created_at' | 'updated_at'>
): Promise<GoalRow> {
  return withOrm('upsertGoal', async (db) => {
    const rows = await db
      .insert(harness_goals)
      .values(row)
      .onConflictDoUpdate({
        target: harness_goals.topic_id,
        set: {
          goal_id: row.goal_id,
          revision: row.revision,
          objective: row.objective,
          phase: row.phase,
          rounds_started: row.rounds_started,
          max_goal_rounds: row.max_goal_rounds,
          blocked_reason: row.blocked_reason,
          updated_at: sql`now()`
        }
      })
      .returning()
    return rows[0]
  })
}

/** Delete a topic's goal (cascades when the topic is deleted) */
export async function deleteGoalByTopic(topicId: number): Promise<void> {
  await withOrm('deleteGoalByTopic', async (db) => {
    await db.delete(harness_goals).where(eq(harness_goals.topic_id, topicId))
  })
}
