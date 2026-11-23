/**
 * Anthropic Messages API 实现（`POST {baseURL}/v1/messages` + SSE）。
 *
 * 覆盖官方接口与「自定义端点里的 Anthropic 兼容协议」（`anthropicApiUrl` 可指向任意兼容网关）。
 * 支持：文本 / 图片（base64 或 URL）/ 工具调用 / 扩展思考（thinking）/ 输出档位（output_config）。
 */
import {
  AIMessage,
  BaseMessage,
  contentToBlocks,
  contentToText,
  MessageContentComplex,
  parseDataUrl,
  ToolCall
} from '../messages'
import {
  BaseChatModel,
  ModelCallOptions,
  ModelStreamCollector,
  type FallbackSnapshot
} from '../chat-model'
import {
  httpRequest,
  inferStatusFromErrorPayload,
  joinUrl,
  ModelEmptyResponseError,
  modelConfigError,
  parseSseStream,
  providerPayloadError,
  safeReadText,
  shouldTryNonStreamingFallback
} from '../http'
import { jsonSchemaOf, StructuredToolInterface } from '../tools'

export interface AnthropicThinking {
  type: 'enabled' | 'disabled' | 'adaptive'
  budget_tokens?: number
}

export interface AnthropicFields {
  model?: string
  apiKey?: string
  /** 自定义服务地址（旧实现字段名） */
  anthropicApiUrl?: string
  baseURL?: string
  maxTokens?: number
  temperature?: number
  topP?: number
  topK?: number
  stopSequences?: string[]
  /** 扩展思考配置（thinking-params 组装后经 fields 传入） */
  thinking?: AnthropicThinking
  /** 推理等级 / 输出配置（Anthropic `output_config`） */
  output_config?: Record<string, unknown>
  streamUsage?: boolean
  timeout?: number
  modelKwargs?: Record<string, unknown>
  [key: string]: unknown
}

/** Anthropic 各模型的默认输出上限（与旧实现保持一致） */
const MODEL_DEFAULT_MAX_OUTPUT_TOKENS: Record<string, number> = {
  'claude-fable-5': 16384,
  'claude-mythos-5': 16384,
  'claude-mythos-preview': 16384,
  'claude-opus-4-7': 16384,
  'claude-opus-4-6': 16384,
  'claude-sonnet-4-6': 16384,
  'claude-opus-4-5': 16384,
  'claude-sonnet-4-5': 16384,
  'claude-haiku-4-5': 16384,
  'claude-opus-4-1': 16384,
  'claude-sonnet-4': 16384,
  'claude-opus-4': 16384,
  'claude-3-7-sonnet': 8192,
  'claude-3-5-sonnet': 8192,
  'claude-3-5-haiku': 8192,
  'claude-3-opus': 4096,
  'claude-3-sonnet': 4096,
  'claude-3-haiku': 4096
}

const FALLBACK_MAX_OUTPUT_TOKENS = 4096

function defaultMaxOutputTokens(model: string): number {
  const match = Object.keys(MODEL_DEFAULT_MAX_OUTPUT_TOKENS).find((key) => model.startsWith(key))
  return match ? MODEL_DEFAULT_MAX_OUTPUT_TOKENS[match] : FALLBACK_MAX_OUTPUT_TOKENS
}

/** Anthropic 内容块 */
type AnthropicBlock = Record<string, unknown>

/** 单个 Anthropic 消息 */
interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: AnthropicBlock[]
}

/** 图片块：data URL → base64 source；http(s) URL → url source */
function toImageBlock(block: MessageContentComplex): AnthropicBlock | null {
  const raw =
    typeof block.image_url === 'string'
      ? block.image_url
      : (block.image_url as { url?: string } | undefined)?.url
  if (!raw) return null
  const dataUrl = parseDataUrl(raw)
  if (dataUrl) {
    return {
      type: 'image',
      source: { type: 'base64', media_type: dataUrl.mimeType, data: dataUrl.data }
    }
  }
  if (/^https?:\/\//i.test(raw)) {
    return { type: 'image', source: { type: 'url', url: raw } }
  }
  return null
}

/** 工具声明：zod schema → Anthropic input_schema */
function toAnthropicTools(tools: StructuredToolInterface[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? '',
    input_schema: jsonSchemaOf(tool)
  }))
}

/**
 * 消息序列 → Anthropic messages（system 单独返回）。
 * 工具结果并入 user 消息的 tool_result 块（连续工具结果合并进同一条 user 消息）。
 */
