/**
 * Thinking mode / reasoning effort parameter adaptation - only responsible for "translating the
 * unified settings into each vendor's parameters".
 *
 * The decision of "which protocol supports which parameter" lives in shared/model-params (the
 * settings UI hints and the main-process injection share one source); this file only assembles
 * parameters:
 *
 * Thinking mode (on/off):
 * - Anthropic (including Anthropic-compatible protocols on custom endpoints): thinking.type =
 *   enabled/disabled (enabled must carry budget_tokens, and it must be less than max_tokens)
 * - Ollama: think = true/false
 * - Google Gemini / Vertex: thinkingConfig.thinkingBudget (-1 dynamic budget / 0 off)
 * - DeepSeek / Zhipu GLM / Volcano Ark: thinking.type = enabled/disabled
 * - OpenRouter: reasoning.enabled = true/false
 * - Alibaba Cloud Bailian / SiliconFlow / Moonshot / Tencent Hunyuan: enable_thinking = true/false
 * - the rest (OpenAI / xAI / Groq / Mistral / Bedrock / Cloudflare / LM Studio…): not adapted,
 *   never injected - better for it not to take effect than to put a field the other side does not
 *   recognize into the request body and get a 400
 *
 * Reasoning effort (the tiers come from the model profile's capabilities.reasoning_effort_levels):
 * - OpenAI-compatible family (OpenAI / xAI / DeepSeek / Zhipu / Volcano / Alibaba / SiliconFlow /
 *   Moonshot / Tencent): request body `reasoning_effort` (DeepSeek and Zhipu official docs both use
 *   this field); for protocols where "thinking is toggled by thinking.type / enable_thinking", the
 *   toggle is also flipped to match the tier (none = drop thinking, other tiers = enable thinking),
 *   avoiding a request where the toggle and the tier contradict each other
 * - OpenRouter: `reasoning.effort`
 * - Anthropic: `output_config.effort` (none goes through thinking.type = disabled)
 * - Gemini / Vertex: `thinkingConfig.thinkingLevel` (none goes through thinkingBudget = 0)
 * - Ollama: `think` (none = false, low/medium/high pass the tier directly, other tiers = true)
 * - unadapted protocols only record it without sending it (the settings UI shows a "recorded only"
 *   hint)
 *
 * Priority: when the tier and the mode conflict in the same request, **the tier wins** (it is the
 * more specific setting), so the implementation assembles by mode first and then overwrites the
 * same-named keys with the effort.
 */

import {
  defaultReasoningEffort,
  resolveReasoningFamily,
  resolveThinkingFamily,
  type ThinkingMode
} from '../../shared/model-params'

/** Lower bound of the Anthropic extended-thinking budget (Anthropic requires >= 1024) */
const ANTHROPIC_MIN_BUDGET = 1024
/** Upper bound of the Anthropic extended-thinking budget (not set higher, to avoid eating the output budget) */
const ANTHROPIC_MAX_BUDGET = 4096

export interface ThinkingParamsInput {
  /** Provider protocol identifier (case-insensitive) */
  provider: string
  /** Whether the custom endpoint uses the Anthropic-compatible protocol */
  anthropicFormat?: boolean
  mode: ThinkingMode
  /**
   * Reasoning effort: null / undefined / empty string = the user did not choose. When not chosen,
   * fall back to "medium thinking" from the model profile's tier table (see
   * defaultReasoningEffort); if there is no tier table at all (the model has no thinking tiers), no
   * tier parameter is sent.
   */
  effort?: string | null
  /** The tier table declared by the model profile (capabilities.reasoning_effort_levels of models-profile) */
  effortLevels?: readonly string[] | null
  /** Currently effective output limit (max_tokens column, or the output limit from the model profile) */
  maxTokens: number | null
}

export interface ThinkingParams {
  /** Fields merged directly into the ChatModel constructor arguments (Anthropic / Ollama / Google receive them as class fields) */
  fields?: Record<string, unknown>
  /** Extra parameters to merge into the request body (the OpenAI-compatible family goes through modelKwargs) */
  modelKwargs?: Record<string, unknown>
}

/** Parameter accumulator: both layers, fields / modelKwargs, are "later writes overwrite earlier ones" */
interface ParamsAccumulator {
  fields: Record<string, unknown>
  modelKwargs: Record<string, unknown>
  touched: boolean
}

/** Anthropic extended-thinking budget: clamped to [1024, 4096] and must be less than max_tokens */
function anthropicBudget(maxTokens: number | null): number {
  const cap = maxTokens ?? ANTHROPIC_MAX_BUDGET + ANTHROPIC_MIN_BUDGET
  return Math.max(ANTHROPIC_MIN_BUDGET, Math.min(ANTHROPIC_MAX_BUDGET, cap - ANTHROPIC_MIN_BUDGET))
}

/** Normalize the tier: lowercase and trim (both the profile and the UI may give different spellings) */
function normalizeEffort(effort: string | null | undefined): string {
  return String(effort ?? '')
    .trim()
    .toLowerCase()
}

/** Thinking-mode (on/off) parameters: auto and unadapted providers write no keys at all */
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
      // Enabling thinking must leave an output budget larger than the budget, otherwise the API
      // rejects it outright
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

/** Reasoning effort parameters: when no tier is set and the model has a tier table, fall back to "medium thinking"; no tier table means write nothing */
function applyReasoningEffort(acc: ParamsAccumulator, input: ThinkingParamsInput): void {
  const explicit = normalizeEffort(input.effort)
  // Do not fall back when thinking is explicitly turned off: the user wants "no thinking", so do
  // not turn it back on here
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
      // Protocols where "the thinking toggle" is the same source as the tier: flip the toggle to
      // match the tier (tier wins over mode)
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
      // minimal has no corresponding tier on the Anthropic side; map it to low (other tiers are sent as-is)
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
      // Gemini's thinkingLevel has only three tiers, LOW/MEDIUM/HIGH, so both ends are pulled inward
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
 * Assemble thinking and reasoning-effort parameters.
 * auto (follow the model's default config) + no reasoning effort set + unadapted provider => return
 * null (inject no fields at all).
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
