import { desc, eq } from 'drizzle-orm'
import { withOrm } from '../../orm'
import { team_task_event } from '../../schema'

/** Agent Teams task event log (append-only; see schema/harness/team-task-event.ts) */

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

/** Append a task event (called by the task board storage adapter on every task change) */
export async function appendTeamTaskEvent(input: TeamTaskEventInput): Promise<void> {
  await withOrm('appendTeamTaskEvent', async (db) => {
    await db.insert(team_task_event).values(input)
  })
}

/** Recent task events (newest first; used by the UI activity line and activity panel) */
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

/** Delete a topic's events (the foreign-key cascade on topic deletion is the main path; keep explicit cleanup here) */
export async function deleteTeamTaskEventsByTopic(topicId: number): Promise<void> {
  await withOrm('deleteTeamTaskEventsByTopic', async (db) => {
    await db.delete(team_task_event).where(eq(team_task_event.topic_id, topicId))
  })
}
