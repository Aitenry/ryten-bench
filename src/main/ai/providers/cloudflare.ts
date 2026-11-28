/**
 * Cloudflare Workers AI implementation (`POST {baseUrl}/{model}`, SSE streaming).
 *
 * As in the legacy implementation, only text chat is supported (the Workers AI chat protocol does
 * not provide tool calling). The account ID comes from `cloudflareAccountId` or the
 * CLOUDFLARE_ACCOUNT_ID environment variable, and the token comes from `cloudflareApiToken` or
 * CLOUDFLARE_API_TOKEN.
 */
import { AIMessage, BaseMessage, contentToText } from '../messages'
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
  joinUrl,
  modelConfigError,
  parseSseStream,
  providerPayloadError,
  safeReadText,
  shouldTryNonStreamingFallback
} from '../http'
import { normalizeUsage } from './converters'
import type { StructuredToolInterface } from '../tools'

export interface CloudflareFields {
  model?: string
  cloudflareApiToken?: string
  cloudflareAccountId?: string
  baseUrl?: string
  temperature?: number
  topP?: number
  maxTokens?: number
  timeout?: number
  modelKwargs?: Record<string, unknown>
  [key: string]: unknown
}

/** Message array → Cloudflare chat messages (text) */
function toCloudflareMessages(messages: BaseMessage[]): Array<Record<string, unknown>> {
  return messages.map((message) => {
    const role =
      message.type === 'ai' ? 'assistant' : message.type === 'tool' ? 'tool' : message.type
    return {
      role,
      content: contentToText(message.content)
    }
  })
}

export class ChatCloudflareWorkersAI extends BaseChatModel {
  readonly model: string
  private readonly apiToken?: string
  private readonly baseUrl?: string
  private readonly accountId?: string
  private readonly temperature?: number
  private readonly topP?: number
  private readonly maxTokens?: number
  private readonly timeoutMs?: number
  private readonly modelKwargs?: Record<string, unknown>
  /** Whether to use streaming requests (extra_config can disable it, or it auto-degrades on failure) */
  private readonly streaming: boolean

  constructor(fields: CloudflareFields) {
    super()
    if (!fields?.model) throw new Error('ChatCloudflareWorkersAI requires a "model" field')
    this.model = fields.model
    this.apiToken = fields.cloudflareApiToken ?? process.env.CLOUDFLARE_API_TOKEN
    this.accountId = fields.cloudflareAccountId ?? process.env.CLOUDFLARE_ACCOUNT_ID
    this.baseUrl = fields.baseUrl ?? process.env.CLOUDFLARE_BASE_URL
    this.temperature = typeof fields.temperature === 'number' ? fields.temperature : undefined
    this.topP = typeof fields.topP === 'number' ? fields.topP : undefined
    this.maxTokens = typeof fields.maxTokens === 'number' ? fields.maxTokens : undefined
    this.timeoutMs = typeof fields.timeout === 'number' ? fields.timeout : undefined
    this.modelKwargs = fields.modelKwargs
    this.streaming = fields.streaming !== false
  }

  get provider(): string {
    return 'cloudflare'
  }

  private resolveEndpoint(): string {
    if (this.baseUrl) return joinUrl(this.baseUrl, this.model)
    if (!this.accountId) {
      throw modelConfigError(
        'Cloudflare account id not found. Set it in the provider settings (extra config "cloudflareAccountId") or via the CLOUDFLARE_ACCOUNT_ID environment variable.'
      )
    }
    return `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/run/${this.model}`
  }

  private buildBody(messages: BaseMessage[], streaming = this.streaming): Record<string, unknown> {
    const body: Record<string, unknown> = {
      messages: toCloudflareMessages(messages),
      stream: streaming
    }
    if (this.temperature != null) body.temperature = this.temperature
    if (this.topP != null) body.top_p = this.topP
    if (this.maxTokens != null) body.max_tokens = this.maxTokens
    if (this.modelKwargs) Object.assign(body, this.modelKwargs)
    return body
  }

  /** Handle one streaming chunk (Cloudflare: `{response}`; a few gateways return the OpenAI shape) */
  private handleChunk(payload: Record<string, unknown>, collector: ModelStreamCollector): void {
    if (typeof payload.response === 'string') collector.text(payload.response)
    const usage = normalizeUsage(payload.usage as Record<string, unknown> | undefined)
    if (usage) collector.usage(usage)
    const choices = payload.choices
    if (Array.isArray(choices) && choices.length > 0) {
      const delta = (choices[0] as Record<string, unknown>).delta as
        Record<string, unknown> | undefined
      if (delta && typeof delta.content === 'string') collector.text(delta.content)
    }
  }

