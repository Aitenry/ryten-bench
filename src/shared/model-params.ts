/**
 * 模型请求参数预设（主进程与渲染进程共用，避免两处各自维护一份魔法数字）。
 *
 * - 渲染层：设置页「高级配置」里的上下文窗口快速填充胶囊、采样参数范围校验；
 * - 主进程：拉取模型列表时，对 models-profile 未收录的模型取每档最低值兜底。
 *
 * 注意：本文件不得引入 electron / node / react 依赖，两侧构建都要能直接打包。
 */

/** 上下文窗口（Token）预设 —— 输入侧（模型能读入的最大上下文） */
export const CONTEXT_WINDOW_PRESETS = [128_000, 256_000, 512_000, 1_000_000] as const

/** 上下文窗口（Token）预设 —— 输出侧（模型单次最大输出，同时作为请求生成上限） */
export const MAX_OUTPUT_PRESETS = [4_000, 16_000, 32_000, 128_000] as const

/** 未收录模型的兜底上下文窗口：取预设档位中的最低值 */
export const FALLBACK_CONTEXT_WINDOW: number = CONTEXT_WINDOW_PRESETS[0]

/** 未收录模型的兜底最大输出：取预设档位中的最低值 */
export const FALLBACK_MAX_OUTPUT_TOKENS: number = MAX_OUTPUT_PRESETS[0]

/** 未收录模型的兜底类型：按语言（对话）模型处理 */
export const FALLBACK_MODEL_TYPE = 'text-generation'

/**
 * 未收录模型的兜底能力：语言模型 + 流式 + 可调用工具；
 * 视觉输入默认关闭（未收录的模型无从判断，交由用户在「支持图片输入」里显式开启）。
 */
export const FALLBACK_MODEL_CAPABILITIES: Record<string, boolean> = {
  supports_text_input: true,
  supports_text_output: true,
  supports_streaming: true,
  supports_function_calling: true,
  supports_image_input: false
}

/** 单次对话工具调用总次数上限的默认值（可在模型「高级配置」里逐模型覆盖） */
export const DEFAULT_MAX_TOOL_ROUNDS = 500

/** 思考模式：auto = 跟随模型默认配置（不注入任何参数） */
export type ThinkingMode = 'auto' | 'on' | 'off'

/** 思考模式下拉/单选选项（label 由界面层按当前语言解析） */
export const THINKING_MODE_OPTIONS: ReadonlyArray<{ value: ThinkingMode }> = [
  { value: 'auto' },
  { value: 'on' },
  { value: 'off' }
]

/** 采样参数：范围与步进；占位提示由界面层按当前语言解析 */
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

/** 采样参数名（与 SAMPLING_PARAM_SPECS 同源） */
export type SamplingParamName = (typeof SAMPLING_PARAM_SPECS)[number]['name']

/**
 * 接受 Top K 的供应商协议：其余协议的 SDK / 接口没有该参数，
 * 设置值只保存不下发（设置界面据此给出提示，主进程据此决定是否注入）。
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
 * 思考模式适配族：各家「开/关思考」的参数名并不统一，按协议族映射；
 * 'none' 表示该协议未适配，选择开启/关闭都不会往请求里塞参数。
 */
export type ThinkingParamFamily =
  'anthropic' | 'ollama' | 'google' | 'thinking-type' | 'openrouter' | 'enable-thinking' | 'none'

/** 协议 → 思考参数族 */
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

/** 解析协议对应的思考参数族（自定义端点按兼容协议判定；入参大小写不敏感） */
export function resolveThinkingFamily(
  provider: string,
  anthropicFormat = false
): ThinkingParamFamily {
  const key = (provider ?? '').toLowerCase()
  if (key === 'custom') return anthropicFormat ? 'anthropic' : 'none'
  return THINKING_FAMILY_BY_PROVIDER[key] ?? 'none'
}

/** 该协议是否支持控制思考模式（设置界面提示 + 主进程注入共用同一判断） */
export function supportsThinkingControl(provider: string, anthropicFormat = false): boolean {
  return resolveThinkingFamily(provider, anthropicFormat) !== 'none'
}

/* ==================== 推理等级（reasoning effort） ==================== */

/**
 * 推理等级的标准档位顺序（各协议通用词汇）。
 *
 * 单模型「支持哪些档位」以模型档案 `capabilities.reasoning_effort_levels` 为唯一真源
 * （models-profile.json），这里只负责排序与展示名——档案里给的顺序不保证规范，
 * 各厂商档位集合也不一致（如 DeepSeek 只有 low/high/max，GLM-5.3 只有 low/high/max，
 * GPT-5.x 有 none/low/medium/high/xhigh/max）。档案未收录的档位按字典序排在末尾。
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

/** 推理等级标识（协议原值，小写；档案与请求体里都是这个形态） */
export type ReasoningEffort = string

