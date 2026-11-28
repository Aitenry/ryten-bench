import type { ModelCapabilities, ModelMetadata } from '../types/provider'

/**
 * Model request parameter presets / protocol capability checks are re-exported from the
 * shared module (main process and renderer share one source, avoiding drift such as
 * "selectable in the UI but rejected by the backend").
 */
export {
  CONTEXT_WINDOW_PRESETS,
  MAX_OUTPUT_PRESETS,
  FALLBACK_CONTEXT_WINDOW,
  FALLBACK_MAX_OUTPUT_TOKENS,
  DEFAULT_MAX_TOOL_ROUNDS,
  THINKING_MODE_OPTIONS,
  SAMPLING_PARAM_SPECS,
  TOP_K_PROVIDERS,
  supportsThinkingControl,
  REASONING_EFFORT_ORDER,
  REASONING_EFFORT_PRESETS,
  REASONING_EFFORT_CHIPS,
  defaultReasoningEffort,
  supportsReasoningEffort,
  reasoningEffortLabel,
  sortReasoningEfforts,
  type ThinkingMode,
  type SamplingParamName,
  type ReasoningEffort
} from '../../../shared/model-params'

/** Compact token counts: 4000 → 4k, 128000 → 128k, 1000000 → 1M */
export function formatTokenCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  if (value >= 1_000_000) {
    const m = value / 1_000_000
    return `${Number(m.toFixed(Number.isInteger(m) ? 0 : 1))}M`
  }
  if (value >= 1000) {
    const k = value / 1000
    return `${Number(k.toFixed(Number.isInteger(k) ? 0 : 1))}k`
  }
  return String(value)
}

/**
 * Selectable capability entries in metadata.capabilities (matching the
 * models-profile.json fields).
 *
 * Only the key is kept: the former `label` Chinese literals were used only by the removed
 * `getCapabilityLabel`, and display names always come from i18n entries
 * (`modelSettings.capabilityBadge.*`).
 */
export interface CapabilityOption {
  key: keyof ModelCapabilities
}

/** Capability options used in the edit form */
export const CAPABILITY_OPTIONS: CapabilityOption[] = [
  { key: 'supports_image_input' },
  { key: 'supports_audio_input' },
  { key: 'supports_video_input' },
  { key: 'supports_image_output' },
  { key: 'supports_function_calling' },
  { key: 'supports_thinking' },
  { key: 'supports_streaming' },
  { key: 'supports_json_mode' },
  { key: 'supports_structured_output' },
  { key: 'supports_batch' },
  { key: 'supports_fine_tuning' },
  { key: 'supports_embeddings' }
]

/** Key capability badges shown inline in table rows (only the ones that matter most) */
export const CAPABILITY_BADGES: CapabilityOption[] = [
  { key: 'supports_image_input' },
  { key: 'supports_function_calling' },
  { key: 'supports_thinking' },
  { key: 'supports_streaming' },
  { key: 'supports_embeddings' }
]

/** Safely read the capabilities object; returns an empty object for non-objects (missing/invalid) */
export function getCapabilities(metadata: ModelMetadata | null | undefined): ModelCapabilities {
  const caps = metadata?.capabilities
  return caps && typeof caps === 'object' ? caps : {}
}

/** Whether this is a vector/embedding model: metadata declares type=embedding or supports_embeddings, otherwise fall back to the name/model string */
export function isEmbeddingProvider(p: {
  name?: string
  model?: string
  metadata?: ModelMetadata | Record<string, unknown> | null
}): boolean {
  const meta = p?.metadata as ModelMetadata | null | undefined
  if (meta) {
    if (typeof meta.type === 'string' && meta.type.toLowerCase() === 'embedding') return true
    if (getCapabilities(meta).supports_embeddings === true) return true
  }
  const lowered = ((p?.name ?? '') + (p?.model ?? '')).toLowerCase()
  return lowered.includes('embedding')
}

/** Capability check for toolbar/vision etc.: false when metadata is missing (takes effect once the user fills in metadata) */
export function supportsCapability(
  metadata: ModelMetadata | Record<string, unknown> | null | undefined,
  key: keyof ModelCapabilities
): boolean {
  const caps = getCapabilities(metadata as ModelMetadata | null | undefined)
  return caps[key] === true
}

