import { eq, sql } from 'drizzle-orm'
import { withOrm } from '../../orm'
import { team_board } from '../../schema'

/** Agent Teams task board persistence (one JSON snapshot row per topic; see schema/harness/team-board.ts) */

export type TeamBoardRow = typeof team_board.$inferSelect

export interface TeamBoardSnapshotInput {
  topic_id: number
  revision: number
  counter: number
  /** JSON: TeamTask[] (with deleted tombstones) */
  tasks: string
}

/** Read the topic's task board snapshot (null if absent) */
export async function getTeamBoard(topicId: number): Promise<TeamBoardRow | null> {
  return withOrm('getTeamBoard', async (db) => {
    const rows = await db.select().from(team_board).where(eq(team_board.topic_id, topicId)).limit(1)
    return rows[0] ?? null
  })
}

/** Overwrite the topic's task board snapshot (insert if absent) */
export async function upsertTeamBoard(input: TeamBoardSnapshotInput): Promise<void> {
  await withOrm('upsertTeamBoard', async (db) => {
    await db
      .insert(team_board)
      .values({ ...input, updated_at: sql`now()` })
      .onConflictDoUpdate({
        target: team_board.topic_id,
        set: {
          revision: input.revision,
          counter: input.counter,
          tasks: input.tasks,
          updated_at: sql`now()`
        }
      })
  })
}

/** Delete the topic's task board (cleanup on topic deletion; the foreign-key cascade is the main path) */
export async function deleteTeamBoard(topicId: number): Promise<void> {
  await withOrm('deleteTeamBoard', async (db) => {
    await db.delete(team_board).where(eq(team_board.topic_id, topicId))
  })
}
