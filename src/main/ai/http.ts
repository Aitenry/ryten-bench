/**
 * Self-contained provider HTTP infrastructure.
 *
 * Only the parts the project actually needs are kept:
 * - `fetch` sends requests (the Electron main process is Node 22, which ships a global fetch);
 * - non-2xx responses uniformly throw `ModelHttpError` (with `.status`, so model-recovery can
 *   classify and retry by status code);
 * - two streaming parsers, SSE / NDJSON (the OpenAI-compatible family / Anthropic / Gemini /
 *   Ollama each use one).
 */

/** Provider HTTP error: keeps the status code and a response body excerpt (needed for classification and troubleshooting alike) */
export class ModelHttpError extends Error {
  readonly status: number
  readonly bodyText: string

  constructor(status: number, statusText: string, bodyText: string) {
    const excerpt = bodyText.length > 2000 ? `${bodyText.slice(0, 2000)}…` : bodyText
    super(
      `HTTP ${status}${statusText ? ` ${statusText}` : ''}: ${excerpt || '(empty response body)'}`
    )
    this.name = 'ModelHttpError'
    this.status = status
    this.bodyText = bodyText
  }
}

/** Network-layer failure (connection refused / DNS / TLS): no status code, treated as a retryable network error */
export class ModelNetworkError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'ModelNetworkError'
    this.cause = cause
  }
}

/** Response excerpt length limit for diagnostics (enough to see gateway error pages/rate-limit payloads without stuffing an entire HTML page into the chat) */
const RAW_SNIPPET_LIMIT = 800

function truncate(text: string, limit = RAW_SNIPPET_LIMIT): string {
  const trimmed = text.trim()
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed
}

/** Empty-response context: provider / model / finish_reason / raw response excerpt */
export interface EmptyResponseContext {
  provider: string
  model: string
  /** Status code parsed from the provider error payload (omitted when absent; the upper layer then classifies it as a retryable network error) */
  status?: number
  finishReason?: string
  /** Raw response excerpt (used to pin down what the service actually returned on an empty response) */
  raw?: string
  contentType?: string
  /** Only reasoning / thinking content was produced, with no final answer */
  reasoningOnly?: boolean
  /** Number of tool calls whose arguments could not be parsed */
  invalidToolCalls?: number
}

/**
 * The model call returned successfully (HTTP 2xx / stream ended normally) but produced **no usable
 * output at all**: no text and no tool calls.
 *
 * Why this error exists: many gateways return rate limits, authentication failures and upstream 5xx
 * error pages with HTTP 200 (or simply return an empty stream). Silently returning an empty message
 * would only show the user "the model returned no content", hiding what the service actually
 * returned and leaving nothing to troubleshoot. This throws the provider, model, finish_reason and
 * the raw response excerpt together so the cause can be located directly.
 */
export class ModelEmptyResponseError extends Error {
  readonly provider: string
  readonly model: string
  readonly status?: number
  readonly raw?: string
  readonly finishReason?: string
  readonly reasoningOnly?: boolean
  readonly contentType?: string

  constructor(context: EmptyResponseContext) {
    super(formatEmptyResponseMessage(context))
    this.name = 'ModelEmptyResponseError'
    this.provider = context.provider
    this.model = context.model
    this.status = context.status
    this.raw = context.raw
    this.finishReason = context.finishReason
    this.reasoningOnly = context.reasoningOnly
    this.contentType = context.contentType
  }
}

function formatEmptyResponseMessage(context: EmptyResponseContext): string {
  const finish = context.finishReason ? ` (finish_reason=${context.finishReason})` : ''
  const parts = [
    `${context.provider} returned an empty chat response for model "${context.model}"${finish}: ` +
      'no text content and no tool calls were returned.',
    'This usually means the provider or an upstream gateway rejected the request ' +
      '(rate limit, authentication, overloaded upstream, or an HTML error page) while still returning a 2xx success status, ' +
      'or that the streaming response ended prematurely.'
  ]
  if (context.contentType) parts.push(`Response content-type: ${context.contentType}.`)
  if (context.reasoningOnly) {
    parts.push('Only reasoning/thinking content was produced; no final answer was returned.')
  }
  if (context.invalidToolCalls) {
    parts.push(
      `${context.invalidToolCalls} tool call(s) were emitted but their arguments could not be parsed.`
    )
  }
  if (context.raw) {
    parts.push(`Raw response (truncated): ${truncate(context.raw)}`)
  } else {
    parts.push('The provider returned no parsable payload at all (empty stream/body).')
  }
  return parts.join(' ')
}

