/**
 * ChatModel implementation of the OpenAI-compatible protocol (`POST {baseURL}/chat/completions` +
 * SSE).
 *
 * Covers OpenAI / DeepSeek / xAI / OpenRouter / Mistral and "custom OpenAI-compatible endpoints"
 * in one place: differences are only the baseURL, the API key env var name, and a few headers;
 * the protocol itself is identical.
 *
 * Behavior follows the project's existing conventions:
 * - `invoke()` performs a streaming request internally (token-by-token callbacks; safe when the
 *   caller passes no callback);
 * - no built-in retries (the retry budget belongs to harness/model-recovery);
 * - non-2xx responses throw `ModelHttpError(status)`; the upper layer handles them by status code.
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

/** Provider construction fields (field names kept for compatibility; `...extra` lets user-defined fields pass straight through to the request body) */
export interface OpenAICompatibleFields {
  model?: string
  apiKey?: string
  /** OpenAI SDK style configuration object */
  configuration?: {
    baseURL?: string
    defaultHeaders?: Record<string, string>
    [key: string]: unknown
  }
  /** Supply baseURL directly */
  baseURL?: string
  baseUrl?: string
  defaultHeaders?: Record<string, string>
  /** Output limit; -1 means unlimited */
  maxTokens?: number
  temperature?: number
  topP?: number
  stop?: string | string[]
  /** Whether to request usage (some gateways do not understand stream_options and drop it automatically) */
  streamUsage?: boolean
  /** Request timeout (milliseconds; unset by default) */
  timeout?: number
  /** Extra parameters merged directly into the request body (thinking / reasoning level, etc.) */
  modelKwargs?: Record<string, unknown>
  organization?: string
  [key: string]: unknown
}

/** Field names passed straight through to the request body (common OpenAI parameters in user extra_config) */
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

/** 4xx statuses commonly seen when a gateway "does not support streaming" (equivalent error codes inside HTTP 200 also use this set) */
const STREAM_INCOMPATIBLE_STATUSES = new Set([400, 405, 415, 422, 501])

