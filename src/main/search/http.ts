/**
 * 搜索适配器共用的 HTTP 小工具：超时、状态码分类、JSON 解析、错误归一化。
 *
 * 约定：**不抛异常**，所有失败都返回结构化 code，由 registry/工具层翻译成界面文案。
 */
import type { SearchErrorCode } from './types'
import { SEARCH_TIMEOUT_MS } from './types'

export type HttpResult =
  | { ok: true; status: number; text: string; json: unknown }
  | { ok: false; code: SearchErrorCode; message: string; status?: number }

/** 按响应状态码归类 */
function codeForStatus(status: number): SearchErrorCode {
  if (status === 401 || status === 403) return 'unauthorized'
  if (status === 429) return 'rate-limited'
  return status >= 500 ? 'provider-error' : 'invalid-response'
}

/**
 * 发一个 JSON POST（`apiKey` 以 Bearer 头发送；也可以把 key 放 body，由调用方决定）。
 *
 * - 10s 超时；
 * - 响应文本上限 2MB；
 * - 非 2xx → 按状态码归类；2xx 但 JSON 解析失败 → invalid-response。
 */
export async function postJson(
  url: string,
  options: {
    body: Record<string, unknown>
    apiKey?: string
    timeoutMs?: number
    extraHeaders?: Record<string, string>
  }
): Promise<HttpResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? SEARCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
        ...(options.extraHeaders ?? {})
      },
      body: JSON.stringify(options.body),
      signal: controller.signal
    })
    const text = await response.text()
    if (!response.ok) {
      return {
        ok: false,
        code: codeForStatus(response.status),
        message: text.slice(0, 500) || `HTTP ${response.status}`,
        status: response.status
      }
    }
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      return { ok: false, code: 'invalid-response', message: 'response is not valid JSON' }
    }
    return { ok: true, status: response.status, text, json }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const aborted = controller.signal.aborted || /abort/i.test(message)
    return { ok: false, code: aborted ? 'timeout' : 'network', message }
  } finally {
    clearTimeout(timer)
  }
}
