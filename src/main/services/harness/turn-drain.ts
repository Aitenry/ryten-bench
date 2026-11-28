import type { QueuedMessage } from './queue-store'

/**
 * Continuation loop for queued messages (pure logic, so assertions can run directly in `tests/`).
 *
 * Semantics (matches the product rule "a message sent while generating continues automatically once this turn ends"):
 *  - Strict FIFO: a turn ends → take the head → send it as a new turn → that turn ends → take the head again…
 *    The old implementation stopped after one continuation (the continuation turn's own teardown never triggered
 *    another continuation), so the second and later queued messages could never be sent;
 *  - No preemption: if the topic still has a running turn, or a goal auto-continuation is running, do not
 *    continue (leave it to whoever is finishing);
 *  - User abort: queued messages after that turn stay in the queue and are not continued automatically (avoiding
 *    "it starts running again after stop");
 *  - Turn start failure: record an error and stop, without infinite retries (the queue content is still there,
 *    visible to and deletable by the user).
 *
 * The loop cap is only defensive (normally the queue length or the four termination conditions above end it).
 */

/** Continuation loop dependencies (real implementation in ipc/harness/harness.ts, fakes in tests) */
export interface DrainTurnDeps {
  /** Whether a turn is already running on the topic */
  isTurnActive: () => boolean
  /** Whether a goal auto-continuation is running */
  isGoalRunning: () => boolean
  /** Whether queued messages remain */
  hasPending: () => boolean
  /** Take one item from the head (taking consumes it) */
  shift: () => QueuedMessage | null
  /** Send it as a new turn and wait for that turn to end (cancelled=true means the user aborted) */
  runTurn: (item: QueuedMessage) => Promise<{ cancelled: boolean } | null>
  /** About to continue an item (for logging) */
  onContinue?: (item: QueuedMessage, index: number) => void
  /** Starting a turn threw (log it and stop continuing) */
  onError?: (error: unknown, item: QueuedMessage) => void
  /** Defensive cap (50 turns by default) */
  maxTurns?: number
}

/**
 * Continue queued messages one by one; returns the number of turns actually started.
 *
 * Note: the caller must ensure "the previous turn has finished" (the turn registration is cleared),
 * otherwise the first check in the loop exits immediately.
 */
export async function drainPendingTurns(deps: DrainTurnDeps): Promise<number> {
  const maxTurns = deps.maxTurns ?? 50
  let drained = 0

  while (drained < maxTurns) {
    if (deps.isTurnActive()) break
    if (deps.isGoalRunning()) break
    if (!deps.hasPending()) break
    const item = deps.shift()
    if (!item) break

    deps.onContinue?.(item, drained)
    let outcome: { cancelled: boolean } | null
    try {
      outcome = await deps.runTurn(item)
    } catch (error) {
      deps.onError?.(error, item)
      break
    }
    // The user aborted this turn: remaining queued messages stay in the queue until the user sends again
    if (!outcome || outcome.cancelled) break
    drained += 1
  }

  return drained
}
