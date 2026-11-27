/**
 * Tavily 搜索适配器（**官方 SDK**：`@tavily/core`）。
 *
 * 用户指定 Tavily 走官方 SDK，而不是手写 REST：由 SDK 负责鉴权、参数拼装与错误类型。
 * 这里只做「归一化（`mappers.ts`）+ 错误码映射」，不把 SDK 类型泄漏到搜索抽象之外。
 */
import { tavily } from '@tavily/core'
import { mapTavilyResults } from './mappers'
import type { SearchOutcome, SearchProvider, SearchRequest } from './types'
import { MAX_SEARCH_RESULTS, clipText } from './types'

/** SDK 抛错 → 稳定错误码（HTTP 状态码 / 错误信息优先） */
function classifyTavilyError(error: unknown): {
  code: Extract<SearchOutcome, { ok: false }>['code']
  message: string
} {
  const message = error instanceof Error ? error.message : String(error)
  const status = (error as { status?: unknown; statusCode?: unknown } | null)?.status
  const statusCode = (error as { statusCode?: unknown } | null)?.statusCode
  const httpStatus =
    typeof status === 'number' ? status : typeof statusCode === 'number' ? statusCode : undefined
  if (httpStatus === 401 || httpStatus === 403) return { code: 'unauthorized', message }
  if (httpStatus === 429) return { code: 'rate-limited', message }
  if (httpStatus !== undefined) return { code: 'provider-error', message }
  if (/unauthorized|invalid api key|api key/i.test(message)) return { code: 'unauthorized', message }
  if (/rate.?limit|too many requests|quota/i.test(message)) return { code: 'rate-limited', message }
  if (/timeout|abort|ETIMEDOUT/i.test(message)) return { code: 'timeout', message }
  if (/ENOTFOUND|ECONNREFUSED|network|fetch failed/i.test(message)) {
    return { code: 'network', message }
  }
  return { code: 'provider-error', message }
}

export const tavilySearchProvider: SearchProvider = {
  id: 'tavily',
  requiresKey: true,
  async search(request: SearchRequest, apiKey?: string): Promise<SearchOutcome> {
    const startedAt = Date.now()
    if (!apiKey) {
      return { ok: false, provider: 'tavily', code: 'not-configured', message: 'missing API key' }
    }
    try {
      const client = tavily({ apiKey })
      const response = await client.search(request.query.trim(), {
        maxResults: Math.max(1, Math.min(MAX_SEARCH_RESULTS, request.maxResults)),
        searchDepth: 'basic',
        includeRawContent: request.includeContent ? 'markdown' : false
      })
      const items = mapTavilyResults(response.results, request)
      return {
        ok: true,
        provider: 'tavily',
        items,
        elapsedMs: Date.now() - startedAt
      }
    } catch (error) {
      const classified = classifyTavilyError(error)
      return {
        ok: false,
        provider: 'tavily',
        code: classified.code,
        message: clipText(classified.message, 500)
      }
    }
  }
}
