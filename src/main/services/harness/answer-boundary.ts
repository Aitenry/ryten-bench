/**
 * The **single source of truth** for the "final answer" boundary of a turn (protocol layer).
 *
 * Why a separate module: this logic used to live in the renderer (AssistantMessage scanned
 * blocks backwards using `segIndex === lastSegIndex && !message.loading`), which was
 * **heuristic** — it guessed "is this turn over?" from the renderer's own loading state, and
 * loading only flips after `harness-stream-done`. During goal auto-continuation the driver is
 * `while (await driveOnce())` (see goal-driver.ts), so the previous turn's done and the next
 * turn's goalRound land almost in the same tick; waiting for loading to flip false then
 * effectively means waiting for the whole goal to finish, and the last round's reasoning and
 * answer stay inside the task segment.
 *
 * Now the main process decides at the moment content arrives:
 *   - The producer tags every answer/reasoning chunk with `answer: true` (no tool/subagent
 *     activity in this turn yet);
 *   - Once tool or subagent activity appears, all subsequent content is tagged
 *     `answer: false` (retracting the earlier mark: what came before was only exploration, not
 *     the answer delivered to the user this turn);
 *   - The real boundary `answerFrom` is derived by this module from the accumulated blocks and
 *     sent with the done event; the renderer only reads it, never guesses.
 *
 * Definition of the "final answer" (consistent with the renderer's block order — both append
 * in arrival order):
 *   From the end of the block array, consecutive reasoning / text blocks — valid only if it
 *   contains at least one text block.
 *   Tool cards break the backtrack (reasoning separated by tools is not contiguous with the
 *   trailing answer), so the boundary only lands at the start of the last non-tool stretch.
 */

/** Minimal shape participating in the "answer tail" (common subset of main-process accumulated blocks and renderer merged blocks) */
export interface AnswerBlockLike {
  type: string
}

/**
 * Count the blocks in the "final answer" from the tail of the block array (0 = no answer this
 * turn).
 *
 * This is the **wire contract**: the main process's accumulated blocks and the renderer's merged
 * blocks have the same order (both append in arrival order), but their counts may differ (the
 * renderer merges adjacent reasoning and has transition blocks that exist only there), so what
 * crosses the wire is the **count**, not indices — the renderer counts the same number of blocks
 * backwards from the end of its own array and need not assume index alignment.
 *
 * @param blocks Accumulated blocks for this turn (main-process acc.blocks / renderer merged blocks)
 */
export function answerTrailingCount(blocks: readonly AnswerBlockLike[]): number {
  let cut = blocks.length
  let sawText = false
  while (cut > 0) {
    const type = blocks[cut - 1]?.type
    if (type === 'text') {
      sawText = true
      cut -= 1
      continue
    }
    if (type === 'reasoning') {
      cut -= 1
      continue
    }
    break
  }
  // If the stretch ends with reasoning (turn aborted, etc.) it does not count: nothing was
  // delivered to the user, so leave it in the collapsed section and do not move a message with
  // no answer outside the fold.
  return sawText ? blocks.length - cut : 0
}

/**
 * End-of-turn markers (sent with `harness-stream-done`).
 *
 * The main process already has all these facts when finalizing (see the finalization check in
 * ipc/harness.ts); they used to go only to the log, so the frontend could not see them and the
 * renderer had to guess from loading.
 */
export interface TurnFinal {
  /** Whether this stream finished naturally (false = user stop / render-frame invalidation abort; errors are reported separately via stream-error) */
  settled: boolean
  /** Whether this turn is a goal auto-continuation round */
  goalRound: boolean
  /** Goal round number (undefined for non-goal turns) */
  round?: number
  /** Whether the goal was already complete when the turn ended */
  goalClosed?: boolean
  /** Whether another round will be auto-dispatched (false = the UI can be sure this is the last round) */
  goalWillContinue?: boolean
  /** Start index of the final answer in the **main-process accumulated blocks** (null = no answer this turn) */
  answerFrom: number | null
  /** Number of blocks in the final answer (the renderer counts backwards from the end of its own array; see answerTrailingCount for the wire contract) */
  answerBlocks: number
}
