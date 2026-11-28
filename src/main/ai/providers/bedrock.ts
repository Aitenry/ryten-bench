/**
 * AWS Bedrock Converse implementation (`/model/<modelId>/converse-stream`, AWS event-stream streaming).
 *
 * Only the Converse API capabilities this project needs are implemented (text / images / tool
 * calls / reasoning content):
 * - Two auth modes: **Bedrock API Key** (Bearer, `apiKey` or `bedrockBearerToken` in the config)
 *   and **SigV4** (static AK/SK: settings.credentials or AWS environment variables);
 * - Streaming responses are AWS event-stream binary frames (not SSE); a minimal decoder is included;
 * - Tool declarations use `toolConfig.tools[].toolSpec`, with JSON Schema as the parameter schema.
 */
import { createHash, createHmac } from 'node:crypto'
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
  inferStatusFromErrorPayload,
  modelConfigError,
  providerPayloadError,
  safeReadText,
  shouldTryNonStreamingFallback
} from '../http'
import { jsonSchemaOf, StructuredToolInterface } from '../tools'

export interface BedrockFields {
  model?: string
  region?: string
  /** Static credentials (SigV4) */
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
  /** Bedrock API Key / Secret (legacy field names) */
  bedrockApiKey?: string
  bedrockApiSecret?: string
  bedrockApiSessionToken?: string
  /** Bedrock API Key (Bearer) */
  bedrockBearerToken?: string
  /** API Key from the project settings: used as a Bearer token for Bedrock */
  apiKey?: string
  endpointHost?: string
  maxTokens?: number
  temperature?: number
  topP?: number
  stopSequences?: string[]
  additionalModelRequestFields?: Record<string, unknown>
  timeout?: number
  modelKwargs?: Record<string, unknown>
  [key: string]: unknown
}

/** Image format set (Converse only accepts these) */
const IMAGE_FORMATS = new Set(['png', 'jpeg', 'gif', 'webp'])

function imageFormatFromMime(mime: string): string {
  const normalized = mime.toLowerCase()
  if (normalized.includes('png')) return 'png'
  if (normalized.includes('gif')) return 'gif'
  if (normalized.includes('webp')) return 'webp'
  return 'jpeg'
}

/** Tool call id → tool name (toolResult does not need the name, but the index is kept for extensions) */
function buildToolNameIndex(messages: BaseMessage[]): Map<string, string> {
  const index = new Map<string, string>()
  for (const message of messages) {
    if (message.type !== 'ai') continue
    for (const call of (message as AIMessage).tool_calls ?? []) {
      if (call.id) index.set(call.id, call.name)
    }
  }
  return index
}

