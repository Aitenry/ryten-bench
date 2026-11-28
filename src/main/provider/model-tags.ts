/**
 * Model metadata profile (models-profile.json) loading and lookup.
 * provider-fetch-models no longer derives anything from names / interface capabilities; it uses
 * the profile content directly. Models missing from the profile return metadata = null, and the
 * user fills it in from the settings UI.
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

/** Model capability fields (the capabilities structure of models-profile.json) */
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

/** A single model profile entry (one item of the models array in models-profile.json) */
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

/** Return item after fetching the remote model list */
export interface FetchedModelInfo {
  id: string
  /** Metadata: the profile content when the profile has it, otherwise a fallback profile (see resolveFetchedModelMetadata) */
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
  // dev: the project resources directory; packaged: copied to resourcesPath by electron-builder extraResources
  return app.isPackaged
    ? path.join(process.resourcesPath, 'models-profile.json')
    : path.join(app.getAppPath(), 'resources', 'models-profile.json')
}

/** Load models-profile.json, index by model id and cache it */
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
 * Exact profile lookup by model ID, with no name derivation at all; returns null when not in the
 * profile. Models with no match have their metadata filled in manually by the user in the settings
 * UI.
 */
export function findModelProfile(id: string): ModelProfileEntry | null {
  return loadModelProfiles().get(id) ?? null
}

/**
 * Resolution used only by "fetch model list": if the profile has the model, use the official
 * profile; for models not in the profile, return a fallback profile - context window and max output
 * take the lowest preset tiers, the type is language (chat) model, and capabilities keep text
 * input/output / streaming / tool calling. This way a model added with one click is not in a
 * "nothing filled in" state, and the user can raise the values later under "advanced config".
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
 * Google Gemini /v1beta/models: returns the model id (with the models/ prefix removed).
 * It only extracts the model id from the API response and derives no capabilities.
 */
export function geminiModelId(model: Record<string, unknown>): string {
  const name = typeof model.name === 'string' ? model.name : ''
  return name.replace(/^models\//, '')
}
