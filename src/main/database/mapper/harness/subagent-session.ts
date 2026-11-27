import { eq, sql } from 'drizzle-orm'
import { withOrm } from '../../orm'
import { subagent_session } from '../../schema'

/**
 * 后台子代理会话持久化（冷恢复基础）。
 *
 * 写入口只有 `upsert`：会话是「快照覆盖」语义（事件流/消息历史在进程内累积，
 * 一轮结束/创建/收件箱变化时整行覆盖），不按事件逐条落库，避免 token 级写放大。
 * 读取侧只有「全量列出」——会话表很小，启动时一次性恢复进内存注册表即可；
 * 话题删除由外键级联清理，不需要额外 mapper。
 */

export type SubagentSessionPersistedRow = typeof subagent_session.$inferSelect

export interface SubagentSessionPersistedInput {
  id: string
  topic_id: number
  name: string
  label: string
  prompt: string
  /** JSON：创建时的 SubAgentConfig 快照 */
  config: string
  /** JSON：[{role:'human'|'ai', content}] */
  messages: string
  /** JSON：SubagentConversationEvent[] */
  conversation: string
  conversation_seq: number
  turn_counter: number
  last_status: string | null
  last_output: string | null
  /** JSON：string[]（排队未开始的消息） */
  inbox: string | null
  /** 最近一轮结束时间（ISO 字符串）；null = 从未运行完成 */
  last_run_at: string | null
  /** spawn 时主模型描述符：provider 行 id（空 = 用默认供应商） */
  main_model_provider_id: number | null
  /** spawn 时主模型名（仅审计/展示用） */
  main_model_name: string | null
  /** 会话累计真实 token 用量（各轮 usage_metadata 累加；0 = 未采集到） */
  usage_input_tokens: number
  usage_output_tokens: number
  usage_total_tokens: number
  usage_calls: number
}

/** 覆盖写一条会话快照（不存在则插入） */
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

/** 全部会话快照（按创建时间升序；启动时恢复进内存注册表） */
export async function listSubagentSessions(): Promise<SubagentSessionPersistedRow[]> {
  return withOrm('listSubagentSessions', async (db) => {
    return db.select().from(subagent_session).orderBy(subagent_session.created_at)
  })
}

/** 删除单条会话（预留：会话显式删除/清理） */
export async function deleteSubagentSession(id: string): Promise<void> {
  await withOrm('deleteSubagentSession', async (db) => {
    await db.delete(subagent_session).where(eq(subagent_session.id, id))
  })
}

/** 删除话题下的全部会话（话题删除的补充清理；主路径仍由外键级联） */
export async function deleteSubagentSessionsByTopic(topicId: number): Promise<void> {
  await withOrm('deleteSubagentSessionsByTopic', async (db) => {
    await db.delete(subagent_session).where(eq(subagent_session.topic_id, topicId))
  })
}
