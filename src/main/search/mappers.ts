/**
 * Search service response mapping (pure functions, no network / SDK dependencies, offline-testable).
 *
 * - DeepSeek: `results[].{rerank_score,title,url,snippet,summary,content,site_name,date}` -> unified structure;
 * - Tavily (official SDK result array): `{title,url,content,rawContent,score}` -> unified structure.
 */
import type { SearchRequest, SearchResultItem } from './types'
import { MAX_SEARCH_RESULTS, clipText } from './types'

interface DeepSeekSearchResult {
  rerank_score?: number
  title?: string
  url?: string
  snippet?: string
  summary?: string
  content?: string
  site_name?: string | null
  date?: string | null
  authority?: number
}

/** DeepSeek raw response -> unified results */
export function mapDeepSeekResponse(
  json: unknown,
  request: SearchRequest
): { ok: true; items: SearchResultItem[] } | { ok: false; message: string } {
  if (!json || typeof json !== 'object') return { ok: false, message: 'empty response' }
  const results = (json as { results?: unknown }).results
  if (!Array.isArray(results)) return { ok: false, message: 'missing results array' }
  const items: SearchResultItem[] = []
  for (const raw of results.slice(0, Math.max(1, Math.min(MAX_SEARCH_RESULTS, request.maxResults)))) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as DeepSeekSearchResult
    const url = typeof row.url === 'string' ? row.url : ''
    if (!url) continue
    // The long summary reads better for the model; fall back to the short snippet when missing
    const snippetSource = row.summary || row.snippet || ''
    const item: SearchResultItem = {
      title: typeof row.title === 'string' && row.title ? row.title : url,
      url,
      snippet: clipText(snippetSource, 800)
    }
    if (row.site_name) item.siteName = row.site_name
    if (row.date) item.publishedAt = row.date
    if (typeof row.rerank_score === 'number') item.score = row.rerank_score
    if (request.includeContent && row.content) item.content = clipText(row.content, 4_000)
    items.push(item)
  }
  return { ok: true, items }
}

/** Tavily SDK result array -> unified results */
export function mapTavilyResults(rawResults: unknown, request: SearchRequest): SearchResultItem[] {
  if (!Array.isArray(rawResults)) return []
  const items: SearchResultItem[] = []
  for (const raw of rawResults.slice(0, Math.max(1, Math.min(MAX_SEARCH_RESULTS, request.maxResults)))) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as {
      title?: unknown
      url?: unknown
      content?: unknown
      rawContent?: unknown
      score?: unknown
    }
    const url = typeof row.url === 'string' ? row.url : ''
    if (!url) continue
    const content = typeof row.content === 'string' ? row.content : ''
    const item: SearchResultItem = {
      title: typeof row.title === 'string' && row.title ? row.title : url,
      url,
      snippet: clipText(content, 800)
    }
    if (typeof row.score === 'number') item.score = row.score
    if (request.includeContent) {
      const rawContent = typeof row.rawContent === 'string' ? row.rawContent : content
      if (rawContent) item.content = clipText(rawContent, 4_000)
    }
    items.push(item)
  }
  return items
}
