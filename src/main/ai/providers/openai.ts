/**
 * OpenAI 兼容协议的 ChatModel 实现（`POST {baseURL}/chat/completions` + SSE）。
 *
 * 一次性覆盖 OpenAI / DeepSeek / xAI / OpenRouter / Mistral 以及「自定义 OpenAI 兼容端点」：
 * 差异只在 baseURL、API Key 环境变量名与少量请求头，协议本身完全相同。
 *
 * 行为对齐项目既有约定：
 * - `invoke()` 内部走流式请求（逐 token 回调；调用方不传回调时也安全）；
 * - 不内置重试（重试预算归 harness/model-recovery）；
 * - 非 2xx 抛 `ModelHttpError(status)`，上层按状态码分类处理。
 */
import { AIMessage } from '../messages'
import {
  BaseChatModel,
  hasMeaningfulOutput,
  ModelCallOptions,
  ModelStreamCollector,
  type FallbackSnapshot
} from '../chat-model'
import {
  ModelHttpError,
  httpRequest,
  inferStatusFromErrorPayload,
  ModelEmptyResponseError,
  modelConfigError,
  parseSseStream,
  providerPayloadError,
  safeReadText,
  shouldTryNonStreamingFallback
} from '../http'
import type { StructuredToolInterface } from '../tools'
import { normalizeUsage, toOpenAIMessages, toOpenAITools } from './converters'

/** 供应商构造字段（与旧实现同名；`...extra` 允许用户自定义字段直接透传到请求体） */
export interface OpenAICompatibleFields {
  model?: string
  apiKey?: string
  /** OpenAI SDK 风格的配置对象 */
  configuration?: {
    baseURL?: string
    defaultHeaders?: Record<string, string>
    [key: string]: unknown
  }
  /** 直接给 baseURL（旧 ChatOpenAI 也接受） */
  baseURL?: string
  baseUrl?: string
  defaultHeaders?: Record<string, string>
  /** 输出上限；-1 表示不限制 */
  maxTokens?: number
  temperature?: number
  topP?: number
  stop?: string | string[]
  /** 是否请求 usage（部分网关不认识 stream_options，会自动降级） */
  streamUsage?: boolean
  /** 请求超时（毫秒；缺省不设） */
  timeout?: number
  /** 直接并入请求体的额外参数（思考/推理等级等） */
  modelKwargs?: Record<string, unknown>
  organization?: string
  [key: string]: unknown
}

/** 可直接透传到请求体的字段名（用户 extra_config 常见的 OpenAI 参数） */
const PASSTHROUGH_BODY_KEYS = [
  'tool_choice',
  'parallel_tool_calls',
  'response_format',
  'frequency_penalty',
  'presence_penalty',
  'seed',
  'logit_bias',
  'user',
  'service_tier',
  'reasoning_effort',
  'max_completion_tokens',
  'stop'
] as const

/** 网关「不支持流式」时常见的 4xx（HTTP 200 里的同义错误码也按这个集合判断） */
const STREAM_INCOMPATIBLE_STATUSES = new Set([400, 405, 415, 422, 501])

/** OpenAI 兼容 ChatModel 基类 */
export class OpenAICompatibleChatModel extends BaseChatModel {
  readonly model: string
  protected readonly fields: OpenAICompatibleFields
  protected readonly baseURL: string
  protected readonly apiKey?: string
  protected readonly maxTokens?: number
  protected readonly temperature?: number
  protected readonly topP?: number
  protected readonly stop?: string | string[]
  protected readonly streamUsage: boolean
  protected readonly timeoutMs?: number
  protected readonly modelKwargs?: Record<string, unknown>
  protected readonly defaultHeaders: Record<string, string>
  /**
   * 是否使用流式请求。
   * 服务层默认 true；用户 extra_config 里显式写 `streaming: false` 时直接走非流式
   * （部分自建网关只实现了 /chat/completions 的非流式语义）。
   */
  protected readonly streaming: boolean

