/**
 * Session-history retrieval tools: `session_search` (search messages across topics) and
 * `conversation_read` (read recent messages of one topic).
 *
 * The truth lives in the `harness_topic` + `harness_dialogue` tables, and two read-only entry
 * points cover these use cases:
 * - search history: isolated per workspace, returns topic title + role + time + matching snippet so
 *   the model can locate things;
 * - read conversation: read the last N messages of a topic id so the model can look back at
 *   context (used for cross-conversation references).
 *
 * Read-only, no side effects; results are laid out per UI language and bodies are returned as-is.
 */
import { z } from 'zod'
import { tool, type StructuredToolInterface } from '../../ai/tools'
import { mainFormat } from '../../i18n'
import { getSessionToolTexts } from '../../i18n/tool-results-session'
import {
  getAllTopics,
  getDialoguesByTopicId,
  getTopicById,
  searchDialogues
} from '../../database/mapper/harness/harness'
import {
  formatConversation,
  formatConversationList,
  formatSessionSearch,
  type ConversationListEntry,
  type SessionSearchHit
} from './session-search-core'

/** core handles snippet clipping; this module only fetches data and handles errors */

/** Build the session retrieval tools (mounted only in sessions that have a workspace) */
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

  const conversationList = tool(
    async ({ limit }) => {
      const texts = getSessionToolTexts()
      try {
        const topics = await getAllTopics(workspaceId)
        const entries: ConversationListEntry[] = topics.slice(0, limit ?? 10).map((topic) => ({
          topicId: topic.id,
          title: topic.title ?? '',
          updatedAt: topic.updated_at ? new Date(topic.updated_at).toISOString() : null,
          archived: topic.archived_at !== null
        }))
        return formatConversationList(mainFormat, texts, entries)
      } catch (err) {
        return mainFormat(texts.conversationList.failed, {
          message: err instanceof Error ? err.message : String(err)
        })
      }
    },
    {
      name: 'conversation_list',
      isConcurrencySafe: () => true,
      timeoutMs: 30_000,
      description:
        'List the most recent conversations of this workspace (id, title, last update, archived flag), newest first. Use it to browse before reading one with conversation_read; session_search searches message text instead.',
      schema: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(30)
          .optional()
          .describe('How many conversations to list (default 10)')
      })
    }
  )

  return [sessionSearch, conversationRead, conversationList]
}