  private buildHeaders(streaming: boolean): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: streaming ? 'text/event-stream' : 'application/json',
      authorization: `Bearer ${this.apiToken}`
    }
  }

  /** Parse a non-streaming JSON response body (Cloudflare: { result: { response } } or an error body) */
  private consumeJsonBody(text: string, collector: ModelStreamCollector): number | undefined {
    collector.recordRaw(text)
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(text) as Record<string, unknown>
    } catch {
      return undefined
    }
    // Cloudflare error body: { success: false, errors: [{ code, message }] } (sometimes still HTTP 200)
    if (parsed.success === false || Array.isArray(parsed.errors)) {
      throw providerPayloadError('cloudflare', parsed, text)
    }
    const result = parsed.result as Record<string, unknown> | undefined
    this.handleChunk(result ?? parsed, collector)
    return inferStatusFromErrorPayload(parsed)
  }

  /** Non-streaming fallback */
  private async requestNonStreaming(
    messages: BaseMessage[],
    options: ModelCallOptions,
    previous?: FallbackSnapshot
  ): Promise<AIMessage> {
    const collector = new ModelStreamCollector(options.onModelChunk)
    const response = await httpRequest(this.resolveEndpoint(), {
      headers: this.buildHeaders(false),
      body: JSON.stringify(this.buildBody(messages, false)),
      signal: options.signal,
      timeoutMs: this.timeoutMs
    })
    const text = await safeReadText(response)
    const contentType = response.headers.get('content-type') ?? ''
    const status = this.consumeJsonBody(text, collector)
    const message = collector.finalizeOrThrow({
      provider: this.provider,
      model: this.model,
      status,
      contentType,
      previous
    })
    message.response_metadata = { ...message.response_metadata, fallback: 'non-streaming' }
    return message
  }

  protected async _generate(
    messages: BaseMessage[],
    _tools: StructuredToolInterface[],
    options: ModelCallOptions
  ): Promise<AIMessage> {
    if (!this.apiToken) {
      throw modelConfigError(
        'Cloudflare API token not found. Set it in the provider settings, or via the CLOUDFLARE_API_TOKEN environment variable.'
      )
    }
    if (!this.streaming) {
      return await this.requestNonStreaming(messages, options)
    }
    const collector = new ModelStreamCollector(options.onModelChunk)
    let response: Response
    try {
      response = await httpRequest(this.resolveEndpoint(), {
        headers: this.buildHeaders(true),
        body: JSON.stringify(this.buildBody(messages, true)),
        signal: options.signal,
        timeoutMs: this.timeoutMs
      })
    } catch (err) {
      if (shouldTryNonStreamingFallback(err)) {
        return await this.requestNonStreaming(messages, options, {
          raw: err instanceof Error ? err.message : String(err)
        })
      }
      throw err
    }

    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.includes('application/json')) {
      const text = await safeReadText(response)
      this.consumeJsonBody(text, collector)
      const message = collector.finalize()
      if (hasMeaningfulOutput(message)) return message
      return await this.requestNonStreaming(messages, options, collector.fallbackSnapshot())
    }

    try {
      for await (const event of parseSseStream(response, options.signal, (chunk) =>
        collector.recordRaw(chunk)
      )) {
        const data = event.data.trim()
        if (!data || data === '[DONE]') continue
        let payload: Record<string, unknown>
        try {
          payload = JSON.parse(data) as Record<string, unknown>
        } catch {
          continue
        }
        if (payload.success === false || Array.isArray(payload.errors)) {
          throw providerPayloadError('cloudflare', payload, data)
        }
        this.handleChunk(payload, collector)
      }
    } catch (err) {
      if (shouldTryNonStreamingFallback(err)) {
        return await this.requestNonStreaming(messages, options, collector.fallbackSnapshot())
      }
      throw err
    }
    const streamed = collector.finalize()
    if (hasMeaningfulOutput(streamed)) return streamed
    return await this.requestNonStreaming(messages, options, collector.fallbackSnapshot())
  }
}
