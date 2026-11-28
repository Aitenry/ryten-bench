/**
 * Turn reconciliation: decide whether a "still generating" screen is actually a dead turn.
 *
 * Background (production 2026-11-28, topic 6): the renderer lost the whole event stream — chunks
 * *and* the final `done`. The main process ran the turn to completion and persisted it, so nothing
 * was running any more, but the screen kept showing "generating…" and the stop button stayed lit.
 *
 * Why that is possible at all: `isLoading` (and each bubble's `loading` flag) is only ever cleared
 * by a stream event — done / error / user stop / queue rollback. Nothing reconciles it with the
 * main process, and the stream is a one-way pipe with no replay, so one missed `done` is enough to
 * leave the UI spinning forever.
 *
 * The main process's turn state (`harness-turn-state` → `harnessQueue.isTurnActive`) is the only
 * witness that survives a lost stream. This module holds the pure part: how many consecutive
 * "not running" answers are needed before believing it, and which persisted row belongs to this
 * turn.
 */

/** Poll interval used by the renderer watchdog (ms) */
export const TURN_RECONCILE_POLL_MS = 4000

/**
 * How long a topic must have been continuously marked "generating" before reconciliation may act.
 *
 * Purpose: a goal round chain and a queued-message chain end one turn and begin the next with only
 * a few milliseconds in between, and `isTurnActive` is false in that gap. Acting on a single
 * observation would cut a running turn short; requiring a second of stability (and several strikes)
 * makes that gap harmless.
 */
export const TURN_RECONCILE_MIN_LOADING_MS = 15000

/** Consecutive "not running" polls required before settling (see the gap note above) */
export const TURN_RECONCILE_STRIKES = 3

/**
 * Tolerance when matching a persisted row to a turn start (ms).
 *
 * The DB timestamp comes from the database clock at persist time (always *after* the turn started);
 * the tolerance only absorbs sub-second clock skew so a row written right at the start still matches.
 */
export const TURN_RECONCILE_START_TOLERANCE_MS = 5000

export interface TurnReconcileInput {
  /** Main process says a turn is running for this topic */
  active: boolean
  /** How long the renderer has shown this topic as generating (ms, monotonic within one load) */
  loadingForMs: number
  /** Consecutive polls that already answered "not running" */
  inactiveStrikes: number
  /**
   * Age of the last stream activity for this turn (ms, `lastChunkAt` falling back to the bubble's
   * creation time). Optional: when provided, a turn whose data is still arriving is never settled —
   * the final guard against this window ever cutting a genuinely live turn short.
   */
  msSinceLastChunk?: number
}

export interface TurnReconcileDecision {
  /** Updated strike counter to remember for the next poll */
  strikes: number
  /** The turn is over and the renderer missed it: settle the bubble now */
  settle: boolean
}

/**
 * One reconciliation step.
 *
 * - `active` → the turn really is running: reset the counter, never settle;
 * - inactive → count a strike; settle only once the count reaches
 *   {@link TURN_RECONCILE_STRIKES} **and** the topic has been generating for at least
 *   {@link TURN_RECONCILE_MIN_LOADING_MS}.
 */
export function nextTurnReconcile(input: TurnReconcileInput): TurnReconcileDecision {
  if (input.active) return { strikes: 0, settle: false }
  const strikes = input.inactiveStrikes + 1
  const silent = input.msSinceLastChunk === undefined || input.msSinceLastChunk >= TURN_RECONCILE_MIN_LOADING_MS
  const settle =
    strikes >= TURN_RECONCILE_STRIKES &&
    input.loadingForMs >= TURN_RECONCILE_MIN_LOADING_MS &&
    silent
  return { strikes, settle }
}

/** Minimal shape of a persisted dialogue row this module needs */
export interface PersistedTurnRow {
  id: number
  role: string
  content: string
  blocks: string | null
  created_at: string | null
}

/**
 * Pick the row that belongs to the turn that started at `startedAtMs`.
 *
 * Only an **assistant** row whose `created_at` is at/after the turn start (minus tolerance) can be
 * this turn's answer: a lost stream may have persisted nothing at all, and attaching a previous
 * turn's message to the empty card would silently show stale content as the new answer. Rows with
 * an unparseable timestamp are skipped for the same reason — "cannot prove" must not become "assume".
 *
 * Returns the newest qualifying row, or `null` when the turn persisted nothing.
 */
export function pickPersistedTurn(
  rows: readonly PersistedTurnRow[],
  startedAtMs: number
): PersistedTurnRow | null {
  const floor = startedAtMs - TURN_RECONCILE_START_TOLERANCE_MS
  let best: { row: PersistedTurnRow; at: number } | null = null
  for (const row of rows) {
    if (row.role !== 'assistant') continue
    const at = row.created_at ? Date.parse(row.created_at) : Number.NaN
    if (!Number.isFinite(at)) continue
    if (at < floor) continue
    if (!best || at >= best.at) best = { row, at }
  }
  return best ? best.row : null
}
