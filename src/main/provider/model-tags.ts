/**
 * 模型元数据档案（models-profile.json）加载与查询。
 * provider-fetch-models 不再做任何名称/接口能力推导，直接使用档案内容；
 * 档案中不存在的模型返回 metadata = null，由用户在设置界面自行填写。
 */
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import logger from 'electron-log'
import {
  FALLBACK_CONTEXT_WINDOW,
  FALLBACK_MAX_OUTPUT_TOKENS,
  FALLBACK_MODEL_CAPABILITIES,
  FALLBACK_MODEL_TYPE
} from '../../shared/model-params'

/** 模型能力字段（models-profile.json 的 capabilities 结构） */
export interface ModelCapabilities {
  supports_text_input?: boolean
  supports_text_output?: boolean
  supports_image_input?: boolean
  supports_image_output?: boolean
  supports_audio_input?: boolean
  supports_audio_output?: boolean
  supports_video_input?: boolean
  supports_thinking?: boolean
  supports_function_calling?: boolean
  supports_streaming?: boolean
  supports_json_mode?: boolean
  supports_structured_output?: boolean
  supports_batch?: boolean
  supports_fine_tuning?: boolean
  supports_embeddings?: boolean
  reasoning_effort_levels?: string[]
}

/** 单个模型档案条目（models-profile.json models 数组的一项） */
export interface ModelProfileEntry {
  id: string
  vendor?: string
  display_name?: string
  type?: string
  status?: string
  release_date?: string | null
  knowledge_cutoff?: string | null
  capabilities?: ModelCapabilities
  context_window?: number | null
  max_output_tokens?: number | null
  image_options?: Record<string, unknown> | null

  [key: string]: unknown
}

/** 拉取远程模型列表后的返回项 */
export interface FetchedModelInfo {
  id: string
  /** 元数据：档案命中用档案内容，未收录用兜底档案（见 resolveFetchedModelMetadata） */
  metadata: ModelProfileEntry | null
}

interface ModelProfileFile {
  version?: string
  updated_at?: string
  schema_version?: string
  api_endpoints?: Record<string, string>
  models?: ModelProfileEntry[]
}

let profileCache: Map<string, ModelProfileEntry> | null = null

function profilePath(): string {
  // dev：项目 resources 目录；打包后：由 electron-builder extraResources 拷贝到 resourcesPath
  return app.isPackaged
    ? path.join(process.resourcesPath, 'models-profile.json')
    : path.join(app.getAppPath(), 'resources', 'models-profile.json')
}

/** 加载 models-profile.json，按模型 id 建立索引并缓存 */
export function loadModelProfiles(): Map<string, ModelProfileEntry> {
  if (profileCache) return profileCache

  const map = new Map<string, ModelProfileEntry>()
  try {
    const raw = fs.readFileSync(profilePath(), 'utf8')
    const data = JSON.parse(raw) as ModelProfileFile
    for (const entry of data.models ?? []) {
      if (entry && entry.id) {
        map.set(entry.id, entry)
      }
    }
    logger.info(`[ModelProfile] Loaded ${map.size} model metadata profiles: ${profilePath()}`)
  } catch (error) {
    logger.warn(`[ModelProfile] Failed to load model metadata profiles (${profilePath()}):`, error)
  }
  profileCache = map
  return profileCache
}

/**
 * 精确按模型 ID 查询档案，不进行任何名称推导；未收录返回 null。
 * 匹配不到的模型由用户在设置界面手动填写元数据。
 */
export function findModelProfile(id: string): ModelProfileEntry | null {
  return loadModelProfiles().get(id) ?? null
}

/**
 * 「拉取模型列表」专用解析：档案命中直接用官方档案；未收录的模型给一份兜底档案——
 * 上下文窗口与最大输出都取预设档位的最低值，类型按语言（对话）模型，能力保留
 * 文本输入输出 / 流式 / 工具调用。这样一键添加进来的模型不会是「什么都没填」的状态，
 * 用户再按需在「高级配置」里上调。
 */
export function resolveFetchedModelMetadata(id: string): ModelProfileEntry {
  const profile = findModelProfile(id)
  if (profile) return profile
  return {
    id,
    type: FALLBACK_MODEL_TYPE,
    capabilities: { ...FALLBACK_MODEL_CAPABILITIES },
    context_window: FALLBACK_CONTEXT_WINDOW,
    max_output_tokens: FALLBACK_MAX_OUTPUT_TOKENS
  }
}

/**
 * Google Gemini /v1beta/models：返回模型的 id（去 models/ 前缀）。
 * 这只是从接口响应中提取模型 id，不做任何能力推导。
 */
export function geminiModelId(model: Record<string, unknown>): string {
  const name = typeof model.name === 'string' ? model.name : ''
  return name.replace(/^models\//, '')
}
