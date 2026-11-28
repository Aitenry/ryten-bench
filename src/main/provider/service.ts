import { BaseChatModel } from '../ai/chat-model'
import { ChatOpenAI } from '../ai/providers/openai'
import { ChatAnthropic } from '../ai/providers/anthropic'
import { ChatDeepSeek } from '../ai/providers/deepseek'
import { ChatGoogleGenerativeAI } from '../ai/providers/google'
import { ChatVertexAI } from '../ai/providers/vertexai'
import { ChatMistralAI } from '../ai/providers/mistral'
import { ChatOllama } from '../ai/providers/ollama'
import { ChatOpenRouter } from '../ai/providers/openrouter'
import { ChatXAI } from '../ai/providers/xai'
import { ChatBedrockConverse } from '../ai/providers/bedrock'
import { ChatCloudflareWorkersAI } from '../ai/providers/cloudflare'
import logger from 'electron-log'
import { getDefaultProvider, getProviderById, LlmProviderConfig } from '../database/mapper/provider'
import { mainFormat, mainMessages } from '../i18n'
import { buildThinkingParams } from './thinking-params'
import { TOP_K_PROVIDERS } from '../../shared/model-params'

/** Providers that accept Top K (from the shared config; protocols not listed do not receive this parameter) */
const TOP_K_PROVIDER_SET = new Set(TOP_K_PROVIDERS)

/**
 * Compatibility parameters that disable "framework-inner silent retries".
 *
 * The self-developed ChatModel layer **builds in no retries** (one `invoke()` is one HTTP
 * request); but `maxRetries` is still kept as a compatibility field: the previous implementation
 * used it to build an `AsyncCaller` (6 silent resends by default, so one 500 response meant 7 HTTP
 * requests and 95 seconds), and the user's extra_config may still contain it. Now the field is
 * accepted and ignored, and the retry budget is delegated to harness/runtime/model-recovery.ts: it
 * decides whether and how many times to retry based on the failure class, and reports progress
 * truthfully to the frontend.
 */
const INNER_RETRIES_DISABLED = { maxRetries: 0 }

/**
 * LLM provider service
 * Reads provider configs from the database and creates the matching self-developed ChatModel
 * instance according to the provider type
 */
class ProviderService {
  private static instance: ProviderService | null = null
  private providerCache: Map<number, LlmProviderConfig> = new Map()

  static getInstance(): ProviderService {
    if (!ProviderService.instance) {
      ProviderService.instance = new ProviderService()
    }
    return ProviderService.instance
  }

  /**
   * Create a ChatModel instance from a provider ID.
   * No fallback to the default provider any more - the frontend must pass providerId explicitly.
   */
  async createModel(providerId?: number, modelOverride?: string): Promise<BaseChatModel> {
    if (providerId == null) {
      throw new Error(mainMessages().error.modelNotSelected)
    }

    const config = await this.resolveConfig(providerId)

    if (!config) {
      throw new Error(mainFormat(mainMessages().error.providerNotFound, { id: providerId }))
    }

    // Allow the caller to override the model name (cold recovery restores the specific model from
    // the spawn-time descriptor): the rest of the provider config (baseUrl / apiKey / protocol)
    // still comes from the current provider row.
    const effectiveModel = (modelOverride ?? '').trim() || config.model
    if (!effectiveModel || effectiveModel.trim() === '') {
      throw new Error(mainFormat(mainMessages().error.modelNameMissing, { name: config.name }))
    }

    return this.buildModel({ ...config, model: effectiveModel })
  }

  /**
   * Get the decrypted config by provider ID (without creating an instance)
   */
  async getConfig(providerId?: number): Promise<LlmProviderConfig> {
    const config = await this.resolveConfig(providerId)
    if (!config) {
      throw new Error(mainMessages().error.noProviderConfigured)
    }
    return config
  }

  /**
   * Clear the cache (called after config changes)
   */
  clearCache(): void {
    this.providerCache.clear()
    logger.info('ProviderService cache cleared')
  }

  // --- Internal methods ---

  private async resolveConfig(providerId?: number): Promise<LlmProviderConfig | null> {
    if (providerId != null) {
      if (this.providerCache.has(providerId)) {
        const cached = this.providerCache.get(providerId)!
        // Also validate is_enabled on a cache hit, so a disabled provider is not used
        if (!cached.is_enabled) return null
        return cached
      }
      const config = await getProviderById(providerId)
      if (config) {
        this.providerCache.set(providerId, config)
        // A lookup by explicit ID also needs to check whether it is enabled
        if (!config.is_enabled) return null
      }
      return config
    }

    return this.getDefaultConfig()
  }

  private async getDefaultConfig(): Promise<LlmProviderConfig | null> {
    const config = await getDefaultProvider()
    if (config) {
      this.providerCache.set(config.id, config)
    }
    return config
  }

