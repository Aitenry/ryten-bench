/**
 * Collection and aggregation of model usage (real tokens).
 *
 * Data source: `usage_metadata` on the model response (a unified field with the same shape as the
 * previous implementation).
 *  - Some providers nest it under `response_metadata.usage` / `response_metadata.tokenUsage`;
 *    both are handled here;
 *  - A single turn may involve several model round trips (tool loop), so one record is collected
 *    **per call**, accumulated into turn totals when persisted, and the raw details are kept as a
 *    JSON array.
 */

/** Usage record for a single model call */
export interface ModelUsageRecord {
  /** Raw usage_metadata object (input/output/total tokens plus provider-specific details) */
  usage: Record<string, unknown>
  /** Model name (taken from the response if present, otherwise the currently bound model) */
  model?: string
  /** Whether it comes from a subagent (subagent graphs share callModel with the main graph) */
  subagent?: boolean
}

/** Accumulated result for a full turn */
export interface UsageTotals {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  calls: number
  /** Whether token numbers were found in the details (the frontend hides usage when none exist) */
  hasTokens: boolean
}

/** Read a numeric field (names differ across providers; try them in priority order) */
function pickNumber(source: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

/**
 * Extract usage_metadata from a model response.
 * Returns null when nothing can be extracted — **no estimation**; it is better to hide usage in
 * the frontend.
 */
export function extractUsageMetadata(response: unknown): Record<string, unknown> | null {
  const message = response as {
    usage_metadata?: Record<string, unknown> | null
    response_metadata?: Record<string, unknown> | null
  } | null
  const direct = message?.usage_metadata
  if (direct && typeof direct === 'object' && Object.keys(direct).length > 0) return direct
  const meta = message?.response_metadata
  if (meta && typeof meta === 'object') {
    for (const key of ['usage', 'tokenUsage', 'usage_metadata']) {
      const candidate = (meta as Record<string, unknown>)[key]
      if (candidate && typeof candidate === 'object' && Object.keys(candidate).length > 0) {
        return candidate as Record<string, unknown>
      }
    }
  }
  return null
}

/** Accumulate the details of several calls into full-turn totals */
export function sumUsage(records: ModelUsageRecord[]): UsageTotals {
  let inputTokens = 0
  let outputTokens = 0
  let totalTokens = 0
  let hasTokens = false
  for (const record of records) {
    const usage = record.usage
    const input =
      pickNumber(usage, ['input_tokens', 'prompt_tokens', 'promptTokens']) ??
      pickNumber(usage, ['inputTokens'])
    const output =
      pickNumber(usage, ['output_tokens', 'completion_tokens', 'completionTokens']) ??
      pickNumber(usage, ['outputTokens'])
    const total = pickNumber(usage, ['total_tokens', 'totalTokens'])
    if (input !== null) {
      inputTokens += input
      hasTokens = true
    }
    if (output !== null) {
      outputTokens += output
      hasTokens = true
    }
    totalTokens += total ?? (input ?? 0) + (output ?? 0)
  }
  return { inputTokens, outputTokens, totalTokens, calls: records.length, hasTokens }
}

/* ── Context size (for compression pressure) ─────────────────────────────── */

function objectOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

/**
 * Cache reads: OpenAI records prompt_tokens_details.cached_tokens; Anthropic-style providers use
 * a separate field
 */
function cacheReadOf(usage: Record<string, unknown>): number {
  const inputDetails = objectOf(usage.input_token_details)
  const promptDetails = objectOf(usage.prompt_tokens_details)
  return (
    (inputDetails ? pickNumber(inputDetails, ['cache_read', 'cacheRead', 'cached_tokens']) : null) ??
    (promptDetails ? pickNumber(promptDetails, ['cached_tokens', 'cache_read']) : null) ??
    pickNumber(usage, ['cache_read_input_tokens', 'prompt_cache_hit_tokens', 'cached_tokens']) ??
    0
  )
}

/** Cache writes (Anthropic-style providers have them; otherwise 0) */
function cacheWriteOf(usage: Record<string, unknown>): number {
  const inputDetails = objectOf(usage.input_token_details)
  return (
    (inputDetails
      ? pickNumber(inputDetails, ['cache_creation', 'cache_write', 'cacheWrite'])
      : null) ?? pickNumber(usage, ['cache_creation_input_tokens']) ?? 0
  )
}

/**
 * Context size of a single model call (tokens) = that call's prompt + that call's output.
 *
 * Uses the same accounting as `entryContextTokens` in the renderer's `utils/harness/usage.ts`:
 * for OpenAI / DeepSeek-style providers prompt_tokens already includes cache hits (the details
 * are only a subset and must not be added again), while Anthropic-style providers have cache_read
 * / cache_creation on top of input_tokens, which must be added.
 *
 * Compression decisions use this instead of character counts: it covers the system prompt, tool
 * schemas, and injected memory — the actual occupancy the model sees.
 */
export function contextTokensOf(usage: Record<string, unknown>): number {
  const input =
    pickNumber(usage, ['input_tokens', 'prompt_tokens', 'promptTokens', 'inputTokens']) ?? 0
  const output =
    pickNumber(usage, ['output_tokens', 'completion_tokens', 'completionTokens', 'outputTokens']) ??
    0
  const promptDetails = objectOf(usage.prompt_tokens_details)
  const cacheIsSubsetOfInput =
    (promptDetails ? pickNumber(promptDetails, ['cached_tokens', 'cache_read']) : null) !== null ||
    pickNumber(usage, ['prompt_cache_hit_tokens']) !== null
  const extra = cacheIsSubsetOfInput ? 0 : cacheReadOf(usage) + cacheWriteOf(usage)
  return Math.max(0, input + extra + output)
}

/** Minimal row shape that provides a usage_metadata column (database rows satisfy it naturally) */
export interface UsageMetadataCarrier {
  usage_metadata: string | null
}

/**
 * Context size (tokens) of the most recent model call in a topic.
 *
 * Usage rows are ordered by ascending id (one row per turn), and the row's `usage_metadata` is a
 * JSON array holding each call of that turn; only the **last entry** is the most recent call —
 * earlier prompts are smaller and say nothing about how full the context is now.
 * If the last row cannot be parsed, step back one row; return null when nothing is available
 * (callers then fall back to the character-based measure).
 */
export function lastCallContextTokens(rows: UsageMetadataCarrier[]): number | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const raw = rows[i]?.usage_metadata
    if (!raw) continue
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed) || parsed.length === 0) continue
      const last = objectOf(parsed[parsed.length - 1])
      const usage = objectOf(last?.usage)
      if (!usage) continue
      const tokens = contextTokensOf(usage)
      if (tokens > 0) return tokens
    } catch {
      // Corrupt row details: keep looking at older rows instead of falling back to characters
    }
  }
  return null
}
