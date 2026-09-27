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
import { Window } from '../../../../resource/types/window'
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

// 预置供应商（value/label/baseURL）；品牌色统一在 providerMeta.PROVIDER_BRAND_COLORS，避免两处漂移
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

/** 供应商展示名：预设表里多数厂商本就是拉丁品牌名，只有国内厂商与「自定义」需要按语言取词条 */
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
 * 共享常量（providerMeta / model-params）里的标签是中文字面量，而这些模块不持有 t。
 * 下面几张表把「数据键 → 本页词条键」的映射留在本页，由组件用 t() 求值。
 * i18next 的键受资源类型约束，所以键要在类型上收窄成字面量；
 * 表里未收录的取值（如档案里自定义的模型类型）由调用方回退成原始字符串。
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

/** 思考模式（ThinkingMode）→ 本页词条键 */
const THINKING_MODE_KEYS = {
  auto: 'modelSettings.thinkingMode.auto',
  on: 'modelSettings.thinkingMode.on',
  off: 'modelSettings.thinkingMode.off'
} as const

/** 采样参数名 → 占位提示词条键 */
const SAMPLING_PLACEHOLDER_KEYS = {
  temperature: 'modelSettings.params.temperaturePlaceholder',
  top_p: 'modelSettings.params.topPPlaceholder',
  top_k: 'modelSettings.params.topKPlaceholder'
} as const

/**
 * 等宽字体栈（与路由骨架屏/编辑器同源）。
 * **只用于拉丁与数字**：等宽族缺中文字形时，Chromium 会回退到宋体/NSimSun 这类
 * 等宽中文字体，和页面其它中文（系统 UI 字体）明显不是一套字，看起来就是「字体坏了」。
 */
const MONO_FONT = "'JetBrains Mono', 'Cascadia Code', Consolas, 'Courier New', monospace"

// provider → @ant-design/icons 映射，无对应图标则为 null（降级为文字首字母）
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
  // 没有 logo 的降级为「印字号」徽章：等宽 monogram + 发丝边框（品牌色由 providerMeta 统一供给）
  return <ProviderMark providerType={provider} size={size} />
}

/** 判断是否为向量/嵌入模型：由元数据（type/supports_embeddings）或名称/模型名兜底 */
const isEmbeddingModel = (p: LlmProviderConfig): boolean => isEmbeddingProvider(p)

/** 模型元数据简述（树行/拉取列表复用，不展示模型名称）；maxBadges 限制能力徽章数量防止挤行 */
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

/* ── 弹窗表单原语 ──────────────────────────────────────────────────────────
   编辑弹窗里原本散落着十几处「Form.Item + label + Space + 硬编码 width」的重复写法。
   这里收敛成一套小组件：纯文本分组标签 + 参数行 + 档位胶囊，
   所有行共用同一套排版，新增参数只需要写一行。 */

const MODAL_FORM_CSS = `
.ms-group { margin: 14px 0 4px; font-size: 13px; color: var(--ms-text); }
.ms-group:first-child { margin-top: 0; }
.ms-hint { font-size: 12px; color: var(--ms-tertiary); white-space: nowrap; }
.ms-row { display: flex; align-items: center; gap: 10px; padding: 5px 0; }
.ms-label { width: 96px; flex: none; font-size: 13.5px; color: var(--ms-secondary); }
.ms-control { flex: 1; min-width: 0; }
.ms-chips { display: flex; gap: 4px; flex: none; }
/* 等宽仅用于拉丁与数字（中文落进等宽族会回退成宋体，与页面其它中文不是一套字） */
.ms-chip { font-family: var(--ms-mono); font-size: 11.5px; line-height: 19px; padding: 0 8px; border-radius: 10px; border: 1px solid var(--ms-hairline); background: transparent; color: var(--ms-tertiary); cursor: pointer; transition: color .15s, border-color .15s, background .15s; }
.ms-chip:hover { color: var(--ms-accent); border-color: var(--ms-accent); }
.ms-chip[data-active='true'] { color: var(--ms-accent); border-color: var(--ms-accent); background: var(--ms-accent-soft); }
.ms-switches { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 20px; margin: 10px 0 2px; }
.ms-switch { display: flex; align-items: center; gap: 7px; font-size: 13px; color: var(--ms-secondary); }
.ms-advanced-head { display: flex; align-items: center; gap: 8px; width: 100%; }
.ms-advanced-hint { margin-left: auto; font-family: var(--ms-mono); font-size: 11.5px; letter-spacing: .04em; text-transform: uppercase; color: var(--ms-tertiary); }
`

