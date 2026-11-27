import { eq, sql } from 'drizzle-orm'
import { withOrm } from '../../orm'
import { team_board } from '../../schema'

/** Agent Teams 任务板持久化（每话题一行 JSON 快照；见 schema/harness/team-board.ts） */

export type TeamBoardRow = typeof team_board.$inferSelect

export interface TeamBoardSnapshotInput {
  topic_id: number
  revision: number
  counter: number
  /** JSON：TeamTask[]（含 deleted tombstone） */
  tasks: string
}

/** 读取话题任务板快照（无则 null） */
export async function getTeamBoard(topicId: number): Promise<TeamBoardRow | null> {
  return withOrm('getTeamBoard', async (db) => {
    const rows = await db.select().from(team_board).where(eq(team_board.topic_id, topicId)).limit(1)
    return rows[0] ?? null
  })
}

/** 覆盖写话题任务板快照（不存在则插入） */
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

/** 删除话题任务板（话题删除时清理；外键级联是主路径） */
export async function deleteTeamBoard(topicId: number): Promise<void> {
  await withOrm('deleteTeamBoard', async (db) => {
    await db.delete(team_board).where(eq(team_board.topic_id, topicId))
  })
}
