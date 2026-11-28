import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import type { TFunction } from 'i18next'
import {
  theme,
  App,
  Tree,
  Button,
  Modal,
  Form,
  Input,
  Select,
  InputNumber,
  Switch,
  Tag,
  Popconfirm,
  Space,
  Tooltip,
  Radio,
  Checkbox,
  Collapse,
  type TreeDataNode
} from 'antd'
import { SkeletonSettingRows } from '@renderer/components/system/Skeleton'
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  StarOutlined,
  StarFilled,
  DownloadOutlined,
  OpenAIFilled,
  DeepSeekFilled,
  OllamaFilled,
  MistralFilled,
  AnthropicFilled,
  GeminiFilled,
  CheckSquareOutlined,
  MinusSquareOutlined
} from '@ant-design/icons'
import { useMessage } from '@renderer/hooks/useMessage'
import { useTranslation, Trans } from '@renderer/i18n'
import {
  type LlmProviderConfig,
  type LlmProviderInput,
  type ModelMetadata,
  type FetchedModel
} from '@renderer/types/provider'
import {
  CAPABILITY_OPTIONS,
  CAPABILITY_BADGES,
  CONTEXT_WINDOW_PRESETS,
  DEFAULT_MAX_TOOL_ROUNDS,
  MAX_OUTPUT_PRESETS,
  SAMPLING_PARAM_SPECS,
  THINKING_MODE_OPTIONS,
  formatTokenCount,
  getCapabilities,
  getProviderDisplayName,
  isEmbeddingProvider,
  REASONING_EFFORT_CHIPS,
  REASONING_EFFORT_PRESETS,
  reasoningEffortLabel,
  sortReasoningEfforts,
  supportsThinkingControl
} from '@renderer/utils/providerMeta'
import { SettingsPageHeader, SettingsSection } from './SettingsUI'
import ProviderMark from '@renderer/components/provider/provider-mark'

