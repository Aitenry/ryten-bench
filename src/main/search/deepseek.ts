/**
 * DeepSeek search adapter.
 *
 * API (`POST https://api.deepseek.com/v1/tools/search`, Bearer auth):
 * - request: `{ query, count, need_content, ori_question? }`;
 * - response: `results[].{ rerank_score, title, url, snippet, summary, content, site_name, date, authority }`.
 *
 * Response mapping lives in `mappers.ts` (pure functions, testable offline).
 */
import { postJson } from './http'
import { mapDeepSeekResponse } from './mappers'
import type { SearchOutcome, SearchProvider, SearchRequest } from './types'
import { MAX_SEARCH_QUERY_CHARS, MAX_SEARCH_RESULTS, clipText } from './types'

const DEEPSEEK_SEARCH_ENDPOINT = 'https://api.deepseek.com/v1/tools/search'

export const deepseekSearchProvider: SearchProvider = {
  id: 'deepseek',
  requiresKey: true,
  async search(request: SearchRequest, apiKey?: string): Promise<SearchOutcome> {
    const startedAt = Date.now()
    if (!apiKey) {
      return { ok: false, provider: 'deepseek', code: 'not-configured', message: 'missing API key' }
    }
    const result = await postJson(DEEPSEEK_SEARCH_ENDPOINT, {
      apiKey,
      body: {
        query: clipText(request.query.trim(), MAX_SEARCH_QUERY_CHARS),
        count: Math.max(1, Math.min(MAX_SEARCH_RESULTS, request.maxResults)),
        need_content: request.includeContent
      }
    })
    if (!result.ok) {
      return { ok: false, provider: 'deepseek', code: result.code, message: result.message }
    }
    const mapped = mapDeepSeekResponse(result.json, request)
    if (!mapped.ok) {
      return { ok: false, provider: 'deepseek', code: 'invalid-response', message: mapped.message }
    }
    return {
      ok: true,
      provider: 'deepseek',
      items: mapped.items,
      elapsedMs: Date.now() - startedAt
    }
  }
}