  /**
   * Create the matching ChatModel instance according to the provider type
   */
  private buildModel(config: LlmProviderConfig): BaseChatModel {
    const provider = config.provider.toLowerCase()
    const extra = (config.extra_config as Record<string, unknown>) ?? {}

    logger.info(
      `Creating model instance: provider="${provider}", name="${config.name}", model="${config.model}"`
    )

    switch (provider) {
      case 'openai':
        return this.buildOpenAI(config, extra)

      case 'anthropic':
        return this.buildAnthropic(config, extra)

      case 'deepseek':
        return this.buildDeepSeek(config, extra)

      case 'google':
      case 'google-genai':
        return this.buildGoogleGenerativeAI(config, extra)

      case 'vertexai':
      case 'google-vertexai':
        return this.buildVertexAI(config, extra)

      case 'mistral':
      case 'mistralai':
        return this.buildMistralAI(config, extra)

      case 'ollama':
        return this.buildOllama(config, extra)

      case 'openrouter':
        return this.buildOpenRouter(config, extra)

      case 'xai':
        return this.buildXAI(config, extra)

      // The value in the renderer's "preset providers" is `aws-bedrock`, while historical configs
      // may hold `aws` / `bedrock`: all three point to the same Bedrock factory, and missing one
      // would fall into the default branch and send requests under the OpenAI-compatible protocol
      // (Bedrock's SigV4/region logic would not run).
      case 'aws':
      case 'bedrock':
      case 'aws-bedrock':
        return this.buildBedrockConverse(config, extra)

      case 'cloudflare':
        return this.buildCloudflareWorkersAI(config, extra)

      case 'custom':
        // Custom provider: choose the compatible protocol by extra_config.api_format
        // (default OpenAI-compatible; Anthropic-compatible goes through ChatAnthropic + custom endpoint)
        if (String(extra.api_format ?? 'openai').toLowerCase() === 'anthropic') {
          return this.buildAnthropic(config, extra)
        }
        return this.buildOpenAI(config, extra)

      default:
        // Unknown provider falls back to OpenAI-compatible mode
        logger.warn(`Unknown provider "${provider}", falling back to ChatOpenAI`)
        return this.buildOpenAI(config, extra)
    }
  }

  // --- Per-provider factory methods ---

  /**
   * Requested output limit: prefer the max_tokens column; when the column is empty, fall back to
   * the "output" limit in the model profile (the settings UI's "context window -> output" is the
   * single source of truth; both take the same value).
   */
  private resolveMaxTokens(config: LlmProviderConfig): number | null {
    if (config.max_tokens && config.max_tokens > 0) return config.max_tokens
    const meta = config.metadata as { max_output_tokens?: unknown } | null
    const fromProfile = typeof meta?.max_output_tokens === 'number' ? meta.max_output_tokens : 0
    return fromProfile > 0 ? fromProfile : null
  }

  /**
   * Unified injection point for per-model request parameters (temperature / Top P / Top K /
   * thinking mode / reasoning effort). All provider factory methods call it before returning, so
   * each branch does not repeat it; sampling parameters left empty are never sent, letting the
   * provider use its "best default config".
   */
  private applyModelParams(
    fields: Record<string, unknown>,
    config: LlmProviderConfig,
    extra: Record<string, unknown>
  ): void {
    const provider = config.provider.toLowerCase()
    if (config.temperature != null) fields.temperature = config.temperature
    if (config.top_p != null) fields.topP = config.top_p
    if (config.top_k != null && TOP_K_PROVIDER_SET.has(provider)) fields.topK = config.top_k

    const thinking = buildThinkingParams({
      provider,
      anthropicFormat: String(extra.api_format ?? 'openai').toLowerCase() === 'anthropic',
      mode: config.thinking_mode,
      effort: config.reasoning_effort,
      // When no tier is explicitly chosen, fall back to "medium thinking" from the model profile's
      // tier table (see thinking-params)
      effortLevels: (
        config.metadata as { capabilities?: { reasoning_effort_levels?: string[] } } | null
      )?.capabilities?.reasoning_effort_levels,
      maxTokens: this.resolveMaxTokens(config)
    })
    if (!thinking) return
    if (thinking.fields) Object.assign(fields, thinking.fields)
    if (thinking.modelKwargs) {
      // Merge with the modelKwargs already present in extra_config (user custom parameters are not lost)
      const merged = {
        ...((fields.modelKwargs as Record<string, unknown> | undefined) ?? {}),
        ...thinking.modelKwargs
      }
      fields.modelKwargs = merged
    }
  }

