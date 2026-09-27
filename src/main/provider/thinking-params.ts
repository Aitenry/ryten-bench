/**
 * 思考（thinking）与推理等级（reasoning effort）参数适配 —— 只负责「把统一设置翻译成各家参数」。
 *
 * 「哪些协议支持哪种参数」的判定在 shared/model-params（设置界面提示与主进程注入同源），
 * 这里只做参数组装：
 *
 * 思考模式（开/关）：
 * - Anthropic（含自定义端点的 Anthropic 兼容协议）：thinking.type = enabled/disabled
 *   （enabled 必须带 budget_tokens，且要小于 max_tokens）
 * - Ollama：think = true/false
 * - Google Gemini / Vertex：thinkingConfig.thinkingBudget（-1 动态预算 / 0 关闭）
 * - DeepSeek / 智谱 GLM / 火山方舟：thinking.type = enabled/disabled
 * - OpenRouter：reasoning.enabled = true/false
 * - 阿里云百炼 / 硅基流动 / Moonshot / 腾讯混元：enable_thinking = true/false
 * - 其余（OpenAI / xAI / Groq / Mistral / Bedrock / Cloudflare / LM Studio…）：
 *   未适配，一律不注入——宁可不生效，也不往请求体里塞对方不认识的字段导致 400
 *
 * 推理等级（档位来自模型档案 capabilities.reasoning_effort_levels）：
 * - OpenAI 兼容族（OpenAI / xAI / DeepSeek / 智谱 / 火山 / 阿里 / 硅基 / 月之暗面 / 腾讯）：
 *   请求体 `reasoning_effort`（DeepSeek、智谱官方文档均为此字段）；
 *   其中「思考由 thinking.type / enable_thinking 开关」的协议顺带把开关翻到与档位一致
 *   （none = 放弃思考，其余档位 = 开启思考），避免同一请求里开关与档位自相矛盾
 * - OpenRouter：`reasoning.effort`
 * - Anthropic：`output_config.effort`（none 走 thinking.type = disabled）
 * - Gemini / Vertex：`thinkingConfig.thinkingLevel`（none 走 thinkingBudget = 0）
 * - Ollama：`think`（none = false，low/medium/high 直接给档位，其余档位 = true）
 * - 未适配的协议只记录不下发（设置界面会给出「仅记录」提示）
 *
 * 优先级：同一请求里档位与模式冲突时**档位优先**（档位是更具体的设置），
 * 因此实现上先按 mode 组装、再用 effort 覆盖同名键。
 */

import {
  defaultReasoningEffort,
  resolveReasoningFamily,
  resolveThinkingFamily,
  type ThinkingMode
} from '../../shared/model-params'

/** Anthropic 扩展思考的预算下限（Anthropic 要求 >= 1024） */
const ANTHROPIC_MIN_BUDGET = 1024
/** Anthropic 扩展思考的预算上限（不设更高，避免吃掉输出预算） */
const ANTHROPIC_MAX_BUDGET = 4096

export interface ThinkingParamsInput {
  /** 供应商协议标识（大小写不敏感） */
  provider: string
  /** 自定义端点是否走 Anthropic 兼容协议 */
  anthropicFormat?: boolean
  mode: ThinkingMode
  /**
   * 推理等级：null / undefined / 空串 = 用户没选。
   * 没选时按模型档案的档位表取「中等思考」兜底（见 defaultReasoningEffort）；
   * 连档位表都没有（模型没有思考档位）就不下发任何档位参数。
   */
  effort?: string | null
  /** 该模型档案声明的档位表（models-profile 的 capabilities.reasoning_effort_levels） */
  effortLevels?: readonly string[] | null
  /** 当前生效的输出上限（max_tokens 列，或模型档案的输出上限） */
  maxTokens: number | null
}

export interface ThinkingParams {
  /** 直接并入 LangChain 构造参数的字段（Anthropic / Ollama / Google 用类字段接收） */
  fields?: Record<string, unknown>
  /** 需要并入请求体的额外参数（OpenAI 兼容族走 modelKwargs） */
  modelKwargs?: Record<string, unknown>
}

/** 参数累加器：fields / modelKwargs 两层都是「后写覆盖先写」 */
interface ParamsAccumulator {
  fields: Record<string, unknown>
  modelKwargs: Record<string, unknown>
  touched: boolean
}

/** Anthropic 扩展思考预算：卡在 [1024, 4096] 且必须小于 max_tokens */
function anthropicBudget(maxTokens: number | null): number {
  const cap = maxTokens ?? ANTHROPIC_MAX_BUDGET + ANTHROPIC_MIN_BUDGET
  return Math.max(ANTHROPIC_MIN_BUDGET, Math.min(ANTHROPIC_MAX_BUDGET, cap - ANTHROPIC_MIN_BUDGET))
}

/** 归一化档位：统一小写去空格（档案与界面都可能给出不同写法） */
function normalizeEffort(effort: string | null | undefined): string {
  return String(effort ?? '')
    .trim()
    .toLowerCase()
}