  constructor(fields: OpenAICompatibleFields) {
    super()
    if (!fields?.model) throw new Error('ChatModel requires a "model" field')
    this.model = fields.model
    this.fields = fields
    this.baseURL =
      fields.configuration?.baseURL ?? fields.baseURL ?? fields.baseUrl ?? this.defaultBaseURL
    this.apiKey = fields.apiKey ?? this.readApiKeyFromEnv()
    this.maxTokens = typeof fields.maxTokens === 'number' ? fields.maxTokens : undefined
    this.temperature = typeof fields.temperature === 'number' ? fields.temperature : undefined
    this.topP = typeof fields.topP === 'number' ? fields.topP : undefined
    this.stop = fields.stop
    this.streamUsage = fields.streamUsage ?? true
    this.timeoutMs = typeof fields.timeout === 'number' ? fields.timeout : undefined
    this.modelKwargs = fields.modelKwargs
    this.streaming = fields.streaming !== false
    this.defaultHeaders = {
      ...(fields.configuration?.defaultHeaders ?? {}),
      ...(fields.defaultHeaders ?? {})
    }
  }

  /** 供应商默认 baseURL（子类覆盖） */
  protected get defaultBaseURL(): string {
    return 'https://api.openai.com/v1'
  }

  /** API Key 环境变量名（按顺序取第一个非空） */
  protected get apiKeyEnvNames(): string[] {
    return ['OPENAI_API_KEY']
  }

  /** 供应商协议名（日志用） */
  get provider(): string {
    return 'openai'
  }

  /** 额外请求头（OpenRouter 的站点归属等） */
  protected extraHeaders(): Record<string, string> {
    return {}
  }

  /** 消息转换（Mistral 等需要改写 id 的子类覆盖） */
  protected convertMessages(
    messages: Parameters<typeof toOpenAIMessages>[0]
  ): Array<Record<string, unknown>> {
    return toOpenAIMessages(messages)
  }

  private readApiKeyFromEnv(): string | undefined {
    for (const name of this.apiKeyEnvNames) {
      const value = process.env[name]
      if (value && value.trim()) return value.trim()
    }
    return undefined
  }

  /** 是否推理模型（o 系列 / gpt-5：用 max_completion_tokens，且不支持 temperature/top_p） */
  protected isReasoningModel(): boolean {
    return /^(o\d|gpt-5)/i.test(this.model)
  }

  /**
   * 组装请求体。
   *
   * `compatibility=true` 生成「最小请求体」：只带标准字段，丢掉 `stream_options`、
   * `modelKwargs`（thinking / reasoning_effort / enable_thinking…）与 extra_config 透传字段。
   * 用于网关 400 明确拒绝这些可选参数时的兼容重试（Spring AI 的请求就只带标准字段）。
   */
  protected buildBody(
    messages: Parameters<typeof toOpenAIMessages>[0],
    tools: StructuredToolInterface[],
    streaming: boolean = this.streaming,
    compatibility = false
  ): Record<string, unknown> {
    const reasoning = this.isReasoningModel()
    const body: Record<string, unknown> = {
      model: this.model,
      messages: this.convertMessages(messages),
      stream: streaming
    }
    if (streaming && this.streamUsage && !compatibility) {
      body.stream_options = { include_usage: true }
    }
    if (typeof this.maxTokens === 'number' && this.maxTokens > 0) {
      body[reasoning ? 'max_completion_tokens' : 'max_tokens'] = this.maxTokens
    }
    if (!reasoning) {
      if (this.temperature != null) body.temperature = this.temperature
      if (this.topP != null) body.top_p = this.topP
    }
    if (this.stop) body.stop = this.stop
    if (tools.length > 0) body.tools = toOpenAITools(tools)
    if (!compatibility) {
      for (const key of PASSTHROUGH_BODY_KEYS) {
        const value = this.fields[key]
        if (value !== undefined) body[key] = value
      }
      if (this.modelKwargs) Object.assign(body, this.modelKwargs)
    }
    return body
  }

