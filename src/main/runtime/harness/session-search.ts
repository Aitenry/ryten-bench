/**
 * 历史会话检索工具：`session_search`（跨话题搜消息）与 `conversation_read`（读某话题最近消息）。
 *
 * 对照 DSH 的 `dsh-tool-session-query`：DSH 的查询建立在事件溯源会话日志上；本项目以
 * `harness_topic` + `harness_dialogue` 两张表为准，提供同等用途的两个只读入口：
 * - 搜历史：按工作区隔离，返回话题标题 + 角色 + 时间 + 命中片段，供模型定位；
 * - 读会话：按话题 id 读最近 N 条，供模型回看上下文（跨会话引用时用）。
 *
 * 只读、无副作用；结果按界面语言排版，正文原样返回。
 */
import { z } from 'zod'
import { tool, type StructuredToolInterface } from '../../ai/tools'
import { mainFormat } from '../../i18n'
import { getSessionToolTexts } from '../../i18n/tool-results-session'
import {
  getDialoguesByTopicId,
  getTopicById,
  searchDialogues
} from '../../database/mapper/harness/harness'
import {
  formatConversation,
  formatSessionSearch,
  type SessionSearchHit
} from './session-search-core'

/** 搜索结果里正文片段的截取由 core 负责；这里只管取数与错误处理 */

/** 构造两个会话检索工具（仅在有工作区的会话里挂载） */
export function buildSessionSearchTools(workspaceId: number): StructuredToolInterface[] {
  const sessionSearch = tool(
    async ({ query, limit }) => {
      const texts = getSessionToolTexts()
      try {
        const rows = await searchDialogues(workspaceId, query, limit ?? 8)
        const hits: SessionSearchHit[] = rows.map((row) => ({
          topicId: row.topic_id,
          topicTitle: row.topic_title ?? '',
          role: row.role,
          content: row.content,
          createdAt: row.created_at
        }))
        return formatSessionSearch(mainFormat, texts, query, hits)
      } catch (err) {
        return mainFormat(texts.sessionSearch.failed, {
          message: err instanceof Error ? err.message : String(err)
        })
      }
    },
    {
      name: 'session_search',
      isConcurrencySafe: () => true,
      timeoutMs: 30_000,
      description:
        'Search past messages of this workspace (all conversations) by a literal keyword and return the most recent hits with topic id/title, role, time and a snippet around the match. Use it when the user refers to earlier conversations; then use conversation_read with a topic id to read that conversation.',
      schema: z.object({
        query: z.string().min(1).describe('Literal text to look for (case-insensitive substring)'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe('Maximum hits to return (default 8)')
      })
    }
  )

  const conversationRead = tool(
    async ({ topicId, limit }) => {
      const texts = getSessionToolTexts()
      try {
        const topics = await getTopicById(topicId)
        const topic = topics[0]
        if (!topic || topic.workspace_id !== workspaceId) {
          return mainFormat(texts.conversationRead.notFound, { topicId: String(topicId) })
        }
        const dialogues = await getDialoguesByTopicId(topicId)
        const tail = limit ? dialogues.slice(-limit) : dialogues.slice(-20)
        return formatConversation(mainFormat, texts, {
          topicId,
          title: topic.title ?? '',
          messages: tail.map((row) => ({ role: row.role, content: row.content }))
        })
      } catch (err) {
        return mainFormat(texts.conversationRead.failed, {
          message: err instanceof Error ? err.message : String(err)
        })
      }
    },
    {
      name: 'conversation_read',
      isConcurrencySafe: () => true,
      timeoutMs: 30_000,
      description:
        'Read the last N messages (default 20) of one conversation by its topic id, with role labels. Use together with session_search to recall what was decided in an earlier conversation of this workspace.',
      schema: z.object({
        topicId: z.number().int().positive().describe('Topic id from session_search'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('How many recent messages to read (default 20)')
      })
    }
  )

  return [sessionSearch, conversationRead]
}
