import { useCallback, useEffect, useRef, useState } from 'react'
import { harnessApi } from '../../api/harness'

/**
 * The two non-streaming end states of a conversation's run status (the 16px indicator slot at the
 * start of a sidebar row).
 *
 * User requirement 2026-11-23 (verbatim): "this is currently the in-progress icon; when the user
 * needs to confirm an action, this icon should become a yellow dot breathing; after the user
 * confirms, the icon should go back to in-progress; when the task completes, the in-progress icon
 * should become a green dot breathing, and when the user clicks this conversation, the green dot
 * disappears."
 *
 * The sources of truth for the three states are deliberately kept separate:
 * - **Running** is not here: that is `loadingTopicIds` in `useHarnessHandlers` (the main process
 *   stream lifecycle);
 * - **Awaiting confirmation** (yellow): the main process broadcasts once each when a question /
 *   approval is raised and settled (`harness-topic-pending`); this hook only records which topics
 *   are currently pending;
 * - **Just completed** (green): lit when a turn **finishes naturally** (`turnFinal.settled`) and
 *   cleared when the user opens that conversation; **it is not lit when that conversation is
 *   currently shown in the conversation window** — per the user requirement 2026-11-23 "if this is
 *   the current conversation window, remove it automatically after the task completes", the user is
 *   watching the result appear, so an extra green dot is only noise.
 *
 * Why not infer "completed" from `loadingTopicIds` disappearing: a turn can end three ways (finished
 * naturally / user stopped / model failed), and all three look identical once loading goes away; the
 * green dot the user wants belongs only to **actually finished**, so the criterion is the turnFinal
 * sent by the main process with the done event, not a frontend guess.
 *
 * The green dot is also **not persisted**: it is a temporary "you haven't looked at this
 * conversation yet" hint that means nothing after the app is closed; after a restart every
 * conversation begins in the quiet state of "not running, nobody waiting, no new result".
 */

/** Set form of the two marks (looked up by topicId for a row start) */
export interface TopicRunStatusMarks {
  /** Conversations with a pending question / approval waiting for user confirmation */
  awaitingTopicIds: Set<number>
  /** Conversations that just finished naturally and were not in the conversation window at that time (green dot) */
  completedTopicIds: Set<number>
}

export interface TopicRunStatusOptions {
  /**
   * Whether this conversation is currently displayed in the conversation window (= the current
   * conversation).
   *
   * If so, no green dot is lit when it finishes (equivalent to "remove automatically after
   * completion"); it must be a function rather than a snapshot value: a turn can run for a long
   * time, and which conversation the user is in at completion time must be read from the ref at that
   * moment, not from a value captured during render.
   */
  isTopicActive?: (topicId: number) => boolean
}

/** The four appearances of the conversation row start indicator (the value is also written to the DOM's data-topic-status, which tests assert on) */
export type TopicRunStatus = 'idle' | 'running' | 'awaiting' | 'completed'

/**
 * Combine the three sources into the final row start status (the priority order is the one in the
 * user requirement):
 *
 * 1. `awaiting` (breathing yellow dot) — while a question / approval is pending the flow is
 *    **stopped** and waiting on a human, which deserves to be seen more than "running";
 * 2. `running` (chase dots) — the main process stream is running;
 * 3. `completed` (breathing green dot) — finished naturally and not opened yet;
 * 4. `idle` — the 16px row start slot stays empty.
 */
export function resolveTopicRunStatus(input: {
  awaiting: boolean
  running: boolean
  completed: boolean
}): TopicRunStatus {
  if (input.awaiting) return 'awaiting'
  if (input.running) return 'running'
  if (input.completed) return 'completed'
  return 'idle'
}

export interface TopicRunStatusApi extends TopicRunStatusMarks {
  /** A new turn begins (user sends / goal continues): clear this conversation's yellow and green dots, back to "running" */
  beginTopicTurn: (topicId: number) => void
  /** The user opened this conversation: the green dot disappears (the yellow one stays — it means "still waiting for you" and shouldn't be wiped by a glance) */
  acknowledgeTopic: (topicId: number) => void
  /** The conversation was deleted: clear both marks so a reused id doesn't get attributed to another conversation */
  forgetTopic: (topicId: number) => void
}

