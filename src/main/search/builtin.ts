/**
 * 内置搜索适配器：DuckDuckGo HTML 端点（零配置、无需密钥，永远可用的兜底）。
 *
 * 复用 `web_fetch` 已有的抓取与解析逻辑（`tools/harness/web-core`），保证内置搜索
 * 与之前的 `web_search` 行为一致（UA、超时、大小上限、结果解析都同源）。
 */
import { fetchReadable, parseDuckDuckGoResults } from '../tools/harness/web-core'
import type { SearchOutcome, SearchProvider, SearchRequest } from './types'
import { MAX_SEARCH_RESULTS } from './types'

export const builtinSearchProvider: SearchProvider = {
  id: 'builtin',
  requiresKey: false,
  async search(request: SearchRequest): Promise<SearchOutcome> {
    const startedAt = Date.now()
    const endpoint = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(request.query)}`
    const outcome = await fetchReadable(endpoint)
    if (!outcome.ok) {
      const failure = outcome.failure
      const code =
        failure.code === 'request-failed'
          ? 'network'
          : failure.code === 'blocked-private' || failure.code === 'invalid-url'
            ? 'invalid-query'
            : 'provider-error'
      return {
        ok: false,
        provider: 'builtin',
        code,
        message: failure.code === 'request-failed' ? failure.message : failure.code
      }
    }
    const hits = parseDuckDuckGoResults(
      outcome.raw,
      Math.max(1, Math.min(MAX_SEARCH_RESULTS, request.maxResults))
    )
    return {
      ok: true,
      provider: 'builtin',
      items: hits.map((hit) => ({
        title: hit.title,
        url: hit.url,
        snippet: hit.snippet
      })),
      elapsedMs: Date.now() - startedAt
    }
  }
}