export function toAnthropicMessages(messages: BaseMessage[]): {
  system: string
  messages: AnthropicMessage[]
} {
  const systemParts: string[] = []
  const result: AnthropicMessage[] = []

  const push = (role: 'user' | 'assistant', blocks: AnthropicBlock[]): void => {
    if (blocks.length === 0) return
    const last = result[result.length - 1]
    if (last && last.role === role) {
      last.content.push(...blocks)
      return
    }
    result.push({ role, content: blocks })
  }

  for (const message of messages) {
    switch (message.type) {
      case 'system':
        systemParts.push(contentToText(message.content))
        break
      case 'human': {
        const blocks: AnthropicBlock[] = []
        for (const block of contentToBlocks(message.content)) {
          if (block.type === 'text') {
            blocks.push({ type: 'text', text: block.text ?? '' })
          } else if (block.type === 'image_url') {
            const image = toImageBlock(block)
            if (image) blocks.push(image)
          }
        }
        push('user', blocks)
        break
      }
      case 'ai': {
        const ai = message as BaseMessage & { tool_calls?: ToolCall[] }
        const blocks: AnthropicBlock[] = []
        const text = contentToText(message.content)
        if (text) blocks.push({ type: 'text', text })
        for (const call of ai.tool_calls ?? []) {
          blocks.push({
            type: 'tool_use',
            id: call.id ?? '',
            name: call.name,
            input: call.args ?? {}
          })
        }
        push('assistant', blocks)
        break
      }
      case 'tool': {
        const toolMessage = message as BaseMessage & { tool_call_id?: string; status?: string }
        const text = contentToText(message.content)
        const block: AnthropicBlock = {
          type: 'tool_result',
          tool_use_id: toolMessage.tool_call_id ?? '',
          content: text
        }
        if (toolMessage.status === 'error') block.is_error = true
        push('user', [block])
        break
      }
      default:
        break
    }
  }

  return { system: systemParts.filter(Boolean).join('\n\n'), messages: result }
}

export class ChatAnthropic extends BaseChatModel {
  readonly model: string
  private readonly apiUrl: string
  private readonly apiKey?: string
  private readonly maxTokens: number
  private readonly temperature?: number
  private readonly topP?: number
  private readonly topK?: number
  private readonly stopSequences?: string[]
  private readonly thinking?: AnthropicThinking
  private readonly outputConfig?: Record<string, unknown>
  private readonly timeoutMs?: number
  private readonly modelKwargs?: Record<string, unknown>
  /** 是否使用流式请求（extra_config 可显式关闭，或流式失败时自动降级） */
  private readonly streaming: boolean

  constructor(fields: AnthropicFields) {
    super()
    if (!fields?.model) throw new Error('ChatAnthropic requires a "model" field')
    this.model = fields.model
    this.apiUrl = fields.anthropicApiUrl ?? fields.baseURL ?? 'https://api.anthropic.com'
    this.apiKey = fields.apiKey ?? process.env.ANTHROPIC_API_KEY
    const configuredMax = typeof fields.maxTokens === 'number' ? fields.maxTokens : undefined
    this.maxTokens =
      configuredMax && configuredMax > 0 ? configuredMax : defaultMaxOutputTokens(fields.model)
    this.temperature = typeof fields.temperature === 'number' ? fields.temperature : undefined
    this.topP = typeof fields.topP === 'number' ? fields.topP : undefined
    this.topK = typeof fields.topK === 'number' ? fields.topK : undefined
    this.stopSequences = fields.stopSequences
    this.thinking = fields.thinking
    this.outputConfig = fields.output_config
    this.timeoutMs = typeof fields.timeout === 'number' ? fields.timeout : undefined
    this.modelKwargs = fields.modelKwargs
    this.streaming = fields.streaming !== false
  }

  get provider(): string {
    return 'anthropic'
  }