/**
 * Add/remove an id in a Set, **returning the original set when the value didn't change**.
 *
 * During streaming, done / error events may arrive repeatedly (multiple listeners, interjection
 * splitting the turn); creating a new Set every time would re-render the whole sidebar, so the same
 * Set reference short-circuits updates that change nothing.
 */
function withFlag(set: Set<number>, topicId: number, present: boolean): Set<number> {
  if (set.has(topicId) === present) return set
  const next = new Set(set)
  if (present) next.add(topicId)
  else next.delete(topicId)
  return next
}

export function useTopicRunStatus(options: TopicRunStatusOptions = {}): TopicRunStatusApi {
  const [awaitingTopicIds, setAwaitingTopicIds] = useState<Set<number>>(() => new Set())
  const [completedTopicIds, setCompletedTopicIds] = useState<Set<number>>(() => new Set())

  // "Which conversation is current" goes in a ref: when the completion event arrives we need the
  // window contents **at that moment**, not a stale value captured during render (a turn can run for
  // minutes, during which the user may switch away or back)
  const isTopicActiveRef = useRef(options.isTopicActive)
  isTopicActiveRef.current = options.isTopicActive

  // Persistent subscriptions (independent of the current topic): when another conversation pends /
  // finishes, that row start must update too. All three channels dispatch through Sets, so they
  // don't interfere with useTopicPending's popup subscription or the per-turn stream subscriptions.
  useEffect(() => {
    const api = harnessApi.harness
    const offPending = api.onTopicPending(({ topicId, pending }) => {
      if (!Number.isFinite(topicId) || topicId <= 0) return
      setAwaitingTopicIds((prev) => withFlag(prev, topicId, pending))
      // Waiting on a human again = the previous "just completed" has been superseded by a new turn, so the green dot shouldn't stay lit
      if (pending) setCompletedTopicIds((prev) => withFlag(prev, topicId, false))
    })

    const offDone = api.onStreamDone((result) => {
      const topicId = result.topicId
      if (!Number.isFinite(topicId) || topicId <= 0) return
      // This turn has wrapped up: however it ended, nothing can still be pending confirmation
      setAwaitingTopicIds((prev) => withFlag(prev, topicId, false))
      /**
       * The green dot is only for "finished naturally":
       * - `settled=false` = the user clicked stop / the render frame was invalidated (errors have
       *   their own stream-error path);
       * - `goalWillContinue=true` = the goal will automatically continue with the next round, so this
       *   turn's done is not the endpoint (the goal-driver emits the next round's goalRound chunk
       *   right after, and lighting it would flicker);
       * - **this conversation is currently shown in the conversation window** = the user is
       *   watching the result appear, so don't light a green dot (completed equals automatically
       *   removed, and any stale old green dot is cleared on the way).
       */
      if (result.turnFinal?.settled && result.turnFinal.goalWillContinue !== true) {
        const activeNow = isTopicActiveRef.current?.(topicId) ?? false
        setCompletedTopicIds((prev) => withFlag(prev, topicId, !activeNow))
      }
    })

    const offError = api.onStreamError(({ topicId }) => {
      if (typeof topicId !== 'number' || !Number.isFinite(topicId) || topicId <= 0) return
      // On error the main process may follow up with a done (without turnFinal): clear "awaiting confirmation" first, but don't light the green dot
      setAwaitingTopicIds((prev) => withFlag(prev, topicId, false))
    })

    return () => {
      offPending()
      offDone()
      offError()
    }
  }, [])

  const beginTopicTurn = useCallback((topicId: number): void => {
    setAwaitingTopicIds((prev) => withFlag(prev, topicId, false))
    setCompletedTopicIds((prev) => withFlag(prev, topicId, false))
  }, [])

  const acknowledgeTopic = useCallback((topicId: number): void => {
    setCompletedTopicIds((prev) => withFlag(prev, topicId, false))
  }, [])

  const forgetTopic = useCallback((topicId: number): void => {
    setAwaitingTopicIds((prev) => withFlag(prev, topicId, false))
    setCompletedTopicIds((prev) => withFlag(prev, topicId, false))
  }, [])

  return {
    awaitingTopicIds,
    completedTopicIds,
    beginTopicTurn,
    acknowledgeTopic,
    forgetTopic
  }
}
