/**
 * Google Gemini 实现（`generativelanguage.googleapis.com` / Vertex AI 共用同一套报文）。
 *
 * 协议：`POST {base}/.../{model}:streamGenerateContent?alt=sse`
 * - 请求：contents（user/model 交替）/ systemInstruction / tools.functionDeclarations /
 *   generationConfig（含 thinkingConfig）；
 * - 流式：每个 SSE data 是一个 `GenerateContentResponse`，parts 里可能是 text、
 *   thought（推理）、functionCall（工具调用）；
 * - 工具结果：user 轮的 functionResponse（name 从历史里的 tool_call id 反查）。
 *
 * Vertex 的差异只在 URL / 鉴权，见 vertexai.ts。
 */
import {
  AIMessage,
  BaseMessage,
  contentToBlocks,
  contentToText,
  MessageContentComplex
} from '../messages'
import {
  BaseChatModel,
  hasMeaningfulOutput,
  ModelCallOptions,
  ModelStreamCollector,
  type FallbackSnapshot
} from '../chat-model'
import {
  httpRequest,
  inferStatusFromErrorPayload,
  ModelEmptyResponseError,
  modelConfigError,
  parseSseStream,
  providerPayloadError,
  safeReadText,
  shouldTryNonStreamingFallback
} from '../http'
import { jsonSchemaOf, StructuredToolInterface } from '../tools'

export interface GoogleFields {
  apiKey?: string
  /** 自定义服务地址（Gemini：默认 https://generativelanguage.googleapis.com） */
  baseUrl?: string
  baseURL?: string
  maxOutputTokens?: number
  temperature?: number
  topP?: number
  topK?: number
  /** 思考配置（thinking-params 组装后经 fields 传入） */
  thinkingConfig?: Record<string, unknown>
  safetySettings?: Array<Record<string, unknown>>
  timeout?: number
  modelKwargs?: Record<string, unknown>
  [key: string]: unknown
}

/** 模型名去掉 `models/` 前缀（URL 模板自己会拼） */
function bareModelName(model: string): string {
  return model.replace(/^models\//, '')
}

/** Gemini 只接受 OpenAPI 子集：去掉它不认识的 JSON Schema 关键字 */
export function sanitizeSchemaForGemini(schema: Record<string, unknown>): Record<string, unknown> {
  const clone = removeUnsupportedKeys(schema)
  return clone
}

function removeUnsupportedKeys(value: unknown): Record<string, unknown> {
  const source = (value ?? {}) as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(source)) {
    if (key === 'additionalProperties' || key === '$schema' || key === 'strict') continue
    if (Array.isArray(entry)) {
      result[key] = entry.map((item) =>
        item && typeof item === 'object' ? removeUnsupportedKeys(item) : item
      )
    } else if (entry && typeof entry === 'object') {
      result[key] = removeUnsupportedKeys(entry)
    } else {
      result[key] = entry
    }
  }
  return result
}

/** 图片块 → Gemini inlineData / fileData */
function toGeminiImagePart(block: MessageContentComplex): Record<string, unknown> | null {
  const raw =
    typeof block.image_url === 'string'
      ? block.image_url
      : (block.image_url as { url?: string } | undefined)?.url
  if (!raw) return null
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(raw)
  if (match && match[2]) {
    return { inlineData: { mimeType: match[1] || 'image/png', data: match[3] } }
  }
  const mime = /\.png($|\?)/i.test(raw)
    ? 'image/png'
    : /\.webp($|\?)/i.test(raw)
      ? 'image/webp'
      : /\.gif($|\?)/i.test(raw)
        ? 'image/gif'
        : 'image/jpeg'
  return { fileData: { mimeType: mime, fileUri: raw } }
}

/** 工具调用 id → 工具名（functionResponse 需要 name） */
function buildToolNameIndex(messages: BaseMessage[]): Map<string, string> {
  const index = new Map<string, string>()
  for (const message of messages) {
    if (message.type !== 'ai') continue
    const toolCalls = (message as AIMessage).tool_calls ?? []
    for (const call of toolCalls) {
      if (call.id) index.set(call.id, call.name)
    }
  }
  return index
}

