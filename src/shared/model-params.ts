/**
 * Model request parameter presets (shared by the main process and the renderer so neither
 * side maintains its own copy of the magic numbers).
 *
 * - Renderer: the context-window quick-fill chips and sampling-parameter range validation in
 *   the settings page's "advanced configuration";
 * - Main process: when listing models, fall back to the lowest value of each tier for models
 *   missing from models-profile.
 *
 * Note: this file must not depend on electron / node / react; both builds have to bundle it directly.
 */

/** Context-window (token) presets — input side (the maximum context the model can read in) */
export const CONTEXT_WINDOW_PRESETS = [128_000, 256_000, 512_000, 1_000_000] as const

/** Context-window (token) presets — output side (max output per response, also the request generation limit) */
export const MAX_OUTPUT_PRESETS = [4_000, 16_000, 32_000, 128_000] as const

/** Fallback context window for unknown models: the lowest preset tier */
export const FALLBACK_CONTEXT_WINDOW: number = CONTEXT_WINDOW_PRESETS[0]

/** Fallback max output for unknown models: the lowest preset tier */
export const FALLBACK_MAX_OUTPUT_TOKENS: number = MAX_OUTPUT_PRESETS[0]

/** Fallback type for unknown models: treat as a language (chat) model */
export const FALLBACK_MODEL_TYPE = 'text-generation'

/**
 * Fallback capabilities for unknown models: language model + streaming + tool calling;
 * vision input is off by default (it cannot be inferred for unknown models, so the user
 * opts in explicitly via "supports image input").
 */
export const FALLBACK_MODEL_CAPABILITIES: Record<string, boolean> = {
  supports_text_input: true,
  supports_text_output: true,
  supports_streaming: true,
  supports_function_calling: true,
  supports_image_input: false
}

/** Default cap on total tool calls per conversation (overridable per model in "advanced configuration") */
export const DEFAULT_MAX_TOOL_ROUNDS = 500

/** Thinking mode: auto = follow the model's default configuration (inject no parameter) */
export type ThinkingMode = 'auto' | 'on' | 'off'

/** Thinking-mode dropdown/radio options (the label is resolved by the UI layer from the current language) */
export const THINKING_MODE_OPTIONS: ReadonlyArray<{ value: ThinkingMode }> = [
  { value: 'auto' },
  { value: 'on' },
  { value: 'off' }
]

/** Sampling parameters: range and step; placeholder text is resolved by the UI layer from the current language */
export const SAMPLING_PARAM_SPECS = [
  {
    name: 'temperature',
    label: 'Temperature',
    min: 0,
    max: 2,
    step: 0.1
  },
  {
    name: 'top_p',
    label: 'Top P',
    min: 0,
    max: 1,
    step: 0.05
  },
  {
    name: 'top_k',
    label: 'Top K',
    min: 1,
    max: 100,
    step: 1
  }
] as const

/** Sampling parameter name (same source as SAMPLING_PARAM_SPECS) */
export type SamplingParamName = (typeof SAMPLING_PARAM_SPECS)[number]['name']

/**
 * Provider protocols that accept Top K: the SDKs / APIs of the other protocols have no such
 * parameter, so the setting is stored but not sent (the settings UI shows a note and the main
 * process decides whether to inject it).
 */
export const TOP_K_PROVIDERS: readonly string[] = [
  'anthropic',
  'ollama',
  'google',
  'google-genai',
  'google-vertexai',
  'vertexai'
]

/**
 * Thinking-mode adapter families: the parameter names for "enable/disable thinking" differ
 * per provider, so they are mapped by protocol family; 'none' means the protocol is not
 * adapted, and choosing on/off sends no parameter at all.
 */
export type ThinkingParamFamily =
  'anthropic' | 'ollama' | 'google' | 'thinking-type' | 'openrouter' | 'enable-thinking' | 'none'

