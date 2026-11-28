/**
 * Built-in search adapter: the DuckDuckGo HTML endpoint (zero-config, no key required, always
 * available as a fallback).
 *
 * Reuses the existing fetch and parse logic of `web_fetch` (`tools/harness/web-core`) so built-in
 * search behaves the same as the previous `web_search` (UA, timeouts, size caps and result parsing
 * all share one source).
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
