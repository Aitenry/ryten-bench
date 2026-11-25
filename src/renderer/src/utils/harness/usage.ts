import type { HarnessDialogueUsageRow } from '../../../../shared/harness/types'

/**
 * 对话用量的归一化（真实数据，不做任何估算）。
 *
 * harness_dialogue_usage 的 input/output/total 是**整轮累加值**，而每次调用的原始
 * usage_metadata 存在 usage_metadata 列（JSON 数组）里——缓存命中、推理 token
 * 这类字段各家命名不同，统一在这里兜住，供「本轮用量」面板展示。
 */

/** 归一化后的明细（字段缺失就不显示对应行，不猜也不补假数据） */
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

/** 原始明细里的一次调用 */
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

/** 缓存读取：旧实现用 input_token_details.cache_read，各家原始字段一并兜住 */
function pickCacheRead(usage: Record<string, unknown>): number {
  return (
    pickNumber(usage.input_token_details, ['cache_read', 'cacheRead', 'cached_tokens']) ??
    pickNumber(usage.prompt_tokens_details, ['cached_tokens', 'cache_read']) ??
    pickNumber(usage, ['cache_read_input_tokens', 'prompt_cache_hit_tokens', 'cached_tokens']) ??
    0
  )
}

/** 缓存写入（Anthropic 系有；没有就是 0） */
function pickCacheWrite(usage: Record<string, unknown>): number {
  return (
    pickNumber(usage.input_token_details, ['cache_creation', 'cache_write', 'cacheWrite']) ??
    pickNumber(usage, ['cache_creation_input_tokens']) ??
    0
  )
}

/** 推理 token（输出明细里） */
function pickReasoning(usage: Record<string, unknown>): number {
  return (
    pickNumber(usage.output_token_details, ['reasoning', 'reasoning_tokens']) ??
    pickNumber(usage.completion_tokens_details, ['reasoning_tokens']) ??
    pickNumber(usage, ['reasoning_tokens']) ??
    0
  )
}

/** 一次调用的上下文规模 = 该次提示 + 输出（各家口径不同，这里只做归一化，不估算） */
function entryContextTokens(usage: Record<string, unknown>): number {
  const input = pickNumber(usage, ['input_tokens', 'prompt_tokens']) ?? 0
  const output = pickNumber(usage, ['output_tokens', 'completion_tokens']) ?? 0
  // OpenAI / DeepSeek 系的 prompt_tokens 已含缓存命中，缓存明细只是它的子集；
  // Anthropic 系的 input_tokens 之外另有 cache_read / cache_creation，必须补上，
  // 否则上下文会被算少一半——按明细里出现的是哪一种来判定。
  const cacheIsSubsetOfInput =
    pickNumber(usage.prompt_tokens_details, ['cached_tokens']) !== null ||
    pickNumber(usage, ['prompt_cache_hit_tokens']) !== null
  const extra = cacheIsSubsetOfInput ? 0 : pickCacheRead(usage) + pickCacheWrite(usage)
  return Math.max(0, input + extra + output)
}

/** 一行用量里最后一次模型调用的原始 usage（话题汇总用它算「当前上下文多大」） */
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
 * 话题级用量汇总（输入框底栏的状态条用它；一条助手回复一行，按话题整段累加）。
 *
 * 字段拿不到就是 null，界面据此**不画那一项**——例如模型档案没填 context_window
 * 就不画上下文圆环，老会话没有 usage 明细就整条不显示。这里不做任何估算。
 */
export interface UsageSummary {
  /** 整段会话累计 token */
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  calls: number
  /** 缓存命中率 0..1；没有输入 token 时为 null */
  cacheHitRate: number | null
  /** 最近一次模型调用的上下文规模；没有明细时为 null */
  contextTokens: number | null
}

/** 把话题下的所有用量行累加成状态条需要的形状；一行都没有则返回 null */
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

  // 一条都没回传 token（老会话 / 请求失败）→ 整条不显示，而不是显示一排 0
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

/** 状态条里的紧凑计数：912 / 2.5k / 845k / 2.5M（精确值留给「本轮用量」面板） */
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

/** 把用量行（含 usage_metadata JSON 数组）累加成面板需要的形状 */
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

  // token 计数优先用库里的累加列（没有明细时也能显示），缺失时才退回明细求和
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