/** Protocol → thinking parameter family */
export const THINKING_FAMILY_BY_PROVIDER: Readonly<Record<string, ThinkingParamFamily>> = {
  anthropic: 'anthropic',
  ollama: 'ollama',
  google: 'google',
  'google-genai': 'google',
  'google-vertexai': 'google',
  vertexai: 'google',
  deepseek: 'thinking-type',
  zhipu: 'thinking-type',
  volcengine: 'thinking-type',
  openrouter: 'openrouter',
  aliyun: 'enable-thinking',
  qwen: 'enable-thinking',
  siliconflow: 'enable-thinking',
  moonshot: 'enable-thinking',
  tencent: 'enable-thinking'
}

/** Resolve the thinking parameter family for a protocol (custom endpoints follow their compatible protocol; input is case-insensitive) */
export function resolveThinkingFamily(
  provider: string,
  anthropicFormat = false
): ThinkingParamFamily {
  const key = (provider ?? '').toLowerCase()
  if (key === 'custom') return anthropicFormat ? 'anthropic' : 'none'
  return THINKING_FAMILY_BY_PROVIDER[key] ?? 'none'
}

/** Whether this protocol supports thinking-mode control (shared by the settings hint and main-process injection) */
export function supportsThinkingControl(provider: string, anthropicFormat = false): boolean {
  return resolveThinkingFamily(provider, anthropicFormat) !== 'none'
}

/* ==================== Reasoning effort ==================== */

/**
 * Canonical ordering of reasoning effort levels (vocabulary shared across protocols).
 *
 * Which levels a single model supports is defined solely by the model profile's
 * `capabilities.reasoning_effort_levels` (models-profile.json); this list only provides
 * ordering and display names — the order in the profile isn't guaranteed to be canonical,
 * and vendors differ in their level sets (e.g. DeepSeek only has low/high/max, GLM-5.3 only
 * has low/high/max, GPT-5.x has none/low/medium/high/xhigh/max). Levels missing from the
 * list sort last, in lexicographic order.
 */
export const REASONING_EFFORT_ORDER = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra'
] as const

/** Reasoning effort identifier (protocol original value, lowercase; used both in profiles and request bodies) */
export type ReasoningEffort = string

/**
 * Levels used by the quick chips in the settings page: the standard vocabulary minus the pure
 * alias `ultra` (`ultra` is only an alias for `max` in DeepSeek's docs, never appears in model
 * profiles, and gets no chip of its own).
 */
export const REASONING_EFFORT_PRESETS: readonly string[] = REASONING_EFFORT_ORDER.filter(
  (level) => level !== 'ultra'
)

/**
 * The row of quick chips **to the right of** the settings field (much narrower than PRESETS).
 *
 * Measured: the modal content area is about 500px, and a row of 7 chips plus the input would
 * overflow the line (chips squeeze out the input, earlier levels get clipped), so only the four
 * most-used levels sit on the right; the rest (none / minimal / xhigh) are picked from the
 * dropdown or typed directly.
 */
export const REASONING_EFFORT_CHIPS: readonly string[] = ['low', 'medium', 'high', 'max']

/**
 * The **default thinking effort** when no level is explicitly selected: prefer `medium`,
 * otherwise take the middle level of the sorted list.
 *
 * User's wording (2026-09-27): "no default option should be shown; pick from the available
 * options… if there is a thinking level, choose medium thinking" — meaning "unset" is not a
 * visible state: whatever levels the model has, default to "medium thinking" among them, and
 * the input shows the level that will actually be sent.
 *
 * - `[none, low, medium, high, xhigh, max]` → `medium`
 * - `[low, high, max]` (the DeepSeek kind) → `high` (middle, and also DeepSeek's own default)
 * - `[low, high]` → `high`; `[low]` → `low`; `[]` → null (no thinking level, so nothing is sent or shown)
 */
export function defaultReasoningEffort(
  levels: readonly string[] | null | undefined
): string | null {
  const sorted = sortReasoningEfforts(levels)
  if (sorted.length === 0) return null
  if (sorted.includes('medium')) return 'medium'
  return sorted[Math.floor(sorted.length / 2)]
}

