/**
 * Tool-call loop guard: detects repeated calls with the same tool + same arguments that make **no
 * observable progress**.
 *
 * Why a cumulative count cannot be used (user incident on 2026-11-23): the plugin workshop's four
 * tools inherently "run again with the same arguments" — `plugin_build` / `plugin_verify` use the
 * same id every round, and `plugin_publish install` retries with the same id after a fix. The old
 * implementation counted identical-argument calls across the **whole conversation** (blocking on
 * the third one), so the model was judged a loop as soon as it re-ran after editing the code and
 * could only sit there stuck. What should be blocked is "the call did not change state": the same
 * arguments **produce the same result**, which means the call advanced nothing and repeating it is
 * pointless.
 *
 * Rules (any hit blocks the **next** call):
 * 1. **Identical result**: the same key produces exactly the same output `identicalResultLimit`
 *    times in a row (default 3) — other tool calls may happen in between; any change in the result
 *    (source/state changed) resets the count;
 * 2. **Consecutive same call**: the same key appears `consecutiveLimit` times in a row (default 4),
 *    a backstop for the extreme case where "the result keeps changing but the call spins in place".
 *
 * Pure logic, zero dependencies, so an offline harness can import it directly (see
 * `test/verify-repeat-guard.mjs`).
 */

/** Block reason (selects the message shown to the model) */
export type RepeatBlockReason = 'identical-result' | 'consecutive'

/** One block decision */
export interface RepeatVerdict {
  blocked: boolean
  reason?: RepeatBlockReason
  /** How many times it already happened when the block fired (shows the model "how often") */
  count: number
}

export interface RepeatGuardOptions {
  /** Max consecutive identical results for one call (block the next one once reached) */
  identicalResultLimit?: number
  /** Max consecutive occurrences of one call (block the next one once reached) */
  consecutiveLimit?: number
}

export const DEFAULT_IDENTICAL_RESULT_LIMIT = 3
export const DEFAULT_CONSECUTIVE_LIMIT = 4

/** Per-key history (only the minimal state the decision needs, so long sessions keep no outputs) */
interface KeyState {
  /** Digest of the previous result */
  lastDigest: string
  /** Consecutive identical results */
  identicalRun: number
}

/**
 * Strip noise from the output that changes on every run but does not mean progress: durations and
 * timestamps.
 *
 * Without this, a loop like "verification failed -> retry publish" would look like "progress"
 * because the report's `1234ms` differs every time and the guard would never fire. Only
 * definitely meaningless formats are erased; file sizes, failed items and error codes are left
 * alone — if those change, something really changed.
 */
function normalizeOutput(text: string): string {
  return text
    .replace(/\d+(?:\.\d+)?\s?ms\b/g, '<ms>')
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, '<time>')
    // The spill-file locator is a new UUID every time (differs even with identical content), so
    // it cannot count as progress
    .replace(
      /spill-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.txt/gi,
      'spill-<id>.txt'
    )
}

/**
 * Stable digest: FNV-1a 32-bit plus length.
 *
 * Only used to decide "are these two outputs the same"; not for security. Mixing in the length
 * makes collisions between different content negligible, and it uses far less memory than keeping
 * the whole tool output. Outputs are usually a few KB to 20KB, so O(n) is cheap.
 */
function digest(text: string): string {
  const normalized = normalizeOutput(text)
  let hash = 0x811c9dc5
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${normalized.length}:${(hash >>> 0).toString(36)}`
}

export class RepeatGuard {
  private readonly identicalResultLimit: number
  private readonly consecutiveLimit: number
  private readonly states = new Map<string, KeyState>()
  private lastKey: string | undefined
  private consecutive = 0

  constructor(options: RepeatGuardOptions = {}) {
    this.identicalResultLimit = Math.max(
      2,
      Math.floor(options.identicalResultLimit ?? DEFAULT_IDENTICAL_RESULT_LIMIT)
    )
    this.consecutiveLimit = Math.max(
      2,
      Math.floor(options.consecutiveLimit ?? DEFAULT_CONSECUTIVE_LIMIT)
    )
  }

  /**
   * Decide before execution whether this call should be blocked.
   *
   * Only records that have **already happened** are consulted: the first call is never blocked, so
   * the guard cannot harm the normal first step.
   */
  check(key: string): RepeatVerdict {
    const state = this.states.get(key)
    if (state && state.identicalRun >= this.identicalResultLimit) {
      return { blocked: true, reason: 'identical-result', count: state.identicalRun }
    }
    if (key === this.lastKey && this.consecutive >= this.consecutiveLimit) {
      return { blocked: true, reason: 'consecutive', count: this.consecutive }
    }
    return { blocked: false, count: state?.identicalRun ?? 0 }
  }

  /** Record the result after execution (do not call this for blocked calls: no new state) */
  record(key: string, output: string): void {
    const next = digest(output)
    const state = this.states.get(key)
    // "Did this call produce anything new": the first call is no progress, later ones need a change
    const changed = state !== undefined && state.lastDigest !== next
    if (!state) {
      this.states.set(key, { lastDigest: next, identicalRun: 1 })
    } else if (state.lastDigest === next) {
      state.identicalRun += 1
    } else {
      // Same call, different result = state was advanced (even only the build duration) -> recount
      state.lastDigest = next
      state.identicalRun = 1
    }

    /**
     * Another tool produced a **new result** = world state changed (sources edited, verification
     * passed again...): clear the "unchanged" counters of the other entries so previously blocked
     * calls get another try.
     *
     * Without this there is a deadlock: publish gets rejected 3 times in a row and is then blocked
     * -> the model edits code and re-verifies, but publish's counter is still at 3, so the same
     * (now succeeding) install call can never get in.
     */
    if (changed) {
      for (const [otherKey, other] of this.states) {
        if (otherKey !== key) other.identicalRun = 0
      }
    }

    if (key === this.lastKey) {
      this.consecutive += 1
    } else {
      this.lastKey = key
      this.consecutive = 1
    }
  }

  /** Clear all state (graph instance reuse / tests) */
  reset(): void {
    this.states.clear()
    this.lastKey = undefined
    this.consecutive = 0
  }
}

/**
 * Block message for the model.
 *
 * It deliberately names "if you just edited sources, build/verify first instead of retrying the
 * install" — that is the most common wrong retry in the plugin workshop; a vague "stop repeating"
 * would not help the model find the next step.
 */
export function repeatGuardMessage(toolName: string, verdict: RepeatVerdict): string {
  const what =
    verdict.reason === 'identical-result'
      ? `has returned the identical result ${verdict.count} times for exactly the same arguments, so calling it again cannot change anything`
      : `has been called ${verdict.count} times in a row with exactly the same arguments and is making no progress`
  const workshopHint = toolName.startsWith('plugin_')
    ? ' If you just edited plugin sources, run plugin_build and then plugin_verify; if plugin_publish was refused, fix the reason it stated instead of retrying it.'
    : ''
  return (
    `The tool "${toolName}" ${what}.${workshopHint} ` +
    `Do not repeat this call: change the inputs/files involved, or stop and report what you already know.`
  )
}