  private buildOpenAI(config: LlmProviderConfig, extra: Record<string, unknown>): ChatOpenAI {
    const fields: Record<string, unknown> = {
      model: config.model,
      // Streaming is always on: invoke() uses a streaming request internally, firing callbacks
      // token by token (including tool-argument deltas), so during long argument construction the
      // frontend receives preparing -> "generating"; messages mode aggregates and dedupes by
      // itself (emittedChatModelRunIds + dedupe) and does not emit the final message twice
      streaming: true,
      ...INNER_RETRIES_DISABLED,
      ...extra
    }
    const maxTokens = this.resolveMaxTokens(config)
    if (maxTokens) fields.maxTokens = maxTokens
    if (config.api_key) fields.apiKey = config.api_key
    if (config.base_url) fields.configuration = { baseURL: config.base_url }
    this.applyModelParams(fields, config, extra)
    return new ChatOpenAI(fields)
  }

  private buildAnthropic(config: LlmProviderConfig, extra: Record<string, unknown>): ChatAnthropic {
    const fields: Record<string, unknown> = {
      model: config.model,
      // Streaming is always on: invoke() uses a streaming request internally, firing callbacks
      // token by token (including tool-argument deltas), so during long argument construction the
      // frontend receives preparing -> "generating"; messages mode aggregates and dedupes by
      // itself (emittedChatModelRunIds + dedupe) and does not emit the final message twice
      streaming: true,
      ...INNER_RETRIES_DISABLED,
      ...extra
    }
    const maxTokens = this.resolveMaxTokens(config)
    if (maxTokens) fields.maxTokens = maxTokens
    if (config.api_key) fields.apiKey = config.api_key
    if (config.base_url) fields.anthropicApiUrl = config.base_url
    this.applyModelParams(fields, config, extra)
    return new ChatAnthropic(fields)
  }

  private buildDeepSeek(config: LlmProviderConfig, extra: Record<string, unknown>): ChatDeepSeek {
    const fields: Record<string, unknown> = {
      model: config.model,
      // Streaming is always on: invoke() uses a streaming request internally, firing callbacks
      // token by token (including tool-argument deltas), so during long argument construction the
      // frontend receives preparing -> "generating"; messages mode aggregates and dedupes by
      // itself (emittedChatModelRunIds + dedupe) and does not emit the final message twice
      streaming: true,
      ...INNER_RETRIES_DISABLED,
      ...extra
    }
    const maxTokens = this.resolveMaxTokens(config)
    if (maxTokens) fields.maxTokens = maxTokens
    if (config.api_key) fields.apiKey = config.api_key
    if (config.base_url) fields.configuration = { baseURL: config.base_url }
    this.applyModelParams(fields, config, extra)
    return new ChatDeepSeek(fields)
  }

  private buildGoogleGenerativeAI(
    config: LlmProviderConfig,
    extra: Record<string, unknown>
  ): ChatGoogleGenerativeAI {
    const fields: Record<string, unknown> = {
      streaming: true,
      ...INNER_RETRIES_DISABLED,
      ...extra
    }
    const maxTokens = this.resolveMaxTokens(config)
    if (maxTokens) fields.maxOutputTokens = maxTokens
    if (config.api_key) fields.apiKey = config.api_key
    if (config.base_url) fields.baseUrl = config.base_url
    this.applyModelParams(fields, config, extra)
    return new ChatGoogleGenerativeAI(config.model, fields)
  }

  private buildVertexAI(config: LlmProviderConfig, extra: Record<string, unknown>): ChatVertexAI {
    const fields: Record<string, unknown> = {
      model: config.model,
      // Streaming is always on: invoke() uses a streaming request internally, firing callbacks
      // token by token (including tool-argument deltas), so during long argument construction the
      // frontend receives preparing -> "generating"; messages mode aggregates and dedupes by
      // itself (emittedChatModelRunIds + dedupe) and does not emit the final message twice
      streaming: true,
      ...INNER_RETRIES_DISABLED,
      ...extra
    }
    const maxTokens = this.resolveMaxTokens(config)
    if (maxTokens) fields.maxOutputTokens = maxTokens
    if (config.api_key) fields.apiKey = config.api_key
    this.applyModelParams(fields, config, extra)
    return new ChatVertexAI(fields)
  }

  private buildMistralAI(config: LlmProviderConfig, extra: Record<string, unknown>): ChatMistralAI {
    const fields: Record<string, unknown> = {
      model: config.model,
      // Streaming is always on: invoke() uses a streaming request internally, firing callbacks
      // token by token (including tool-argument deltas), so during long argument construction the
      // frontend receives preparing -> "generating"; messages mode aggregates and dedupes by
      // itself (emittedChatModelRunIds + dedupe) and does not emit the final message twice
      streaming: true,
      ...INNER_RETRIES_DISABLED,
      ...extra
    }
    const maxTokens = this.resolveMaxTokens(config)
    if (maxTokens) fields.maxTokens = maxTokens
    if (config.api_key) fields.apiKey = config.api_key
    if (config.base_url) fields.serverURL = config.base_url
    this.applyModelParams(fields, config, extra)
    return new ChatMistralAI(fields)
  }

