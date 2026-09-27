import { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { ChatOpenAI } from '@langchain/openai'
import { ChatAnthropic } from '@langchain/anthropic'
import { ChatDeepSeek } from '@langchain/deepseek'
import { ChatGoogleGenerativeAI } from '@langchain/google-genai'
import { ChatVertexAI } from '@langchain/google-vertexai'
import { ChatMistralAI } from '@langchain/mistralai'
import { ChatOllama } from '@langchain/ollama'
import { ChatOpenRouter } from '@langchain/openrouter'
import { ChatXAI } from '@langchain/xai'
import { ChatBedrockConverse } from '@langchain/aws'
import { ChatCloudflareWorkersAI } from '@langchain/cloudflare'
import logger from 'electron-log'
import { getDefaultProvider, getProviderById, LlmProviderConfig } from '../database/mapper/provider'
import { buildThinkingParams } from './thinking-params'
import { TOP_K_PROVIDERS } from '../../shared/model-params'

/** 接受 Top K 的供应商（来自共享配置，未收录的协议不下发该参数） */
const TOP_K_PROVIDER_SET = new Set(TOP_K_PROVIDERS)

/**
 * 关闭 LangChain 自带的模型调用重试层。
 *
 * `BaseChatModel` 会用构造参数建一个 `AsyncCaller`，其 `maxRetries` **缺省是 6**：
 * 一次 `invoke()` 失败后，框架会在后台静默重发最多 6 次（p-retry 指数退避，工装实测
 * 一个 500 报文 = 7 个 HTTP 请求、95 秒），我们自己的「正在重试（第 N/2 次）」完全看不到
 * 这一层；网关读超时 120 秒时，这一层就是 14 分钟的等待（2026-09-23 用户反馈
 * 「模型不可用时报了错还一直重试」的根因之一）。Retry-After 很短、以及 5xx 之外的
 * 4xx（AsyncCaller 的 STATUS_NO_RETRY：400/401/402/403/404/405/406/407/409）它本来就不重发。
 *
 * 重试预算统一交给 harness/runtime/model-recovery.ts：按失败分类决定要不要重试、重试几次，
 * 并把进度如实报给前端。放在 `...extra` 之前展开：用户写进 extra_config 的 maxRetries 仍然优先。
 */
const INNER_RETRIES_DISABLED = { maxRetries: 0 }

/**
 * 大模型供应商服务
 * 从数据库读取供应商配置，根据 provider 类型创建对应的 LangChain ChatModel 实例
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
  async createModel(providerId?: number): Promise<BaseChatModel> {
    if (providerId == null) {
      throw new Error('目标模型不存在：请先在聊天界面顶部选择一个可用的 AI 模型。')
    }

    const config = await this.resolveConfig(providerId)

    if (!config) {
      throw new Error(
        `目标模型不存在：未找到 ID 为 ${providerId} 的供应商配置，或该供应商已被禁用。`
      )
    }

    if (!config.model || config.model.trim() === '') {
      throw new Error(
        `目标模型不存在：供应商 "${config.name}" 未指定模型名称，请在设置中配置模型。`
      )
    }

    return this.buildModel(config)
  }

  /**
   * 根据供应商 ID 获取解密后的配置（不创建实例）
   */
  async getConfig(providerId?: number): Promise<LlmProviderConfig> {
    const config = await this.resolveConfig(providerId)
    if (!config) {
      throw new Error('No LLM provider configured.')
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
