/**
 * 模型用量（真实 token）采集与归集。
 *
 * 数据来源：模型响应上的 `usage_metadata`（LangChain 统一字段）。
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