  private buildOllama(config: LlmProviderConfig, extra: Record<string, unknown>): ChatOllama {
    const fields: Record<string, unknown> = {
      model: config.model,
      // Streaming is always on: invoke() uses a streaming request internally, firing callbacks
      // token by token (including tool-argument deltas), so during long argument construction the
      // frontend receives preparing -> "generating"; messages mode aggregates and dedupes by
      // itself (emittedChatModelRunIds + dedupe) and does not emit the final message twice
      streaming: true,
      ...INNER_RETRIES_DISABLED,
      ...extra
    }
    const maxTokens = this.resolveMaxTokens(config)
    if (maxTokens) fields.numPredict = maxTokens
    if (config.api_key) fields.apiKey = config.api_key
    if (config.base_url) fields.baseUrl = config.base_url
    this.applyModelParams(fields, config, extra)
    return new ChatOllama(fields)
  }

  private buildOpenRouter(
    config: LlmProviderConfig,
    extra: Record<string, unknown>
  ): ChatOpenRouter {
    const fields: Record<string, unknown> = {
      model: config.model,
      // Streaming is always on: invoke() uses a streaming request internally, firing callbacks
      // token by token (including tool-argument deltas), so during long argument construction the
      // frontend receives preparing -> "generating"; messages mode aggregates and dedupes by
      // itself (emittedChatModelRunIds + dedupe) and does not emit the final message twice
      streaming: true,
      ...INNER_RETRIES_DISABLED,
      ...extra
    }
    const maxTokens = this.resolveMaxTokens(config)
    if (maxTokens) fields.maxTokens = maxTokens
    if (config.api_key) fields.apiKey = config.api_key
    if (config.base_url) fields.configuration = { baseURL: config.base_url }
    this.applyModelParams(fields, config, extra)
    return new ChatOpenRouter(fields)
  }

  private buildXAI(config: LlmProviderConfig, extra: Record<string, unknown>): ChatXAI {
    // The xAI API is compatible with the OpenAI format
    const fields: Record<string, unknown> = {
      model: config.model,
      // Streaming is always on: invoke() uses a streaming request internally, firing callbacks
      // token by token (including tool-argument deltas), so during long argument construction the
      // frontend receives preparing -> "generating"; messages mode aggregates and dedupes by
      // itself (emittedChatModelRunIds + dedupe) and does not emit the final message twice
      streaming: true,
      ...INNER_RETRIES_DISABLED,
      ...extra
    }
    const maxTokens = this.resolveMaxTokens(config)
    if (maxTokens) fields.maxTokens = maxTokens
    if (config.api_key) fields.apiKey = config.api_key
    if (config.base_url) fields.configuration = { baseURL: config.base_url }
    this.applyModelParams(fields, config, extra)
    return new ChatXAI(fields)
  }

  private buildBedrockConverse(
    config: LlmProviderConfig,
    extra: Record<string, unknown>
  ): ChatBedrockConverse {
    const fields: Record<string, unknown> = {
      model: config.model,
      // Streaming is always on: invoke() uses a streaming request internally, firing callbacks
      // token by token (including tool-argument deltas), so during long argument construction the
      // frontend receives preparing -> "generating"; messages mode aggregates and dedupes by
      // itself (emittedChatModelRunIds + dedupe) and does not emit the final message twice
      streaming: true,
      ...INNER_RETRIES_DISABLED,
      ...extra
    }
    const maxTokens = this.resolveMaxTokens(config)
    if (maxTokens) fields.maxTokens = maxTokens
    if (config.api_key) {
      // Bedrock uses AWS credentials; the API key does not go through the usual path
      // Credentials can be passed via extra_config
    }
    if (config.base_url) {
      // Bedrock specifies the endpoint via region
      if (!fields.region) fields.region = 'us-east-1'
    }
    this.applyModelParams(fields, config, extra)
    return new ChatBedrockConverse(fields)
  }

  private buildCloudflareWorkersAI(
    config: LlmProviderConfig,
    extra: Record<string, unknown>
  ): ChatCloudflareWorkersAI {
    const fields: Record<string, unknown> = {
      model: config.model,
      streaming: true,
      ...INNER_RETRIES_DISABLED,
      ...extra
    }
    if (config.api_key) fields.cloudflareApiToken = config.api_key
    this.applyModelParams(fields, config, extra)
    return new ChatCloudflareWorkersAI(fields)
  }
}

/** Get the singleton */
function getProviderService(): ProviderService {
  return ProviderService.getInstance()
}

export { ProviderService, getProviderService }
