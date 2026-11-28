/**
 * Tavily search adapter (**official SDK**: `@tavily/core`).
 *
 * Tavily is required to use the official SDK rather than hand-written REST: the SDK handles auth,
 * parameter assembly and error types. This file only does "normalization (`mappers.ts`) + error code
 * mapping" and must not leak SDK types outside the search abstraction.
 */
import { tavily } from '@tavily/core'
import { mapTavilyResults } from './mappers'
import type { SearchOutcome, SearchProvider, SearchRequest } from './types'
import { MAX_SEARCH_RESULTS, clipText } from './types'

/** SDK error -> stable error code (HTTP status code / error message preferred) */
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
