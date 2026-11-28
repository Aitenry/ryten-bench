import { eq, sql } from 'drizzle-orm'
import { withOrm } from '../../orm'
import { subagent_session } from '../../schema'

/**
 * Background subagent session persistence (basis for cold recovery).
 *
 * The only write entry point is `upsert`: sessions use "snapshot overwrite" semantics
 * (event streams / message history accumulate in-process and the whole row is overwritten
 * when a turn ends, a session is created, or the inbox changes) rather than persisting every
 * event, avoiding token-level write amplification.
 * The read side only lists all rows — the session table is small, so restoring it into the
 * in-memory registry once at startup is enough; topic deletion is handled by the foreign-key
 * cascade, so no extra mapper is needed.
 */

export type SubagentSessionPersistedRow = typeof subagent_session.$inferSelect

export interface SubagentSessionPersistedInput {
  id: string
  topic_id: number
  name: string
  label: string
  prompt: string
  /** JSON: SubAgentConfig snapshot at creation time */
  config: string
  /** JSON: [{role:'human'|'ai', content}] */
  messages: string
  /** JSON: SubagentConversationEvent[] */
  conversation: string
  conversation_seq: number
  turn_counter: number
  last_status: string | null
  last_output: string | null
  /** JSON: string[] (queued messages that have not started) */
  inbox: string | null
  /** End time of the most recent turn (ISO string); null = never completed a run */
  last_run_at: string | null
  /** Main model descriptor at spawn time: provider row id (empty = use the default provider) */
  main_model_provider_id: number | null
  /** Main model name at spawn time (for audit/display only) */
  main_model_name: string | null
  /** Cumulative real token usage of the session (sum of per-turn usage_metadata; 0 = not collected) */
  usage_input_tokens: number
  usage_output_tokens: number
  usage_total_tokens: number
  usage_calls: number
}

/** Overwrite a session snapshot (insert if absent) */
export async function upsertSubagentSession(input: SubagentSessionPersistedInput): Promise<void> {
  await withOrm('upsertSubagentSession', async (db) => {
    await db
      .insert(subagent_session)
      .values({
        ...input,
        updated_at: sql`now()`
      })
      .onConflictDoUpdate({
        target: subagent_session.id,
        set: {
          topic_id: input.topic_id,
          name: input.name,
          label: input.label,
          prompt: input.prompt,
          config: input.config,
          messages: input.messages,
          conversation: input.conversation,
          conversation_seq: input.conversation_seq,
          turn_counter: input.turn_counter,
          last_status: input.last_status,
          last_output: input.last_output,
          inbox: input.inbox,
          last_run_at: input.last_run_at,
          main_model_provider_id: input.main_model_provider_id,
          main_model_name: input.main_model_name,
          usage_input_tokens: input.usage_input_tokens,
          usage_output_tokens: input.usage_output_tokens,
          usage_total_tokens: input.usage_total_tokens,
          usage_calls: input.usage_calls,
          updated_at: sql`now()`
        }
      })
  })
}

/** All session snapshots (ascending by creation time; restored into the in-memory registry at startup) */
export async function listSubagentSessions(): Promise<SubagentSessionPersistedRow[]> {
  return withOrm('listSubagentSessions', async (db) => {
    return db.select().from(subagent_session).orderBy(subagent_session.created_at)
  })
}

/** Delete a single session (reserved for explicit session deletion/cleanup) */
export async function deleteSubagentSession(id: string): Promise<void> {
  await withOrm('deleteSubagentSession', async (db) => {
    await db.delete(subagent_session).where(eq(subagent_session.id, id))
  })
}

/** Delete all sessions under a topic (supplementary cleanup for topic deletion; the main path is still the foreign-key cascade) */
export async function deleteSubagentSessionsByTopic(topicId: number): Promise<void> {
  await withOrm('deleteSubagentSessionsByTopic', async (db) => {
    await db.delete(subagent_session).where(eq(subagent_session.topic_id, topicId))
  })
}
