import type { HarnessDialogueUsageRow } from '../../../../shared/harness/types'

/**
 * Dialogue usage normalization (real data, no estimation).
 *
 * The input/output/total columns of harness_dialogue_usage are **whole-round cumulative
 * values**, while the raw usage_metadata of each call is stored in the usage_metadata
 * column (a JSON array) — fields such as cache hits and reasoning tokens are named
 * differently across providers, so they are all normalized here for the "usage for this
 * round" panel.
 */

/** Normalized details (a missing field hides that row; no guessing, no fake data) */
export interface UsageDetails {
  route: string | null
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  calls: number
  hasCache: boolean
  hasReasoning: boolean
}

/** One call in the raw details */
interface RawUsageEntry {
  model?: string
  subagent?: boolean
  usage?: Record<string, unknown>
}

function pickNumber(source: unknown, keys: string[]): number | null {
  if (!source || typeof source !== 'object') return null
  const record = source as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

/** Cache read: the legacy implementation used input_token_details.cache_read; raw fields from every provider are covered here */
function pickCacheRead(usage: Record<string, unknown>): number {
  return (
    pickNumber(usage.input_token_details, ['cache_read', 'cacheRead', 'cached_tokens']) ??
    pickNumber(usage.prompt_tokens_details, ['cached_tokens', 'cache_read']) ??
    pickNumber(usage, ['cache_read_input_tokens', 'prompt_cache_hit_tokens', 'cached_tokens']) ??
    0
  )
}

/** Cache write (present for Anthropic-family providers; 0 otherwise) */
function pickCacheWrite(usage: Record<string, unknown>): number {
  return (
    pickNumber(usage.input_token_details, ['cache_creation', 'cache_write', 'cacheWrite']) ??
    pickNumber(usage, ['cache_creation_input_tokens']) ??
    0
  )
}

/** Reasoning tokens (in the output details) */
function pickReasoning(usage: Record<string, unknown>): number {
  return (
    pickNumber(usage.output_token_details, ['reasoning', 'reasoning_tokens']) ??
    pickNumber(usage.completion_tokens_details, ['reasoning_tokens']) ??
    pickNumber(usage, ['reasoning_tokens']) ??
    0
  )
}

/** Context size of one call = that call's prompt + output (providers measure differently; normalized only, never estimated) */
function entryContextTokens(usage: Record<string, unknown>): number {
  const input = pickNumber(usage, ['input_tokens', 'prompt_tokens']) ?? 0
  const output = pickNumber(usage, ['output_tokens', 'completion_tokens']) ?? 0
  // For OpenAI / DeepSeek, prompt_tokens already includes cache hits, so the cache details
  // are just a subset of it; for Anthropic, cache_read / cache_creation come on top of
  // input_tokens and must be added, or the context would be undercounted by half — decide
  // by which shape appears in the details.
  const cacheIsSubsetOfInput =
    pickNumber(usage.prompt_tokens_details, ['cached_tokens']) !== null ||
    pickNumber(usage, ['prompt_cache_hit_tokens']) !== null
  const extra = cacheIsSubsetOfInput ? 0 : pickCacheRead(usage) + pickCacheWrite(usage)
  return Math.max(0, input + extra + output)
}

/** Raw usage of the last model call in a usage row (topic summaries use it to compute "how big the current context is") */
function lastCallUsage(row: HarnessDialogueUsageRow): Record<string, unknown> | null {
  if (!row.usage_metadata) return null
  try {
    const parsed = JSON.parse(row.usage_metadata)
    if (!Array.isArray(parsed) || parsed.length === 0) return null
    const last = parsed[parsed.length - 1] as RawUsageEntry
    return (last?.usage as Record<string, unknown>) ?? null
  } catch {
    return null
  }
}

/**
 * Topic-level usage summary (used by the status bar under the input box; one row per
 * assistant reply, accumulated over the whole topic).
 *
 * A field that cannot be read is null, and the UI **omits that item** accordingly — e.g.
 * no context ring when the model profile has no context_window, and nothing at all when
 * an old session has no usage details. No estimation is done here.
 */
export interface UsageSummary {
  /** Accumulated tokens for the whole session */
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  calls: number
  /** Cache hit rate 0..1; null when there are no input tokens */
  cacheHitRate: number | null
  /** Context size of the most recent model call; null without details */
  contextTokens: number | null
}

/** Accumulate all usage rows of a topic into the shape the status bar needs; null when there are no rows */
export function buildUsageSummary(rows: HarnessDialogueUsageRow[]): UsageSummary | null {
  if (!rows || rows.length === 0) return null

  let totalTokens = 0
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let calls = 0
  let contextTokens: number | null = null

  for (const row of rows) {
    const details = buildUsageDetails(row)
    if (!details) continue
    totalTokens += details.totalTokens
    inputTokens += details.inputTokens
    outputTokens += details.outputTokens
    cacheReadTokens += details.cacheReadTokens
    cacheWriteTokens += details.cacheWriteTokens
    calls += details.calls
    const lastUsage = lastCallUsage(row)
    if (lastUsage) contextTokens = entryContextTokens(lastUsage)
  }

  // No token was ever reported (old session / failed request) → hide the whole thing rather than show a row of 0s
  if (totalTokens === 0) return null

  return {
    totalTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    calls,
    cacheHitRate: inputTokens > 0 ? cacheReadTokens / inputTokens : null,
    contextTokens
  }
}

/** Compact counts for the status bar: 912 / 2.5k / 845k / 2.5M (exact values live in the "usage for this round" panel) */
export function formatCompactTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value >= 1_000_000) {
    const millions = value / 1_000_000
    return `${millions >= 10 ? Math.round(millions) : millions.toFixed(1).replace(/\.0$/, '')}M`
  }
  if (value >= 1_000) {
    const thousands = value / 1_000
    return `${thousands >= 100 ? Math.round(thousands) : thousands.toFixed(1).replace(/\.0$/, '')}k`
  }
  return String(Math.round(value))
}

/** Accumulate a usage row (including the usage_metadata JSON array) into the shape the panel needs */
export function buildUsageDetails(usage: HarnessDialogueUsageRow | undefined): UsageDetails | null {
  if (!usage) return null
  let entries: RawUsageEntry[] = []
  try {
    const parsed = usage.usage_metadata ? JSON.parse(usage.usage_metadata) : []
    if (Array.isArray(parsed)) entries = parsed as RawUsageEntry[]
  } catch {
    entries = []
  }

  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let reasoningTokens = 0
  let model = usage.model ?? null
  for (const entry of entries) {
    const raw = entry?.usage ?? {}
    cacheReadTokens += pickCacheRead(raw)
    cacheWriteTokens += pickCacheWrite(raw)
    reasoningTokens += pickReasoning(raw)
    if (!model && entry?.model) model = entry.model
  }

  // Prefer the accumulated columns in the database for token counts (they work without details); fall back to summing the details only when missing
  const inputTokens =
    usage.input_tokens ??
    entries.reduce((sum, entry) => sum + (pickNumber(entry?.usage, ['input_tokens']) ?? 0), 0)
  const outputTokens =
    usage.output_tokens ??
    entries.reduce((sum, entry) => sum + (pickNumber(entry?.usage, ['output_tokens']) ?? 0), 0)

  return {
    route: [usage.provider, model].filter(Boolean).join('/') || null,
    inputTokens,
    outputTokens,
    totalTokens: usage.total_tokens ?? inputTokens + outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    calls: usage.calls ?? entries.length,
    hasCache: cacheReadTokens > 0 || cacheWriteTokens > 0,
    hasReasoning: reasoningTokens > 0
  }
}