/** OpenAI-compatible ChatModel base class */
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
   * Whether streaming requests are used.
   * The service layer defaults to true; when the user explicitly sets `streaming: false` in
   * extra_config, non-streaming is used directly (some self-hosted gateways only implement the
   * non-streaming semantics of /chat/completions).
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

  /** Provider default baseURL (overridden by subclasses) */
  protected get defaultBaseURL(): string {
    return 'https://api.openai.com/v1'
  }

  /** API key env var names (the first non-empty one wins) */
  protected get apiKeyEnvNames(): string[] {
    return ['OPENAI_API_KEY']
  }

  /** Provider protocol name (for logging) */
  get provider(): string {
    return 'openai'
  }

  /** Extra request headers (OpenRouter site attribution, etc.) */
  protected extraHeaders(): Record<string, string> {
    return {}
  }

  /** Message conversion (overridden by subclasses such as Mistral that need to rewrite ids) */
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

  /** Whether this is a reasoning model (o series / gpt-5: use max_completion_tokens, and no temperature/top_p support) */
  protected isReasoningModel(): boolean {
    return /^(o\d|gpt-5)/i.test(this.model)
  }

  /**
   * Assemble the request body.
   *
   * `compatibility=true` produces a "minimal request body": only standard fields, dropping
   * `stream_options`, `modelKwargs` (thinking / reasoning_effort / enable_thinking…) and
   * extra_config passthrough fields. Used for the compatibility retry when a gateway returns 400
   * explicitly rejecting these optional parameters (the standard-field-only request shape).
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

  /** Request headers (Accept is application/json for the non-streaming fallback; some gateways decide the response shape from it) */
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
   * Handle one streaming chunk (`choices[0].delta`); also supports non-streaming `choices[0].message`.
   */
  protected handleChunk(payload: Record<string, unknown>, collector: ModelStreamCollector): void {
    const usage = payload.usage
    if (usage && typeof usage === 'object') {
      collector.usage(normalizeUsage(usage as Record<string, unknown>))
    }
    if (typeof payload.model === 'string') collector.metadata({ model_name: payload.model })
    const choices = payload.choices
    if (!Array.isArray(choices) || choices.length === 0) {
      // Some gateways put top-level content/response directly in the stream (no choices wrapper)
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
    // Also accept the completion style (choices[0].text)
    if (typeof choice.text === 'string') collector.text(choice.text)
    const delta = (choice.delta ?? choice.message) as Record<string, unknown> | undefined
    if (!delta) return

    // Model refusal (OpenAI's refusal field): show it as text so it is not treated as an "empty response"
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
    // Some gateways use delta.text instead of delta.content
    if (typeof delta.text === 'string') collector.text(delta.text)

    // DeepSeek / vLLM use reasoning_content; OpenRouter uses reasoning (may be a string or an object)
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
    // Legacy function_call streaming shape (no id): treat it as the first tool
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

  /** Find the first error object in a response value (handles both objects and arrays) */
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

  /** Parse JSON text (does not throw on failure) */
  private static tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
    try {
      return { ok: true, value: JSON.parse(text) as unknown }
    } catch {
      return { ok: false }
    }
  }

  /** Consume one complete response value (handles objects / arrays / multiple choices) */
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
   * Consume a "non-streaming" response text: whole-package JSON / JSON array / SSE / NDJSON are
   * all accepted.
   * Returns the status code parsed from an error payload (undefined for a normal response).
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
    // Accept SSE / NDJSON mislabeled as JSON: parse line by line
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
   * Non-streaming request (the default `stream: false` call style).
   *
   * Used both when the user explicitly sets `streaming: false` and as a fallback when the streaming
   * response is empty/corrupt. Once the whole JSON package is received it is parsed by the same
   * aggregator, so tool calls / reasoning content / usage are identical to the streaming path.
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
    // When the gateway rejects optional parameters (400/422), retry once with a minimal request body
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

  /** Marker after a successful compatibility retry (for diagnostics only, does not affect the UI) */
  private withCompatibilityNote(message: AIMessage, used: boolean): AIMessage {
    if (used) {
      message.response_metadata = {
        ...message.response_metadata,
        compatibility: 'minimal-request'
      }
    }
    return message
  }

  /** Perform one complete streaming attempt on the given endpoint (automatically switches to non-streaming on an empty stream / protocol error) */
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
        // The gateway rejects optional parameters (thinking / reasoning_effort / stream_options /
        // passthrough fields): retry once with a minimal request body to avoid failing outright
        if (!usedCompatibility && isParameterCompatibilityError(err)) {
          usedCompatibility = true
          body = this.buildBody(messages, tools, true, true)
          continue
        }
        // The gateway rejects streaming parameters outright (400/405/…): retry non-streaming
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
      // Support gateways that return a whole JSON package despite stream=true
      const text = await safeReadText(response)
      const parsed = OpenAICompatibleChatModel.tryParseJson(text)
      if (parsed.ok) {
        const errorPayload = this.findErrorPayload(parsed.value)
        if (errorPayload) {
          const status = inferStatusFromErrorPayload(errorPayload)
          // The gateway wraps "streaming not supported" in an HTTP 200 error body: switching to non-streaming usually succeeds
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
      // Whole JSON package but no content at all: possibly a gateway hiccup, fall back to one non-streaming request
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
        // A single event may contain: one JSON, one JSON array, or multiple lines of JSON (all accepted)
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
            // Do not replay in another shape once content has streamed (to avoid duplicates); only fall back when the error code looks like "streaming not supported"
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
    // Empty stream (typical symptom of a gateway's broken streaming implementation): automatically continue non-streaming instead of failing outright
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

/** Only retry with a minimal request body on 400/422 whose payload explicitly points to unknown/unsupported optional parameters */
function isParameterCompatibilityError(err: unknown): boolean {
  if (!(err instanceof ModelHttpError) || ![400, 422].includes(err.status)) return false
  return /stream[_-]?options|thinking|reasoning|top[_-]?k|unknown|unsupported|not supported|unrecognized|extra (fields|inputs)|additional propert|invalid (parameter|field)/i.test(
    err.bodyText
  )
}

/**
 * Candidate chat completions endpoints.
 *
 * One convention appends `/chat/completions` directly after baseURL (baseURL usually includes
 * `/v1`); another treats baseURL as the service root and always appends `/v1/chat/completions`.
 * Both configurations must work:
 * - baseURL already has a version segment (/v1, /v2beta…) → append only `/chat/completions`;
 * - baseURL is a bare domain (no path) → try `/v1/chat/completions` first, then fall back to
 *   `/chat/completions`;
 * - baseURL has a custom path (/api, /openai…) → append according to the original semantics first,
 *   then fall back to the `/v1` form.
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

/** Whether this error may be only "wrong endpoint path" (worth retrying with another candidate path) */
function isEndpointMismatchError(err: unknown): boolean {
  if (err instanceof ModelHttpError) return [404, 405, 415, 501].includes(err.status)
  // An empty response may also be HTML / an empty body returned by a wrong path (HTTP 200)
  return err instanceof ModelEmptyResponseError
}

/** Merge diagnostics when both endpoints fail (keeping the raw payloads / error messages from both sides) */
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

/** OpenAI (official API) */
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
