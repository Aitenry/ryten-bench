/**
 * **Pure logic** for the background job output buffer (zero imports, loadable directly by node for
 * offline regression).
 *
 * Why a separate file: a running job's output frames must be bounded (a long-running dev server
 * emits many frames per second, otherwise main-process memory grows without bound), and pruning the
 * oldest frames must roll the `job_output` consumer cursor back by the same amount — these two are
 * easy to let drift apart in later changes, so they must be assertable offline. jobs.ts only wires
 * it to the registry.
 */

/** Output buffer state (jobs.ts's JobRecord structurally satisfies it) */
export interface FramedOutputState {
  /** Output frames (each frame is a chunk of text; joined by frameSeparator) */
  outputFrames: string[]
  /** Frame position already read by job_output */
  cursor: number
  /** Total number of buffered characters (O(1) check for whether pruning is needed) */
  bufferedChars: number
}

/** Buffer caps */
export interface FrameCapLimits {
  maxChars: number
  maxFrames: number
}

/**
 * Append a frame and prune to the caps: on overflow drop the oldest frames from the head and roll
 * the cursor back by the same number of frames (so the relative position of "already read" vs
 * "unread" does not shift because of pruning).
 *
 * @returns Number of frames actually dropped (0 means nothing was pruned)
 */
export function appendFrameWithinCap(
  state: FramedOutputState,
  text: string,
  limits: FrameCapLimits
): number {
  state.outputFrames.push(text)
  state.bufferedChars += text.length
  let dropped = 0
  while (
    state.outputFrames.length > 0 &&
    (state.outputFrames.length > limits.maxFrames || state.bufferedChars > limits.maxChars)
  ) {
    const removed = state.outputFrames.shift() as string
    state.bufferedChars -= removed.length
    state.cursor = Math.max(0, state.cursor - 1)
    dropped += 1
  }
  return dropped
}