/** Structured error code → HTTP status code (only explicit code/type, no guessing from payload keywords) */
function mapErrorCodeToStatus(code: string): number | undefined {
  const normalized = code.trim().toLowerCase()
  if (!normalized) return undefined
  if (/overloaded/.test(normalized)) return 529
  if (/rate.?limit|too.?many|throttl|quota|resource.?exhausted|usage.?limit/.test(normalized)) {
    return 429
  }
  if (/auth|api.?key|unauthor|invalid.?token|token.?invalid/.test(normalized)) return 401
  if (/permission|forbidden/.test(normalized)) return 403
  if (/not.?found|does.?not.?exist|model.?missing|unknown.?model/.test(normalized)) return 404
  if (/timeout|deadline/.test(normalized)) return 408
  if (
    /invalid.?request|bad.?request|validation|context.?length|too.?long|unsupported/.test(
      normalized
    )
  ) {
    return 400
  }
  if (/server|internal|unavailable|api.?error/.test(normalized)) return 500
  return undefined
}

/**
 * Parse a status code out of an error payload returned with HTTP 200:
 * only reads structured status / statusCode / code / type (including nested `error` and `errors[]`),
 * never guessing from free text — consistent with model-recovery's "status code only" principle.
 */
export function inferStatusFromErrorPayload(payload: unknown): number | undefined {
  const seen = new Set<unknown>()
  const codes: unknown[] = []
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object' || seen.has(value)) return
    seen.add(value)
    const record = value as Record<string, unknown>
    codes.push(record.status, record.statusCode, record.code, record.type)
    visit(record.error)
    visit(record.response)
    if (Array.isArray(record.errors)) {
      for (const item of record.errors) visit(item)
    }
  }
  visit(payload)
  for (const code of codes) {
    if (typeof code === 'number' && code >= 400 && code <= 599) return code
    if (typeof code === 'string') {
      if (/^[45]\d{2}$/.test(code.trim())) return Number(code.trim())
      const mapped = mapErrorCodeToStatus(code)
      if (mapped) return mapped
    }
  }
  return undefined
}

/** Extract a readable message from an error payload (covers OpenAI / Anthropic / Cloudflare / generic gateways) */
export function extractProviderErrorMessage(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const record = payload as Record<string, unknown>
  const error = record.error
  if (error && typeof error === 'object') {
    const nested = error as Record<string, unknown>
    if (typeof nested.message === 'string' && nested.message.trim()) return nested.message.trim()
    if (typeof nested.type === 'string' && nested.type.trim()) return nested.type.trim()
  }
  if (typeof error === 'string' && error.trim()) return error.trim()
  if (Array.isArray(record.errors)) {
    for (const item of record.errors) {
      const message = extractProviderErrorMessage(item)
      if (message) return message
    }
  }
  for (const key of ['message', 'detail', 'msg', 'reason']) {
    if (typeof record[key] === 'string' && (record[key] as string).trim()) {
      return (record[key] as string).trim()
    }
  }
  return ''
}

/**
 * The provider returned an error object inside HTTP 200 (the most common source of "empty
 * responses"): throw an error carrying the provider's original text and status code instead of
 * continuing to parse it into an empty message.
 */
export function providerPayloadError(
  provider: string,
  payload: unknown,
  raw?: string,
  statusOverride?: number
): Error {
  const status = statusOverride ?? inferStatusFromErrorPayload(payload)
  const detail = extractProviderErrorMessage(payload) || 'unknown provider error'
  const snippet = raw ? truncate(raw) : JSON.stringify(payload).slice(0, RAW_SNIPPET_LIMIT)
  const error = new Error(
    `${provider} API returned an error${status ? ` (HTTP ${status})` : ''}: ${detail}` +
      (snippet ? ` | raw response: ${snippet}` : '')
  )
  error.name = 'ModelProviderError'
  if (status != null) Object.assign(error, { status })
  return error
}

/**
 * After a streaming call fails or yields nothing, whether it is worth retrying once with a
 * non-streaming request.
 *
 * Background: many clients default to `stream: false`, so gateways with a broken streaming
 * implementation but working non-streaming behavior serve them fine. The same situation is
 * degraded automatically here, so a gateway's streaming defect doesn't fail the call outright.
 *
 * Not retried: user cancellation, network-layer failures (a non-streaming request can't connect
 * either), and explicit provider errors (auth/rate limit/request rejected — changing the request
 * shape won't help).
 */
