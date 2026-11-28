/** Thinking mode: auto follows the model's default config (definition shared with the main
 * process) */
import type { ThinkingMode } from '../../../shared/model-params'

export type { ThinkingMode }

/** Model capability fields (matches the capabilities structure in models-profile.json) */
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

  [key: string]: boolean | string[] | undefined
}

/** Model metadata (a single models-profile.json entry; null when not listed or not filled in) */
export interface ModelMetadata {
  id?: string
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

/** LLM provider config */
export interface LlmProviderConfig {
  id: number
  name: string
  provider: string
  base_url: string | null
  api_key: string | null
  model: string
  /** Sampling temperature: null = unset, use the provider's best default */
  temperature: number | null
  max_tokens: number | null
  top_p: number | null
  top_k: number | null
  thinking_mode: ThinkingMode
  /** Reasoning effort: null = unset (no effort parameter is sent); values come from the model
   * profile's effort table */
  reasoning_effort: string | null
  /** Tool call rounds: upper bound on total tool calls in a single conversation */
  max_tool_rounds: number
  extra_config: Record<string, unknown> | null
  metadata: ModelMetadata | null
  is_default: boolean
  is_enabled: boolean
  /** Pin sort value (>0 means pinned, computed by the main process SQL as max+1); ordering only */
  sort_order: number
  /** Whether pinned (read by the "Pin" toggle in the edit modal) */
  is_pinned: boolean
}

/** LLM provider input (create/edit form) */
export interface LlmProviderInput {
  name: string
  provider: string
  base_url?: string | null
  api_key?: string | null
  model: string
  /** Sampling params: blank (undefined/null) = not sent, use the provider's best default */
  temperature?: number | null
  max_tokens?: number | null
  top_p?: number | null
  top_k?: number | null
  thinking_mode?: ThinkingMode
  /** Reasoning effort: blank (undefined/null) = unset, no effort parameter sent */
  reasoning_effort?: string | null
  max_tool_rounds?: number
  extra_config?: Record<string, unknown> | null
  metadata?: ModelMetadata | null
  is_default?: boolean
  is_enabled?: boolean
  /** Whether pinned: the sort value is computed by the main process SQL as max+1, so the frontend
   * does not send a sort number */
  pinned?: boolean
}

/** Item returned by the fetch-models API */
export interface FetchedModel {
  id: string
  metadata: ModelMetadata | null
}