/** 消息序列 → Gemini contents + systemInstruction */
export function toGeminiContents(messages: BaseMessage[]): {
  contents: Array<Record<string, unknown>>
  systemInstruction?: Record<string, unknown>
  thoughtSignatures: string[]
} {
  const systemParts: string[] = []
  const contents: Array<Record<string, unknown>> = []
  const toolNames = buildToolNameIndex(messages)
  const thoughtSignatures: string[] = []
  // 推理签名：按工具调用顺序从 AIMessage.additional_kwargs 读回
  const signatureQueue: string[] = []

  const append = (role: 'user' | 'model', parts: Array<Record<string, unknown>>): void => {
    if (parts.length === 0) return
    const last = contents[contents.length - 1]
    if (last && last.role === role) {
      ;(last.parts as Array<Record<string, unknown>>).push(...parts)
      return
    }
    contents.push({ role, parts })
  }

  for (const message of messages) {
    switch (message.type) {
      case 'system':
        systemParts.push(contentToText(message.content))
        break
      case 'human': {
        const parts: Array<Record<string, unknown>> = []
        for (const block of contentToBlocks(message.content)) {
          if (block.type === 'text') parts.push({ text: block.text ?? '' })
          else if (block.type === 'image_url') {
            const image = toGeminiImagePart(block)
            if (image) parts.push(image)
          }
        }
        append('user', parts)
        break
      }
      case 'ai': {
        const ai = message as AIMessage
        const parts: Array<Record<string, unknown>> = []
        const text = contentToText(message.content)
        if (text) parts.push({ text })
        const stored = message.additional_kwargs?.['__gemini_thought_signatures__']
        if (Array.isArray(stored)) {
          for (const signature of stored) {
            if (typeof signature === 'string') signatureQueue.push(signature)
          }
        }
        for (const call of ai.tool_calls ?? []) {
          const signature = signatureQueue.shift()
          parts.push({
            functionCall: {
              name: call.name,
              args: call.args ?? {}
            },
            ...(signature ? { thoughtSignature: signature } : {})
          })
          if (signature) thoughtSignatures.push(signature)
        }
        append('model', parts)
        break
      }
      case 'tool': {
        const toolMessage = message as BaseMessage & { tool_call_id?: string; tool_name?: string }
        const callId = toolMessage.tool_call_id ?? ''
        const name = toolMessage.tool_name ?? toolNames.get(callId) ?? 'tool'
        const text = contentToText(message.content)
        let responseContent: unknown = text
        try {
          responseContent = JSON.parse(text) as unknown
        } catch {
          responseContent = text
        }
        append('user', [
          {
            functionResponse: {
              name,
              response: { content: responseContent }
            }
          }
        ])
        break
      }
      default:
        break
    }
  }

  return {
    contents,
    systemInstruction: systemParts.filter(Boolean).length
      ? { parts: systemParts.filter(Boolean).map((text) => ({ text })) }
      : undefined,
    thoughtSignatures
  }
}

/** 工具声明 */
function toGeminiTools(tools: StructuredToolInterface[]): Array<Record<string, unknown>> {
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        parameters: sanitizeSchemaForGemini(jsonSchemaOf(tool))
      }))
    }
  ]
}

/**
 * Gemini / Vertex 共用的 ChatModel 基类：报文与流式解析完全一致，
 * 子类只提供 URL 与鉴权头。
 */
export abstract class GoogleChatModelBase extends BaseChatModel {
  readonly model: string
  protected readonly fields: GoogleFields
  protected readonly maxOutputTokens?: number
  protected readonly temperature?: number
  protected readonly topP?: number
  protected readonly topK?: number
  protected readonly thinkingConfig?: Record<string, unknown>
  protected readonly safetySettings?: Array<Record<string, unknown>>
  protected readonly timeoutMs?: number
  protected readonly modelKwargs?: Record<string, unknown>
  /** 是否使用流式请求（extra_config 可显式关闭，或流式失败时自动降级） */
  protected readonly streaming: boolean

