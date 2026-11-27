/**
 * 压缩压力判定（纯函数，无 electron / 数据库依赖，便于单测）。
 *
 * 两套口径，**真实 token 优先**：
 *
 * 1. `tokenBased`：上一轮模型调用实际回传的上下文 token（prompt + 输出）÷ 模型上下文窗口。
 *    它把系统提示词、工具 schema、注入的记忆一起算进去——那才是模型真正看到的占用。
 *    触发阈值 [`TOKEN_PRESSURE_RATIO`] = 79%，给本轮回复 + 工具结果留 21%。
 * 2. `charBased`（兜底）：历史字符 ÷ 字符预算，阈值由调用方传（现为 0.7）。
 *    只有拿不到 `usage_metadata`（模型/网关不回传 token）时才用。中英混排下
 *    1 字符 ≈ 0.3~1.2 token，这条口径只是保守近似，不能反映系统提示词的固定开销。
 */

/** 真实 token 压力阈值：上下文达到模型窗口的 79% 即压缩 */
export const TOKEN_PRESSURE_RATIO = 0.79

/** 单次摘要调用的转录字符上限（相对窗口再收敛，见 history.ts 的 chunkLimit 计算） */
export const COMPACTION_CHUNK_CHARS = 120_000

export interface ContextPressureInput {
  /** 可回放历史的字符总量（不含系统提示词） */
  totalChars: number
  /** 字符预算（当前模型窗口按 1 字符 ≈ 1 token 换算，见 IPC 层的 contextBudget） */
  maxChars: number
  /** 字符口径的触发阈值（0.7） */
  charThreshold: number
  /** 上一轮模型调用真实上下文规模（token）；拿不到为 null/undefined */
  measuredContextTokens?: number | null
  /** 当前模型上下文窗口（token）；未知为 null/undefined */
  contextWindowTokens?: number | null
}

export interface ContextPressure {
  /** 字符口径压力（0..n） */
  charRatio: number
  /** 真实 token 口径压力；拿不到为 null */
  tokenRatio: number | null
  /** 实际生效的压力值与阈值（token 可用时取 token 口径） */
  ratio: number
  threshold: number
  /** 本次判定是否走真实 token */
  tokenBased: boolean
  triggered: boolean
}

/**
 * 判定本轮是否该做摘要压缩。
 *
 * token 数据不完整（任一侧缺失或为 0）时整条退回字符口径——不做混合加权：
 * 两种口径量纲不同，混在一起既说不清也测不准。
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
 * 把一串条目按字符上限切成**连续**的若干块（不重排、不拆单条）。
 *
 * 用途：token 口径下触发得比字符口径晚，待压缩的历史可能是旧实现的数倍；
 * 一次性塞进摘要模型会超窗，切成块后逐块增量合并（既有摘要当 priorSummary）。
 * 单条记录本身超限时仍单独成块——宁可一条超一点，也不能把一条消息切成两半。
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