/**
 * 设置页快捷胶囊用的档位：标准词汇去掉纯别名 `ultra`
 * （`ultra` 只是 DeepSeek 文档里映射到 `max` 的别名，模型档案里不出现，不单列一个胶囊）。
 */
export const REASONING_EFFORT_PRESETS: readonly string[] = REASONING_EFFORT_ORDER.filter(
  (level) => level !== 'ultra'
)

/**
 * 设置页字段**右侧那一排**快捷胶囊（比 PRESETS 窄很多）。
 *
 * 实测：弹窗内容区约 500px，一排 7 个胶囊 + 输入框会撑破整行（胶囊挤掉输入框、前面的档位被裁掉），
 * 所以右侧只放最常用的四档，其余档位（none / minimal / xhigh）在下拉里选或直接输入。
 */
export const REASONING_EFFORT_CHIPS: readonly string[] = ['low', 'medium', 'high', 'max']

/**
 * 未显式选择档位时的**默认思考力度**：优先 `medium`，没有 medium 就取排序后的中间那一档。
 *
 * 用户口径（2026-09-27）：「不要默认选项，要从已有的选项里面选择……如果有思考等级就选择中等思考」——
 * 也就是说「未设置」不是一个可见状态：模型有哪些档位就从中默认挑「中等思考」，
 * 输入框里显示的就是这个真正会下发的档位。
 *
 * - `[none, low, medium, high, xhigh, max]` → `medium`
 * - `[low, high, max]`（DeepSeek 那类）→ `high`（中间，也正好是 DeepSeek 自己的默认）
 * - `[low, high]` → `high`；`[low]` → `low`；`[]` → null（没有思考档位，不下发也不显示）
 */
export function defaultReasoningEffort(
  levels: readonly string[] | null | undefined
): string | null {
  const sorted = sortReasoningEfforts(levels)
  if (sorted.length === 0) return null
  if (sorted.includes('medium')) return 'medium'
  return sorted[Math.floor(sorted.length / 2)]
}

/** 档位展示名：拉丁原文首字母大写（等宽/拉丁用原文，不译成中文，避免和协议值两套叫法） */
export function reasoningEffortLabel(effort: string): string {
  const key = (effort ?? '').trim()
  if (!key) return ''
  if (key.toLowerCase() === 'xhigh') return 'XHigh'
  return key.charAt(0).toUpperCase() + key.slice(1)
}

/** 按标准档位顺序排列档案给的档位集合（去重、去空、未知档位按字典序收尾） */
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
 * 推理等级适配族：各家「调推理力度」的参数形态同样不统一，按协议族映射。
 * - 'reasoning-effort'：OpenAI 兼容请求体里的 `reasoning_effort`（DeepSeek / 智谱官方文档
 *   明确该字段；同族 OpenAI 兼容端点沿用同一字段）
 * - 'openrouter-effort'：OpenRouter 统一的 `reasoning.effort`
 * - 'anthropic-effort'：Anthropic 的 `output_config.effort`（`none` 走关闭思考）
 * - 'google-level'：Gemini 的 `thinkingConfig.thinkingLevel`（LOW/MEDIUM/HIGH）
 * - 'ollama-think'：Ollama 的 `think`（布尔或 low/medium/high）
 * - 'none'：未适配，只记录不下发
 */
export type ReasoningParamFamily =
  | 'reasoning-effort'
  | 'openrouter-effort'
  | 'anthropic-effort'
  | 'google-level'
  | 'ollama-think'
  | 'none'

/**
 * 协议 → 推理等级适配族。
 * 未收录的协议（含自定义 OpenAI 兼容端点）一律 'none'：宁可不生效，也不往请求体里
 * 塞对方可能不认识的字段导致 400（与思考模式同一原则）。
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

/** 解析协议对应的推理等级适配族（自定义端点按兼容协议判定；入参大小写不敏感） */
export function resolveReasoningFamily(
  provider: string,
  anthropicFormat = false
): ReasoningParamFamily {
  const key = (provider ?? '').toLowerCase()
  if (key === 'custom') return anthropicFormat ? 'anthropic-effort' : 'none'
  return REASONING_FAMILY_BY_PROVIDER[key] ?? 'none'
}

/** 该协议是否会把推理等级真正下发（设置界面提示 + 主进程注入共用同一判断） */
export function supportsReasoningEffort(provider: string, anthropicFormat = false): boolean {
  return resolveReasoningFamily(provider, anthropicFormat) !== 'none'
}
