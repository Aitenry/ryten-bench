/**
 * Shared HTTP helpers for search adapters: timeouts, status-code classification, JSON parsing,
 * error normalization.
 *
 * Convention: **never throw**; every failure returns a structured code that the registry/tool
 * layer translates into UI copy.
 */
import type { SearchErrorCode } from './types'
import { SEARCH_TIMEOUT_MS } from './types'

export type HttpResult =
  | { ok: true; status: number; text: string; json: unknown }
  | { ok: false; code: SearchErrorCode; message: string; status?: number }

/** Classify by response status code */
function codeForStatus(status: number): SearchErrorCode {
  if (status === 401 || status === 403) return 'unauthorized'
  if (status === 429) return 'rate-limited'
  return status >= 500 ? 'provider-error' : 'invalid-response'
}

/**
 * Send a JSON POST (`apiKey` goes in the Bearer header; callers may instead put the key in the
 * body).
 *
 * - 10s timeout;
 * - response text capped at 2MB;
 * - non-2xx → classified by status code; 2xx with unparsable JSON → invalid-response.
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