export function shouldTryNonStreamingFallback(err: unknown): boolean {
  const candidate = err as { name?: string; status?: unknown } | undefined
  if (
    candidate?.name === 'AbortError' ||
    candidate?.name === 'ModelNetworkError' ||
    candidate?.name === 'ModelProviderError'
  ) {
    return false
  }
  // Common status codes for gateways that don't support the streaming parameter; 404 (endpoint missing) / 401 / 403 / 429 / 5xx are excluded
  if (err instanceof ModelHttpError) return [400, 405, 415, 422, 501].includes(err.status)
  // Errors carrying a status code are explicit rejections by the provider/protocol layer (rate limit, auth, overload…); changing the request shape won't fix them
  if (typeof candidate?.status === 'number') return false
  // Protocol/parsing errors (invalid JSON, streaming event parse failures, etc.) are worth trying with a different request shape
  return true
}

/**
 * Configuration errors (missing API key / missing region, etc.): tag them with status=401 so
 * model-recovery reports them directly as auth errors and doesn't retry pointlessly.
 */
export function modelConfigError(message: string): Error {
  const error = new Error(message)
  error.name = 'ModelConfigError'
  Object.assign(error, { status: 401 })
  return error
}

/** Whether it is a cancellation (user clicked stop / graph was interrupted) */
export function isAbortError(err: unknown): boolean {
  const candidate = err as { name?: string; code?: string } | null
  return candidate?.name === 'AbortError' || candidate?.code === 'ABORT_ERR'
}

/** Whether it is a timeout (a DOMException triggered by AbortSignal.timeout) */
function isTimeoutError(err: unknown): boolean {
  const candidate = err as { name?: string } | null
  return candidate?.name === 'TimeoutError'
}

export interface HttpRequestOptions {
  method?: string
  headers?: Record<string, string>
  /** Already-serialized request body (string) */
  body?: string
  signal?: AbortSignal
  /** Optimistic timeout (ms); when omitted, only signal controls it */
  timeoutMs?: number
}

/**
 * Send one HTTP request and ensure 2xx; on failure throws an error carrying the status code.
 *
 * Note: the timeout is merged with the original signal via `AbortSignal.any` — timeouts and user
 * cancellation have different semantics; timeouts are wrapped as network errors (retryable) while
 * user cancellation stays AbortError (the upper layer finishes silently).
 */
export async function httpRequest(url: string, options: HttpRequestOptions): Promise<Response> {
  const signals: AbortSignal[] = []
  if (options.signal) signals.push(options.signal)
  const timeoutMs = options.timeoutMs
  if (timeoutMs && timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs))
  const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0]

  let response: Response
  try {
    response = await fetch(url, {
      method: options.method ?? 'POST',
      headers: options.headers,
      body: options.body,
      signal
    })
  } catch (err) {
    if (isAbortError(err)) throw err
    if (isTimeoutError(err)) {
      throw new ModelNetworkError(`Request timed out after ${timeoutMs} ms`)
    }
    const message = err instanceof Error ? err.message : String(err)
    const cause = (err as { cause?: unknown }).cause
    const causeText =
      cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : undefined
    throw new ModelNetworkError(
      `Network request failed: ${message}${causeText ? ` (${causeText})` : ''}`,
      err
    )
  }

  if (!response.ok) {
    const bodyText = await safeReadText(response)
    throw new ModelHttpError(response.status, response.statusText, bodyText)
  }
  return response
}

/** Read the response body text (doesn't throw on failure) */
export async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

/** SSE event (`event:` may be absent; multi-line `data:` is joined with newlines per the spec) */
export interface SseEvent {
  event?: string
  data: string
}

/**
 * Parse an SSE stream.
 * Only the subset the project actually uses is supported: `data:` / `event:` / comment lines /
 * blank-line dispatch.
 *
 * `onRawChunk` hands the decoded raw fragment to the caller (for empty-response diagnostics: the
 * service may return an HTML error page).
 */