/** Display name of a level: capitalize the first letter of the Latin original (keep Latin as-is rather than translating, to avoid a second name for the same protocol value) */
export function reasoningEffortLabel(effort: string): string {
  const key = (effort ?? '').trim()
  if (!key) return ''
  if (key.toLowerCase() === 'xhigh') return 'XHigh'
  return key.charAt(0).toUpperCase() + key.slice(1)
}

/** Sort the level set from a profile into canonical order (dedupe, drop empties, unknown levels sorted last) */
export function sortReasoningEfforts(levels: readonly string[] | null | undefined): string[] {
  const list = Array.from(
    new Set((levels ?? []).map((l) => String(l).trim().toLowerCase()).filter(Boolean))
  )
  const rank = (level: string): number => {
    const index = (REASONING_EFFORT_ORDER as readonly string[]).indexOf(level)
    return index === -1 ? REASONING_EFFORT_ORDER.length : index
  }
  return list.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
}

/**
 * Reasoning-effort adapter families: the parameter shape for "adjust reasoning effort" also
 * differs per provider, so they are mapped by protocol family.
 * - 'reasoning-effort': the `reasoning_effort` field of OpenAI-compatible request bodies
 *   (DeepSeek / Zhipu docs state this field explicitly; OpenAI-compatible endpoints in the
 *   same family reuse it)
 * - 'openrouter-effort': OpenRouter's unified `reasoning.effort`
 * - 'anthropic-effort': Anthropic's `output_config.effort` (`none` disables thinking)
 * - 'google-level': Gemini's `thinkingConfig.thinkingLevel` (LOW/MEDIUM/HIGH)
 * - 'ollama-think': Ollama's `think` (boolean or low/medium/high)
 * - 'none': not adapted — recorded but never sent
 */
export type ReasoningParamFamily =
  | 'reasoning-effort'
  | 'openrouter-effort'
  | 'anthropic-effort'
  | 'google-level'
  | 'ollama-think'
  | 'none'

/**
 * Protocol → reasoning-effort adapter family.
 * Unlisted protocols (including custom OpenAI-compatible endpoints) are always 'none': it is
 * better for the setting to have no effect than to send a field the other side may not
 * recognise and trigger a 400 (same principle as thinking mode).
 */
export const REASONING_FAMILY_BY_PROVIDER: Readonly<Record<string, ReasoningParamFamily>> = {
  openai: 'reasoning-effort',
  xai: 'reasoning-effort',
  deepseek: 'reasoning-effort',
  zhipu: 'reasoning-effort',
  volcengine: 'reasoning-effort',
  aliyun: 'reasoning-effort',
  qwen: 'reasoning-effort',
  siliconflow: 'reasoning-effort',
  moonshot: 'reasoning-effort',
  tencent: 'reasoning-effort',
  openrouter: 'openrouter-effort',
  anthropic: 'anthropic-effort',
  google: 'google-level',
  'google-genai': 'google-level',
  'google-vertexai': 'google-level',
  vertexai: 'google-level',
  ollama: 'ollama-think'
}

/** Resolve the reasoning-effort adapter family for a protocol (custom endpoints follow their compatible protocol; input is case-insensitive) */
export function resolveReasoningFamily(
  provider: string,
  anthropicFormat = false
): ReasoningParamFamily {
  const key = (provider ?? '').toLowerCase()
  if (key === 'custom') return anthropicFormat ? 'anthropic-effort' : 'none'
  return REASONING_FAMILY_BY_PROVIDER[key] ?? 'none'
}

/** Whether this protocol actually sends the reasoning effort (shared by the settings hint and main-process injection) */
export function supportsReasoningEffort(provider: string, anthropicFormat = false): boolean {
  return resolveReasoningFamily(provider, anthropicFormat) !== 'none'
}
