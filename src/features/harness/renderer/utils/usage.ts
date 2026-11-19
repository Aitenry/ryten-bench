import type { HarnessDialogueUsageRow } from '../../shared/types'

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

/** 缓存读取：LangChain 用 input_token_details.cache_read，各家原始字段一并兜住 */
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