  /** 组装请求体 */
  private buildBody(
    messages: BaseMessage[],
    tools: StructuredToolInterface[],
    streaming = this.streaming
  ): Record<string, unknown> {
    const { system, messages: anthropicMessages } = toAnthropicMessages(messages)
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: this.maxTokens,
      messages: anthropicMessages,
      stream: streaming
    }
    if (system) body.system = system
    // 扩展思考开启时 Anthropic 不接受 temperature / top_k（会 400），与旧实现同规则
    const thinkingEnabled =
      this.thinking && (this.thinking.type === 'enabled' || this.thinking.type === 'adaptive')
    if (!thinkingEnabled) {
      if (this.temperature != null) body.temperature = this.temperature
      if (this.topP != null) body.top_p = this.topP
      if (this.topK != null) body.top_k = this.topK
    }
    if (this.stopSequences && this.stopSequences.length > 0)
      body.stop_sequences = this.stopSequences
    if (tools.length > 0) body.tools = toAnthropicTools(tools)
    if (this.thinking) body.thinking = this.thinking
    if (this.outputConfig) body.output_config = this.outputConfig
    if (this.modelKwargs) Object.assign(body, this.modelKwargs)
    return body
  }

  private buildHeaders(streaming: boolean): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: streaming ? 'text/event-stream' : 'application/json',
      'x-api-key': this.apiKey ?? '',
      'anthropic-version': '2023-06-01'
    }
  }

  /** 处理一个 Anthropic 流式事件；返回 true 表示消息结束 */
  private handleEvent(
    payload: Record<string, unknown>,
    collector: ModelStreamCollector,
    state: {
      blockIndexToTool: Map<number, number>
      nextToolIndex: number
      inputTokens: number
      outputTokens: number
      cacheReadTokens: number
      cacheWriteTokens: number
    }
  ): boolean {
    const type = payload.type
    if (type === 'error') {
      const error = payload.error as Record<string, unknown> | undefined
      throw new Error(
        `anthropic stream error: ${String(error?.message ?? JSON.stringify(payload))}`
      )
    }
    if (type === 'message_start') {
      const message = payload.message as Record<string, unknown> | undefined
      if (message) {
        if (typeof message.model === 'string') collector.metadata({ model_name: message.model })
        const usage = message.usage as Record<string, unknown> | undefined
        if (usage) {
          if (typeof usage.input_tokens === 'number') state.inputTokens = usage.input_tokens
          if (typeof usage.cache_read_input_tokens === 'number') {
            state.cacheReadTokens = usage.cache_read_input_tokens
          }
          if (typeof usage.cache_creation_input_tokens === 'number') {
            state.cacheWriteTokens = usage.cache_creation_input_tokens
          }
        }
      }
      return false
    }
    if (type === 'content_block_start') {
      const index = typeof payload.index === 'number' ? payload.index : 0
      const block = payload.content_block as Record<string, unknown> | undefined
      if (block?.type === 'tool_use') {
        const toolIndex = state.nextToolIndex++
        state.blockIndexToTool.set(index, toolIndex)
        collector.toolDelta(toolIndex, {
          id: typeof block.id === 'string' ? block.id : undefined,
          name: typeof block.name === 'string' ? block.name : undefined
        })
      }
      return false
    }
    if (type === 'content_block_delta') {
      const index = typeof payload.index === 'number' ? payload.index : 0
      const delta = payload.delta as Record<string, unknown> | undefined
      if (!delta) return false
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        collector.text(delta.text)
      } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        collector.reasoning(delta.thinking)
      } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        const toolIndex = state.blockIndexToTool.get(index)
        if (toolIndex != null) collector.toolDelta(toolIndex, { args: delta.partial_json })
      }
      return false
    }
    if (type === 'message_delta') {
      const delta = payload.delta as Record<string, unknown> | undefined
      if (delta && typeof delta.stop_reason === 'string') {
        collector.metadata({ finish_reason: delta.stop_reason })
      }
      const usage = payload.usage as Record<string, unknown> | undefined
      if (usage) {
        if (typeof usage.output_tokens === 'number') state.outputTokens = usage.output_tokens
        if (typeof usage.input_tokens === 'number') state.inputTokens = usage.input_tokens
        if (typeof usage.cache_read_input_tokens === 'number') {
          state.cacheReadTokens = usage.cache_read_input_tokens
        }
        if (typeof usage.cache_creation_input_tokens === 'number') {
          state.cacheWriteTokens = usage.cache_creation_input_tokens
        }
      }
      return false
    }
    if (type === 'message_stop') return true
    return false
  }

  /** 非流式响应 → 消息（部分兼容网关忽略 stream 参数） */
  private handleFullResponse(
    payload: Record<string, unknown>,
    collector: ModelStreamCollector
  ): void {
    if (typeof payload.model === 'string') collector.metadata({ model_name: payload.model })
    if (typeof payload.stop_reason === 'string') {
      collector.metadata({ finish_reason: payload.stop_reason })
    }
    const usage = payload.usage as Record<string, unknown> | undefined
    if (usage) {
      collector.usage({
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        total_tokens:
          typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number'
            ? usage.input_tokens + usage.output_tokens
            : undefined
      })
    }
    const content = payload.content
    if (!Array.isArray(content)) return
    let toolIndex = 0
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === 'text' && typeof block.text === 'string') {
        collector.text(block.text)
      } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
        collector.reasoning(block.thinking)
      } else if (block.type === 'tool_use') {
        const index = toolIndex++
        collector.toolDelta(index, {
          id: typeof block.id === 'string' ? block.id : undefined,
          name: typeof block.name === 'string' ? block.name : undefined,
          args: block.input ? JSON.stringify(block.input) : '{}'
        })
      }
    }
  }

  protected async _generate(
    messages: BaseMessage[],
    tools: StructuredToolInterface[],
    options: ModelCallOptions
  ): Promise<AIMessage> {
    if (!this.apiKey) {
      throw modelConfigError(
        'anthropic API key not found. Set it in the provider settings, or via the ANTHROPIC_API_KEY environment variable.'
      )
    }
    if (!this.streaming) {
      return await this.requestNonStreaming(messages, tools, options)
    }
    const collector = new ModelStreamCollector(options.onModelChunk)
    const state = this.newState()
    const url = joinUrl(this.apiUrl, 'v1/messages')
    let response: Response
    try {
      response = await httpRequest(url, {
        headers: this.buildHeaders(true),
        body: JSON.stringify(this.buildBody(messages, tools, true)),
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
      collector.recordRaw(text)
      const payload = JSON.parse(text) as Record<string, unknown>
      if (payload.type === 'error') throw providerPayloadError('anthropic', payload, text)
      this.handleFullResponse(payload, collector)
      return this.finalize(collector, state, {
        contentType,
        status: inferStatusFromErrorPayload(payload)
      })
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
        if (this.handleEvent(payload, collector, state)) break
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
      // 空流：换非流式请求继续（与 Spring AI 默认的 stream:false 行为对齐）
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

  /** 非流式兜底：`stream:false` 返回标准 Messages JSON（部分兼容网关只实现了这条路径） */
  private async requestNonStreaming(
    messages: BaseMessage[],
    tools: StructuredToolInterface[],
    options: ModelCallOptions,
    previous?: FallbackSnapshot
  ): Promise<AIMessage> {
    const collector = new ModelStreamCollector(options.onModelChunk)
    const state = this.newState()
    const response = await httpRequest(joinUrl(this.apiUrl, 'v1/messages'), {
      headers: this.buildHeaders(false),
      body: JSON.stringify(this.buildBody(messages, tools, false)),
      signal: options.signal,
      timeoutMs: this.timeoutMs
    })
    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.includes('application/json')) {
      const text = await safeReadText(response)
      collector.recordRaw(text)
      const payload = JSON.parse(text) as Record<string, unknown>
      if (payload.type === 'error') throw providerPayloadError('anthropic', payload, text)
      this.handleFullResponse(payload, collector)
    } else {
      // 极端情况：非流式请求仍回了 SSE
      for await (const event of parseSseStream(response, options.signal, (chunk) =>
        collector.recordRaw(chunk)
      )) {
        const data = event.data.trim()
        if (!data) continue
        try {
          if (this.handleEvent(JSON.parse(data) as Record<string, unknown>, collector, state)) break
        } catch {
          continue
        }
      }
    }
    const message = this.finalize(collector, state, { contentType, previous })
    message.response_metadata = { ...message.response_metadata, fallback: 'non-streaming' }
    return message
  }

  private newState(): {
    blockIndexToTool: Map<number, number>
    nextToolIndex: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
  } {
    return {
      blockIndexToTool: new Map<number, number>(),
      nextToolIndex: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0
    }
  }

  /** 收尾：补 total_tokens 与缓存明细（Anthropic 不直接给总量），并守卫空响应 */
  private finalize(
    collector: ModelStreamCollector,
    state: {
      inputTokens: number
      outputTokens: number
      cacheReadTokens: number
      cacheWriteTokens: number
    },
    context: { contentType?: string; status?: number; previous?: FallbackSnapshot } = {}
  ): AIMessage {
    if (state.inputTokens || state.outputTokens) {
      const usage: Record<string, unknown> = {
        input_tokens: state.inputTokens,
        output_tokens: state.outputTokens,
        total_tokens: state.inputTokens + state.outputTokens
      }
      const inputDetails: Record<string, unknown> = {}
      if (state.cacheReadTokens) {
        inputDetails.cache_read = state.cacheReadTokens
        usage.cache_read_input_tokens = state.cacheReadTokens
      }
      if (state.cacheWriteTokens) {
        inputDetails.cache_creation = state.cacheWriteTokens
        usage.cache_creation_input_tokens = state.cacheWriteTokens
      }
      if (Object.keys(inputDetails).length > 0) usage.input_token_details = inputDetails
      collector.usage(usage)
    }
    return collector.finalizeOrThrow({
      provider: this.provider,
      model: this.model,
      status: context.status,
      contentType: context.contentType,
      previous: context.previous
    })
  }
}
