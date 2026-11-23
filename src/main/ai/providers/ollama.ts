/**
 * Ollama 实现（`POST {baseUrl}/api/chat`，NDJSON 流式）。
 *
 * 与 OpenAI 协议的区别：
 * - 流式响应是「一行一个 JSON」而不是 SSE；
 * - 工具调用不带 id（这里按出现顺序合成，工具结果回传时用 `tool_name` 关联）；
 * - 采样参数在 `options` 里（num_predict / top_k …），思考开关是顶层 `think`。
 */
import { AIMessage, BaseMessage, contentToBlocks, contentToText, parseDataUrl } from '../messages'
import {
  BaseChatModel,
  hasMeaningfulOutput,
  ModelCallOptions,
  ModelStreamCollector,
  type FallbackSnapshot
} from '../chat-model'
import {
  httpRequest,
  joinUrl,
  parseJsonLinesStream,
  providerPayloadError,
  safeReadText,
  shouldTryNonStreamingFallback
} from '../http'
import { jsonSchemaOf, StructuredToolInterface } from '../tools'

export interface OllamaFields {
  model?: string
  baseUrl?: string
  apiKey?: string
  numPredict?: number
  temperature?: number
  topP?: number
  topK?: number
  /** 思考开关：true/false 或 'low' | 'medium' | 'high' */
  think?: boolean | string
  stop?: string[]
  timeout?: number
  modelKwargs?: Record<string, unknown>
  [key: string]: unknown
}

/** 工具调用 id → 工具名 */
function toolNameIndex(messages: BaseMessage[]): Map<string, string> {
  const index = new Map<string, string>()
  for (const message of messages) {
    if (message.type !== 'ai') continue
    for (const call of (message as AIMessage).tool_calls ?? []) {
      if (call.id) index.set(call.id, call.name)
    }
  }
  return index
}

/** 消息数组 → Ollama /api/chat 的 messages */
export function toOllamaMessages(messages: BaseMessage[]): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = []
  const toolNames = toolNameIndex(messages)
  for (const message of messages) {
    switch (message.type) {
      case 'system':
        result.push({ role: 'system', content: contentToText(message.content) })
        break
      case 'human': {
        const images: string[] = []
        const texts: string[] = []
        for (const block of contentToBlocks(message.content)) {
          if (block.type === 'text') texts.push(block.text ?? '')
          else if (block.type === 'image_url') {
            const raw =
              typeof block.image_url === 'string'
                ? block.image_url
                : (block.image_url as { url?: string } | undefined)?.url
            const data = raw ? parseDataUrl(raw) : null
            if (data) images.push(data.data)
          }
        }
        const entry: Record<string, unknown> = {
          role: 'user',
          content: texts.join('\n')
        }
        if (images.length > 0) entry.images = images
        result.push(entry)
        break
      }
      case 'ai': {
        const ai = message as AIMessage
        const entry: Record<string, unknown> = {
          role: 'assistant',
          content: contentToText(message.content)
        }
        if (ai.tool_calls && ai.tool_calls.length > 0) {
          entry.tool_calls = ai.tool_calls.map((call) => ({
            function: { name: call.name, arguments: call.args ?? {} }
          }))
        }
        result.push(entry)
        break
      }
      case 'tool': {
        const toolMessage = message as BaseMessage & { tool_call_id?: string; tool_name?: string }
        const entry: Record<string, unknown> = {
          role: 'tool',
          content: contentToText(message.content)
        }
        const name = toolMessage.tool_name ?? toolNames.get(toolMessage.tool_call_id ?? '')
        if (name) entry.tool_name = name
        result.push(entry)
        break
      }
      default:
        break
    }
  }
  return result
}

export class ChatOllama extends BaseChatModel {
  readonly model: string
  private readonly baseUrl: string
  private readonly apiKey?: string
  private readonly options: Record<string, unknown>
  private readonly think?: boolean | string
  private readonly timeoutMs?: number
  private readonly modelKwargs?: Record<string, unknown>
  /** 是否使用流式请求（extra_config 可显式关闭，或流式失败时自动降级） */
  private readonly streaming: boolean

  constructor(fields: OllamaFields) {
    super()
    if (!fields?.model) throw new Error('ChatOllama requires a "model" field')
    this.model = fields.model
    this.baseUrl = fields.baseUrl ?? process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434'
    this.apiKey = fields.apiKey
    this.think = fields.think
    this.timeoutMs = typeof fields.timeout === 'number' ? fields.timeout : undefined
    this.modelKwargs = fields.modelKwargs
    this.streaming = fields.streaming !== false
    this.options = {}
    if (typeof fields.temperature === 'number') this.options.temperature = fields.temperature
    if (typeof fields.topP === 'number') this.options.top_p = fields.topP
    if (typeof fields.topK === 'number') this.options.top_k = fields.topK
    if (typeof fields.numPredict === 'number' && fields.numPredict > 0) {
      this.options.num_predict = fields.numPredict
    }
    if (fields.stop && fields.stop.length > 0) this.options.stop = fields.stop
  }

