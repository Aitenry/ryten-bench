import { desc, eq } from 'drizzle-orm'
import { withOrm } from '../../orm'
import { team_task_event } from '../../schema'

/** Agent Teams 任务事件日志（追加写；见 schema/harness/team-task-event.ts） */

export type TeamTaskEventRow = typeof team_task_event.$inferSelect

export interface TeamTaskEventInput {
  topic_id: number
  task_id: string
  /** created / claimed / completed / updated / deleted */
  action: string
  actor_id: string
  actor_name: string
  subject: string
  task_revision: number
}

/** 追加一条任务事件（任务板存储适配器在每次任务变更时调用） */
export async function appendTeamTaskEvent(input: TeamTaskEventInput): Promise<void> {
  await withOrm('appendTeamTaskEvent', async (db) => {
    await db.insert(team_task_event).values(input)
  })
}

/** 最近任务事件（新的在前；UI 活动行/后续活动面板用） */
export async function listTeamTaskEvents(topicId: number, limit = 20): Promise<TeamTaskEventRow[]> {
  return withOrm('listTeamTaskEvents', async (db) => {
    return db
      .select()
      .from(team_task_event)
      .where(eq(team_task_event.topic_id, topicId))
      .orderBy(desc(team_task_event.id))
      .limit(Math.max(1, Math.min(200, Math.floor(limit))))
  })
}

/** 删除话题下的事件（话题删除外键级联是主路径；这里保持显式清理） */
export async function deleteTeamTaskEventsByTopic(topicId: number): Promise<void> {
  await withOrm('deleteTeamTaskEventsByTopic', async (db) => {
    await db.delete(team_task_event).where(eq(team_task_event.topic_id, topicId))
  })
}
