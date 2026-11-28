import { useEffect, useRef, useState } from 'react'
import { harnessApi } from '../../api/harness'

/**
 * Fetching logic for "the question / approval pending on **this conversation right now**" (shared by
 * three dialogs: generic question, resume with another model, sandbox approval).
 *
 * Why broadcasts alone are not enough (user requirement 2026-09-28 "it stays stuck; once another
 * conversation takes over, approval behaves the same way — pending items should be isolated per
 * conversation, and the popup should appear only when you click that conversation"):
 * - A broadcast is sent **once** — if the user is in another conversation when the question is
 *   raised, that question is never received: the main process is still waiting for an answer, the
 *   tool card keeps showing "running…", and the whole turn hangs;
 * - Conversely, a broadcast with no conversation boundary pops up conversation B's approval while
 *   the user is in conversation A, and the answer lands on someone else;
 * - Clearing `setPending(null)` indiscriminately when a stream ends/errors also wrongly closes an
 *   item pending in **another topic**.
 *
 * So there are only two jobs here, both keyed by **topic**:
 * 1. Broadcasts are accepted only for the current topic (questions from other conversations don't
 *    pop up; they are fetched once the user clicks back);
 * 2. **Switching topics (including the first mount) refetches once by topic** — the main process is
 *    the only source of truth (`getPending(topicId)`), so "the popup appears only when you click a
 *    different conversation" holds naturally, and a page reload doesn't lose it.
 *
 * Returns the item pending for the current topic (null if none) and a `clear()` (so the dialog
 * collapses immediately after the user submits an answer/decision, without another IPC round trip).
 */
export function useTopicPending<T extends { topicId: number; requestId: string }>(options: {
  /** Currently displayed topic (null = blank conversation, nothing pops up) */
  currentTopicId: number | null
  /** Main process fetches the pending item by topic (single source of truth) */
  fetchPending: (topicId: number) => Promise<T | null>
  /** Broadcast subscription for new pending items (returns the unsubscribe function) */
  subscribe: (listener: (pending: T) => void) => () => void
  /** Additional filter (e.g. the generic question dialog must ignore the kind='model-recovery' item) */
  accept?: (pending: T) => boolean
}): { pending: T | null; clear: () => void } {
  const { currentTopicId, fetchPending, subscribe, accept } = options
  const [pending, setPending] = useState<T | null>(null)

  // Callbacks go in refs: all three dialogs pass inline arrow functions, which would unsubscribe/resubscribe on every render if in the dependency array
  const fetchRef = useRef(fetchPending)
  fetchRef.current = fetchPending
  const acceptRef = useRef(accept)
  acceptRef.current = accept

  const topicRef = useRef(currentTopicId)
  topicRef.current = currentTopicId

  /** Reconcile once by topic (topic switches, mounts and turn ends all go through it) */
  const syncForTopic = (topicId: number | null): void => {
    if (topicId == null) {
      setPending(null)
      return
    }
    void fetchRef
      .current(topicId)
      .then((view) => {
        // The user may have switched away by the time it resolves: only accept results for the same conversation
        if (topicRef.current !== topicId) return
        // Fetched items must pass the same filter: otherwise the generic question dialog grabs the
        // "resume with another model" item (the broadcast path filtered but the fetch path didn't,
        // and the inconsistency produces duplicate / misplaced popups)
        if (view && acceptRef.current && !acceptRef.current(view)) {
          setPending(null)
          return
        }
        setPending(view ?? null)
      })
      .catch(() => {
        // When the channel is unavailable (plugin disabled/reloading) keep the current state
      })
  }

  // Broadcasts: accept only the current topic
  useEffect(
    () =>
      subscribe((view) => {
        if (view.topicId !== topicRef.current) return
        if (acceptRef.current && !acceptRef.current(view)) return
        setPending(view)
      }),
    [subscribe]
  )

  // Topic switch / first mount: fetch the item currently pending on that topic (clear if none)
  useEffect(() => {
    syncForTopic(currentTopicId)
  }, [currentTopicId, fetchPending])

  // Current topic's turn ended -> reconcile again (question/approval is settled with the turn, so the
  // popup shouldn't stay on screen; another conversation's stream ending is unrelated to the current
  // popup — indiscriminate clearing used to close the current conversation's pending question by mistake)
  useEffect(() => {
    const onSettled = (payload?: { topicId?: number }): void => {
      const settled = typeof payload?.topicId === 'number' ? payload.topicId : null
      if (settled != null && settled !== topicRef.current) return
      syncForTopic(topicRef.current)
    }
    const offDone = harnessApi.harness.onStreamDone(onSettled)
    const offError = harnessApi.harness.onStreamError(onSettled)
    return () => {
      offDone()
      offError()
    }
  }, [])

  return { pending, clear: () => setPending(null) }
}