  constructor(model: string, fields: GoogleFields = {}) {
    super()
    if (!model) throw new Error('Google ChatModel requires a "model" field')
    this.model = model
    this.fields = fields
    this.maxOutputTokens =
      typeof fields.maxOutputTokens === 'number' ? fields.maxOutputTokens : undefined
    this.temperature = typeof fields.temperature === 'number' ? fields.temperature : undefined
    this.topP = typeof fields.topP === 'number' ? fields.topP : undefined
    this.topK = typeof fields.topK === 'number' ? fields.topK : undefined
    this.thinkingConfig = fields.thinkingConfig
    this.safetySettings = fields.safetySettings
    this.timeoutMs = typeof fields.timeout === 'number' ? fields.timeout : undefined
    this.modelKwargs = fields.modelKwargs
    this.streaming = fields.streaming !== false
  }

  get provider(): string {
    return 'google'
  }

  /** 子类：拼请求 URL（含鉴权参数） */
  protected abstract buildRequestUrl(streaming: boolean): Promise<string>

  /** 子类：鉴权头 */
  protected abstract buildRequestHeaders(): Promise<Record<string, string>>

  /** 组装请求体 */
  protected buildBody(
    messages: BaseMessage[],
    tools: StructuredToolInterface[]
  ): Record<string, unknown> {
    const { contents, systemInstruction } = toGeminiContents(messages)
    const body: Record<string, unknown> = { contents }
    if (systemInstruction) body.systemInstruction = systemInstruction
    if (tools.length > 0) body.tools = toGeminiTools(tools)
    const generationConfig: Record<string, unknown> = {}
    if (this.maxOutputTokens != null) generationConfig.maxOutputTokens = this.maxOutputTokens
    if (this.temperature != null) generationConfig.temperature = this.temperature
    if (this.topP != null) generationConfig.topP = this.topP
    if (this.topK != null) generationConfig.topK = this.topK
    if (this.thinkingConfig) generationConfig.thinkingConfig = this.thinkingConfig
    if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig
    if (this.safetySettings && this.safetySettings.length > 0) {
      body.safetySettings = this.safetySettings
    }
    if (this.modelKwargs) Object.assign(body, this.modelKwargs)
    return body
  }

