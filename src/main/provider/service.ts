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

/** 接受 Top K 的供应商（来自共享配置，未收录的协议不下发该参数） */
const TOP_K_PROVIDER_SET = new Set(TOP_K_PROVIDERS)

/**
 * 关闭「框架内层静默重试」的兼容参数。
 *
 * 自研 ChatModel 层**不内置任何重试**（一次 `invoke()` 就是一次 HTTP 请求）；
 * 但 `maxRetries` 仍作为兼容字段保留：旧版 LangChain 实现曾用它建 `AsyncCaller`
 * （缺省 6 次静默重发，一次 500 报文等于 7 个 HTTP 请求、95 秒），用户 extra_config 里
 * 可能还写着它。现在这个字段只是被接受后忽略，重试预算统一交给
 * harness/runtime/model-recovery.ts：按失败分类决定要不要重试、重试几次，并把进度如实报给前端。
 */
const INNER_RETRIES_DISABLED = { maxRetries: 0 }

/**
 * 大模型供应商服务
 * 从数据库读取供应商配置，根据 provider 类型创建对应的自研 ChatModel 实例
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
   * 根据供应商 ID 创建 ChatModel 实例。
   * 不再回退到默认供应商——要求前端显式传入 providerId。
   */
  async createModel(providerId?: number, modelOverride?: string): Promise<BaseChatModel> {
    if (providerId == null) {
      throw new Error(mainMessages().error.modelNotSelected)
    }

    const config = await this.resolveConfig(providerId)

    if (!config) {
      throw new Error(mainFormat(mainMessages().error.providerNotFound, { id: providerId }))
    }

    // 允许调用方覆盖模型名（冷恢复按 spawn 时 descriptor 还原具体模型）：
    // 其余供应商配置（baseUrl / apiKey / 协议）仍取自当前 provider 行。
    const effectiveModel = (modelOverride ?? '').trim() || config.model
    if (!effectiveModel || effectiveModel.trim() === '') {
      throw new Error(mainFormat(mainMessages().error.modelNameMissing, { name: config.name }))
    }

    return this.buildModel({ ...config, model: effectiveModel })
  }

  /**
   * 根据供应商 ID 获取解密后的配置（不创建实例）
   */
  async getConfig(providerId?: number): Promise<LlmProviderConfig> {
    const config = await this.resolveConfig(providerId)
    if (!config) {
      throw new Error(mainMessages().error.noProviderConfigured)
    }
    return config
  }

  /**
   * 清除缓存（配置变更后调用）
   */
  clearCache(): void {
    this.providerCache.clear()
    logger.info('ProviderService cache cleared')
  }

  // --- 内部方法 ---

  private async resolveConfig(providerId?: number): Promise<LlmProviderConfig | null> {
    if (providerId != null) {
      if (this.providerCache.has(providerId)) {
        const cached = this.providerCache.get(providerId)!
        // 缓存命中时也校验 is_enabled，防止使用已禁用的供应商
        if (!cached.is_enabled) return null
        return cached
      }
      const config = await getProviderById(providerId)
      if (config) {
        this.providerCache.set(providerId, config)
        // 指定 ID 查询时也需要检查是否已启用
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
   * 根据供应商类型创建对应的 ChatModel 实例
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

      case 'aws':
      case 'bedrock':
        // 渲染层「预置供应商」里的 value 是 `aws-bedrock`，而历史配置里可能是
        // `aws` / `bedrock`：三个值都指向同一个 Bedrock 工厂，少一个就会掉进
        // default 分支按 OpenAI 兼容协议发请求（Bedrock 的 SigV4/region 逻辑不会执行）。
      case 'aws-bedrock':
        return this.buildBedrockConverse(config, extra)

      case 'cloudflare':
        return this.buildCloudflareWorkersAI(config, extra)

      case 'custom':
        // 自定义服务商：按 extra_config.api_format 选兼容协议调用
        // （缺省 OpenAI 兼容；Anthropic 兼容走 ChatAnthropic + 自定义端点）
        if (String(extra.api_format ?? 'openai').toLowerCase() === 'anthropic') {
          return this.buildAnthropic(config, extra)
        }
        return this.buildOpenAI(config, extra)

      default:
        // 未知供应商回退为 OpenAI 兼容模式
        logger.warn(`Unknown provider "${provider}", falling back to ChatOpenAI`)
        return this.buildOpenAI(config, extra)
    }
  }

  // --- 各供应商工厂方法 ---

  /**
   * 请求的输出上限：优先用 max_tokens 列；列为空时回退到模型档案里的「输出」上限
   * （设置界面的「上下文窗口 → 输出」是唯一真源，两者取值一致）。
   */
  private resolveMaxTokens(config: LlmProviderConfig): number | null {
    if (config.max_tokens && config.max_tokens > 0) return config.max_tokens
    const meta = config.metadata as { max_output_tokens?: unknown } | null
    const fromProfile = typeof meta?.max_output_tokens === 'number' ? meta.max_output_tokens : 0
    return fromProfile > 0 ? fromProfile : null
  }

  /**
   * 逐模型请求参数的统一注入点（温度 / Top P / Top K / 思考模式 / 推理等级）。
   * 所有供应商工厂方法在返回前调用，避免每个分支各写一遍；
   * 留空的采样参数一律不下发，交给供应商走「最佳默认配置」。
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
      // 没显式选档位时按模型档案的档位表取「中等思考」兜底（见 thinking-params）
      effortLevels: (
        config.metadata as { capabilities?: { reasoning_effort_levels?: string[] } } | null
      )?.capabilities?.reasoning_effort_levels,
      maxTokens: this.resolveMaxTokens(config)
    })
    if (!thinking) return
    if (thinking.fields) Object.assign(fields, thinking.fields)
    if (thinking.modelKwargs) {
      // 与 extra_config 里已有的 modelKwargs 合并（用户自定义参数不丢）
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
      // 统一开启流式：invoke() 内部走流式请求，逐 token（含工具参数增量）触发回调，
      // 长参数构建期间前端才能收到 preparing →「生成中」；LangGraph messages 模式
      // 自带聚合去重（emittedChatModelRunIds + dedupe），不会重复下发最终消息
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
      // 统一开启流式：invoke() 内部走流式请求，逐 token（含工具参数增量）触发回调，
      // 长参数构建期间前端才能收到 preparing →「生成中」；LangGraph messages 模式
      // 自带聚合去重（emittedChatModelRunIds + dedupe），不会重复下发最终消息
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
      // 统一开启流式：invoke() 内部走流式请求，逐 token（含工具参数增量）触发回调，
      // 长参数构建期间前端才能收到 preparing →「生成中」；LangGraph messages 模式
      // 自带聚合去重（emittedChatModelRunIds + dedupe），不会重复下发最终消息
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
      // 统一开启流式：invoke() 内部走流式请求，逐 token（含工具参数增量）触发回调，
      // 长参数构建期间前端才能收到 preparing →「生成中」；LangGraph messages 模式
      // 自带聚合去重（emittedChatModelRunIds + dedupe），不会重复下发最终消息
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
      // 统一开启流式：invoke() 内部走流式请求，逐 token（含工具参数增量）触发回调，
      // 长参数构建期间前端才能收到 preparing →「生成中」；LangGraph messages 模式
      // 自带聚合去重（emittedChatModelRunIds + dedupe），不会重复下发最终消息
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
      // 统一开启流式：invoke() 内部走流式请求，逐 token（含工具参数增量）触发回调，
      // 长参数构建期间前端才能收到 preparing →「生成中」；LangGraph messages 模式
      // 自带聚合去重（emittedChatModelRunIds + dedupe），不会重复下发最终消息
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
      // 统一开启流式：invoke() 内部走流式请求，逐 token（含工具参数增量）触发回调，
      // 长参数构建期间前端才能收到 preparing →「生成中」；LangGraph messages 模式
      // 自带聚合去重（emittedChatModelRunIds + dedupe），不会重复下发最终消息
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
    // xAI API 兼容 OpenAI 格式
    const fields: Record<string, unknown> = {
      model: config.model,
      // 统一开启流式：invoke() 内部走流式请求，逐 token（含工具参数增量）触发回调，
      // 长参数构建期间前端才能收到 preparing →「生成中」；LangGraph messages 模式
      // 自带聚合去重（emittedChatModelRunIds + dedupe），不会重复下发最终消息
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
      // 统一开启流式：invoke() 内部走流式请求，逐 token（含工具参数增量）触发回调，
      // 长参数构建期间前端才能收到 preparing →「生成中」；LangGraph messages 模式
      // 自带聚合去重（emittedChatModelRunIds + dedupe），不会重复下发最终消息
      streaming: true,
      ...INNER_RETRIES_DISABLED,
      ...extra
    }
    const maxTokens = this.resolveMaxTokens(config)
    if (maxTokens) fields.maxTokens = maxTokens
    if (config.api_key) {
      // Bedrock 使用 AWS credentials，API key 不走常规路径
      // 支持通过 extra_config 传入 credentials
    }
    if (config.base_url) {
      // Bedrock 通过 region 指定端点
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

/** 获取单例 */
function getProviderService(): ProviderService {
  return ProviderService.getInstance()
}

export { ProviderService, getProviderService }
