/**
 * 观测清理（observation masking）策略 — 纯函数，无 IO / 无 electron 依赖，便于单测。
 *
 * 行业结论（Anthropic context editing、Gemini CLI、JetBrains《The Complexity Trap》）：
 * 旧工具结果占历史 token 的绝大部分，但模型真正需要的是「做过什么、结论是什么」，
 * 不是原始字节。最安全、最便宜的压缩就是**保留工具调用结构、把旧结果内容换成占位符**
 * ——绝不删消息本身（`tool_calls` 与工具结果必须成对，删一侧直接 400）。
 *
 * 本模块只回答一个问题：给定按时间排列的对话（含各自的工具调用），哪些工具结果可以清？
 * 具体替换成什么文本、怎么写回消息，由 history.ts 负责。
 */

/** 可清理的工具：结果可重放/可复现，丢了还能再读一次 */
export const MASKABLE_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'grep',
  'glob',
  'ls',
  'execute',
  'web_fetch'
])

export interface ObservationMaskPolicy {
  /** 最近这么多**工具调用**原样保留（Anthropic 平台默认 keep=3，工程上 8 更稳） */
  keepToolPairs: number
  /** 最近这么多**用户回合**内的工具结果原样保留（同一任务链往往跨多轮） */
  keepUserTurns: number
  /** 小于这个字符数的结果不清：省不下多少，反而增加噪声 */
  minChars: number
}

export const DEFAULT_OBSERVATION_POLICY: ObservationMaskPolicy = {
  keepToolPairs: 8,
  keepUserTurns: 2,
  minChars: 500
}

export interface MaskableToolCall {
  name: string
  /** 该工具结果的字符数（缺省/空结果传 0） */
  chars: number
}

export interface MaskableDialogue {
  role: 'user' | 'assistant'
  tools: MaskableToolCall[]
}

export interface ObservationMaskPlan {
  /** 对话下标 → 该对话内要清理的工具下标集合 */
  masked: Map<number, Set<number>>
  /** 被清理的结果条数 */
  maskedCount: number
  /** 被清理结果的原始字符总数（不含占位符） */
  maskedChars: number
}

/**
 * 计算清理计划。
 *
 * 保护边界：从最新一条对话往前累计，直到「用户回合数 ≥ keepUserTurns」且
 * 「工具调用数 ≥ keepToolPairs」同时满足；边界**含**该条对话（一起保留）。
 * 边界之前的对话里，属于 [`MASKABLE_TOOLS`] 且长度 ≥ `minChars` 的结果才清。
 *
 * 为什么按「对话行」切而不是按消息切：在本项目的数据模型里，一条 assistant 对话行
 * 带着它自己的全部 tool_calls 与结果，行与行之间切永远不会拆散配对。
 */
export function planObservationMask(
  dialogues: MaskableDialogue[],
  policy: Partial<ObservationMaskPolicy> = {}
): ObservationMaskPlan {
  const merged: ObservationMaskPolicy = { ...DEFAULT_OBSERVATION_POLICY, ...policy }
  const keepTurns = Math.max(0, merged.keepUserTurns)
  const keepPairs = Math.max(0, merged.keepToolPairs)
  const minChars = Math.max(0, merged.minChars)

  let userTurns = 0
  let toolCalls = 0
  let boundary = 0
  for (let i = dialogues.length - 1; i >= 0; i--) {
    if (dialogues[i].role === 'user') userTurns++
    toolCalls += dialogues[i].tools.length
    if (userTurns >= keepTurns && toolCalls >= keepPairs) {
      boundary = i
      break
    }
  }

  const masked = new Map<number, Set<number>>()
  let maskedCount = 0
  let maskedChars = 0
  for (let i = 0; i < boundary; i++) {
    const tools = dialogues[i].tools
    if (tools.length === 0) continue
    const set = new Set<number>()
    for (let t = 0; t < tools.length; t++) {
      const tool = tools[t]
      if (!MASKABLE_TOOLS.has(tool.name)) continue
      if (tool.chars < minChars) continue
      set.add(t)
      maskedCount++
      maskedChars += tool.chars
    }
    if (set.size > 0) masked.set(i, set)
  }

  return { masked, maskedCount, maskedChars }
}