  /** 处理一个 GenerateContentResponse（流式与非流式同形） */
  private handleResponse(
    payload: Record<string, unknown>,
    collector: ModelStreamCollector,
    state: { nextToolIndex: number; thoughtSignatures: string[] }
  ): void {
    if (typeof payload.modelVersion === 'string') {
      collector.metadata({ model_name: payload.modelVersion })
    }
    const promptFeedback = payload.promptFeedback as Record<string, unknown> | undefined
    if (promptFeedback?.blockReason) {
      throw new Error(`Gemini request blocked: ${String(promptFeedback.blockReason)}`)
    }
    const usage = payload.usageMetadata as Record<string, unknown> | undefined
    if (usage) {
      const input = typeof usage.promptTokenCount === 'number' ? usage.promptTokenCount : undefined
      const candidates =
        typeof usage.candidatesTokenCount === 'number' ? usage.candidatesTokenCount : undefined
      const thoughts =
        typeof usage.thoughtsTokenCount === 'number' ? usage.thoughtsTokenCount : undefined
      const total = typeof usage.totalTokenCount === 'number' ? usage.totalTokenCount : undefined
      const cached =
        typeof usage.cachedContentTokenCount === 'number'
          ? usage.cachedContentTokenCount
          : undefined
      const output =
        candidates == null && thoughts == null ? undefined : (candidates ?? 0) + (thoughts ?? 0)
      const metadata: Record<string, unknown> = {
        input_tokens: input,
        output_tokens: output,
        total_tokens: total ?? (input ?? 0) + (output ?? 0)
      }
      if (cached != null) {
        metadata.input_token_details = { cache_read: cached }
        metadata.cachedContentTokenCount = cached
      }
      if (thoughts != null) metadata.output_token_details = { reasoning: thoughts }
      collector.usage(metadata)
    }
    const candidates = payload.candidates
    if (!Array.isArray(candidates) || candidates.length === 0) return
    const candidate = candidates[0] as Record<string, unknown>
    if (typeof candidate.finishReason === 'string') {
      collector.metadata({ finish_reason: candidate.finishReason })
      if (
        ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT'].includes(candidate.finishReason)
      ) {
        throw new Error(`Gemini response blocked: ${candidate.finishReason}`)
      }
    }
    const content = candidate.content as Record<string, unknown> | undefined
    const parts = content?.parts
    if (!Array.isArray(parts)) return
    for (const rawPart of parts as Array<Record<string, unknown>>) {
      if (!rawPart || typeof rawPart !== 'object') continue
      const text = rawPart.text
      if (typeof text === 'string' && text) {
        if (rawPart.thought === true) collector.reasoning(text)
        else collector.text(text)
      }
      const functionCall = rawPart.functionCall as Record<string, unknown> | undefined
      if (functionCall && typeof functionCall.name === 'string') {
        const index = state.nextToolIndex++
        const signature = rawPart.thoughtSignature
        if (typeof signature === 'string') state.thoughtSignatures.push(signature)
        collector.toolDelta(index, {
          id: typeof functionCall.id === 'string' ? functionCall.id : undefined,
          name: functionCall.name,
          // 少数网关把 args 直接给成 JSON 字符串：原样当参数文本，避免二次编码
          args:
            typeof functionCall.args === 'string'
              ? functionCall.args
              : JSON.stringify(functionCall.args ?? {})
        })
      }
    }
  }

  /** 解析非流式 JSON（单对象或数组）→ 内容；返回错误报文里的状态码 */
  private consumeJsonResponse(
    text: string,
    collector: ModelStreamCollector,
    state: { nextToolIndex: number; thoughtSignatures: string[] }
  ): number | undefined {
    collector.recordRaw(text)
    let parsed: unknown
    try {
      parsed = JSON.parse(text) as unknown
    } catch {
      return undefined
    }
    const payloads = Array.isArray(parsed) ? parsed : [parsed]
    for (const payload of payloads) {
      const record = payload as Record<string, unknown>
      if (record.error) throw providerPayloadError('google', record, text)
      this.handleResponse(record, collector, state)
    }
    return inferStatusFromErrorPayload(parsed)
  }

  /** 非流式兜底：`:generateContent`（部分网关只实现了非流式路径） */
  private async requestNonStreaming(
    messages: BaseMessage[],
    tools: StructuredToolInterface[],
    options: ModelCallOptions,
    previous?: FallbackSnapshot
  ): Promise<AIMessage> {
    const url = await this.buildRequestUrl(false)
    const headers = await this.buildRequestHeaders()
    const collector = new ModelStreamCollector(options.onModelChunk)
    const state = { nextToolIndex: 0, thoughtSignatures: [] as string[] }
    const response = await httpRequest(url, {
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: JSON.stringify(this.buildBody(messages, tools)),
      signal: options.signal,
      timeoutMs: this.timeoutMs
    })
    const text = await safeReadText(response)
    const contentType = response.headers.get('content-type') ?? ''
    const status = this.consumeJsonResponse(text, collector, state)
    const message = this.finalize(collector, state, { contentType, status, previous })
    message.response_metadata = { ...message.response_metadata, fallback: 'non-streaming' }
    return message
  }