  get provider(): string {
    return 'ollama'
  }

  private buildBody(
    messages: BaseMessage[],
    tools: StructuredToolInterface[],
    streaming = true
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toOllamaMessages(messages),
      stream: streaming
    }
    if (Object.keys(this.options).length > 0) body.options = this.options
    if (this.think !== undefined) body.think = this.think
    if (tools.length > 0) {
      body.tools = tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description ?? '',
          parameters: jsonSchemaOf(tool)
        }
      }))
    }
    if (this.modelKwargs) Object.assign(body, this.modelKwargs)
    return body
  }

  /** 处理一行 NDJSON；返回 true 表示流结束 */
  private handleLine(
    payload: Record<string, unknown>,
    collector: ModelStreamCollector,
    state: { toolIndex: number }
  ): boolean {
    if (payload.error !== undefined) {
      throw providerPayloadError('ollama', payload, JSON.stringify(payload))
    }
    const message = payload.message as Record<string, unknown> | undefined
    if (message) {
      if (typeof message.content === 'string') collector.text(message.content)
      if (typeof message.thinking === 'string') collector.reasoning(message.thinking)
      const toolCalls = message.tool_calls
      if (Array.isArray(toolCalls)) {
        for (const rawCall of toolCalls) {
          if (!rawCall || typeof rawCall !== 'object') continue
          const call = rawCall as Record<string, unknown>
          const fn = call.function as Record<string, unknown> | undefined
          if (!fn || typeof fn.name !== 'string') continue
          const args = fn.arguments
          collector.toolDelta(state.toolIndex++, {
            name: fn.name,
            args: args ? JSON.stringify(args) : '{}'
          })
        }
      }
    }
    if (payload.done === true) {
      const input =
        typeof payload.prompt_eval_count === 'number' ? payload.prompt_eval_count : undefined
      const output = typeof payload.eval_count === 'number' ? payload.eval_count : undefined
      const total = (input ?? 0) + (output ?? 0)
      collector.usage({
        input_tokens: input,
        output_tokens: output,
        total_tokens: total
      })
      collector.metadata({
        model_name: typeof payload.model === 'string' ? payload.model : undefined,
        finish_reason: typeof payload.done_reason === 'string' ? payload.done_reason : 'stop'
      })
      return true
    }
    return false
  }

  /** 非流式兜底：Ollama 的 stream:false 返回单个 JSON 对象 */
  private async requestNonStreaming(
    messages: BaseMessage[],
    tools: StructuredToolInterface[],
    options: ModelCallOptions,
    previous?: FallbackSnapshot
  ): Promise<AIMessage> {
    const collector = new ModelStreamCollector(options.onModelChunk)
    const response = await httpRequest(joinUrl(this.baseUrl, 'api/chat'), {
      headers: this.buildHeaders(false),
      body: JSON.stringify(this.buildBody(messages, tools, false)),
      signal: options.signal,
      timeoutMs: this.timeoutMs
    })
    const text = await safeReadText(response)
    collector.recordRaw(text)
    const contentType = response.headers.get('content-type') ?? ''
    const parsed = parseSingleJson(text)
    if (parsed) this.handleLine(parsed, collector, { toolIndex: 0 })
    const message = collector.finalizeOrThrow({
      provider: this.provider,
      model: this.model,
      contentType,
      previous
    })
    message.response_metadata = { ...message.response_metadata, fallback: 'non-streaming' }
    return message
  }

  private buildHeaders(streaming: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: streaming ? 'application/x-ndjson' : 'application/json'
    }
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`
    return headers
  }

  protected async _generate(
    messages: BaseMessage[],
    tools: StructuredToolInterface[],
    options: ModelCallOptions
  ): Promise<AIMessage> {
    if (!this.streaming) {
      return await this.requestNonStreaming(messages, tools, options)
    }
    const collector = new ModelStreamCollector(options.onModelChunk)
    let response: Response
    try {
      response = await httpRequest(joinUrl(this.baseUrl, 'api/chat'), {
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
    const state = { toolIndex: 0 }
    try {
      for await (const line of parseJsonLinesStream(response, options.signal, (chunk) =>
        collector.recordRaw(chunk)
      )) {
        if (!line || typeof line !== 'object') continue
        if (this.handleLine(line as Record<string, unknown>, collector, state)) break
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
    const streamed = collector.finalize()
    if (hasMeaningfulOutput(streamed)) return streamed
    // 空流（网关流式实现异常的典型表现）：自动换非流式继续
    return await this.requestNonStreaming(messages, tools, options, collector.fallbackSnapshot())
  }
}

/** 解析单个 JSON 对象（非流式响应体） */
function parseSingleJson(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    return undefined
  }
  return undefined
}