export async function* parseSseStream(
  response: Response,
  signal?: AbortSignal,
  onRawChunk?: (text: string) => void
): AsyncGenerator<SseEvent> {
  if (!response.body) throw new ModelNetworkError('Response has no body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventName: string | undefined
  let dataLines: string[] = []
  let bomStripped = false

  const dispatch = (): SseEvent | undefined => {
    if (dataLines.length === 0) {
      eventName = undefined
      return undefined
    }
    const event: SseEvent = {
      event: eventName,
      data: dataLines.join('\n')
    }
    eventName = undefined
    dataLines = []
    return event
  }

  /**
   * Take the next line: supports `\n`, `\r\n` and a lone `\r` (the SSE spec allows three line
   * terminators, and a few gateways only send `\r`; splitting on `\n` alone would treat the whole
   * stream as one line and ultimately parse no events).
   */
  const takeLine = (): string | undefined => {
    const lf = buffer.indexOf('\n')
    const cr = buffer.indexOf('\r')
    if (lf < 0 && cr < 0) return undefined
    if (cr >= 0 && (lf < 0 || cr < lf)) {
      const line = buffer.slice(0, cr)
      buffer = buffer.slice(cr + (buffer[cr + 1] === '\n' ? 2 : 1))
      return line
    }
    const line = buffer.slice(0, lf)
    buffer = buffer.slice(lf + 1)
    return line
  }

  const processLine = (line: string): SseEvent | undefined => {
    if (line === '') return dispatch()
    if (line.startsWith(':')) return undefined
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''))
      return undefined
    }
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim()
      return undefined
    }
    // Non-standard but common: the gateway sends bare JSON line by line (NDJSON) without the `data:` prefix
    if (line.startsWith('{') || line.startsWith('[')) {
      dataLines.push(line)
      return dispatch()
    }
    return undefined
  }

  try {
    for (;;) {
      if (signal?.aborted) {
        const err = new Error('Model stream aborted')
        err.name = 'AbortError'
        throw err
      }
      const { done, value } = await reader.read()
      const decoded = decoder.decode(value ?? new Uint8Array(), { stream: !done })
      if (decoded) onRawChunk?.(decoded)
      buffer += decoded
      if (!bomStripped && buffer) {
        bomStripped = true
        if (buffer.charCodeAt(0) === 0xfeff) buffer = buffer.slice(1)
      }
      let line = takeLine()
      while (line !== undefined) {
        const event = processLine(line)
        if (event) yield event
        line = takeLine()
      }
      if (done) break
    }
    // At end of stream, handle the final fragment that has no newline (some implementations end without a blank line)
    if (buffer.length > 0) {
      const event = processLine(buffer)
      buffer = ''
      if (event) yield event
    }
    const tail = dispatch()
    if (tail) yield tail
  } finally {
    try {
      await reader.cancel()
    } catch {
      // already closed: ignore
    }
  }
}

/**
 * Parse an NDJSON stream (Ollama's `/api/chat`).
 * One JSON per line; blank lines and lines that fail to parse are skipped (upstream may interleave
 * heartbeat text).
 */
export async function* parseJsonLinesStream(
  response: Response,
  signal?: AbortSignal,
  onRawChunk?: (text: string) => void
): AsyncGenerator<unknown> {
  if (!response.body) throw new ModelNetworkError('Response has no body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      if (signal?.aborted) {
        const err = new Error('Model stream aborted')
        err.name = 'AbortError'
        throw err
      }
      const { done, value } = await reader.read()
      const decoded = decoder.decode(value ?? new Uint8Array(), { stream: !done })
      if (decoded) onRawChunk?.(decoded)
      buffer += decoded
      let lineEnd = buffer.indexOf('\n')
      while (lineEnd >= 0) {
        const line = buffer.slice(0, lineEnd).trim()
        buffer = buffer.slice(lineEnd + 1)
        if (line) {
          try {
            yield JSON.parse(line) as unknown
          } catch {
            // non-JSON line: ignore
          }
        }
        lineEnd = buffer.indexOf('\n')
      }
      if (done) break
    }
    const tail = buffer.trim()
    if (tail) {
      try {
        yield JSON.parse(tail) as unknown
      } catch {
        // ignore
      }
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      // already closed: ignore
    }
  }
}

/** URL joining: insensitive to a trailing slash on base (`https://api.deepseek.com` + `chat/completions`) */
export function joinUrl(base: string, path: string): string {
  const left = base.endsWith('/') ? base.slice(0, -1) : base
  const right = path.startsWith('/') ? path.slice(1) : path
  return `${left}/${right}`
}
