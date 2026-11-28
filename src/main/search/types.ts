/**
 * Unified contract for web search (inside the main process, no electron / DB dependencies).
 *
 * Design goal: adding a search service only requires one adapter (implementing `SearchProvider`);
 * UI, tools and settings storage stay unchanged; the entry point is always `registry.searchWeb()`.
 */

/** Available search services */
export type SearchProviderId = 'builtin' | 'deepseek' | 'tavily'

/** Stable error codes (the UI / tool layer translates them into the display language) */
export type SearchErrorCode =
  | 'not-configured'
  | 'unauthorized'
  | 'rate-limited'
  | 'timeout'
  | 'network'
  | 'provider-error'
  | 'invalid-response'
  | 'invalid-query'

/** A single search request */
export interface SearchRequest {
  query: string
  /** Desired result count (1–10) */
  maxResults: number
  /** Whether to request content summaries */
  includeContent: boolean
}

/** Normalized single result (all three adapters map to it) */
export interface SearchResultItem {
  title: string
  url: string
  snippet: string
  /** Content summary (only present when includeContent is set and a value exists) */
  content?: string
  siteName?: string
  publishedAt?: string
  score?: number
}

export interface SearchSuccess {
  ok: true
  provider: SearchProviderId
  items: SearchResultItem[]
  elapsedMs: number
  /** Whether this fell back to builtin search after the default service failed */
  fallbackFrom?: SearchProviderId
}

export interface SearchFailure {
  ok: false
  provider: SearchProviderId
  code: SearchErrorCode
  /** Raw provider error message (truncated; used for logs/details, not shown to users directly) */
  message: string
}

export type SearchOutcome = SearchSuccess | SearchFailure

/** Search service adapter */
export interface SearchProvider {
  id: SearchProviderId
  /** true for services that require a key; false for builtin search */
  requiresKey: boolean
  search(request: SearchRequest, apiKey?: string): Promise<SearchOutcome>
}

/** Maximum query length (matches the DeepSeek search API) */
export const MAX_SEARCH_QUERY_CHARS = 128
/** Maximum number of results per request */
export const MAX_SEARCH_RESULTS = 10
/** Timeout for a single search request */
export const SEARCH_TIMEOUT_MS = 10_000

/** Truncate a string (keeps UI/logs readable) */
export function clipText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}…`
}