/** 思考模式（开/关）参数：auto 与未适配的供应商都不写任何键 */
function applyThinkingMode(acc: ParamsAccumulator, input: ThinkingParamsInput): void {
  const { mode, provider, anthropicFormat = false, maxTokens } = input
  if (mode === 'auto') return

  const on = mode === 'on'

  switch (resolveThinkingFamily(provider, anthropicFormat)) {
    case 'anthropic': {
      if (!on) {
        acc.fields.thinking = { type: 'disabled' }
        acc.touched = true
        return
      }
      const budget = anthropicBudget(maxTokens)
      // 开启思考必须留出比预算更大的输出额度，否则接口直接拒绝
      acc.fields.thinking = { type: 'enabled', budget_tokens: budget }
      if (maxTokens == null || maxTokens <= budget) {
        acc.fields.maxTokens = budget + ANTHROPIC_MIN_BUDGET
      }
      acc.touched = true
      return
    }

    case 'ollama':
      acc.fields.think = on
      acc.touched = true
      return

    case 'google':
      acc.fields.thinkingConfig = on
        ? { thinkingBudget: -1, includeThoughts: true }
        : { thinkingBudget: 0 }
      acc.touched = true
      return

    case 'thinking-type':
      acc.modelKwargs.thinking = { type: on ? 'enabled' : 'disabled' }
      acc.touched = true
      return

    case 'openrouter':
      acc.modelKwargs.reasoning = { enabled: on }
      acc.touched = true
      return

    case 'enable-thinking':
      acc.modelKwargs.enable_thinking = on
      acc.touched = true
      return

    default:
      return
  }
}

/** 推理等级参数：未设置档位且模型有档位表时按「中等思考」兜底；没有档位表就什么都不写 */
function applyReasoningEffort(acc: ParamsAccumulator, input: ThinkingParamsInput): void {
  const explicit = normalizeEffort(input.effort)
  // 思考被显式关掉时不兜底：用户要的就是「别思考」，别在这里把它又打开
  const fallback = input.mode === 'off' ? null : defaultReasoningEffort(input.effortLevels)
  const effort = explicit || (fallback ?? '')
  if (!effort) return

  const { provider, anthropicFormat = false } = input
  const family = resolveReasoningFamily(provider, anthropicFormat)
  if (family === 'none') return

  const off = effort === 'none'
  const thinkingFamily = resolveThinkingFamily(provider, anthropicFormat)

  switch (family) {
    case 'reasoning-effort': {
      // 「思考开关」与档位同源的协议：把开关翻到与档位一致（档位优先于 mode）
      if (thinkingFamily === 'thinking-type') {
        acc.modelKwargs.thinking = { type: off ? 'disabled' : 'enabled' }
      } else if (thinkingFamily === 'enable-thinking') {
        acc.modelKwargs.enable_thinking = !off
      }
      acc.modelKwargs.reasoning_effort = effort
      acc.touched = true
      return
    }

    case 'openrouter-effort':
      acc.modelKwargs.reasoning = { effort }
      acc.touched = true
      return

    case 'anthropic-effort': {
      if (off) {
        acc.fields.thinking = { type: 'disabled' }
        acc.touched = true
        return
      }
      // minimal 在 Anthropic 侧没有对应档位，映射到 low（其余档位原样下发）
      acc.fields.output_config = { effort: effort === 'minimal' ? 'low' : effort }
      acc.touched = true
      return
    }

    case 'google-level': {
      if (off) {
        acc.fields.thinkingConfig = { thinkingBudget: 0 }
        acc.touched = true
        return
      }
      // Gemini 的 thinkingLevel 只有 LOW/MEDIUM/HIGH 三档，两端各向外收敛
      const level =
        effort === 'minimal' || effort === 'low' ? 'LOW' : effort === 'medium' ? 'MEDIUM' : 'HIGH'
      acc.fields.thinkingConfig = { thinkingLevel: level, includeThoughts: true }
      acc.touched = true
      return
    }

    case 'ollama-think': {
      const think = off ? false : ['low', 'medium', 'high'].includes(effort) ? effort : true
      acc.fields.think = think
      acc.touched = true
      return
    }

    default:
      return
  }
}

/**
 * 组装思考与推理等级参数。
 * auto（跟随模型默认配置）+ 未设置推理等级 + 未适配的供应商 ⇒ 返回 null（不注入任何字段）。
 */
export function buildThinkingParams(input: ThinkingParamsInput): ThinkingParams | null {
  const acc: ParamsAccumulator = { fields: {}, modelKwargs: {}, touched: false }
  applyThinkingMode(acc, input)
  applyReasoningEffort(acc, input)
  if (!acc.touched) return null

  const result: ThinkingParams = {}
  if (Object.keys(acc.fields).length > 0) result.fields = acc.fields
  if (Object.keys(acc.modelKwargs).length > 0) result.modelKwargs = acc.modelKwargs
  return result
}
