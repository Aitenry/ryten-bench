import type { TodoItem, TodoStore } from './todo'

/**
 * Close-out convergence for the conversation todo list (write_todos) — the fallback for
 * "no item stays in progress once this turn ends".
 *
 * Why it is needed: the list is written by the model itself, and its final write is unreliable.
 * Instance from 2026-09-18: all six items were finished and the answer was delivered, yet the
 * last write_todos still left one item in_progress, so the card was stuck forever at
 * "5/6 completed · 1 in progress"; it is even more visible under goal auto-continuation — the
 * final round marks the goal complete, but nobody closes out that remaining item (user,
 * 2026-09-23: "the task is clearly done, but the page still shows one last task unfinished").
 *
 * There is only one criterion: **will another round take over this list after the current turn**.
 *   - Yes (goal active + armed, the driver is about to dispatch the next round) → leave it alone,
 *     the list is left to the model to keep maintaining;
 *   - No (user turn ended, goal completed/blocked/disarmed, or the round left behind by a stop or
 *     an error) → close it out in place.
 *
 * "The turn was stopped / the stream failed" also closes out: nothing is running then, and a
 * lingering spinner showing "in progress" is a fake state that the frontend would read back from
 * the store after the app restarts. Close-out only touches this in-process cache (nothing is
 * persisted), so the model's planning ability is unaffected (the next write_todos overwrites the
 * whole list anyway).
 */

/**
 * External facts needed for the decision (all injected by the caller: this module touches no DB,
 * goal storage or question service)
 */
export interface CloseOutSources {
  /**
   * Whether this turn was taken over by the goal auto-continuation driver (source === 'goal-round')
   */
  isGoalRound: boolean
  /**
   * Whether the topic's goal will still auto-continue another round (active + armed, under the
   * round cap)
   */
  goalWillContinue: () => Promise<boolean>
  /**
   * Whether the topic has a question waiting for an answer (the model is waiting for the user, so
   * the task is genuinely still mid-flight)
   */
  hasPendingQuestion: () => boolean
}

/**
 * Close-out decision: whether to close out, and if not, why (the reason goes to the log so it is
 * easy to trace why the card was not closed)
 */
export type CloseOutDecision =
  { close: true } | { close: false; reason: 'pending-question' | 'goal-continues' }

/**
 * Close-out decision (pure logic + two async queries, no side effects; the fixture
 * test/verify-todo-closeout.mjs runs the real code directly).
 *
 * Pending question takes priority: while the model has a question open, no close-out happens on any
 * round — it is waiting for the user's answer, so the task is genuinely unfinished.
 */
export async function decideCloseOutOnTurnEnd(sources: CloseOutSources): Promise<CloseOutDecision> {
  if (sources.hasPendingQuestion()) return { close: false, reason: 'pending-question' }
  if (sources.isGoalRound && (await sources.goalWillContinue())) {
    return { close: false, reason: 'goal-continues' }
  }
  return { close: true }
}

/** Close-out result: completion counts after convergence (null when nothing was written) */
export interface CloseOutResult {
  /** Number of "in progress" items closed by this run */
  closed: number
  /** Number of completed items in the list after convergence */
  completed: number
  /** Total number of items in the list */
  total: number
}

/**
 * Close items still in in_progress as completed (returns null when there are none, so no extra
 * broadcast is produced).
 *
 * Writes go through store.set, so onChange fires as usual → the harness-todos-updated broadcast,
 * and the task card above the composer switches from "1 in progress" to "all done".
 */
export function closeOutInProgress(store: TodoStore, topicId: number): CloseOutResult | null {
  const todos = store.get(topicId)
  const running = todos.filter((t) => t.status === 'in_progress')
  if (running.length === 0) return null
  const closed: TodoItem[] = todos.map((t) =>
    t.status === 'in_progress' ? { ...t, status: 'completed' as const, activeForm: undefined } : t
  )
  store.set(topicId, closed)
  return {
    closed: running.length,
    completed: closed.filter((t) => t.status === 'completed').length,
    total: closed.length
  }
}
