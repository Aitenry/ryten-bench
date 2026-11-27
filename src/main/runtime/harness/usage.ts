/**
 * 模型用量（真实 token）采集与归集。
 *
 * 数据来源：模型响应上的 `usage_metadata`（与旧实现同形的统一字段）。
 *  - 部分供应商放在 `response_metadata.usage` / `response_metadata.tokenUsage`，这里一并兜住；
 *  - 一轮对话可能发生多次模型往返（工具循环），所以采集的是**每次调用一条**，
 *    落库时再累加成整轮总量，原始明细以 JSON 数组保留。
 */

/** 单次模型调用的用量记录 */
export interface ModelUsageRecord {
  /** usage_metadata 原始对象（input_tokens / output_tokens / total_tokens / … 各家可能还有明细） */
  usage: Record<string, unknown>
  /** 模型名（响应里带的优先，其次取当前绑定的模型） */
  model?: string
  /** 是否来自子代理（子代理图与主图共用 callModel） */
  subagent?: boolean
}

/** 整轮累加结果 */
export interface UsageTotals {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  calls: number
  /** 明细里是否真的取到了 token 数字（全都没有时前端不显示用量） */
  hasTokens: boolean
}

/** 取数字字段（各家命名不一，按优先级兜） */
function pickNumber(source: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

/**
 * 从模型响应里抽 usage_metadata。
 * 抽不到就返回 null——**不估算**，宁可前端不显示用量。
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

/** 把若干次调用的明细累加成整轮总量 */
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

/* ── 上下文规模（压缩压力用） ───────────────────────────────────────────── */

function objectOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

/** 缓存读取：OpenAI 记在 prompt_tokens_details.cached_tokens，Anthropic 系单列 */
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

/** 缓存写入（Anthropic 系有；没有就是 0） */
function cacheWriteOf(usage: Record<string, unknown>): number {
  const inputDetails = objectOf(usage.input_token_details)
  return (
    (inputDetails
      ? pickNumber(inputDetails, ['cache_creation', 'cache_write', 'cacheWrite'])
      : null) ?? pickNumber(usage, ['cache_creation_input_tokens']) ?? 0
  )
}

/**
 * 单次模型调用的上下文规模（token）= 该次 prompt + 该次输出。
 *
 * 与渲染层 `utils/harness/usage.ts` 的 `entryContextTokens` 同口径：
 * OpenAI / DeepSeek 系的 prompt_tokens 已含缓存命中（明细只是子集，不能再加），
 * Anthropic 系的 input_tokens 之外另有 cache_read / cache_creation，必须补上。
 *
 * 压缩判定用它而不是字符数：它包含系统提示词、工具 schema、注入记忆，
 * 就是模型真正看到的占用。
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

/** 能提供 usage_metadata 列的最小行形态（数据库行天然满足） */
export interface UsageMetadataCarrier {
  usage_metadata: string | null
}

/**
 * 话题最近一次模型调用的上下文规模（token）。
 *
 * 用量行按 id 升序（一轮一行），行内 `usage_metadata` 是该轮每次调用的 JSON 数组，
 * **最后一条**才是最近一次调用——前面几次的 prompt 更小，对「现在多满」没有参考价值。
 * 最后一行解析不出来就往前退一行；全都拿不到返回 null（调用方退回字符口径）。
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
      // 该行明细坏了：继续找更早的一行，不因为一条脏数据退回字符口径
    }
  }
  return null
}