  protected async _generate(
    messages: BaseMessage[],
    tools: StructuredToolInterface[],
    options: ModelCallOptions
  ): Promise<AIMessage> {
    if (!this.streaming) {
      return await this.requestNonStreaming(messages, tools, options)
    }
    const url = await this.buildRequestUrl(true)
    const headers = await this.buildRequestHeaders()
    const collector = new ModelStreamCollector(options.onModelChunk)
    const state = { nextToolIndex: 0, thoughtSignatures: [] as string[] }
    let response: Response
    try {
      response = await httpRequest(url, {
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...headers
        },
        body: JSON.stringify(this.buildBody(messages, tools)),
        signal: options.signal,
        timeoutMs: this.timeoutMs
      })
    } catch (err) {
      if (shouldTryNonStreamingFallback(err)) {
        return await this.requestNonStreaming(messages, tools, options, {
          raw: err instanceof Error ? err.message : String(err)
        })
      }
      throw err
    }

    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.includes('application/json')) {
      const text = await safeReadText(response)
      this.consumeJsonResponse(text, collector, state)
      const message = collector.finalize()
      if (hasMeaningfulOutput(message)) {
        if (state.thoughtSignatures.length > 0) {
          message.additional_kwargs['__gemini_thought_signatures__'] = state.thoughtSignatures
        }
        return message
      }
      return await this.requestNonStreaming(messages, tools, options, collector.fallbackSnapshot())
    }

    try {
      for await (const event of parseSseStream(response, options.signal, (chunk) =>
        collector.recordRaw(chunk)
      )) {
        const data = event.data.trim()
        if (!data) continue
        let payload: Record<string, unknown>
        try {
          payload = JSON.parse(data) as Record<string, unknown>
        } catch {
          continue
        }
        if (payload.error) throw providerPayloadError('google', payload, data)
        this.handleResponse(payload, collector, state)
      }
    } catch (err) {
      if (shouldTryNonStreamingFallback(err)) {
        return await this.requestNonStreaming(
          messages,
          tools,
          options,
          collector.fallbackSnapshot()
        )
      }
      throw err
    }
    try {
      return this.finalize(collector, state, { contentType })
    } catch (err) {
      // 空流：换非流式请求继续（对齐 Spring AI 默认的 stream:false 行为）
      if (err instanceof ModelEmptyResponseError) {
        return await this.requestNonStreaming(
          messages,
          tools,
          options,
          collector.fallbackSnapshot()
        )
      }
      throw err
    }
  }

  /** 收尾：把函数调用的思考签名挂回消息（下一轮工具结果回传时要用），并守卫空响应 */
  private finalize(
    collector: ModelStreamCollector,
    state: { thoughtSignatures: string[] },
    context: { contentType?: string; status?: number; previous?: FallbackSnapshot } = {}
  ): AIMessage {
    const message = collector.finalizeOrThrow({
      provider: this.provider,
      model: this.model,
      status: context.status,
      contentType: context.contentType,
      previous: context.previous
    })
    if (state.thoughtSignatures.length > 0) {
      message.additional_kwargs['__gemini_thought_signatures__'] = state.thoughtSignatures
    }
    return message
  }
}

/** Google Generative AI（Gemini 官方接口，API Key 鉴权） */
export class ChatGoogleGenerativeAI extends GoogleChatModelBase {
  private readonly apiKey?: string

  constructor(model: string, fields: GoogleFields = {}) {
    super(model, fields)
    this.apiKey = fields.apiKey ?? process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY
  }

  protected async buildRequestUrl(streaming: boolean): Promise<string> {
    if (!this.apiKey) {
      throw modelConfigError(
        'Google Generative AI API key not found. Set it in the provider settings, or via the GOOGLE_API_KEY environment variable.'
      )
    }
    const base = (
      this.fields.baseUrl ??
      this.fields.baseURL ??
      'https://generativelanguage.googleapis.com'
    ).replace(/\/+$/, '')
    const method = streaming ? 'streamGenerateContent' : 'generateContent'
    const key = `key=${encodeURIComponent(this.apiKey)}`
    return `${base}/v1beta/models/${bareModelName(this.model)}:${method}?${streaming ? `alt=sse&${key}` : key}`
  }

  protected async buildRequestHeaders(): Promise<Record<string, string>> {
    return {}
  }
}