/**
 * 参数分组小标题：纯文本（对齐设计稿「上下文窗口（Token）」「采样参数」的写法）。
 * 不做圆点 + 发丝线那套装饰——分组本身不携带信息时，装饰只是噪声。
 */
const GroupLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="ms-group">{children}</div>
)

/** 参数行：标签 + 控件 +（可选）右侧胶囊/说明；控件自身用 Form.Item noStyle 绑定 */
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

/** 数值档位胶囊：点一下即填入（当前值命中档位时高亮） */
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
 * 推理档位胶囊：点一下把这个档位加进 / 移出「可选档位」。
 *
 * 为什么是**多选开关**而不是像上下文窗口那样的单选回填：这里的字段本身是一个集合
 * （哪些档位能在输入框里选），胶囊就是集合成员的开关；模型档案没收录档位的模型，
 * 用户在这里自己点出该模型的档位表。
 *
 * 只放最常用的四档（`REASONING_EFFORT_CHIPS`）：弹窗内容区约 500px，一排 7 个胶囊会把
 * 输入框挤没（实测胶囊因 `justify-content: flex-end` 反向溢出、盖住输入框边缘）。
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
 * 「支持图片输入」单选：直接读写 metadata_capabilities 数组。
 * 面板只暴露这一个能力开关，档案里其余能力（工具调用/思考/嵌入…）原样保留，不被覆盖。
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

  // 拉取模型模态框
  const [fetchModalOpen, setFetchModalOpen] = useState(false)
  const [fetchProviderType, setFetchProviderType] = useState('ollama')
  const [fetchBaseUrl, setFetchBaseUrl] = useState('http://localhost:11434')
  const [fetchApiKey, setFetchApiKey] = useState('')
  const [fetchModels, setFetchModels] = useState<FetchedModel[]>([])
  const [fetchLoading, setFetchLoading] = useState(false)
  const [checkedModels, setCheckedModels] = useState<string[]>([])
  const [addingModels, setAddingModels] = useState(false)
  // 自定义拉取：供应商 ID（全英文小写，仅可包含数字与 -）
  const [fetchCustomProviderId, setFetchCustomProviderId] = useState('')

  // 树形目录：分组展开与勾选状态（勾选用于批量删除）
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([])
  const [checkedKeys, setCheckedKeys] = useState<React.Key[]>([])
  const [deletingBatch, setDeletingBatch] = useState(false)

  // 能力项来自档案自动填充与「支持图片输入」单选；用 useMemo 固定引用，避免每次渲染换新数组
  const watchedCapsRaw = Form.useWatch('metadata_capabilities', form) as string[] | undefined
  const watchedCaps = useMemo<string[]>(() => watchedCapsRaw ?? [], [watchedCapsRaw])
  const watchedType: string | undefined = Form.useWatch('metadata_type', form)
  const watchedProviderType: string | undefined = Form.useWatch('provider', form)
  const watchedModel: string | undefined = Form.useWatch('model', form)
  const watchedApiFormat: string | undefined = Form.useWatch('api_format', form)
  // 高级配置摘要与提示所需的实时值
  const watchedContext: number | null | undefined = Form.useWatch('metadata_context_window', form)
  const watchedMaxOutput: number | null | undefined = Form.useWatch(
    'metadata_max_output_tokens',
    form
  )
  const watchedToolRounds: number | null | undefined = Form.useWatch('max_tool_rounds', form)
  const watchedReasoningEffort: string | null | undefined = Form.useWatch('reasoning_effort', form)
  /**
   * 该模型的「可选档位」表（推理等级候选集）。
   * 真源是模型档案的 `capabilities.reasoning_effort_levels`，但**用户可以自己改**：
   * 档案没收录档位的模型（自建/小众模型）就在这里手填或点胶囊，输入框的档位菜单读的也是它。
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
  /** 当前接口协议（含自定义端点的兼容协议）是否会被下发思考参数 */
  const thinkingControllable = supportsThinkingControl(
    watchedProviderType ?? '',
    watchedApiFormat === 'anthropic'
  )
  // 表单中是否将模型配置为嵌入模型（用于禁用“设为默认”）
  const isEmbeddingInForm =
    watchedType === 'embedding' || watchedCaps.includes('supports_embeddings')

  /**
   * 高级配置折叠标题上的一行摘要：只显示真正有值的项。
   * 用拉丁缩写而不是中文——等宽字体族里中文会回退成宋体，跟页面其它中文不是一套字。
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

  /** 快捷档位：写入数值并标记「已触碰」，避免切换模型 ID 时被档案自动填充重置 */
  const pickAdvancedNumber = (name: string, value: number): void => {
    form.setFields([{ name, value, touched: true }])
  }

  /** 档位胶囊：把档位加进 / 移出「可选档位」，同样标记「已触碰」（用户的手动集合优先于档案） */
  const toggleEffortLevel = (level: string): void => {
    const next = effortLevels.includes(level)
      ? effortLevels.filter((item) => item !== level)
      : [...effortLevels, level]
    form.setFields([
      { name: 'metadata_reasoning_effort_levels', value: sortReasoningEfforts(next), touched: true }
    ])
  }

  /** 弹窗内的主题变量：表单原语共用一套色板（发丝线/等宽字/强调色） */
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

  // 接口协议：单选 Select + 输入任意协议标识。
  // 输入内容不匹配任何预置平台时，实时注入「自定义协议」选项供提交（未知协议按 OpenAI 兼容调用）。
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

  // ── 模型档案自动填充（仅「新增」流程）：输入模型 ID 命中 models-profile 即自动补齐元数据 ──
  // 命中状态：idle 未查询 / matched 已命中 / missing 已查询未收录
  const [profileStatus, setProfileStatus] = useState<'idle' | 'matched' | 'missing'>('idle')
  const profileTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const autoFillRef = useRef<{ modelId: string; keys: string[] } | null>(null)

  /** 清空自动填充痕迹：仅清除「由自动填充写入、且用户未手改过」的字段 */
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

  /** 新增：查询官方档案，仅补齐「当前仍为空」的字段（用户已填内容一律不覆盖） */
  const applyProfileAutofill = useCallback(
    async (modelId: string): Promise<void> => {
      try {
        const profile = (await (window as unknown as Window).api.providers.lookupProfile(
          modelId
        )) as ModelMetadata | null
        if (!profile) {
          setProfileStatus('missing')
          return
        }
        // 查询期间用户已继续输入：旧结果作废，等新模型 ID 的下一次查询
        if (form.getFieldValue('model') !== modelId) return
        const cur = form.getFieldsValue()
        const patch: Record<string, unknown> = {}
        const fillIfEmpty = (key: string, value: string | number | string[]): void => {
          const now = cur[key]
          const empty =
            now == null || now === '' || now === 0 || (Array.isArray(now) && now.length === 0) // 数组型字段（可选档位）空数组也算空
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
        // 推理档位表：档案命中就回填（用户已手改过则不动——fillIfEmpty 只补空数组）
        const profileLevels = pc.reasoning_effort_levels
        if (Array.isArray(profileLevels) && profileLevels.length > 0) {
          fillIfEmpty('metadata_reasoning_effort_levels', sortReasoningEfforts(profileLevels))
        }
        autoFillRef.current = { modelId, keys: Object.keys(patch) }
        setProfileStatus('matched')
        if (Object.keys(patch).length > 0) form.setFieldsValue(patch)
      } catch {
        // 档案查询失败保持静默：不阻塞手动填写
      }
    },
    [form]
  )

  /** 模型 ID 输入防抖调度（编辑流程不触发，避免覆盖已有档案） */
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

  /** Form 值变化入口：仅响应模型 ID 变化（setFieldsValue 不会触发，无自循环） */
  const handleFormValuesChange = (changedValues: Record<string, unknown>): void => {
    if (!('model' in changedValues)) return
    scheduleProfileAutofill(String(changedValues.model ?? '').trim())
  }

  /** 关闭编辑/新增弹窗的统一收尾（取消、保存成功共用） */
  const closeModal = useCallback((): void => {
    resetProfileAutofill()
    setModalOpen(false)
    form.resetFields()
    setEditingProvider(null)
    setProtocolSearch('')
  }, [form, resetProfileAutofill])

  // 卸载时清理档案查询定时器
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
      const result = await (window as unknown as Window).api.providers.getAll()
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
      // 采样/思考全部留空 = 使用供应商最佳默认值；工具调用轮数给默认上限
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
      // 名称即展示名（含历史档案 display_name 的展示结果）；保存后统一收敛到 name
      name: getProviderDisplayName(record),
      provider: record.provider,
      base_url: record.base_url,
      // 密钥永不发送到渲染进程：编辑时恒为空，留空保持原密钥，重新输入才替换
      api_key: '',
      model: record.model,
      // 上下文窗口 → 输出：旧的独立「最大 Token」列作为回退读取，两者在保存时收敛为同一个值
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
      // 已存元数据里的档位表：输入框的档位菜单与这里的选择器读的都是它
      metadata_reasoning_effort_levels: sortReasoningEfforts(caps.reasoning_effort_levels),
      is_enabled: record.is_enabled,
      pinned: record.is_pinned
    })
    setModalOpen(true)
  }

  const handleProviderTypeChange = (providerType: string): void => {
    const config = getProviderConfig(providerType)
    if (config) {
      // 预置协议自动跟随其默认端点；自定义类型清空由用户填写（API 地址仅在自定义时展示）
      form.setFieldsValue({ base_url: config.value === 'custom' ? '' : config.baseURL || '' })
    }
    setProtocolSearch('')
  }

  /**
   * 由表单字段组装元数据对象：保留已有档案字段，覆盖用户编辑项。
   * 厂商 ID 不再手填——按接口协议推导（自定义端点用其自定义 ID，即 provider 值）。
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
    // 面板只暴露「支持图片输入」一个开关，其余能力按档案原样保留
    const selectedCaps = ((values.metadata_capabilities as string[]) ?? []).filter(Boolean)
    currentCaps.supports_image_input = selectedCaps.includes('supports_image_input')

    // 可选档位（数组型能力）：用户手填/档案回填后整份写回；空表示该模型没有档位可选
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
    // 展示名统一收敛到表单 name 字段：历史档案遗留的 display_name 随编辑保存归一到 name
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

      // API 地址：仅「自定义」类型可输入；非自定义使用所选服务商的默认地址
      const cfg = getProviderConfig(values.provider as string)
      const rawBaseUrl =
        typeof values.base_url === 'string'
          ? values.base_url.trim()
          : typeof form.getFieldValue('base_url') === 'string'
            ? String(form.getFieldValue('base_url')).trim()
            : ''
      const defaultBaseUrl = cfg?.baseURL || undefined
      const modelId = String(values.model ?? '').trim()
      // 名称留空默认使用模型 ID（与「拉取模型」批量添加一致；name 即展示名）
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
        // 采样/思考留空即不下发（null），由供应商走最佳默认值
        temperature: (values.temperature as number | null | undefined) ?? null,
        // 请求输出上限与「上下文窗口 → 输出」是同一个值：一处填写，两处同步
        max_tokens: outputTokens != null && outputTokens > 0 ? outputTokens : null,
        top_p: (values.top_p as number | null | undefined) ?? null,
        top_k: (values.top_k as number | null | undefined) ?? null,
        thinking_mode: (values.thinking_mode as LlmProviderInput['thinking_mode']) ?? 'auto',
        // 推理等级：留空 = 未设置（不下发档位参数，走模型默认）
        reasoning_effort: (values.reasoning_effort as string | null | undefined) ?? null,
        max_tool_rounds:
          (values.max_tool_rounds as number | null | undefined) ?? DEFAULT_MAX_TOOL_ROUNDS,
        // 兼容协议仅对「自定义」类型生效，存入 extra_config.api_format；其余类型保留原 extra_config
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
        // 置顶由主进程用 SQL 取 max(sort_order)+1，前端只传开关
        pinned: values.pinned === true
      }

      if (editingProvider) {
        if (values.api_key) {
          input.api_key = values.api_key as string
        }
        viewMessage(msgKey, 'loading', t('modelSettings.messages.updating'))
        await (window as unknown as Window).api.providers.update(editingProvider.id, input)
        viewMessage(msgKey, 'success', t('modelSettings.messages.updated'), 2)
      } else {
        input.api_key = (values.api_key as string) || null
        viewMessage(msgKey, 'loading', t('modelSettings.messages.creating'))
        await (window as unknown as Window).api.providers.create(input)
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
      await (window as unknown as Window).api.providers.delete(id)
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
      await (window as unknown as Window).api.providers.setDefault(id)
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

  // 拉取模型
  const handleFetchModels = async (): Promise<void> => {
    setFetchLoading(true)
    setFetchModels([])
    setCheckedModels([])
    try {
      const result = (await (window as unknown as Window).api.providers.fetchModels(
        fetchProviderType,
        fetchBaseUrl || undefined,
        fetchApiKey || undefined
      )) as FetchedModel[]
      // 过滤掉已存在的模型
      const existingIds = new Set(providers.map((p) => p.model))
      const newModels = result.filter((m) => !existingIds.has(m.id))
      setFetchModels(newModels)
      // 默认全选新拉取到的模型，用户可在列表中取消勾选后再一键添加
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

  // 一键添加选中的模型（携带拉取时推导出的能力标签）。
  // 走 provider-create-batch：主进程单事务插入 + 只广播一次变更，
  // 避免逐个 create 触发渲染进程 29 次全量刷新导致程序卡死。
  const handleBatchAdd = async (): Promise<void> => {
    const msgKey = 'batch-add'
    if (checkedModels.length === 0) {
      viewMessage(msgKey, 'warning', t('modelSettings.messages.selectAtLeastOne'))
      return
    }
    // 自定义类型必须填写供应商 ID（全英文小写，仅可包含数字与 -）
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
      const result = await (window as unknown as Window).api.providers.createBatch(inputs)
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

  // --- 树形目录（按模型供应商 / 接口协议分组） ---

  /** 分组归属：按模型供应商（接口协议）分组，如 OpenAI / DeepSeek / 智谱 GLM / 自定义 */
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
        // 默认模型不可勾选（与单行删除一致：默认模型不能删）
        disableCheckbox: p.is_default
      }))
    }))
  }, [providers, t])

  /** 当前勾选中的模型 id（模型节点 key 为纯数字 id；分组节点 key 含冒号前缀） */
  const selectedIds = useMemo(
    () => checkedKeys.filter((k) => !String(k).includes(':')).map((k) => Number(k)),
    [checkedKeys]
  )

  // 数据加载 / 刷新后默认展开「新增」分组（修复：此前无条件把所有分组加回展开,
  // 用户手动折叠过的分组每次刷新都被强制重新展开）
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

  /** 树节点渲染：分组行 / 模型行（模型行自带操作按钮） */
  const renderTreeNodeTitle = (node: ProviderTreeNode): React.ReactNode => {
    const record = node.record
    if (!record) {
      // 分组节点
      const count = node.children?.length ?? 0
      return (
        <span className="inline-flex items-center" style={{ gap: 6 }}>
          <span style={{ fontWeight: 600 }}>{String(node.title)}</span>
          <span style={{ color: colorTextTertiary, fontSize: 12 }}>
            {/* 数字走等宽、中文走默认 UI 字体（见文件顶部字体规则） */}
            <Trans
              i18nKey="modelSettings.list.groupCount"
              count={count}
              components={{ mono: <span style={{ fontFamily: MONO_FONT }} /> }}
            />
          </span>
        </span>
      )
    }
    // 模型节点
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

  /** 批量删除勾选的模型（单事务 + 单广播，避免逐个删除触发刷新风暴） */
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
          const count = await (window as unknown as Window).api.providers.deleteBatch(selectedIds)
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

  // 拉取列表中是否已全选（checkedModels 恒为 fetchModels 的子集，数量相等即全选）
  const fetchAllChecked = fetchModels.length > 0 && checkedModels.length === fetchModels.length
  /** 全选/取消全选按钮的提示与 aria 文案 */
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
        {/* 目录头：统计 + 批量删除操作条 */}
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
          /* 厂商 / 模型是树形目录：先按行铺骨架，避免空白之后一次性「长出」整棵树 */
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

          {/* ── 连接：每次真正要填的项 ── */}
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

          {/* ── 模型：ID / API Key / 名称（模型 ID 在编辑态锁定，厂商按接口协议推导） ── */}
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

          {/* 模型类型由档案自动填充并保留（面板不暴露，避免与能力重复） */}
          <Form.Item name="metadata_type" hidden>
            <Input />
          </Form.Item>

          {profileStatus === 'missing' && !editingProvider && Boolean(watchedModel?.trim()) && (
            <div style={{ color: colorTextTertiary, fontSize: 12, marginTop: 8, lineHeight: 1.6 }}>
              {t('modelSettings.form.profileMissing', { model: String(watchedModel).trim() })}
            </div>
          )}

          {/* ── 唯一的高级配置：对齐设计稿（上下文窗口 / 工具调用轮数 / 图片输入 / 思考模式 / 采样参数） ── */}
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

                    {/* 可选档位：模型有哪些档位（档案命中自动回填，用户可自己增删）。
                        排列与「上下文窗口 → 输入/输出」一致：控件在左、档位胶囊在右。
                        当前用哪个档位不在这里选（输入框的模型菜单负责），但值要随表单原样带回，
                        否则每次在设置里保存都会把用户在输入框选好的档位清掉。 */}
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
                          // 档位多了不折行（折行会把整行撑高、还会跟右侧胶囊抢宽度）：
                          // 放不下的档位收成「+N」，完整集合点开下拉就能看见与增删
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

                    {/* 状态开关（启用 / 置顶 / 没默认模型时的设为默认）也归高级配置：
                        它们是模型自身的状态，不是主流程必填项，跟着下面这批开关走。 */}
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

      {/* 拉取模型模态框 */}
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
