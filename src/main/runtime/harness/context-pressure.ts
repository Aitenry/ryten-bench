/**
 * Compaction pressure decision (pure function, no electron/database dependencies, easy to unit test).
 *
 * Two measures, **real tokens preferred**:
 *
 * 1. `tokenBased`: context tokens actually reported by the previous model call (prompt + output)
 *    divided by the model context window. This counts the system prompt, tool schemas and injected
 *    memory together — what the model really sees. The trigger threshold
 *    [`TOKEN_PRESSURE_RATIO`] is 79%, leaving 21% for this round's reply plus tool results.
 * 2. `charBased` (fallback): history characters divided by the character budget, with the threshold
 *    passed by the caller (currently 0.7). Used only when `usage_metadata` is unavailable (the
 *    model/gateway does not report tokens). With mixed Chinese/English text 1 character is about
 *    0.3-1.2 tokens, so this is a conservative approximation and cannot reflect the fixed cost of
 *    the system prompt.
 */

/** Real-token pressure threshold: compact when context reaches 79% of the model window */
export const TOKEN_PRESSURE_RATIO = 0.79

/** Transcript character limit for one summary call (further bounded relative to the window; see the chunkLimit computation in history.ts) */
export const COMPACTION_CHUNK_CHARS = 120_000

export interface ContextPressureInput {
  /** Total characters of replayable history (excluding the system prompt) */
  totalChars: number
  /** Character budget (the model window converted at 1 character ~ 1 token; see contextBudget in the IPC layer) */
  maxChars: number
  /** Character-based trigger threshold (0.7) */
  charThreshold: number
  /** Real context size of the previous model call (tokens); null/undefined when unavailable */
  measuredContextTokens?: number | null
  /** Current model context window (tokens); null/undefined when unknown */
  contextWindowTokens?: number | null
}

export interface ContextPressure {
  /** Character-based pressure (0..n) */
  charRatio: number
  /** Real-token pressure; null when unavailable */
  tokenRatio: number | null
  /** The pressure value and threshold actually in effect (token measure when tokens are available) */
  ratio: number
  threshold: number
  /** Whether this decision used real tokens */
  tokenBased: boolean
  triggered: boolean
}

/**
 * Decide whether this round should run summary compaction.
 *
 * When token data is incomplete (either side missing or 0) fall back entirely to the character
 * measure — no mixed weighting: the two measures have different dimensions, and mixing them is
 * neither explainable nor measurable.
 */
export function decideContextPressure(input: ContextPressureInput): ContextPressure {
  const charRatio = input.maxChars > 0 ? input.totalChars / input.maxChars : 0
  const window = input.contextWindowTokens ?? null
  const measured = input.measuredContextTokens ?? null
  const tokenRatio =
    measured !== null && measured > 0 && window !== null && window > 0 ? measured / window : null

  if (tokenRatio !== null) {
    return {
      charRatio,
      tokenRatio,
      ratio: tokenRatio,
      threshold: TOKEN_PRESSURE_RATIO,
      tokenBased: true,
      triggered: tokenRatio >= TOKEN_PRESSURE_RATIO
    }
  }
  return {
    charRatio,
    tokenRatio: null,
    ratio: charRatio,
    threshold: input.charThreshold,
    tokenBased: false,
    triggered: charRatio >= input.charThreshold
  }
}

/**
 * Split items into **contiguous** chunks by a character limit (no reordering, no splitting a
 * single item).
 *
 * Purpose: the token measure triggers later than the character measure, so the history to compact
 * can be several times larger than before; feeding it to the summarizer in one go would overflow
 * the window, so chunks are merged incrementally (the existing summary as priorSummary). An
 * oversized single item still forms its own chunk — better to exceed slightly than to cut a
 * message in half.
 */
export function chunkByChars<T>(items: T[], charsOf: (item: T) => number, limit: number): T[][] {
  const safeLimit = Math.max(1, limit)
  const chunks: T[][] = []
  let current: T[] = []
  let currentChars = 0
  for (const item of items) {
    const size = Math.max(0, charsOf(item))
    if (current.length > 0 && currentChars + size > safeLimit) {
      chunks.push(current)
      current = []
      currentChars = 0
    }
    current.push(item)
    currentChars += size
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}