// Preset providers (value/label/baseURL); brand colors all live in providerMeta.PROVIDER_BRAND_COLORS so the two cannot drift
const PROVIDER_TYPES = [
  { value: 'openai', label: 'OpenAI', baseURL: 'https://api.openai.com/v1' },
  { value: 'deepseek', label: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1' },
  { value: 'ollama', label: 'Ollama', baseURL: 'http://localhost:11434' },
  { value: 'openrouter', label: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1' },
  { value: 'mistral', label: 'Mistral AI', baseURL: 'https://api.mistral.ai/v1' },
  { value: 'xai', label: 'xAI (Grok)', baseURL: 'https://api.x.ai/v1' },
  { value: 'anthropic', label: 'Anthropic', baseURL: 'https://api.anthropic.com' },
  {
    value: 'google-genai',
    label: 'Google Gemini',
    baseURL: 'https://generativelanguage.googleapis.com'
  },
  { value: 'google-vertexai', label: 'Google Vertex AI', baseURL: '' },
  { value: 'aws-bedrock', label: 'AWS Bedrock', baseURL: '' },
  { value: 'cloudflare', label: 'Cloudflare Workers AI', baseURL: '' },
  { value: 'minimax', label: 'MiniMax', baseURL: 'https://api.minimax.io/v1' },
  { value: 'moonshot', label: 'Moonshot Kimi', baseURL: 'https://api.moonshot.cn/v1' },
  {
    value: 'zhipu',
    label: 'Zhipu GLM',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4'
  },
  {
    value: 'aliyun',
    label: 'Alibaba Cloud Bailian',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1'
  },
  { value: 'qianfan', label: 'Baidu Qianfan', baseURL: 'https://qianfan.baidubce.com/v2' },
  {
    value: 'volcengine',
    label: 'Volcano Engine Ark',
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3'
  },
  {
    value: 'tencent',
    label: 'Tencent Hunyuan',
    baseURL: 'https://api.hunyuan.cloud.tencent.com/v1'
  },
  { value: 'siliconflow', label: 'SiliconFlow', baseURL: 'https://api.siliconflow.cn/v1' },
  { value: 'groq', label: 'Groq', baseURL: 'https://api.groq.com/openai/v1' },
  { value: 'perplexity', label: 'Perplexity', baseURL: 'https://api.perplexity.ai' },
  { value: 'together', label: 'Together AI', baseURL: 'https://api.together.xyz/v1' },
  { value: 'lmstudio', label: 'LM Studio', baseURL: 'http://localhost:1234/v1' },
  { value: 'custom', label: 'Custom', baseURL: '' }
]

const getProviderConfig = (provider: string): (typeof PROVIDER_TYPES)[number] | undefined =>
  PROVIDER_TYPES.find((preset) => preset.value === provider)

/** Provider display name: most vendors in the preset table already use Latin brand names; only the Chinese vendors and "Custom" need a localized label */
type ProviderLabelKey =
  | 'modelSettings.provider.zhipu'
  | 'modelSettings.provider.aliyun'
  | 'modelSettings.provider.qianfan'
  | 'modelSettings.provider.volcengine'
  | 'modelSettings.provider.tencent'
  | 'modelSettings.provider.siliconflow'

const PROVIDER_LABEL_KEYS: Partial<Record<string, ProviderLabelKey>> = {
  zhipu: 'modelSettings.provider.zhipu',
  aliyun: 'modelSettings.provider.aliyun',
  qianfan: 'modelSettings.provider.qianfan',
  volcengine: 'modelSettings.provider.volcengine',
  tencent: 'modelSettings.provider.tencent',
  siliconflow: 'modelSettings.provider.siliconflow'
}

const getProviderLabel = (t: TFunction, providerType: string, fallback: string): string => {
  if (providerType === 'custom') return t('common.state.custom')
  const key = PROVIDER_LABEL_KEYS[providerType]
  return key ? t(key) : fallback
}

/**
 * Labels in the shared constants (providerMeta / model-params) are literal strings, and those
 * modules do not hold a `t`.
 * The tables below keep the "data key → page translation key" mapping on this page, and the
 * component resolves it with `t()`.
 * i18next keys are constrained by the resource types, so the keys are narrowed to literals here;
 * values not covered by a table (e.g. a custom model type from a profile) fall back to the raw
 * string at the call site.
 */
type ModelTypeLabelKey =
  | 'modelSettings.modelType.textGeneration'
  | 'modelSettings.modelType.imageGeneration'
  | 'modelSettings.modelType.audioGeneration'
  | 'modelSettings.modelType.videoGeneration'
  | 'modelSettings.modelType.embedding'
  | 'modelSettings.modelType.rerank'
  | 'modelSettings.modelType.other'

type CapabilityBadgeKey =
  | 'modelSettings.capabilityBadge.imageInput'
  | 'modelSettings.capabilityBadge.functionCalling'
  | 'modelSettings.capabilityBadge.thinking'
  | 'modelSettings.capabilityBadge.streaming'
  | 'modelSettings.capabilityBadge.embeddings'

const MODEL_TYPE_LABEL_KEYS: Partial<Record<string, ModelTypeLabelKey>> = {
  'text-generation': 'modelSettings.modelType.textGeneration',
  'image-generation': 'modelSettings.modelType.imageGeneration',
  'audio-generation': 'modelSettings.modelType.audioGeneration',
  'video-generation': 'modelSettings.modelType.videoGeneration',
  embedding: 'modelSettings.modelType.embedding',
  rerank: 'modelSettings.modelType.rerank',
  other: 'modelSettings.modelType.other'
}

const CAPABILITY_BADGE_KEYS: Partial<Record<string, CapabilityBadgeKey>> = {
  supports_image_input: 'modelSettings.capabilityBadge.imageInput',
  supports_function_calling: 'modelSettings.capabilityBadge.functionCalling',
  supports_thinking: 'modelSettings.capabilityBadge.thinking',
  supports_streaming: 'modelSettings.capabilityBadge.streaming',
  supports_embeddings: 'modelSettings.capabilityBadge.embeddings'
}

/** Thinking mode (ThinkingMode) → page translation key */
const THINKING_MODE_KEYS = {
  auto: 'modelSettings.thinkingMode.auto',
  on: 'modelSettings.thinkingMode.on',
  off: 'modelSettings.thinkingMode.off'
} as const

/** Sampling parameter name → placeholder hint key */
const SAMPLING_PLACEHOLDER_KEYS = {
  temperature: 'modelSettings.params.temperaturePlaceholder',
  top_p: 'modelSettings.params.topPPlaceholder',
  top_k: 'modelSettings.params.topKPlaceholder'
} as const

/**
 * Monospace font stack (shared with the route skeleton and the editor).
 * **Latin and digits only**: when a monospace family lacks CJK glyphs, Chromium falls back to
 * monospace CJK fonts such as SimSun/NSimSun, which are clearly a different typeface from the rest
 * of the page's text (the system UI font) and simply look broken.
 */
const MONO_FONT = "'JetBrains Mono', 'Cascadia Code', Consolas, 'Courier New', monospace"

// provider → @ant-design/icons mapping; null when no icon matches (falls back to a letter mark)
const providerIconMap: Record<string, React.ComponentType<{ style?: React.CSSProperties }> | null> =
  {
    openai: OpenAIFilled,
    deepseek: DeepSeekFilled,
    ollama: OllamaFilled,
    mistral: MistralFilled,
    anthropic: AnthropicFilled,
    'google-genai': GeminiFilled
  }

const ProviderLogo: React.FC<{ provider: string; size?: number }> = ({ provider, size = 20 }) => {
  const Icon = providerIconMap[provider]
  if (Icon) {
    return <Icon style={{ fontSize: size }} />
  }
  // Providers without a logo fall back to a letter-mark badge: monospace monogram + hairline border (brand colors supplied by providerMeta)
  return <ProviderMark providerType={provider} size={size} />
}

/** Whether this is an embedding model: derived from metadata (type/supports_embeddings) or, as a fallback, the name/model id */
const isEmbeddingModel = (p: LlmProviderConfig): boolean => isEmbeddingProvider(p)

/** Compact model metadata summary (reused by tree rows and the fetch list; the model name is not shown); maxBadges caps the number of capability badges so rows do not overflow */
const MetaSummary: React.FC<{ metadata: ModelMetadata | null; maxBadges?: number }> = ({
  metadata,
  maxBadges
}) => {
  const { t } = useTranslation()
  const {
    token: { colorTextTertiary }
  } = theme.useToken()
  if (!metadata) {
    return (
      <span style={{ color: colorTextTertiary, fontSize: 12 }}>
        {t('modelSettings.list.unfilled')}
      </span>
    )
  }
  const caps = getCapabilities(metadata)
  const typeKey = metadata.type ? MODEL_TYPE_LABEL_KEYS[metadata.type] : undefined
  const typeLabel = typeKey ? t(typeKey) : (metadata.type ?? null)
  const badges = CAPABILITY_BADGES.filter((b) => caps[b.key] === true)
  const shown = maxBadges != null && badges.length > maxBadges ? badges.slice(0, maxBadges) : badges
  const hidden = badges.length - shown.length
  return (
    <Space size={4} wrap>
      {typeLabel ? <Tag style={{ margin: 0, fontSize: 11 }}>{typeLabel}</Tag> : null}
      {shown.map((b) => {
        const badgeKey = CAPABILITY_BADGE_KEYS[b.key]
        return (
          <Tag key={b.key} style={{ margin: 0, fontSize: 11 }} color="blue">
            {badgeKey ? t(badgeKey) : b.key}
          </Tag>
        )
      })}
      {hidden > 0 ? (
        <Tag style={{ margin: 0, fontSize: 11 }} color="blue">
          +{hidden}
        </Tag>
      ) : null}
    </Space>
  )
}

/* ── Modal form primitives ────────────────────────────────────────────────
   The edit modal used to contain a dozen scattered repetitions of "Form.Item + label + Space +
   hardcoded width". They are consolidated into a small component set here: plain-text group label +
   param row + preset chips. All rows share one layout, so a new parameter takes a single line. */

const MODAL_FORM_CSS = `
.ms-group { margin: 14px 0 4px; font-size: 13px; color: var(--ms-text); }
.ms-group:first-child { margin-top: 0; }
.ms-hint { font-size: 12px; color: var(--ms-tertiary); white-space: nowrap; }
.ms-row { display: flex; align-items: center; gap: 10px; padding: 5px 0; }
.ms-label { width: 96px; flex: none; font-size: 13.5px; color: var(--ms-secondary); }
.ms-control { flex: 1; min-width: 0; }
.ms-chips { display: flex; gap: 4px; flex: none; }
/* Mono is used for Latin and digits only (CJK in a mono family falls back to SimSun, a different typeface from the rest of the page) */
.ms-chip { font-family: var(--ms-mono); font-size: 11.5px; line-height: 19px; padding: 0 8px; border-radius: 10px; border: 1px solid var(--ms-hairline); background: transparent; color: var(--ms-tertiary); cursor: pointer; transition: color .15s, border-color .15s, background .15s; }
.ms-chip:hover { color: var(--ms-accent); border-color: var(--ms-accent); }
.ms-chip[data-active='true'] { color: var(--ms-accent); border-color: var(--ms-accent); background: var(--ms-accent-soft); }
.ms-switches { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 20px; margin: 10px 0 2px; }
.ms-switch { display: flex; align-items: center; gap: 7px; font-size: 13px; color: var(--ms-secondary); }
.ms-advanced-head { display: flex; align-items: center; gap: 8px; width: 100%; }
.ms-advanced-hint { margin-left: auto; font-family: var(--ms-mono); font-size: 11.5px; letter-spacing: .04em; text-transform: uppercase; color: var(--ms-tertiary); }
`

/**
 * Parameter group heading: plain text (following the design's wording for "context window (token)"
 * and "sampling parameters").
 * No dot + hairline decoration — when the group itself carries no information, decoration is just
 * noise.
 */
const GroupLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="ms-group">{children}</div>
)

/** Param row: label + control + (optional) right-side chips/note; the control itself binds via Form.Item noStyle */
const ParamRow: React.FC<{
  label: string
  hint?: React.ReactNode
  extra?: React.ReactNode
  children: React.ReactNode
}> = ({ label, hint, extra, children }) => (
  <div className="ms-row">
    <span className="ms-label">{label}</span>
    <div className="ms-control">{children}</div>
    {extra}
    {hint ? <span className="ms-hint">{hint}</span> : null}
  </div>
)

/** Numeric preset chips: one click fills the value in (highlighted when the current value matches the preset) */
const PresetChips: React.FC<{
  value: number | null | undefined
  presets: readonly number[]
  onPick: (value: number) => void
}> = ({ value, presets, onPick }) => (
  <div className="ms-chips">
    {presets.map((preset) => (
      <button
        key={preset}
        type="button"
        className="ms-chip"
        data-active={value === preset}
        onClick={() => onPick(preset)}
      >
        {formatTokenCount(preset)}
      </button>
    ))}
  </div>
)

/**
 * Reasoning effort chips: one click adds the level to / removes it from "available levels".
 *
 * Why a **multi-select toggle** instead of single-choice fill-in like the context window: this
 * field is itself a set (which levels can be picked in the input box), and each chip toggles
 * membership in it; for models whose profile lists no levels, the user builds the level table here.
 *
 * Only the four most common levels are shown (`REASONING_EFFORT_CHIPS`): the modal body is about
 * 500px wide, and seven chips in a row push the input box out (measured: the chips overflow
 * backwards because of `justify-content: flex-end` and cover the input's edge).
 */
const EffortPresetChips: React.FC<{
  value: string[]
  presets: readonly string[]
  onToggle: (level: string) => void
}> = ({ value, presets, onToggle }) => (
  <div className="ms-chips">
    {presets.map((preset) => (
      <button
        key={preset}
        type="button"
        className="ms-chip"
        data-active={value.includes(preset)}
        onClick={() => onToggle(preset)}
      >
        {reasoningEffortLabel(preset)}
      </button>
    ))}
  </div>
)

/**
 * "Supports image input" radio: reads and writes the metadata_capabilities array directly.
 * The panel exposes only this one capability switch; the other capabilities in the profile (tool
 * calling / thinking / embeddings …) are preserved as-is and not overwritten.
 */
const ImageInputRadio: React.FC<{
  value?: string[]
  onChange?: (value: string[]) => void
}> = ({ value, onChange }) => {
  const { t } = useTranslation()
  const caps = value ?? []
  const supported = caps.includes('supports_image_input')
  const setSupported = (next: boolean): void => {
    const rest = caps.filter((key) => key !== 'supports_image_input')
    if (next) rest.push('supports_image_input')
    onChange?.(rest)
  }
  return (
    <Radio.Group value={supported} onChange={(e) => setSupported(Boolean(e.target.value))}>
      <Radio value={true}>{t('modelSettings.form.imageInputSupported')}</Radio>
      <Radio value={false}>{t('modelSettings.form.imageInputUnsupported')}</Radio>
    </Radio.Group>
  )
}

const ModelSettings: React.FC = () => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const { colorTextSecondary, colorTextTertiary, colorSplit } = token

  const { modal } = App.useApp()
  const { viewMessage } = useMessage()

  const [providers, setProviders] = useState<LlmProviderConfig[]>([])
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editingProvider, setEditingProvider] = useState<LlmProviderConfig | null>(null)
  const [form] = Form.useForm()

  // Fetch-models modal
  const [fetchModalOpen, setFetchModalOpen] = useState(false)
  const [fetchProviderType, setFetchProviderType] = useState('ollama')
  const [fetchBaseUrl, setFetchBaseUrl] = useState('http://localhost:11434')
  const [fetchApiKey, setFetchApiKey] = useState('')
  const [fetchModels, setFetchModels] = useState<FetchedModel[]>([])
  const [fetchLoading, setFetchLoading] = useState(false)
  const [checkedModels, setCheckedModels] = useState<string[]>([])
  const [addingModels, setAddingModels] = useState(false)
  // Custom fetch: provider ID (lowercase ASCII, digits and - only)
  const [fetchCustomProviderId, setFetchCustomProviderId] = useState('')

  // Tree directory: group expansion and check state (checks drive batch delete)
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([])
  const [checkedKeys, setCheckedKeys] = useState<React.Key[]>([])
  const [deletingBatch, setDeletingBatch] = useState(false)

  // Capabilities come from profile autofill and the "supports image input" radio; useMemo keeps the reference stable so no new array is created per render
  const watchedCapsRaw = Form.useWatch('metadata_capabilities', form) as string[] | undefined
  const watchedCaps = useMemo<string[]>(() => watchedCapsRaw ?? [], [watchedCapsRaw])
  const watchedType: string | undefined = Form.useWatch('metadata_type', form)
  const watchedProviderType: string | undefined = Form.useWatch('provider', form)
  const watchedModel: string | undefined = Form.useWatch('model', form)
  const watchedApiFormat: string | undefined = Form.useWatch('api_format', form)
  // Live values needed by the advanced-settings summary and hints
  const watchedContext: number | null | undefined = Form.useWatch('metadata_context_window', form)
  const watchedMaxOutput: number | null | undefined = Form.useWatch(
    'metadata_max_output_tokens',
    form
  )
  const watchedToolRounds: number | null | undefined = Form.useWatch('max_tool_rounds', form)
  const watchedReasoningEffort: string | null | undefined = Form.useWatch('reasoning_effort', form)
  /**
   * The model's "available levels" table (the candidate set of reasoning efforts).
   * The source of truth is `capabilities.reasoning_effort_levels` in the model profile, but **the
   * user may edit it**: for models whose profile has no levels (self-hosted / niche models), pick
   * them here or click the chips; the level menu in the input box reads this same value.
   */
  const watchedEffortLevels: string[] | undefined = Form.useWatch(
    'metadata_reasoning_effort_levels',
    form
  )
  const effortLevels = useMemo<string[]>(
    () => (Array.isArray(watchedEffortLevels) ? watchedEffortLevels.filter(Boolean) : []),
    [watchedEffortLevels]
  )
  const watchedTemperature: number | null | undefined = Form.useWatch('temperature', form)
  const watchedTopP: number | null | undefined = Form.useWatch('top_p', form)
  const watchedTopK: number | null | undefined = Form.useWatch('top_k', form)
  /** Whether the current API protocol (including the compatible protocol of custom endpoints) is sent thinking parameters */
  const thinkingControllable = supportsThinkingControl(
    watchedProviderType ?? '',
    watchedApiFormat === 'anthropic'
  )
  // Whether the model is configured as an embedding model in the form (used to disable "set as default")
  const isEmbeddingInForm =
    watchedType === 'embedding' || watchedCaps.includes('supports_embeddings')

  /**
   * A one-line summary in the advanced-settings collapse header: only items that actually have a
   * value are shown.
   * Latin abbreviations are used rather than CJK — CJK falls back to SimSun inside the monospace
   * family, a different typeface from the rest of the page.
   */
  const advancedSummary = useMemo(() => {
    const parts: string[] = []
    if (watchedContext != null) parts.push(`in ${formatTokenCount(watchedContext)}`)
    if (watchedMaxOutput != null) parts.push(`out ${formatTokenCount(watchedMaxOutput)}`)
    if (watchedToolRounds != null) parts.push(`tools ${watchedToolRounds}`)
    if (watchedReasoningEffort) parts.push(String(watchedReasoningEffort))
    if (watchedTemperature != null) parts.push(`t ${watchedTemperature}`)
    if (watchedTopP != null) parts.push(`p ${watchedTopP}`)
    if (watchedTopK != null) parts.push(`k ${watchedTopK}`)
    return parts.length > 0 ? parts.join(' · ') : 'defaults'
  }, [
    watchedContext,
    watchedMaxOutput,
    watchedToolRounds,
    watchedReasoningEffort,
    watchedTemperature,
    watchedTopP,
    watchedTopK
  ])

  /** Quick presets: write the number and mark it touched so switching the model ID does not reset it via profile autofill */
  const pickAdvancedNumber = (name: string, value: number): void => {
    form.setFields([{ name, value, touched: true }])
  }

  /** Level chips: add / remove a level from "available levels", also marking it touched (the user's manual set wins over the profile) */
  const toggleEffortLevel = (level: string): void => {
    const next = effortLevels.includes(level)
      ? effortLevels.filter((item) => item !== level)
      : [...effortLevels, level]
    form.setFields([
      { name: 'metadata_reasoning_effort_levels', value: sortReasoningEfforts(next), touched: true }
    ])
  }

  /** Theme variables inside the modal: the form primitives share one palette (hairline / mono / accent) */
  const modalVars = {
    '--ms-accent': token.colorPrimary,
    '--ms-accent-soft': token.colorFillQuaternary,
    '--ms-hairline': token.colorBorderSecondary,
    '--ms-surface': token.colorFillQuaternary,
    '--ms-text': token.colorText,
    '--ms-secondary': token.colorTextSecondary,
    '--ms-tertiary': token.colorTextTertiary,
    '--ms-mono': MONO_FONT
  } as React.CSSProperties

  // API protocol: a single-select Select plus free entry of any protocol id.
  // When the input matches no preset platform, a "custom protocol" option is injected live for
  // submission (unknown protocols are called as OpenAI-compatible).
  const [protocolSearch, setProtocolSearch] = useState('')
  const protocolOptions = useMemo(() => {
    const raw = protocolSearch.trim()
    const search = raw.toLowerCase()
    const presets = PROVIDER_TYPES.map((preset) => ({
      value: preset.value,
      label: `${getProviderLabel(t, preset.value, preset.label)} (${preset.value})`
    }))
    const matchesPreset = presets.some((o) => o.label.toLowerCase().includes(search))
    return raw && !matchesPreset
      ? [{ value: raw, label: t('modelSettings.protocol.customOption', { name: raw }) }, ...presets]
      : presets
  }, [protocolSearch, t])

  // ── Model profile autofill (create flow only): a model ID hit in models-profile fills in metadata ──
  // Hit status: idle = not queried / matched = found / missing = queried but not covered
  const [profileStatus, setProfileStatus] = useState<'idle' | 'matched' | 'missing'>('idle')
  const profileTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const autoFillRef = useRef<{ modelId: string; keys: string[] } | null>(null)

  /** Clear autofill traces: only clear fields "written by autofill and never edited by the user" */
  const resetProfileAutofill = useCallback((): void => {
    if (profileTimer.current) {
      clearTimeout(profileTimer.current)
      profileTimer.current = null
    }
    const prev = autoFillRef.current
    autoFillRef.current = null
    setProfileStatus('idle')
    if (!prev || prev.keys.length === 0) return
    const empty: Record<string, unknown> = {}
    for (const key of prev.keys) {
      if (form.isFieldTouched(key)) continue
      if (key === 'name') empty[key] = ''
      else if (key === 'metadata_type') empty[key] = undefined
      else if (key === 'metadata_capabilities') empty[key] = []
      else if (key === 'metadata_reasoning_effort_levels') empty[key] = []
      else empty[key] = null
    }
    form.setFieldsValue(empty)
  }, [form])

  /** Create: query the official profile and fill only fields that are "still empty" (content the user already entered is never overwritten) */
  const applyProfileAutofill = useCallback(
    async (modelId: string): Promise<void> => {
      try {
        const profile = (await window.api.providers.lookupProfile(
          modelId
        )) as ModelMetadata | null
        if (!profile) {
          setProfileStatus('missing')
          return
        }
        // The user kept typing during the query: discard the old result and wait for the next query on the new model ID
        if (form.getFieldValue('model') !== modelId) return
        const cur = form.getFieldsValue()
        const patch: Record<string, unknown> = {}
        const fillIfEmpty = (key: string, value: string | number | string[]): void => {
          const now = cur[key]
          const empty =
            now == null || now === '' || now === 0 || (Array.isArray(now) && now.length === 0) // an empty array also counts as empty for array fields (available levels)
          if (empty) patch[key] = value
        }
        if (typeof profile.display_name === 'string' && profile.display_name.trim()) {
          fillIfEmpty('name', profile.display_name.trim())
        }
        if (typeof profile.type === 'string' && profile.type.trim()) {
          fillIfEmpty('metadata_type', profile.type.trim())
        }
        const caps = Array.isArray(cur.metadata_capabilities)
          ? (cur.metadata_capabilities as string[])
          : []
        const pc = (profile.capabilities ?? {}) as Record<string, boolean | string[] | undefined>
        if (caps.length === 0) {
          const capKeys = CAPABILITY_OPTIONS.filter((o) => pc[o.key] === true).map((o) => o.key)
          if (capKeys.length > 0) patch.metadata_capabilities = capKeys
        }
        if (typeof profile.context_window === 'number' && profile.context_window > 0) {
          fillIfEmpty('metadata_context_window', profile.context_window)
        }
        if (typeof profile.max_output_tokens === 'number' && profile.max_output_tokens > 0) {
          fillIfEmpty('metadata_max_output_tokens', profile.max_output_tokens)
        }
        // Level table: backfilled when the profile hits (left alone if the user edited it — fillIfEmpty only fills empty arrays)
        const profileLevels = pc.reasoning_effort_levels
        if (Array.isArray(profileLevels) && profileLevels.length > 0) {
          fillIfEmpty('metadata_reasoning_effort_levels', sortReasoningEfforts(profileLevels))
        }
        autoFillRef.current = { modelId, keys: Object.keys(patch) }
        setProfileStatus('matched')
        if (Object.keys(patch).length > 0) form.setFieldsValue(patch)
      } catch {
        // Stay silent when the profile query fails: do not block manual entry
      }
    },
    [form]
  )

  /** Debounced scheduling on model ID input (not triggered in the edit flow, to avoid overwriting the existing profile) */
  const scheduleProfileAutofill = useCallback(
    (modelId: string): void => {
      if (profileTimer.current) {
        clearTimeout(profileTimer.current)
        profileTimer.current = null
      }
      if (!modelId) {
        resetProfileAutofill()
        return
      }
      const prev = autoFillRef.current
      if (prev && prev.modelId !== modelId) resetProfileAutofill()
      else setProfileStatus('idle')
      if (editingProvider) return
      profileTimer.current = setTimeout(() => {
        profileTimer.current = null
        void applyProfileAutofill(modelId)
      }, 350)
    },
    [editingProvider, applyProfileAutofill, resetProfileAutofill]
  )

  /** Form value-change entry: reacts only to model ID changes (setFieldsValue does not fire it, so there is no loop) */
  const handleFormValuesChange = (changedValues: Record<string, unknown>): void => {
    if (!('model' in changedValues)) return
    scheduleProfileAutofill(String(changedValues.model ?? '').trim())
  }

  /** Shared teardown for closing the edit/create modal (used by both cancel and successful save) */
  const closeModal = useCallback((): void => {
    resetProfileAutofill()
    setModalOpen(false)
    form.resetFields()
    setEditingProvider(null)
    setProtocolSearch('')
  }, [form, resetProfileAutofill])

  // Clear the profile query timer on unmount
  useEffect(() => {
    return () => {
      if (profileTimer.current) {
        clearTimeout(profileTimer.current)
        profileTimer.current = null
      }
    }
  }, [])

  const loadProviders = useCallback(async () => {
    const msgKey = 'providers-load'
    try {
      setLoading(true)
      const result = await window.api.providers.getAll()
      setProviders(result)
    } catch (error) {
      viewMessage(
        msgKey,
        'error',
        t('common.message.loadFailedWithReason', { reason: String(error) })
      )
    } finally {
      setLoading(false)
    }
  }, [viewMessage, t])

  useEffect(() => {
    loadProviders().then()
  }, [loadProviders])

  const openCreateModal = (): void => {
    resetProfileAutofill()
    setEditingProvider(null)
    setProtocolSearch('')
    form.resetFields()
    form.setFieldsValue({
      provider: 'deepseek',
      api_format: 'openai',
      // Leave sampling/thinking empty = use the provider's best defaults; give tool rounds the default cap
      temperature: null,
      top_p: null,
      top_k: null,
      thinking_mode: 'auto',
      reasoning_effort: null,
      max_tool_rounds: DEFAULT_MAX_TOOL_ROUNDS,
      metadata_capabilities: [],
      metadata_reasoning_effort_levels: [],
      is_enabled: true,
      pinned: false
    })
    setModalOpen(true)
  }

  const openEditModal = (record: LlmProviderConfig): void => {
    resetProfileAutofill()
    setEditingProvider(record)
    setProtocolSearch('')
    const meta = record.metadata ?? {}
    const caps = getCapabilities(record.metadata)
    form.setFieldsValue({
      // The name is the display name (including the displayed result of a legacy display_name); after saving everything converges to name
      name: getProviderDisplayName(record),
      provider: record.provider,
      base_url: record.base_url,
      // The key is never sent to the renderer: always empty when editing; leaving it empty keeps the old key, only re-entry replaces it
      api_key: '',
      model: record.model,
      // Context window → output: the old standalone "max tokens" column is read as a fallback; the two converge to one value on save
      metadata_context_window: typeof meta.context_window === 'number' ? meta.context_window : null,
      metadata_max_output_tokens:
        typeof meta.max_output_tokens === 'number' ? meta.max_output_tokens : record.max_tokens,
      temperature: record.temperature,
      top_p: record.top_p,
      top_k: record.top_k,
      thinking_mode: record.thinking_mode ?? 'auto',
      reasoning_effort: record.reasoning_effort ?? null,
      max_tool_rounds: record.max_tool_rounds ?? DEFAULT_MAX_TOOL_ROUNDS,
      api_format:
        record.extra_config && typeof record.extra_config.api_format === 'string'
          ? record.extra_config.api_format
          : 'openai',
      metadata_type: typeof meta.type === 'string' ? meta.type : undefined,
      metadata_capabilities: CAPABILITY_OPTIONS.filter((o) => caps[o.key]).map((o) => o.key),
      // Level table from the stored metadata: both the input box's level menu and the selector here read it
      metadata_reasoning_effort_levels: sortReasoningEfforts(caps.reasoning_effort_levels),
      is_enabled: record.is_enabled,
      pinned: record.is_pinned
    })
    setModalOpen(true)
  }

  const handleProviderTypeChange = (providerType: string): void => {
    const config = getProviderConfig(providerType)
    if (config) {
      // A preset protocol follows its default endpoint; the custom type clears it for the user to fill in (the API address is shown only for custom)
      form.setFieldsValue({ base_url: config.value === 'custom' ? '' : config.baseURL || '' })
    }
    setProtocolSearch('')
  }

  /**
   * Build the metadata object from the form fields: keep existing profile fields and override the
   * ones the user edited.
   * The vendor ID is no longer entered by hand — it is derived from the API protocol (a custom
   * endpoint uses its custom ID, i.e. the provider value).
   */
  const buildMetadata = (
    values: Record<string, unknown>,
    existing: ModelMetadata | null
  ): ModelMetadata | null => {
    const base = existing ? { ...existing } : {}
    const currentCaps: Record<string, boolean | string[]> = {
      ...(existing?.capabilities && typeof existing.capabilities === 'object'
        ? (existing.capabilities as Record<string, boolean | string[]>)
        : {})
    }
    // The panel exposes only the "supports image input" switch; other capabilities are kept as they are in the profile
    const selectedCaps = ((values.metadata_capabilities as string[]) ?? []).filter(Boolean)
    currentCaps.supports_image_input = selectedCaps.includes('supports_image_input')

    // Available levels (an array capability): written back whole after manual entry / profile backfill; empty means the model offers no levels
    const levels = sortReasoningEfforts(
      (values.metadata_reasoning_effort_levels as string[] | undefined) ?? []
    )
    if (levels.length > 0) currentCaps.reasoning_effort_levels = levels
    else delete currentCaps.reasoning_effort_levels

    const vendor = typeof values.provider === 'string' ? values.provider.trim() : ''
    const type = typeof values.metadata_type === 'string' ? values.metadata_type.trim() : ''
    const ctx = values.metadata_context_window as number | null | undefined
    const maxOut = values.metadata_max_output_tokens as number | null | undefined

    const metadata: ModelMetadata = { ...base, capabilities: currentCaps }
    // Display names converge to the form's name field: a legacy display_name left in a profile is normalized to name when saved
    delete metadata.display_name
    if (vendor) metadata.vendor = vendor
    else delete metadata.vendor
    if (type) metadata.type = type
    else delete metadata.type
    if (ctx != null && ctx > 0) metadata.context_window = ctx
    else delete metadata.context_window
    if (maxOut != null && maxOut > 0) metadata.max_output_tokens = maxOut
    else delete metadata.max_output_tokens

    const meaningful =
      vendor.length > 0 ||
      type.length > 0 ||
      (ctx != null && ctx > 0) ||
      (maxOut != null && maxOut > 0) ||
      CAPABILITY_OPTIONS.some((o) => currentCaps[o.key])
    return meaningful ? metadata : null
  }

  const handleSubmit = async (): Promise<void> => {
    const msgKey = 'provider-save'
    try {
      const values = await form.validateFields()

      // API address: only the "custom" type can enter one; other types use the selected provider's default
      const cfg = getProviderConfig(values.provider as string)
      const rawBaseUrl =
        typeof values.base_url === 'string'
          ? values.base_url.trim()
          : typeof form.getFieldValue('base_url') === 'string'
            ? String(form.getFieldValue('base_url')).trim()
            : ''
      const defaultBaseUrl = cfg?.baseURL || undefined
      const modelId = String(values.model ?? '').trim()
      // An empty name defaults to the model ID (same as batch add in "fetch models"; name is the display name)
      const rawName = typeof values.name === 'string' ? values.name.trim() : ''
      const name = rawName || modelId

      const embeddingInForm =
        values.metadata_type === 'embedding' ||
        ((values.metadata_capabilities as string[] | undefined) ?? []).includes(
          'supports_embeddings'
        )
      if (values.is_default === true && embeddingInForm) {
        viewMessage(msgKey, 'warning', t('modelSettings.messages.embeddingNotDefaultChat'))
        return
      }

      const outputTokens = values.metadata_max_output_tokens as number | null | undefined
      const input: LlmProviderInput = {
        name,
        provider: values.provider as string,
        base_url: rawBaseUrl || defaultBaseUrl,
        model: modelId,
        // Empty sampling/thinking is not sent (null), letting the provider apply its best defaults
        temperature: (values.temperature as number | null | undefined) ?? null,
        // The request output cap and "context window → output" are the same value: enter it once, kept in sync in both places
        max_tokens: outputTokens != null && outputTokens > 0 ? outputTokens : null,
        top_p: (values.top_p as number | null | undefined) ?? null,
        top_k: (values.top_k as number | null | undefined) ?? null,
        thinking_mode: (values.thinking_mode as LlmProviderInput['thinking_mode']) ?? 'auto',
        // Reasoning effort: empty = unset (no effort parameter is sent; the model default applies)
        reasoning_effort: (values.reasoning_effort as string | null | undefined) ?? null,
        max_tool_rounds:
          (values.max_tool_rounds as number | null | undefined) ?? DEFAULT_MAX_TOOL_ROUNDS,
        // The compatible protocol only applies to the "custom" type and is stored in extra_config.api_format; other types keep their extra_config
        extra_config:
          (values.provider as string) === 'custom'
            ? {
                ...(editingProvider?.extra_config ?? {}),
                api_format: (values.api_format as string) || 'openai'
              }
            : editingProvider
              ? editingProvider.extra_config
              : undefined,
        metadata: buildMetadata(values, editingProvider?.metadata ?? null),
        is_enabled: values.is_enabled as boolean | undefined,
        is_default: values.is_default as boolean | undefined,
        // Pinning is performed in the main process with SQL max(sort_order)+1; the frontend only sends the toggle
        pinned: values.pinned === true
      }

      if (editingProvider) {
        if (values.api_key) {
          input.api_key = values.api_key as string
        }
        viewMessage(msgKey, 'loading', t('modelSettings.messages.updating'))
        await window.api.providers.update(editingProvider.id, input)
        viewMessage(msgKey, 'success', t('modelSettings.messages.updated'), 2)
      } else {
        input.api_key = (values.api_key as string) || null
        viewMessage(msgKey, 'loading', t('modelSettings.messages.creating'))
        await window.api.providers.create(input)
        viewMessage(msgKey, 'success', t('modelSettings.messages.created'), 2)
      }

      closeModal()
      await loadProviders()
    } catch (error) {
      if (error && typeof error === 'object' && 'errorFields' in error) return
      viewMessage(
        msgKey,
        'error',
        t('common.message.operationFailedWithReason', { reason: String(error) })
      )
    }
  }

  const handleDelete = async (id: number): Promise<void> => {
    const msgKey = 'provider-delete'
    try {
      viewMessage(msgKey, 'loading', t('common.action.deleting'))
      await window.api.providers.delete(id)
      viewMessage(msgKey, 'success', t('common.action.deleteSuccess'), 2)
      await loadProviders()
    } catch (error) {
      viewMessage(
        msgKey,
        'error',
        t('common.message.deleteFailedWithReason', { reason: String(error) })
      )
    }
  }

  const handleSetDefault = async (id: number): Promise<void> => {
    const msgKey = 'provider-default'
    try {
      const provider = providers.find((p) => p.id === id)
      if (provider && isEmbeddingModel(provider)) {
        viewMessage(msgKey, 'error', t('modelSettings.messages.vectorNotDefaultChat'))
        return
      }
      viewMessage(msgKey, 'loading', t('modelSettings.messages.settingDefault'))
      await window.api.providers.setDefault(id)
      viewMessage(msgKey, 'success', t('modelSettings.messages.defaultUpdated'), 2)
      await loadProviders()
    } catch (error) {
      viewMessage(
        msgKey,
        'error',
        t('modelSettings.messages.setDefaultFailed', { reason: String(error) })
      )
    }
  }

  // Fetch models
  const handleFetchModels = async (): Promise<void> => {
    setFetchLoading(true)
    setFetchModels([])
    setCheckedModels([])
    try {
      const result = (await window.api.providers.fetchModels(
        fetchProviderType,
        fetchBaseUrl || undefined,
        fetchApiKey || undefined
      )) as FetchedModel[]
      // Filter out models that already exist
      const existingIds = new Set(providers.map((p) => p.model))
      const newModels = result.filter((m) => !existingIds.has(m.id))
      setFetchModels(newModels)
      // Newly fetched models are selected by default; the user can uncheck some in the list and then add them in one go
      setCheckedModels(newModels.map((m) => m.id))
    } catch (error) {
      viewMessage(
        'fetch-models',
        'error',
        t('modelSettings.messages.fetchFailed', { reason: String(error) })
      )
    } finally {
      setFetchLoading(false)
    }
  }

  const handleProviderTypeChangeForFetch = (type: string): void => {
    setFetchProviderType(type)
    const config = PROVIDER_TYPES.find((preset) => preset.value === type)
    if (config?.baseURL) {
      setFetchBaseUrl(config.baseURL)
      setFetchApiKey('')
    } else {
      setFetchBaseUrl('')
    }
  }

  // Add the selected models in one click (carrying the capability tags derived during the fetch).
  // Uses provider-create-batch: the main process inserts in a single transaction and broadcasts one
  // change, instead of per-model creates causing 29 full renderer refreshes and freezing the app.
  const handleBatchAdd = async (): Promise<void> => {
    const msgKey = 'batch-add'
    if (checkedModels.length === 0) {
      viewMessage(msgKey, 'warning', t('modelSettings.messages.selectAtLeastOne'))
      return
    }
    // The custom type requires a provider ID (lowercase ASCII, digits and - only)
    if (fetchProviderType === 'custom') {
      const pid = fetchCustomProviderId.trim()
      if (!/^[a-z0-9-]+$/.test(pid)) {
        viewMessage(msgKey, 'warning', t('modelSettings.messages.invalidProviderId'))
        return
      }
    }
    const addProvider =
      fetchProviderType === 'custom' ? fetchCustomProviderId.trim() : fetchProviderType
    const metaMap = new Map(fetchModels.map((m) => [m.id, m.metadata]))
    setAddingModels(true)
    try {
      const inputs: LlmProviderInput[] = checkedModels.map((modelId) => ({
        name: modelId,
        provider: addProvider,
        base_url: fetchBaseUrl || undefined,
        api_key: fetchApiKey || undefined,
        model: modelId,
        metadata: metaMap.get(modelId) ?? null,
        is_enabled: true,
        is_default: false
      }))
      const result = await window.api.providers.createBatch(inputs)
      viewMessage(
        msgKey,
        'success',
        result.skipped > 0
          ? t('modelSettings.messages.batchAddSuccessWithSkipped', {
              count: result.created,
              skipped: result.skipped
            })
          : t('modelSettings.messages.batchAddSuccess', { count: result.created }),
        3
      )
      setFetchModalOpen(false)
      await loadProviders()
    } catch (error) {
      viewMessage(
        msgKey,
        'error',
        t('modelSettings.messages.batchAddFailed', { reason: String(error) })
      )
    } finally {
      setAddingModels(false)
    }
  }

  // --- Tree directory (grouped by model provider / API protocol) ---

  /** Group membership: grouped by model provider (API protocol), e.g. OpenAI / DeepSeek / Zhipu GLM / Custom */
  const groupOf = (p: LlmProviderConfig): { key: string; label: string } => {
    const cfg = getProviderConfig(p.provider)
    return {
      key: `provider:${p.provider}`,
      label: cfg ? getProviderLabel(t, cfg.value, cfg.label) : p.provider
    }
  }

  interface ProviderTreeNode extends TreeDataNode {
    record?: LlmProviderConfig
    children?: ProviderTreeNode[]
  }

  const treeData = useMemo<ProviderTreeNode[]>(() => {
    const groups = new Map<string, { label: string; items: LlmProviderConfig[] }>()
    for (const p of providers) {
      const g = groupOf(p)
      let entry = groups.get(g.key)
      if (!entry) {
        entry = { label: g.label, items: [] }
        groups.set(g.key, entry)
      }
      entry.items.push(p)
    }
    return [...groups.entries()].map(([key, entry]) => ({
      key,
      title: entry.label,
      children: entry.items.map((p) => ({
        key: String(p.id),
        record: p,
        // The default model cannot be checked (consistent with single-row delete: the default model cannot be deleted)
        disableCheckbox: p.is_default
      }))
    }))
  }, [providers, t])

  /** Currently checked model ids (model node keys are plain numeric ids; group node keys carry a colon prefix) */
  const selectedIds = useMemo(
    () => checkedKeys.filter((k) => !String(k).includes(':')).map((k) => Number(k)),
    [checkedKeys]
  )

  // Expand newly added groups by default after load / refresh (fix: previously all groups were
  // unconditionally re-added to the expanded set, so groups the user had collapsed were forced open
  // on every refresh)
  useEffect(() => {
    setExpandedKeys((prev) => {
      const known = new Set<React.Key>(prev)
      const next = new Set<React.Key>(prev)
      let changed = false
      for (const node of treeData) {
        if (!known.has(node.key)) {
          next.add(node.key)
          changed = true
        }
      }
      return changed ? [...next] : prev
    })
  }, [treeData])

  /** Tree node rendering: group rows / model rows (model rows carry their own action buttons) */
  const renderTreeNodeTitle = (node: ProviderTreeNode): React.ReactNode => {
    const record = node.record
    if (!record) {
      // Group node
      const count = node.children?.length ?? 0
      return (
        <span className="inline-flex items-center" style={{ gap: 6 }}>
          <span style={{ fontWeight: 600 }}>{String(node.title)}</span>
          <span style={{ color: colorTextTertiary, fontSize: 12 }}>
            {/* Digits use mono, CJK uses the default UI font (see the font rule at the top of the file) */}
            <Trans
              i18nKey="modelSettings.list.groupCount"
              count={count}
              components={{ mono: <span style={{ fontFamily: MONO_FONT }} /> }}
            />
          </span>
        </span>
      )
    }
    // Model node
    return (
      <span
        className="inline-flex items-center w-full"
        style={{ gap: 6, minWidth: 0, paddingRight: 8 }}
      >
        <ProviderLogo provider={record.provider} size={16} />
        <span style={{ whiteSpace: 'nowrap' }}>{getProviderDisplayName(record)}</span>
        {record.is_default && (
          <Tag color="gold" style={{ margin: 0, fontSize: 11 }}>
            {t('common.state.default')}
          </Tag>
        )}
        {record.is_pinned && (
          <Tag style={{ margin: 0, fontSize: 11, color: colorTextTertiary }}>
            {t('modelSettings.list.pinned')}
          </Tag>
        )}
        {record.provider === 'custom' && (
          <span
            style={{
              color: colorTextTertiary,
              fontSize: 12,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              maxWidth: 260,
              minWidth: 0
            }}
          >
            {record.base_url ? (
              <span style={{ fontFamily: MONO_FONT }}>{record.base_url}</span>
            ) : (
              t('modelSettings.list.noBaseUrl')
            )}{' '}
            <span style={{ fontFamily: MONO_FONT }}>
              (
              {record.extra_config && record.extra_config.api_format === 'anthropic'
                ? 'Anthropic'
                : 'OpenAI'}
              )
            </span>
          </span>
        )}
        <MetaSummary metadata={record.metadata} maxBadges={2} />
        <span className="flex-1" />
        <Space size={2} onClick={(e) => e.stopPropagation()}>
          {record.is_default ? (
            <Tooltip title={t('modelSettings.list.alreadyDefault')}>
              <StarFilled style={{ color: '#faad14', fontSize: 14, padding: '0 6px' }} />
            </Tooltip>
          ) : isEmbeddingModel(record) ? null : (
            <Tooltip title={t('modelSettings.list.setDefaultTooltip')}>
              <Popconfirm
                title={t('modelSettings.list.setDefaultTitle')}
                description={t('modelSettings.list.setDefaultDescription')}
                onConfirm={() => handleSetDefault(record.id)}
                okText={t('common.action.confirm')}
                cancelText={t('common.action.cancel')}
              >
                <Button type="text" size="small" icon={<StarOutlined />} />
              </Popconfirm>
            </Tooltip>
          )}
          <Tooltip title={t('common.action.edit')}>
            <Button
              type="text"
              size="small"
              icon={<EditOutlined />}
              onClick={() => openEditModal(record)}
            />
          </Tooltip>
          {!record.is_default && (
            <Tooltip title={t('common.action.delete')}>
              <Button
                type="text"
                size="small"
                danger
                icon={<DeleteOutlined />}
                onClick={() => {
                  modal.confirm({
                    title: t('modelSettings.messages.deleteConfirmTitle'),
                    content: t('modelSettings.messages.deleteConfirmContent', {
                      name: record.name
                    }),
                    okText: t('common.action.delete'),
                    cancelText: t('common.action.cancel'),
                    okButtonProps: { danger: true },
                    onOk: () => handleDelete(record.id)
                  })
                }}
              />
            </Tooltip>
          )}
        </Space>
      </span>
    )
  }

  /** Delete the checked models in a batch (single transaction + single broadcast, avoiding a refresh storm from per-item deletes) */
  const handleBatchDelete = async (): Promise<void> => {
    const msgKey = 'provider-delete-batch'
    if (selectedIds.length === 0) return
    const targets = providers.filter((p) => selectedIds.includes(p.id))
    const names = targets.map((p) => getProviderDisplayName(p))
    const separator = t('modelSettings.messages.nameSeparator')
    modal.confirm({
      title: t('modelSettings.messages.batchDeleteTitle', { count: targets.length }),
      content:
        targets.length > 3
          ? t('modelSettings.messages.batchDeleteDetailMore', {
              names: names.slice(0, 3).join(separator),
              count: targets.length
            })
          : t('modelSettings.messages.batchDeleteDetail', { names: names.join(separator) }),
      okText: t('modelSettings.actions.batchDelete'),
      cancelText: t('common.action.cancel'),
      okButtonProps: { danger: true },
      onOk: async () => {
        setDeletingBatch(true)
        try {
          const count = await window.api.providers.deleteBatch(selectedIds)
          viewMessage(
            msgKey,
            'success',
            t('modelSettings.messages.batchDeleteSuccess', { count }),
            2
          )
          setCheckedKeys([])
          await loadProviders()
        } catch (error) {
          viewMessage(
            msgKey,
            'error',
            t('modelSettings.messages.batchDeleteFailed', { reason: String(error) })
          )
        } finally {
          setDeletingBatch(false)
        }
      }
    })
  }

  // Whether everything in the fetch list is checked (checkedModels is always a subset of fetchModels, so equal counts mean all)
  const fetchAllChecked = fetchModels.length > 0 && checkedModels.length === fetchModels.length
  /** Tooltip and aria label for the select-all / deselect-all button */
  const fetchAllLabel = fetchAllChecked
    ? t('modelSettings.fetch.deselectAll')
    : t('modelSettings.fetch.selectAll')

  return (
    <div>
      <SettingsPageHeader
        title={t('modelSettings.pageTitle')}
        description={t('modelSettings.pageDescription')}
        extra={
          <div className="flex items-center" style={{ gap: 8 }}>
            <Button icon={<DownloadOutlined />} onClick={() => setFetchModalOpen(true)}>
              {t('modelSettings.actions.fetchModels')}
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreateModal}>
              {t('modelSettings.actions.addModel')}
            </Button>
          </div>
        }
      />

      <SettingsSection bodyPadding={0}>
        {/* Directory header: counts + batch-delete action bar */}
        <div
          className="flex items-center justify-between px-4 py-2"
          style={{ borderBottom: `1px solid ${colorSplit}` }}
        >
          <span style={{ color: colorTextSecondary, fontSize: 12 }}>
            <Trans
              i18nKey="modelSettings.list.total"
              count={providers.length}
              components={{ mono: <span style={{ fontFamily: MONO_FONT }} /> }}
            />
          </span>
          {selectedIds.length > 0 && (
            <Space size={8}>
              <span style={{ color: colorTextSecondary, fontSize: 12 }}>
                <Trans
                  i18nKey="modelSettings.list.selected"
                  count={selectedIds.length}
                  components={{ mono: <span style={{ fontFamily: MONO_FONT }} /> }}
                />
              </span>
              <Button
                danger
                size="small"
                icon={<DeleteOutlined />}
                loading={deletingBatch}
                onClick={handleBatchDelete}
              >
                {t('modelSettings.actions.batchDelete')}
              </Button>
              <Button type="text" size="small" onClick={() => setCheckedKeys([])}>
                {t('modelSettings.actions.clearSelection')}
              </Button>
            </Space>
          )}
        </div>
        {loading ? (
          /* Vendors / models form a tree: lay out row skeletons first so the whole tree does not "grow" at once after a blank frame */
          <div style={{ padding: '8px 0' }}>
            <SkeletonSettingRows rows={6} />
          </div>
        ) : providers.length === 0 ? (
          <div className="py-12 text-center" style={{ color: colorTextSecondary }}>
            {t('modelSettings.empty.noModels')}
          </div>
        ) : (
          <Tree
            checkable
            selectable={false}
            blockNode
            showLine={{ showLeafIcon: false }}
            treeData={treeData}
            checkedKeys={checkedKeys}
            onCheck={(keys) => setCheckedKeys(Array.isArray(keys) ? keys : keys.checked)}
            expandedKeys={expandedKeys}
            onExpand={(keys) => setExpandedKeys(keys)}
            titleRender={(node) => renderTreeNodeTitle(node as ProviderTreeNode)}
            className="provider-directory-tree"
            style={{ padding: '8px 8px 12px 4px' }}
          />
        )}
      </SettingsSection>

      <Modal
        title={
          editingProvider
            ? t('modelSettings.form.editTitle', { name: getProviderDisplayName(editingProvider) })
            : t('modelSettings.actions.addModel')
        }
        open={modalOpen}
        onCancel={closeModal}
        onOk={handleSubmit}
        okText={t('common.action.save')}
        cancelText={t('common.action.cancel')}
        width={560}
        styles={{ body: { maxHeight: 560, padding: 16, overflowY: 'auto' } }}
        classNames={{ body: 'custom-scrollbar' }}
      >
        <Form
          form={form}
          layout="vertical"
          style={modalVars}
          initialValues={{
            provider: 'deepseek',
            api_format: 'openai',
            temperature: null,
            top_p: null,
            top_k: null,
            thinking_mode: 'auto',
            max_tool_rounds: DEFAULT_MAX_TOOL_ROUNDS,
            metadata_capabilities: [],
            is_enabled: true,
            pinned: false
          }}
          onValuesChange={handleFormValuesChange}
        >
          <style>{MODAL_FORM_CSS}</style>

          {/* ── Connection: the fields actually filled in each time ── */}
          <Form.Item
            name="provider"
            label={t('modelSettings.form.protocol')}
            rules={[{ required: true, message: t('modelSettings.form.protocolRequired') }]}
            tooltip={
              editingProvider
                ? t('modelSettings.form.protocolTooltipEditing')
                : t('modelSettings.form.protocolTooltip')
            }
          >
            <Select
              showSearch
              allowClear
              disabled={Boolean(editingProvider)}
              placeholder={t('modelSettings.form.protocolPlaceholder')}
              optionFilterProp="label"
              options={protocolOptions}
              onChange={handleProviderTypeChange}
              onSearch={setProtocolSearch}
            />
          </Form.Item>

          {watchedProviderType === 'custom' && (
            <>
              <Form.Item
                name="base_url"
                label={t('modelSettings.form.baseUrl')}
                tooltip={t('modelSettings.form.baseUrlTooltip')}
              >
                <Input placeholder="https://api.example.com/v1" allowClear />
              </Form.Item>
              <Form.Item
                name="api_format"
                label={t('modelSettings.form.apiFormat')}
                tooltip={t('modelSettings.form.apiFormatTooltip')}
              >
                <Select
                  options={[
                    { value: 'openai', label: t('modelSettings.form.apiFormatOpenAI') },
                    { value: 'anthropic', label: t('modelSettings.form.apiFormatAnthropic') }
                  ]}
                />
              </Form.Item>
            </>
          )}

          {/* ── Model: ID / API key / name (the model ID is locked in edit mode; the vendor is derived from the API protocol) ── */}
          <Form.Item
            name="model"
            label={t('modelSettings.form.modelId')}
            rules={[
              {
                required: true,
                whitespace: true,
                message: t('modelSettings.form.modelIdRequired')
              }
            ]}
            tooltip={
              editingProvider
                ? t('modelSettings.form.modelIdTooltipEditing')
                : t('modelSettings.form.modelIdTooltip')
            }
          >
            <Input
              disabled={Boolean(editingProvider)}
              placeholder={t('modelSettings.form.modelIdPlaceholder')}
              allowClear
            />
          </Form.Item>

          <Form.Item
            name="api_key"
            label={t('modelSettings.form.apiKey')}
            rules={
              editingProvider
                ? undefined
                : [{ required: true, message: t('modelSettings.form.apiKeyRequired') }]
            }
            tooltip={
              editingProvider
                ? t('modelSettings.form.apiKeyTooltipEditing')
                : t('modelSettings.form.apiKeyTooltip')
            }
          >
            <Input.Password
              placeholder={
                editingProvider ? t('modelSettings.form.apiKeyPlaceholderEditing') : 'sk-xxxxxxxx'
              }
              allowClear
            />
          </Form.Item>

          <Form.Item
            name="name"
            label={t('modelSettings.form.name')}
            tooltip={t('modelSettings.form.nameTooltip')}
          >
            <Input placeholder={t('modelSettings.form.namePlaceholder')} allowClear />
          </Form.Item>

          {/* The model type is autofilled from the profile and preserved (not exposed in the panel, to avoid duplicating the capabilities) */}
          <Form.Item name="metadata_type" hidden>
            <Input />
          </Form.Item>

          {profileStatus === 'missing' && !editingProvider && Boolean(watchedModel?.trim()) && (
            <div style={{ color: colorTextTertiary, fontSize: 12, marginTop: 8, lineHeight: 1.6 }}>
              {t('modelSettings.form.profileMissing', { model: String(watchedModel).trim() })}
            </div>
          )}

          {/* ── The single advanced section: matching the design (context window / tool rounds / image input / thinking mode / sampling params) ── */}
          <Collapse
            size="small"
            className="mt-4"
            defaultActiveKey={['advanced']}
            items={[
              {
                key: 'advanced',
                forceRender: true,
                label: (
                  <span className="ms-advanced-head">
                    <span>{t('modelSettings.form.advanced')}</span>
                    <span className="ms-advanced-hint">{advancedSummary}</span>
                  </span>
                ),
                children: (
                  <div>
                    <GroupLabel>{t('modelSettings.form.contextWindow')}</GroupLabel>
                    <ParamRow
                      label={t('modelSettings.form.input')}
                      extra={
                        <PresetChips
                          value={watchedContext}
                          presets={CONTEXT_WINDOW_PRESETS}
                          onPick={(value) => pickAdvancedNumber('metadata_context_window', value)}
                        />
                      }
                    >
                      <Form.Item name="metadata_context_window" noStyle>
                        <InputNumber
                          min={1000}
                          step={1000}
                          style={{ width: '100%' }}
                          placeholder={t('modelSettings.form.numberPlaceholder')}
                        />
                      </Form.Item>
                    </ParamRow>
                    <ParamRow
                      label={t('modelSettings.form.output')}
                      extra={
                        <PresetChips
                          value={watchedMaxOutput}
                          presets={MAX_OUTPUT_PRESETS}
                          onPick={(value) =>
                            pickAdvancedNumber('metadata_max_output_tokens', value)
                          }
                        />
                      }
                    >
                      <Form.Item name="metadata_max_output_tokens" noStyle>
                        <InputNumber
                          min={1}
                          step={100}
                          style={{ width: '100%' }}
                          placeholder={t('modelSettings.form.numberPlaceholder')}
                        />
                      </Form.Item>
                    </ParamRow>

                    <ParamRow
                      label={t('modelSettings.form.maxToolRounds')}
                      hint={t('modelSettings.form.maxToolRoundsHint')}
                    >
                      <Form.Item name="max_tool_rounds" noStyle>
                        <InputNumber
                          min={1}
                          max={5000}
                          step={10}
                          style={{ width: '100%' }}
                          placeholder={t('modelSettings.form.maxToolRoundsPlaceholder', {
                            value: DEFAULT_MAX_TOOL_ROUNDS
                          })}
                        />
                      </Form.Item>
                    </ParamRow>

                    <ParamRow label={t('modelSettings.form.imageInput')}>
                      <Form.Item name="metadata_capabilities" noStyle>
                        <ImageInputRadio />
                      </Form.Item>
                    </ParamRow>

                    <ParamRow
                      label={t('modelSettings.form.thinkingMode')}
                      hint={
                        thinkingControllable ? undefined : t('modelSettings.form.thinkingModeHint')
                      }
                    >
                      <Form.Item name="thinking_mode" noStyle>
                        <Radio.Group
                          options={THINKING_MODE_OPTIONS.map((option) => ({
                            value: option.value,
                            label: t(THINKING_MODE_KEYS[option.value])
                          }))}
                        />
                      </Form.Item>
                    </ParamRow>

                    {/* Available levels: which levels the model has (autofilled when the profile hits, the
                        user can add or remove them). Layout matches "context window → input/output":
                        control on the left, level chips on the right. The currently selected level is
                        not chosen here (the input box's model menu handles that), but the value must
                        round-trip with the form, otherwise every save in settings would clear the level
                        the user picked in the input box. */}
                    <Form.Item name="reasoning_effort" hidden>
                      <Input />
                    </Form.Item>
                    <ParamRow
                      label={t('modelSettings.form.reasoningEffortLevels')}
                      extra={
                        <EffortPresetChips
                          value={effortLevels}
                          presets={REASONING_EFFORT_CHIPS}
                          onToggle={toggleEffortLevel}
                        />
                      }
                    >
                      <Form.Item name="metadata_reasoning_effort_levels" noStyle>
                        <Select
                          mode="tags"
                          allowClear
                          // Do not wrap when there are many levels (wrapping makes the row taller and
                          // competes with the right-side chips for width): levels that do not fit
                          // collapse into "+N", and the full set is visible and editable in the dropdown
                          maxTagCount="responsive"
                          maxTagPlaceholder={(omitted) => `+${omitted.length}`}
                          placeholder={t('modelSettings.form.reasoningEffortLevelsPlaceholder')}
                          options={REASONING_EFFORT_PRESETS.map((level) => ({
                            value: level,
                            label: reasoningEffortLabel(level)
                          }))}
                          style={{ width: '100%' }}
                        />
                      </Form.Item>
                    </ParamRow>

                    <GroupLabel>{t('modelSettings.form.samplingParams')}</GroupLabel>
                    {SAMPLING_PARAM_SPECS.map((spec) => (
                      <ParamRow key={spec.name} label={spec.label}>
                        <Form.Item name={spec.name} noStyle>
                          <InputNumber
                            min={spec.min}
                            max={spec.max}
                            step={spec.step}
                            style={{ width: '100%' }}
                            placeholder={t(SAMPLING_PLACEHOLDER_KEYS[spec.name])}
                          />
                        </Form.Item>
                      </ParamRow>
                    ))}

                    {/* Status switches (enabled / pinned / set-default when no default exists) also live in
                        advanced settings: they are the model's own state, not required in the main path,
                        so they go with this batch of switches. */}
                    <div className="ms-switches">
                      <span className="ms-switch">
                        {t('modelSettings.form.enabled')}
                        <Form.Item name="is_enabled" valuePropName="checked" noStyle>
                          <Switch size="small" />
                        </Form.Item>
                      </span>
                      {!editingProvider && !providers.some((p) => p.is_default) && (
                        <Tooltip
                          title={
                            isEmbeddingInForm
                              ? t('modelSettings.messages.embeddingNotDefaultChat')
                              : t('modelSettings.form.setDefaultTooltipNoDefault')
                          }
                        >
                          <span className="ms-switch">
                            {t('modelSettings.form.setDefault')}
                            <Form.Item name="is_default" valuePropName="checked" noStyle>
                              <Switch size="small" disabled={isEmbeddingInForm} />
                            </Form.Item>
                          </span>
                        </Tooltip>
                      )}
                      <Tooltip title={t('modelSettings.form.pinnedTooltip')}>
                        <span className="ms-switch">
                          {t('modelSettings.form.pinned')}
                          <Form.Item name="pinned" valuePropName="checked" noStyle>
                            <Switch size="small" />
                          </Form.Item>
                        </span>
                      </Tooltip>
                    </div>
                  </div>
                )
              }
            ]}
          />
        </Form>
      </Modal>

      {/* Fetch-models modal */}
      <Modal
        title={t('modelSettings.fetch.title')}
        open={fetchModalOpen}
        onCancel={() => setFetchModalOpen(false)}
        footer={[
          <Button key="cancel" onClick={() => setFetchModalOpen(false)}>
            {t('common.action.cancel')}
          </Button>,
          <Button
            key="add"
            type="primary"
            loading={addingModels}
            disabled={checkedModels.length === 0}
            onClick={handleBatchAdd}
          >
            {t('modelSettings.fetch.addSelected', { count: checkedModels.length })}
          </Button>
        ]}
        width={520}
        destroyOnHidden
        styles={{ body: { maxHeight: 480, padding: 12, overflowY: 'auto' } }}
        classNames={{ body: 'custom-scrollbar' }}
      >
        <Space orientation="vertical" style={{ width: '100%' }} size="middle">
          <div className="flex w-full" style={{ gap: 8 }}>
            <Select
              value={fetchProviderType}
              options={PROVIDER_TYPES.map((preset) => ({
                value: preset.value,
                label: getProviderLabel(t, preset.value, preset.label)
              }))}
              onChange={handleProviderTypeChangeForFetch}
              style={{ flex: '1 1 0%', minWidth: 80 }}
              placeholder={t('modelSettings.fetch.providerTypePlaceholder')}
            />
            {(fetchProviderType === 'custom' || fetchProviderType === 'ollama') && (
              <Input
                placeholder={
                  fetchProviderType === 'custom'
                    ? t('modelSettings.fetch.customBaseUrlPlaceholder')
                    : t('modelSettings.fetch.ollamaBaseUrlPlaceholder')
                }
                value={fetchBaseUrl}
                onChange={(e) => setFetchBaseUrl(e.target.value)}
                allowClear
                style={{ flex: '5 1 0%', minWidth: 100 }}
              />
            )}
          </div>
          {fetchProviderType !== 'ollama' && (
            <Input.Password
              placeholder={t('modelSettings.form.apiKey')}
              value={fetchApiKey}
              onChange={(e) => setFetchApiKey(e.target.value)}
              allowClear
            />
          )}
          {fetchProviderType === 'custom' && (
            <>
              <Input
                placeholder={t('modelSettings.fetch.customProviderIdPlaceholder')}
                value={fetchCustomProviderId}
                onChange={(e) => setFetchCustomProviderId(e.target.value.toLowerCase())}
                status={
                  fetchCustomProviderId && !/^[a-z0-9-]+$/.test(fetchCustomProviderId)
                    ? 'error'
                    : undefined
                }
                allowClear
              />
              <div style={{ color: colorTextSecondary, fontSize: 12 }}>
                {t('modelSettings.fetch.customProviderIdHint')}
              </div>
            </>
          )}

          <Button
            type="primary"
            icon={<DownloadOutlined />}
            loading={fetchLoading}
            onClick={handleFetchModels}
            block
          >
            {t('modelSettings.fetch.fetchList')}
          </Button>

          {fetchModels.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <span style={{ color: colorTextSecondary, fontSize: 13 }}>
                  {t('modelSettings.fetch.total', { count: fetchModels.length })}
                </span>
                <Tooltip title={fetchAllLabel}>
                  <Button
                    type="text"
                    size="small"
                    aria-label={fetchAllLabel}
                    icon={fetchAllChecked ? <MinusSquareOutlined /> : <CheckSquareOutlined />}
                    onClick={() =>
                      setCheckedModels(fetchAllChecked ? [] : fetchModels.map((m) => m.id))
                    }
                  />
                </Tooltip>
              </div>
              <Checkbox.Group
                value={checkedModels}
                onChange={(vals) => setCheckedModels(vals as string[])}
                style={{ width: '100%' }}
              >
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {fetchModels.map((m) => (
                    <div
                      key={m.id}
                      style={{
                        padding: '4px 0',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8
                      }}
                    >
                      <Checkbox value={m.id} style={{ minWidth: 0, overflow: 'hidden' }}>
                        <span style={{ wordBreak: 'break-all' }}>{m.id}</span>
                      </Checkbox>
                      <span
                        style={{
                          flexShrink: 0,
                          display: 'flex',
                          gap: 4,
                          flexWrap: 'wrap',
                          justifyContent: 'flex-end',
                          maxWidth: 260
                        }}
                      >
                        {m.metadata ? (
                          <MetaSummary metadata={m.metadata} />
                        ) : (
                          <span style={{ color: colorTextSecondary, fontSize: 12 }}>
                            {t('modelSettings.fetch.noMetadata')}
                          </span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              </Checkbox.Group>
            </div>
          )}

          {!fetchLoading && fetchModels.length === 0 && (
            <div className="text-center py-6" style={{ color: colorTextSecondary }}>
              {t('modelSettings.fetch.empty')}
            </div>
          )}
        </Space>
      </Modal>
    </div>
  )
}

export default ModelSettings