/** Message array → Converse `messages` + `system` */
export function toBedrockMessages(messages: BaseMessage[]): {
  system: Array<Record<string, unknown>>
  messages: Array<Record<string, unknown>>
} {
  const systemParts: string[] = []
  const result: Array<Record<string, unknown>> = []
  const toolNames = buildToolNameIndex(messages)

  const push = (role: 'user' | 'assistant', content: Array<Record<string, unknown>>): void => {
    if (content.length === 0) return
    const last = result[result.length - 1]
    if (last && last.role === role) {
      ;(last.content as Array<Record<string, unknown>>).push(...content)
      return
    }
    result.push({ role, content })
  }

  for (const message of messages) {
    switch (message.type) {
      case 'system':
        systemParts.push(contentToText(message.content))
        break
      case 'human': {
        const content: Array<Record<string, unknown>> = []
        for (const block of contentToBlocks(message.content)) {
          if (block.type === 'text') {
            content.push({ text: block.text ?? '' })
          } else if (block.type === 'image_url') {
            const raw =
              typeof block.image_url === 'string'
                ? block.image_url
                : (block.image_url as { url?: string } | undefined)?.url
            const data = raw ? parseDataUrl(raw) : null
            if (data) {
              const format = imageFormatFromMime(data.mimeType)
              if (IMAGE_FORMATS.has(format)) {
                content.push({ image: { format, source: { bytes: data.data } } })
              }
            }
          }
        }
        push('user', content)
        break
      }
      case 'ai': {
        const ai = message as AIMessage
        const content: Array<Record<string, unknown>> = []
        const text = contentToText(message.content)
        if (text) content.push({ text })
        for (const call of ai.tool_calls ?? []) {
          content.push({
            toolUse: {
              toolUseId: call.id ?? '',
              name: call.name,
              input: call.args ?? {}
            }
          })
        }
        push('assistant', content)
        break
      }
      case 'tool': {
        const toolMessage = message as BaseMessage & { tool_call_id?: string; status?: string }
        const callId = toolMessage.tool_call_id ?? ''
        // Including the tool name in toolResult is not required by the protocol, but helps
        // diagnostics when several tools run in the same batch
        void toolNames.get(callId)
        push('user', [
          {
            toolResult: {
              toolUseId: callId,
              content: [{ text: contentToText(message.content) }],
              status: toolMessage.status === 'error' ? 'error' : 'success'
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
    system: systemParts.filter(Boolean).map((text) => ({ text })),
    messages: result
  }
}

/** Tool declaration → Converse toolConfig */
function toBedrockTools(tools: StructuredToolInterface[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    toolSpec: {
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: { json: jsonSchemaOf(tool) }
    }
  }))
}

// ============================================================================
// SigV4 signing
// ============================================================================

function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest()
}

interface StaticCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
}

/** Sign the request with SigV4 and return the headers that must be attached */
export function signSigV4(options: {
  method: string
  url: string
  body: string
  service: string
  region: string
  headers: Record<string, string>
  credentials: StaticCredentials
  now?: Date
}): Record<string, string> {
  const parsed = new URL(options.url)
  const now = options.now ?? new Date()
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const dateStamp = amzDate.slice(0, 8)
  const payloadHash = sha256Hex(options.body)

  const rawHeaders: Record<string, string> = {
    ...options.headers,
    host: parsed.host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash
  }
  if (options.credentials.sessionToken) {
    rawHeaders['x-amz-security-token'] = options.credentials.sessionToken
  }
  // Normalization: SigV4 canonical headers must be all lowercase with trimmed values
  const normalizedHeaders: Record<string, string> = {}
  for (const [name, value] of Object.entries(rawHeaders)) {
    normalizedHeaders[name.toLowerCase()] = String(value).trim()
  }

  const headerNames = Object.keys(normalizedHeaders).sort()
  const canonicalHeaders = headerNames
    .map((name) => `${name}:${normalizedHeaders[name]}\n`)
    .join('')
  const signedHeaders = headerNames.join(';')

  const canonicalQuery = [...parsed.searchParams.entries()]
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .sort()
    .join('&')

  const canonicalRequest = [
    options.method,
    parsed.pathname,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n')

  const scope = `${dateStamp}/${options.region}/${options.service}/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n')

  const kDate = hmac(`AWS4${options.credentials.secretAccessKey}`, dateStamp)
  const kRegion = hmac(kDate, options.region)
  const kService = hmac(kRegion, options.service)
  const kSigning = hmac(kService, 'aws4_request')
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex')

  const result: Record<string, string> = { ...normalizedHeaders }
  delete result.host
  result.authorization =
    `AWS4-HMAC-SHA256 Credential=${options.credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`
  return result
}

// ============================================================================
// AWS event-stream decoding
// ============================================================================

/**
 * Parse AWS event-stream response frames.
 * Frame layout: total_length(4) | headers_length(4) | prelude_crc(4) | headers | payload | message_crc(4)
 */
async function* parseAwsEventStream(
  response: Response,
  signal?: AbortSignal
): AsyncGenerator<Record<string, unknown>> {
  if (!response.body) return
  const reader = response.body.getReader()
  let buffer = Buffer.alloc(0)
  try {
    for (;;) {
      if (signal?.aborted) {
        const error = new Error('Bedrock stream aborted')
        error.name = 'AbortError'
        throw error
      }
      const { done, value } = await reader.read()
      if (value) buffer = Buffer.concat([buffer, Buffer.from(value)])
      for (;;) {
        if (buffer.length < 12) break
        const totalLength = buffer.readUInt32BE(0)
        const headersLength = buffer.readUInt32BE(4)
        if (totalLength < 16 || buffer.length < totalLength) break
        const payloadStart = 12 + headersLength
        const payloadEnd = totalLength - 4
        const payloadText = buffer.subarray(payloadStart, payloadEnd).toString('utf-8')
        buffer = buffer.subarray(totalLength)
        if (payloadText) {
          try {
            yield JSON.parse(payloadText) as Record<string, unknown>
          } catch {
            // Non-JSON frame (e.g. empty payload): ignore
          }
        }
      }
      if (done) break
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      // Already closed: ignore
    }
  }
}

/**
 * Exception frame (the server also places errors in the event stream) → error object
 * (with status so it participates in retry classification).
 */
function errorFromEvent(payload: Record<string, unknown>): Error | null {
  const keys = Object.keys(payload)
  const exceptionKey = keys.find((key) => key.endsWith('Exception'))
  if (!exceptionKey) return null
  const detail = payload[exceptionKey] as Record<string, unknown> | string | undefined
  const message =
    typeof detail === 'string'
      ? detail
      : String((detail as Record<string, unknown> | undefined)?.message ?? exceptionKey)
  const error = new Error(`bedrock ${exceptionKey}: ${message}`)
  const status =
    exceptionKey === 'throttlingException'
      ? 429
      : exceptionKey === 'validationException'
        ? 400
        : /timeout/i.test(exceptionKey)
          ? 408
          : 500
  Object.assign(error, { status })
  return error
}

/** Converse usage → unified usage_metadata (including the Bedrock prompt cache fields) */
function toBedrockUsage(usage: Record<string, unknown>): Record<string, unknown> {
  const input = typeof usage.inputTokens === 'number' ? usage.inputTokens : undefined
  const output = typeof usage.outputTokens === 'number' ? usage.outputTokens : undefined
  const total =
    typeof usage.totalTokens === 'number' ? usage.totalTokens : (input ?? 0) + (output ?? 0)
  const metadata: Record<string, unknown> = {
    input_tokens: input,
    output_tokens: output,
    total_tokens: total
  }
  const cacheRead =
    typeof usage.cacheReadInputTokens === 'number' ? usage.cacheReadInputTokens : undefined
  const cacheWrite =
    typeof usage.cacheWriteInputTokens === 'number' ? usage.cacheWriteInputTokens : undefined
  if (cacheRead != null || cacheWrite != null) {
    metadata.input_token_details = {
      ...(cacheRead != null ? { cache_read: cacheRead } : {}),
      ...(cacheWrite != null ? { cache_creation: cacheWrite } : {})
    }
    if (cacheRead != null) metadata.cache_read_input_tokens = cacheRead
    if (cacheWrite != null) metadata.cache_creation_input_tokens = cacheWrite
  }
  return metadata
}

export class ChatBedrockConverse extends BaseChatModel {
  readonly model: string
  private readonly region: string
  private readonly bearerToken?: string
  private readonly staticCredentials?: StaticCredentials
  private readonly endpointHost: string
  private readonly maxTokens?: number
  private readonly temperature?: number
  private readonly topP?: number
  private readonly stopSequences?: string[]
  private readonly additionalModelRequestFields?: Record<string, unknown>
  private readonly timeoutMs?: number
  private readonly modelKwargs?: Record<string, unknown>
  /** Whether to use streaming (extra_config can disable it explicitly; auto-degrades on failure) */
  private readonly streaming: boolean

  constructor(fields: BedrockFields) {
    super()
    if (!fields?.model) throw new Error('ChatBedrockConverse requires a "model" field')
    this.model = fields.model
    this.region =
      fields.region ?? process.env.AWS_DEFAULT_REGION ?? process.env.AWS_REGION ?? 'us-east-1'
    this.bearerToken =
      fields.bedrockBearerToken ?? fields.apiKey ?? process.env.BEDROCK_AWS_BEARER_TOKEN
    this.staticCredentials = resolveStaticCredentials(fields)
    this.endpointHost = fields.endpointHost
      ? /^https?:\/\//.test(fields.endpointHost)
        ? fields.endpointHost.replace(/\/+$/, '')
        : `https://${fields.endpointHost}`
      : `https://bedrock-runtime.${this.region}.amazonaws.com`
    this.maxTokens = typeof fields.maxTokens === 'number' ? fields.maxTokens : undefined
    this.temperature = typeof fields.temperature === 'number' ? fields.temperature : undefined
    this.topP = typeof fields.topP === 'number' ? fields.topP : undefined
    this.stopSequences = fields.stopSequences
    this.additionalModelRequestFields = fields.additionalModelRequestFields
    this.timeoutMs = typeof fields.timeout === 'number' ? fields.timeout : undefined
    this.modelKwargs = fields.modelKwargs
    this.streaming = fields.streaming !== false
  }

  get provider(): string {
    return 'bedrock'
  }

  private buildBody(
    messages: BaseMessage[],
    tools: StructuredToolInterface[]
  ): Record<string, unknown> {
    const { system, messages: converseMessages } = toBedrockMessages(messages)
    const body: Record<string, unknown> = { messages: converseMessages }
    if (system.length > 0) body.system = system
    const inferenceConfig: Record<string, unknown> = {}
    if (this.maxTokens != null) inferenceConfig.maxTokens = this.maxTokens
    if (this.temperature != null) inferenceConfig.temperature = this.temperature
    if (this.topP != null) inferenceConfig.topP = this.topP
    if (this.stopSequences && this.stopSequences.length > 0) {
      inferenceConfig.stopSequences = this.stopSequences
    }
    if (Object.keys(inferenceConfig).length > 0) body.inferenceConfig = inferenceConfig
    if (tools.length > 0) body.toolConfig = { tools: toBedrockTools(tools) }
    const extraFields = {
      ...(this.additionalModelRequestFields ?? {}),
      ...(this.modelKwargs ?? {})
    }
    if (Object.keys(extraFields).length > 0) body.additionalModelRequestFields = extraFields
    return body
  }

  /** Handle one Converse stream event */
  private handleEvent(
    payload: Record<string, unknown>,
    collector: ModelStreamCollector,
    state: { blockIndexToTool: Map<number, number>; nextToolIndex: number }
  ): boolean {
    const error = errorFromEvent(payload)
    if (error) throw error
    if (payload.messageStart) {
      collector.metadata({ role: 'assistant' })
      return false
    }
    if (payload.contentBlockStart) {
      const event = payload.contentBlockStart as Record<string, unknown>
      const index = typeof event.contentBlockIndex === 'number' ? event.contentBlockIndex : 0
      const start = event.start as Record<string, unknown> | undefined
      const toolUse = start?.toolUse as Record<string, unknown> | undefined
      if (toolUse) {
        const toolIndex = state.nextToolIndex++
        state.blockIndexToTool.set(index, toolIndex)
        collector.toolDelta(toolIndex, {
          id: typeof toolUse.toolUseId === 'string' ? toolUse.toolUseId : undefined,
          name: typeof toolUse.name === 'string' ? toolUse.name : undefined
        })
      }
      return false
    }
    if (payload.contentBlockDelta) {
      const event = payload.contentBlockDelta as Record<string, unknown>
      const index = typeof event.contentBlockIndex === 'number' ? event.contentBlockIndex : 0
      const delta = event.delta as Record<string, unknown> | undefined
      if (!delta) return false
      if (typeof delta.text === 'string') collector.text(delta.text)
      const toolUse = delta.toolUse as Record<string, unknown> | undefined
      if (toolUse && typeof toolUse.input === 'string') {
        const toolIndex = state.blockIndexToTool.get(index)
        if (toolIndex != null) collector.toolDelta(toolIndex, { args: toolUse.input })
      }
      const reasoning = delta.reasoningContent as Record<string, unknown> | undefined
      if (reasoning && typeof reasoning.text === 'string') collector.reasoning(reasoning.text)
      return false
    }
    if (payload.metadata) {
      const metadata = payload.metadata as Record<string, unknown>
      const usage = metadata.usage as Record<string, unknown> | undefined
      if (usage) collector.usage(toBedrockUsage(usage))
      return false
    }
    if (payload.messageStop) {
      const stop = payload.messageStop as Record<string, unknown>
      collector.metadata({ finish_reason: stop.stopReason })
      // Do not finish here: Converse usage arrives in the metadata frame **after** messageStop
      return false
    }
    return false
  }

  /** Non-streaming Converse response (compatible with models / gateways that do not support streaming) */
  private handleFullResponse(
    payload: Record<string, unknown>,
    collector: ModelStreamCollector
  ): void {
    const output = payload.output as Record<string, unknown> | undefined
    const message = output?.message as Record<string, unknown> | undefined
    const content = message?.content
    if (Array.isArray(content)) {
      let toolIndex = 0
      for (const block of content as Array<Record<string, unknown>>) {
        if (typeof block.text === 'string') collector.text(block.text)
        const toolUse = block.toolUse as Record<string, unknown> | undefined
        if (toolUse) {
          collector.toolDelta(toolIndex++, {
            id: typeof toolUse.toolUseId === 'string' ? toolUse.toolUseId : undefined,
            name: typeof toolUse.name === 'string' ? toolUse.name : undefined,
            args: toolUse.input ? JSON.stringify(toolUse.input) : '{}'
          })
        }
        const reasoning = block.reasoningContent as Record<string, unknown> | undefined
        if (reasoning && typeof reasoning.text === 'string') collector.reasoning(reasoning.text)
      }
    }
    const usage = payload.usage as Record<string, unknown> | undefined
    if (usage) collector.usage(toBedrockUsage(usage))
    if (typeof payload.stopReason === 'string') {
      collector.metadata({ finish_reason: payload.stopReason })
    }
  }

  private endpointFor(streaming: boolean): string {
    const method = streaming ? 'converse-stream' : 'converse'
    return `${this.endpointHost}/model/${encodeURIComponent(this.model)}/${method}`
  }

  /** Build request headers (Bearer or SigV4; streaming/non-streaming only affects accept) */
  private buildHeaders(url: string, body: string, streaming: boolean): Record<string, string> {
    const baseHeaders: Record<string, string> = {
      'content-type': 'application/json',
      accept: streaming ? 'application/vnd.amazon.eventstream' : 'application/json'
    }
    if (this.bearerToken) {
      return { ...baseHeaders, authorization: `Bearer ${this.bearerToken}` }
    }
    if (this.staticCredentials) {
      return signSigV4({
        method: 'POST',
        url,
        body,
        service: 'bedrock',
        region: this.region,
        headers: baseHeaders,
        credentials: this.staticCredentials
      })
    }
    throw modelConfigError(
      'Bedrock credentials not found. Set an API key (used as a Bedrock bearer token) or AWS credentials (access key id / secret access key) in the provider settings, or set BEDROCK_AWS_BEARER_TOKEN / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY.'
    )
  }

  /** Non-streaming fallback: Converse `/converse` returns standard JSON (some gateways/models only support non-streaming) */
  private async requestNonStreaming(
    messages: BaseMessage[],
    tools: StructuredToolInterface[],
    options: ModelCallOptions,
    previous?: FallbackSnapshot
  ): Promise<AIMessage> {
    const body = JSON.stringify(this.buildBody(messages, tools))
    const url = this.endpointFor(false)
    const collector = new ModelStreamCollector(options.onModelChunk)
    const response = await httpRequest(url, {
      headers: this.buildHeaders(url, body, false),
      body,
      signal: options.signal,
      timeoutMs: this.timeoutMs
    })
    const text = await safeReadText(response)
    collector.recordRaw(text)
    const contentType = response.headers.get('content-type') ?? ''
    const payload = tryParseBedrockJson(text)
    if (payload) {
      if (!payload.output && (payload.message || payload.Message || payload.__type)) {
        throw providerPayloadError('bedrock', payload, text)
      }
      this.handleFullResponse(payload, collector)
    }
    const message = collector.finalizeOrThrow({
      provider: this.provider,
      model: this.model,
      status: inferStatusFromErrorPayload(payload),
      contentType,
      previous
    })
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
    const body = JSON.stringify(this.buildBody(messages, tools))
    const url = this.endpointFor(true)
    const collector = new ModelStreamCollector(options.onModelChunk)
    let response: Response
    try {
      response = await httpRequest(url, {
        headers: this.buildHeaders(url, body, true),
        body,
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
      const payload = tryParseBedrockJson(text)
      if (payload) {
        if (!payload.output && (payload.message || payload.Message || payload.__type)) {
          throw providerPayloadError('bedrock', payload, text)
        }
        this.handleFullResponse(payload, collector)
      }
      const message = collector.finalize()
      if (hasMeaningfulOutput(message)) return message
      return await this.requestNonStreaming(messages, tools, options, collector.fallbackSnapshot())
    }
    const state = { blockIndexToTool: new Map<number, number>(), nextToolIndex: 0 }
    try {
      for await (const payload of parseAwsEventStream(response, options.signal)) {
        collector.recordRaw(JSON.stringify(payload))
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
    const streamed = collector.finalize()
    if (hasMeaningfulOutput(streamed)) return streamed
    return await this.requestNonStreaming(messages, tools, options, collector.fallbackSnapshot())
  }
}

/** Leniently parse a JSON response body (non-streaming fallback / gateway ignoring stream; undefined on failure) */
function tryParseBedrockJson(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    return undefined
  }
  return undefined
}

/** Resolve static credentials (explicit fields → Bedrock-specific env vars → standard AWS env vars) */
function resolveStaticCredentials(fields: BedrockFields): StaticCredentials | undefined {
  if (fields.credentials?.accessKeyId && fields.credentials.secretAccessKey) {
    return fields.credentials
  }
  const apiKey = fields.bedrockApiKey ?? process.env.BEDROCK_AWS_ACCESS_KEY_ID
  const apiSecret = fields.bedrockApiSecret ?? process.env.BEDROCK_AWS_SECRET_ACCESS_KEY
  const sessionToken = fields.bedrockApiSessionToken ?? process.env.BEDROCK_AWS_SESSION_TOKEN
  if (apiKey && apiSecret) {
    return { accessKeyId: apiKey, secretAccessKey: apiSecret, sessionToken }
  }
  const envKey = process.env.AWS_ACCESS_KEY_ID
  const envSecret = process.env.AWS_SECRET_ACCESS_KEY
  if (envKey && envSecret) {
    return {
      accessKeyId: envKey,
      secretAccessKey: envSecret,
      sessionToken: process.env.AWS_SESSION_TOKEN
    }
  }
  return undefined
}
