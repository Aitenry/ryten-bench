import { eq, sql } from 'drizzle-orm'
import { withOrm } from '../../../../../main/database/orm'
import { harness_goals } from '../../../../../main/database/schema'

// --- 类型定义 ---

/** 会话目标行（phase 的联合类型由 schema 的 $type 提供） */
export type GoalRow = typeof harness_goals.$inferSelect

/** 按话题读取当前目标（无则 null） */
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
 * 写入/覆盖目标（每个话题一行）。
 * 返回写入后的行。
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

/** 删除话题的目标（话题删除时级联清理） */
export async function deleteGoalByTopic(topicId: number): Promise<void> {
  await withOrm('deleteGoalByTopic', async (db) => {
    await db.delete(harness_goals).where(eq(harness_goals.topic_id, topicId))
  })
}