/** Model display name: prefer display_name from metadata (profile/user-provided), otherwise fall back to name */
export function getProviderDisplayName(p: {
  name?: string
  metadata?: ModelMetadata | Record<string, unknown> | null
}): string {
  const meta = p?.metadata as ModelMetadata | null | undefined
  if (meta && typeof meta.display_name === 'string' && meta.display_name.trim()) {
    return meta.display_name
  }
  return p?.name ?? ''
}

/* ======== Provider brand colors (single source of truth shared by icons/monogram badges; change colors only here) ======== */

/**
 * Provider protocol id → official brand color (for the light theme).
 * Verified sources: official UIColours brand pages / 2025 official rebrand announcements /
 * vendor site primary colors.
 */
export const PROVIDER_BRAND_COLORS: Record<string, string> = {
  // —— Monochrome black-and-white brands: color was officially abandoned; light variants are used in dark theme (see MONOCHROME_PROVIDERS) ——
  // OpenAI: monochrome since the 2025 rebrand (the old green #10a37f is deprecated)
  openai: '#1e1f22',
  // xAI (Grok): official Near Black #1E1F22 / Warm White #F9F8F7 (UIColours)
  xai: '#1e1f22',
  // Ollama: black llama mark
  ollama: '#1e1f22',
  // OpenRouter: the 2025 Bauhaus refresh turned it into a black-and-white geometric mark
  openrouter: '#1e1f22',
  // —— Colored brands (official UIColours values) ——
  deepseek: '#4d6bfe', // DeepSeek Blue
  mistral: '#ff7000', // Mistral official orange (the old #ff9900 was too yellow)
  anthropic: '#d97757', // Anthropic Burnt Orange
  'google-genai': '#4285f4', // Google Blue
  'google-vertexai': '#4285f4',
  groq: '#f55036', // Groq orange-red
  perplexity: '#20808d', // Perplexity teal
  // —— Chinese vendors: common values approximating the official primary colors (tweak here if they differ) ——
  minimax: '#4e28f5',
  moonshot: '#2d5bff', // Kimi starlight blue-purple (previously misused OpenAI's old green)
  zhipu: '#3859ff',
  aliyun: '#ff6a00',
  qianfan: '#2932e1',
  volcengine: '#3370ff',
  tencent: '#006cff',
  siliconflow: '#5d2cff',
  together: '#7700ff',
  lmstudio: '#4d4d4d'
}

/** Brands that are officially monochrome: use light variants in dark theme for visibility */
const MONOCHROME_PROVIDERS = new Set(['openai', 'xai', 'ollama', 'openrouter'])

/** Brand colors for the dark theme (monochrome brands switch to warm white, matching the warm-paper-and-ink editorial system) */
const PROVIDER_DARK_COLORS: Record<string, string> = {
  openai: '#f9f8f7',
  xai: '#f9f8f7',
  ollama: '#e4e4e7',
  openrouter: '#f9f8f7'
}

/**
 * Brand color for provider icons/badges: official color in the light theme, light variants
 * for monochrome brands in the dark theme.
 * Returns undefined for unknown protocols; the caller decides the fallback.
 */
export function getProviderColor(
  providerType: string | undefined,
  isDark: boolean
): string | undefined {
  if (!providerType) return undefined
  if (isDark && MONOCHROME_PROVIDERS.has(providerType)) {
    return PROVIDER_DARK_COLORS[providerType]
  }
  return PROVIDER_BRAND_COLORS[providerType]
}

/** Letter monogram when a provider has no icon: split on hyphens/underscores/camelCase, take the initial of each word for multiple words, the first two letters (uppercased) for a single word */
export function getProviderMonogram(providerType: string): string {
  if (!providerType) return '?'
  const tokens = providerType
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .map((t) => t.trim())
    .filter((t) => /[a-zA-Z]/.test(t))
  if (tokens.length === 0) return providerType.slice(0, 1).toUpperCase()
  if (tokens.length === 1) {
    // For words starting with digits (e.g. '123ai') take the first letter cluster, avoiding dumb output like '12'
    const word = tokens[0]
    const letterCluster = word.match(/[a-zA-Z]+/)
    const cluster = letterCluster && letterCluster.index ? letterCluster[0] : word
    return cluster.slice(0, 2).toUpperCase()
  }
  return (tokens[0][0] + tokens[1][0]).toUpperCase()
}
