import { tool, type StructuredToolInterface } from '../../ai/tools'
import { z } from 'zod'

/**
 * Todo tool set — the task plan the model draws up during a conversation (write_todos / read_todos)
 *
 * The schema stays consistent with the frontend rendering contract:
 *   { todos: [{ content, status: "pending"|"in_progress"|"completed", activeForm }] }
 *
 * Lifecycle (2026-08-20 refactor):
 * - Process-level singleton (survives requests and turns): the model keeps maintaining the plan
 *   with write_todos across turns, and later turns can still read it via read_todos (the original
 *   implementation created one instance per request and cleared it when the run ended, so the plan
 *   could not span turns);
 * - Isolated by topicId: each conversation topic has its own list, with no cross-talk;
 * - A write triggers onChange immediately (injected by the main process, which broadcasts the
 *   harness-todos-updated event and drives live updates of the in-progress task card above the
 *   composer);
 * - End-of-turn close-out (so no item stays "in progress") is not here, see todo-closeout.ts: that
 *   is a turn-scheduling decision, while the tool layer only reads and writes the list itself.
 */

export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
}

export type TodoUpdateListener = (topicId: number, todos: TodoItem[]) => void

/** Conversation todo store (process-level singleton, isolated by topicId) */
export class TodoStore {
  private readonly itemsByTopic = new Map<number, TodoItem[]>()

  /** Change callback (injected by the main process to broadcast to the renderer) */
  onChange?: TodoUpdateListener

  set(topicId: number, todos: TodoItem[]): TodoItem[] {
    this.itemsByTopic.set(topicId, todos)
    this.onChange?.(topicId, todos)
    return todos
  }

  get(topicId: number): TodoItem[] {
    return this.itemsByTopic.get(topicId) ?? []
  }

  /** Clear the corresponding list when a topic is deleted */
  clear(topicId: number): void {
    this.itemsByTopic.delete(topicId)
  }

  /**
   * Discard every list (used when the account data space switches).
   *
   * topicId auto-increments separately in each account's database, so after switching databases
   * the same id may point at a different topic; without clearing, the previous account's plan
   * would be shown on the new account's conversation.
   */
  reset(): void {
    this.itemsByTopic.clear()
  }
}

/**
 * Process-level singleton: shared across requests, used by the Runtime and main-process broadcasts
 */
export const todoStore = new TodoStore()

/**
 * Build the todo tool set (the closure binds topicId so the list belongs to the current
 * conversation)
 */
export function buildTodoTools(store: TodoStore, topicId: number): StructuredToolInterface[] {
  const todoSchema = z.object({
    content: z.string().describe('Content of the todo item'),
    status: z
      .enum(['pending', 'in_progress', 'completed'])
      .describe(
        'Status. Mark an item completed in the same batch that finishes it; in_progress means you are working on it right now'
      ),
    activeForm: z
      .string()
      .optional()
      .describe('Present-tense phrasing of the work in progress (the action being performed now)')
  })

  return [
    tool(
      async ({ todos }) => {
        const normalized = todos.map((t) => ({
          content: t.content,
          status: t.status ?? 'pending',
          activeForm: t.activeForm
        }))
        store.set(topicId, normalized)
        return JSON.stringify({ todos: store.get(topicId) })
      },
      {
        name: 'write_todos',
        description:
          'Write or update the todo list for the current task. The list is a live status board the user watches, not a plan you fill in at the end — it replaces the previous list entirely, so always send the whole list. For multi-step work, list every todo up front (all pending), then advance one item at a time: set an item to in_progress the moment you start it, set it to completed in the same write that finishes it, and only then start the next item. Never batch the status changes at the end of the turn. Before you write the final answer of a turn, send one last write_todos with the final state: every item you finished must be completed, and no item may stay in_progress — the only exception is when you are genuinely handing control back to the user mid-work (for example you are asking a question and waiting for the answer).',
        schema: z.object({
          todos: z.array(todoSchema).describe('The todo list (replaces the previous list entirely)')
        })
      }
    ),
    tool(
      async () => {
        return JSON.stringify({ todos: store.get(topicId) })
      },
      {
        name: 'read_todos',
        description:
          'Read the todo list for the current task. If it still shows an in_progress item that you have actually finished, fix it with write_todos.',
        schema: z.object({})
      }
    )
  ]
}