  /** 请求头（非流式兜底时 Accept 用 application/json，部分网关按它决定返回形态） */
  protected buildHeaders(streaming: boolean = this.streaming): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: streaming ? 'text/event-stream' : 'application/json',
      ...this.defaultHeaders,
      ...this.extraHeaders()
    }
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`
    if (typeof this.fields.organization === 'string' && this.fields.organization) {
      headers['openai-organization'] = this.fields.organization
    }
    return headers
  }

  /**
   * 处理一个流式 chunk（`choices[0].delta`），也兼容非流式 `choices[0].message`。
   */
  protected handleChunk(payload: Record<string, unknown>, collector: ModelStreamCollector): void {
    const usage = payload.usage
    if (usage && typeof usage === 'object') {
      collector.usage(normalizeUsage(usage as Record<string, unknown>))
    }
    if (typeof payload.model === 'string') collector.metadata({ model_name: payload.model })
    const choices = payload.choices
    if (!Array.isArray(choices) || choices.length === 0) {
      // 少数网关在流里直接给顶层 content/response（没有 choices 包装）
      const topLevelText =
        typeof payload.content === 'string'
          ? payload.content
          : typeof payload.response === 'string'
            ? payload.response
            : undefined
      if (topLevelText) collector.text(topLevelText)
      return
    }
    const choice = choices[0] as Record<string, unknown>
    if (typeof choice.finish_reason === 'string') {
      collector.metadata({ finish_reason: choice.finish_reason })
    }
    // completion 风格（choices[0].text）也接受
    if (typeof choice.text === 'string') collector.text(choice.text)
    const delta = (choice.delta ?? choice.message) as Record<string, unknown> | undefined
    if (!delta) return

    // 模型拒答（OpenAI 的 refusal 字段）：按文本展示，避免被当成「空响应」
    if (typeof delta.refusal === 'string' && delta.refusal) collector.text(delta.refusal)

    const content = delta.content
    if (typeof content === 'string') {
      collector.text(content)
    } else if (Array.isArray(content)) {
      for (const part of content as Array<Record<string, unknown>>) {
        if (part && part.type === 'text' && typeof part.text === 'string') collector.text(part.text)
      }
    } else if (content && typeof content === 'object') {
      const nested = (content as Record<string, unknown>).text
      if (typeof nested === 'string') collector.text(nested)
    }
    // 少数网关用 delta.text 而不是 delta.content
    if (typeof delta.text === 'string') collector.text(delta.text)

    // DeepSeek / vLLM 系用 reasoning_content；OpenRouter 用 reasoning（可能是字符串或对象）
    const reasoning = delta.reasoning_content ?? delta.reasoning
    if (typeof reasoning === 'string') {
      collector.reasoning(reasoning)
    } else if (reasoning && typeof reasoning === 'object') {
      const nested = (reasoning as Record<string, unknown>).content
      if (typeof nested === 'string') collector.reasoning(nested)
    }

    const toolCalls = delta.tool_calls
    if (Array.isArray(toolCalls)) {
      toolCalls.forEach((rawCall, position) => {
        if (!rawCall || typeof rawCall !== 'object') return
        const call = rawCall as Record<string, unknown>
        const fn = call.function as Record<string, unknown> | undefined
        const index = typeof call.index === 'number' ? call.index : position
        const rawArgs = fn?.arguments
        collector.toolDelta(index, {
          id: typeof call.id === 'string' ? call.id : undefined,
          name: typeof fn?.name === 'string' ? fn.name : undefined,
          args:
            typeof rawArgs === 'string' ? rawArgs : rawArgs ? JSON.stringify(rawArgs) : undefined
        })
      })
    }
    // 旧版 function_call 流式形态（无 id）：按第一个工具处理
    const legacyFunctionCall = delta.function_call as Record<string, unknown> | undefined
    if (legacyFunctionCall) {
      const legacyArgs = legacyFunctionCall.arguments
      collector.toolDelta(0, {
        name: typeof legacyFunctionCall.name === 'string' ? legacyFunctionCall.name : undefined,
        args:
          typeof legacyArgs === 'string'
            ? legacyArgs
            : legacyArgs
              ? JSON.stringify(legacyArgs)
              : undefined
      })
    }
  }

  /** 从响应值里找出第一个错误对象（对象或数组都兜住） */
  private findErrorPayload(value: unknown): unknown | undefined {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = this.findErrorPayload(item)
        if (found) return found
      }
      return undefined
    }
    if (!value || typeof value !== 'object') return undefined
    const record = value as Record<string, unknown>
    return record.error ? record : undefined
  }

  /** 解析 JSON 文本（失败不抛错） */
  private static tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
    try {
      return { ok: true, value: JSON.parse(text) as unknown }
    } catch {
      return { ok: false }
    }
  }

  /** 消费一个完整响应值（对象 / 数组 / 多个 choice 都兜住） */
  private consumePayloadValue(value: unknown, collector: ModelStreamCollector): void {
    if (Array.isArray(value)) {
      for (const item of value) this.consumePayloadValue(item, collector)
      return
    }
    if (!value || typeof value !== 'object') return
    const record = value as Record<string, unknown>
    if (record.error) throw providerPayloadError(this.provider, record, JSON.stringify(record))
    this.handleChunk(record, collector)
  }

  /**
   * 消费「非流式」响应文本：整包 JSON / JSON 数组 / SSE / NDJSON 都接受。
   * 返回从错误报文里解析出的状态码（正常响应为 undefined）。
   */
  private consumeResponseText(text: string, collector: ModelStreamCollector): number | undefined {
    const trimmed = text.trim()
    if (!trimmed) return undefined
    collector.recordRaw(trimmed)
    const whole = OpenAICompatibleChatModel.tryParseJson(trimmed)
    if (whole.ok) {
      const status = inferStatusFromErrorPayload(whole.value)
      this.consumePayloadValue(whole.value, collector)
      return status
    }
    // 兼容被标成 JSON 的 SSE / NDJSON：逐行解析
    for (const rawLine of trimmed.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || line === '[DONE]' || line.startsWith(':')) continue
      const data = line.startsWith('data:') ? line.slice(5).trim() : line
      if (!data || data === '[DONE]') continue
      const parsed = OpenAICompatibleChatModel.tryParseJson(data)
      if (!parsed.ok) continue
      this.consumePayloadValue(parsed.value, collector)
    }
    return undefined
  }

  /**
   * 非流式请求（对齐 Spring AI 默认的 `stream: false` 调用方式）。
   *
   * 既用于用户显式 `streaming: false`，也用于流式响应为空/损坏时的兜底。
   * 拿到整包 JSON 后按同一套聚合器解析，工具调用 / 推理内容 / 用量与流式路径完全一致。
   */
  private async requestNonStreaming(
    endpoint: string,
    messages: Parameters<typeof toOpenAIMessages>[0],
    tools: StructuredToolInterface[],
    options: ModelCallOptions,
    previous?: FallbackSnapshot,
    compatibility = false
  ): Promise<AIMessage> {
    const collector = new ModelStreamCollector(options.onModelChunk)
    // 网关拒绝可选参数时（400/422），用最小请求体重试一次（Spring AI 的请求形态）
    let usedCompatibility = compatibility
    let body = JSON.stringify(this.buildBody(messages, tools, false, usedCompatibility))
    let response: Response
    for (;;) {
      try {
        response = await httpRequest(endpoint, {
          headers: this.buildHeaders(false),
          body,
          signal: options.signal,
          timeoutMs: this.timeoutMs
        })
        break
      } catch (err) {
        if (!usedCompatibility && isParameterCompatibilityError(err)) {
          usedCompatibility = true
          body = JSON.stringify(this.buildBody(messages, tools, false, true))
          continue
        }
        throw err
      }
    }
    const text = await safeReadText(response)
    const contentType = response.headers.get('content-type') ?? ''
    const status = this.consumeResponseText(text, collector)
    const message = collector.finalizeOrThrow({
      provider: this.provider,
      model: this.model,
      status,
      contentType,
      previous
    })
    message.response_metadata = { ...message.response_metadata, fallback: 'non-streaming' }
    return this.withCompatibilityNote(message, usedCompatibility)
  }

  /** 兼容重试成功后的标记（排查用，不影响 UI） */
  private withCompatibilityNote(message: AIMessage, used: boolean): AIMessage {
    if (used) {
      message.response_metadata = {
        ...message.response_metadata,
        compatibility: 'minimal-request'
      }
    }
    return message
  }

  /** 在指定 endpoint 上执行一次完整的流式尝试（空流/协议异常时自动换非流式） */
  private async attemptStreaming(
    endpoint: string,
    messages: Parameters<typeof toOpenAIMessages>[0],
    tools: StructuredToolInterface[],
    options: ModelCallOptions
  ): Promise<AIMessage> {
    const collector = new ModelStreamCollector(options.onModelChunk)
    let usedCompatibility = false
    let body = this.buildBody(messages, tools, true)
    const headers = this.buildHeaders(true)

    let response: Response
    for (;;) {
      try {
        response = await httpRequest(endpoint, {
          headers,
          body: JSON.stringify(body),
          signal: options.signal,
          timeoutMs: this.timeoutMs
        })
        break
      } catch (err) {
        // 网关拒绝可选参数（thinking / reasoning_effort / stream_options / 透传字段）：
        // 用最小请求体重试一次（Spring AI 的请求形态），避免直接失败
        if (!usedCompatibility && isParameterCompatibilityError(err)) {
          usedCompatibility = true
          body = this.buildBody(messages, tools, true, true)
          continue
        }
        // 网关直接拒绝流式参数（400/405/…）：换非流式再试一次
        if (shouldTryNonStreamingFallback(err)) {
          const reason = err instanceof Error ? err.message : String(err)
          return await this.requestNonStreaming(
            endpoint,
            messages,
            tools,
            options,
            { raw: reason },
            usedCompatibility
          )
        }
        throw err
      }
    }

    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.includes('application/json')) {
      // 兼容「stream=true 但返回整包 JSON」的网关
      const text = await safeReadText(response)
      const parsed = OpenAICompatibleChatModel.tryParseJson(text)
      if (parsed.ok) {
        const errorPayload = this.findErrorPayload(parsed.value)
        if (errorPayload) {
          const status = inferStatusFromErrorPayload(errorPayload)
          // 网关把「不支持流式」包成 HTTP 200 错误体：换非流式通常能成功
          if (status == null || STREAM_INCOMPATIBLE_STATUSES.has(status)) {
            return await this.requestNonStreaming(
              endpoint,
              messages,
              tools,
              options,
              { raw: text },
              usedCompatibility
            )
          }
          throw providerPayloadError(this.provider, errorPayload, text)
        }
      }
      this.consumeResponseText(text, collector)
      const message = collector.finalize()
      if (hasMeaningfulOutput(message)) {
        return this.withCompatibilityNote(message, usedCompatibility)
      }
      // 整包 JSON 却没有任何内容：可能是网关抖动，换一次非流式请求兜底
      return await this.requestNonStreaming(
        endpoint,
        messages,
        tools,
        options,
        collector.fallbackSnapshot(),
        usedCompatibility
      )
    }

    try {
      for await (const event of parseSseStream(response, options.signal, (chunk) =>
        collector.recordRaw(chunk)
      )) {
        const data = event.data.trim()
        if (!data) continue
        if (data === '[DONE]') break
        // 单个事件里可能是：一个 JSON、一个 JSON 数组，或多行 JSON（都接受）
        const values: unknown[] = []
        const whole = OpenAICompatibleChatModel.tryParseJson(data)
        if (whole.ok) {
          values.push(whole.value)
        } else {
          for (const line of data.split(/\r?\n/)) {
            const parsed = OpenAICompatibleChatModel.tryParseJson(line.trim())
            if (parsed.ok) values.push(parsed.value)
          }
        }
        if (values.length === 0) continue
        for (const value of values) {
          const errorPayload = this.findErrorPayload(value)
          if (errorPayload) {
            const status = inferStatusFromErrorPayload(errorPayload)
            const alreadyHasOutput = hasMeaningfulOutput(collector.finalize())
            // 已经流出内容就不再换形态重放（避免重复）；错误码像「不支持流式」时才兜底
            if (!alreadyHasOutput && (status == null || STREAM_INCOMPATIBLE_STATUSES.has(status))) {
              return await this.requestNonStreaming(
                endpoint,
                messages,
                tools,
                options,
                { raw: data },
                usedCompatibility
              )
            }
            throw providerPayloadError(this.provider, errorPayload, data)
          }
          this.consumePayloadValue(value, collector)
        }
      }
    } catch (err) {
      if (shouldTryNonStreamingFallback(err)) {
        return await this.requestNonStreaming(
          endpoint,
          messages,
          tools,
          options,
          collector.fallbackSnapshot(),
          usedCompatibility
        )
      }
      throw err
    }

    const streamed = collector.finalize()
    if (hasMeaningfulOutput(streamed)) {
      return this.withCompatibilityNote(streamed, usedCompatibility)
    }
    // 空流（网关流式实现异常的典型表现）：自动换非流式继续，不再直接判失败
    return await this.requestNonStreaming(
      endpoint,
      messages,
      tools,
      options,
      collector.fallbackSnapshot(),
      usedCompatibility
    )
  }

  protected async _generate(
    messages: Parameters<typeof toOpenAIMessages>[0],
    tools: StructuredToolInterface[],
    options: ModelCallOptions
  ): Promise<AIMessage> {
    if (!this.apiKey) {
      const envHint = this.apiKeyEnvNames.join(' / ')
      throw modelConfigError(
        `${this.provider} API key not found. Set it in the provider settings, or via the ${envHint} environment variable.`
      )
    }
    const endpoints = resolveChatCompletionsEndpoints(this.baseURL)
    let previousError: unknown
    for (let index = 0; index < endpoints.length; index += 1) {
      const endpoint = endpoints[index]
      try {
        if (!this.streaming) {
          return await this.requestNonStreaming(endpoint, messages, tools, options)
        }
        return await this.attemptStreaming(endpoint, messages, tools, options)
      } catch (err) {
        const hasAnotherEndpoint = index < endpoints.length - 1
        if (hasAnotherEndpoint && isEndpointMismatchError(err)) {
          previousError = err
          continue
        }
        if (previousError) {
          throw combineEndpointErrors(this.provider, this.model, previousError, err)
        }
        throw err
      }
    }
    throw new Error(`${this.provider} has no usable chat completions endpoint`)
  }
}

/** 400/422 且报文明确指向「不认识/不支持的可选参数」时才做最小请求体重试 */
function isParameterCompatibilityError(err: unknown): boolean {
  if (!(err instanceof ModelHttpError) || ![400, 422].includes(err.status)) return false
  return /stream[_-]?options|thinking|reasoning|top[_-]?k|unknown|unsupported|not supported|unrecognized|extra (fields|inputs)|additional propert|invalid (parameter|field)/i.test(
    err.bodyText
  )
}

/**
 * 候选 chat completions 端点。
 *
 * OpenAI SDK / LangChain 的约定是 baseURL 后面直接拼 `/chat/completions`（baseURL 通常自带 `/v1`）；
 * Spring AI 的约定是 baseURL 是服务根、固定拼 `/v1/chat/completions`。两种配置都要能用：
 * - baseURL 已带版本段（/v1、/v2beta…）→ 只拼 `/chat/completions`；
 * - baseURL 是纯域名（无路径）→ 先试 Spring AI 的 `/v1/chat/completions`，再退回 `/chat/completions`；
 * - baseURL 带自定义路径（/api、/openai…）→ 先按原语义拼，再退回加 `/v1` 的写法。
 */
function resolveChatCompletionsEndpoints(baseURL: string): string[] {
  const base = baseURL.trim().replace(/\/+$/, '')
  if (/\/chat\/completions$/i.test(base)) return [base]
  if (/\/v\d+(?:\.\d+)?$/i.test(base)) return [`${base}/chat/completions`]
  let pathname = '/'
  try {
    pathname = new URL(base).pathname
  } catch {
    pathname = '/'
  }
  const plain = `${base}/chat/completions`
  const springStyle = `${base}/v1/chat/completions`
  const isRoot = pathname === '' || pathname === '/'
  return isRoot ? [springStyle, plain] : [plain, springStyle]
}

/** 这个错误是否可能只是「端点路径不对」（换一个候选路径值得再试） */
function isEndpointMismatchError(err: unknown): boolean {
  if (err instanceof ModelHttpError) return [404, 405, 415, 501].includes(err.status)
  // 空响应也可能是错误路径返回了 HTML/空体（HTTP 200）
  return err instanceof ModelEmptyResponseError
}

/** 两个端点都失败时合并诊断（保留两边的原始报文/错误信息） */
function combineEndpointErrors(
  provider: string,
  model: string,
  previous: unknown,
  current: unknown
): Error {
  if (current instanceof ModelEmptyResponseError) {
    const previousText =
      previous instanceof ModelEmptyResponseError
        ? previous.raw
        : previous instanceof Error
          ? previous.message
          : String(previous ?? '')
    const parts: string[] = []
    if (previousText) parts.push(`first endpoint: ${previousText}`)
    if (current.raw) parts.push(`fallback endpoint: ${current.raw}`)
    return new ModelEmptyResponseError({
      provider,
      model,
      status: current.status,
      finishReason: current.finishReason,
      reasoningOnly: current.reasoningOnly,
      contentType: current.contentType,
      raw: parts.length > 0 ? parts.join(' | ') : undefined
    })
  }
  const currentError = current instanceof Error ? current : new Error(String(current))
  if (previous instanceof ModelEmptyResponseError && previous.raw) {
    const error = new Error(
      `${currentError.message} (first endpoint returned empty: ${previous.raw})`
    )
    error.name = currentError.name
    const status = (currentError as { status?: unknown }).status
    if (typeof status === 'number') Object.assign(error, { status })
    return error
  }
  return currentError
}

/** OpenAI（官方接口） */
export class ChatOpenAI extends OpenAICompatibleChatModel {
  protected get defaultBaseURL(): string {
    return 'https://api.openai.com/v1'
  }

  protected get apiKeyEnvNames(): string[] {
    return ['OPENAI_API_KEY']
  }

  get provider(): string {
    return 'openai'
  }
}
