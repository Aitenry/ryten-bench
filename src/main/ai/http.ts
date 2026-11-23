/**
 * 自研供应商 HTTP 基础设施（替代各家 SDK 的传输层）。
 *
 * 只保留项目真正需要的部分：
 * - `fetch` 发请求（Electron 主进程 = Node 22，自带全局 fetch）；
 * - 非 2xx 统一抛 `ModelHttpError`（带 `.status`，供 model-recovery 按状态码分类重试）；
 * - SSE / NDJSON 两种流式解析（OpenAI 兼容族 / Anthropic / Gemini / Ollama 各用其一）。
 */

/** 供应商 HTTP 错误：保留状态码与响应体片段（分类与排障都要用） */
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

/** 网络层失败（连接被拒 / DNS / TLS）：没有状态码，按可重试的网络错误处理 */
export class ModelNetworkError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'ModelNetworkError'
    this.cause = cause
  }
}

/** 诊断用的响应片段长度上限（够看到网关错误页/限流报文，又不会把整段 HTML 塞进聊天） */
const RAW_SNIPPET_LIMIT = 800

function truncate(text: string, limit = RAW_SNIPPET_LIMIT): string {
  const trimmed = text.trim()
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed
}

/** 空响应上下文：供应商 / 模型 / finish_reason / 原始响应片段 */
export interface EmptyResponseContext {
  provider: string
  model: string
  /** 从供应商错误报文里解析出的状态码（没有就不带，交给上层按可重试的网络错误分类） */
  status?: number
  finishReason?: string
  /** 原始响应片段（空响应时用来定位服务商到底返回了什么） */
  raw?: string
  contentType?: string
  /** 只产出了推理 / 思考内容，没有最终答复 */
  reasoningOnly?: boolean
  /** 工具调用参数无法解析的数量 */
  invalidToolCalls?: number
}

/**
 * 模型调用成功返回（HTTP 2xx / 流正常结束）但**没有任何可用输出**：
 * 没有正文、没有工具调用。
 *
 * 为什么需要这个错误：不少网关会把限流、鉴权失败、上游 5xx 错误页用 HTTP 200
 * 返回（或直接回一个空流）。如果只是静默返回空消息，用户只会看到「模型未返回任何内容」，
 * 看不到服务商真实返回的报文，排查无从下手。这里把供应商、模型、finish_reason 与
 * 原始响应片段一并抛出，方便直接定位。
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

/** 结构化错误码 → HTTP 状态码（只认显式 code/type，不做报文关键字猜测） */
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
 * 从 HTTP 200 的错误报文里解析状态码：
 * 只读结构化的 status / statusCode / code / type（含嵌套 `error` 与 `errors[]`），
 * 不根据自由文本猜——与 model-recovery「只看状态码」的原则一致。
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

/** 从错误报文里取出可读信息（OpenAI / Anthropic / Cloudflare / 通用网关都兜住） */
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
 * 供应商在 HTTP 200 里回了一个错误对象（最常见的「空响应」来源）：
 * 抛出带服务商原文与状态码的错误，而不是继续解析成空消息。
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
 * 流式调用失败/为空后，是否值得再用「非流式」请求试一次。
 *
 * 背景：Spring AI 等客户端默认发 `stream: false`，所以流式实现有问题、非流式正常的网关
 * 在它们那里能正常工作。这里对同类情况做自动降级，避免因为网关的流式缺陷直接判失败。
 *
 * 不重试的情况：用户取消、网络层失败（换非流式也一样连不上）、服务商明确报错
 * （鉴权/限流/请求被拒——换形态也解决不了）。
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
  // 网关不支持流式参数时常见的状态码；404（端点不存在）/401/403/429/5xx 不在此列
  if (err instanceof ModelHttpError) return [400, 405, 415, 422, 501].includes(err.status)
  // 带状态码的错误是服务商/协议层明确拒绝（限流、鉴权、过载…），换请求形态解决不了
  if (typeof candidate?.status === 'number') return false
  // 协议/解析类错误（invalid JSON、流式事件解析失败等）值得换一种请求形态
  return true
}

/**
 * 配置类错误（缺 API Key / 缺 region 等）：挂 status=401，
 * 让 model-recovery 按「鉴权错误」直接报错，不做无意义的重试。
 */
export function modelConfigError(message: string): Error {
  const error = new Error(message)
  error.name = 'ModelConfigError'
  Object.assign(error, { status: 401 })
  return error
}

/** 是否为取消（用户点停止 / 图被中断） */
export function isAbortError(err: unknown): boolean {
  const candidate = err as { name?: string; code?: string } | null
  return candidate?.name === 'AbortError' || candidate?.code === 'ABORT_ERR'
}

/** 是否为超时（AbortSignal.timeout 触发的 DOMException） */
function isTimeoutError(err: unknown): boolean {
  const candidate = err as { name?: string } | null
  return candidate?.name === 'TimeoutError'
}

export interface HttpRequestOptions {
  method?: string
  headers?: Record<string, string>
  /** 已序列化好的请求体（字符串） */
  body?: string
  signal?: AbortSignal
  /** 乐观超时（毫秒）；不传则只受 signal 控制 */
  timeoutMs?: number
}

/**
 * 发一次 HTTP 请求并保证 2xx；失败时抛出带状态码的错误。
 *
 * 注意：超时用 `AbortSignal.any` 与原 signal 合并——超时与用户取消的语义不同，
 * 超时包装成网络错误（可重试），用户取消保持 AbortError（上层静默收尾）。
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

/** 读取响应体文本（失败不抛错） */
export async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

/** SSE 事件（`event:` 可缺省；`data:` 多行按规范用换行拼接） */
export interface SseEvent {
  event?: string
  data: string
}

/**
 * 解析 SSE 流。
 * 只支持项目实际用到的子集：`data:` / `event:` / 注释行 / 空行分派。
 *
 * `onRawChunk` 会把解码后的原始片段交给调用方（诊断空响应用：服务商可能回 HTML 错误页）。
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
   * 取下一行：同时兼容 `\n`、`\r\n` 和单独的 `\r`（SSE 规范允许三种行结束符，
   * 少数网关只发 `\r`；只按 `\n` 切会把整个流当成一行，最终解析不到任何事件）。
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
    // 非标准但常见的形态：网关直接按行发裸 JSON（NDJSON），没有 `data:` 前缀
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
    // 流结束时处理最后一段没有换行符的内容（部分实现末尾没有空行）
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
      // 已关闭：忽略
    }
  }
}

/**
 * 解析 NDJSON 流（Ollama 的 `/api/chat`）。
 * 每行一个 JSON；空行与解析失败行直接跳过（上游可能夹带心跳文本）。
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
            // 非 JSON 行：忽略
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
        // 忽略
      }
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      // 已关闭：忽略
    }
  }
}

/** URL 拼接：base 末尾斜杠不敏感（`https://api.deepseek.com` + `chat/completions`） */
export function joinUrl(base: string, path: string): string {
  const left = base.endsWith('/') ? base.slice(0, -1) : base
  const right = path.startsWith('/') ? path.slice(1) : path
  return `${left}/${right}`
}
