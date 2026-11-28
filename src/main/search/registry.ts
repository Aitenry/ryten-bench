/**
 * Unified web search entry: resolve global settings -> call the corresponding adapter -> fall back to
 * builtin search on failure according to settings.
 *
 * All searches (`web_search` tool, the settings page "Test" button) go through here; UI and tools only
 * receive normalized results.
 */
import { builtinSearchProvider } from './builtin'
import { deepseekSearchProvider } from './deepseek'
import { tavilySearchProvider } from './tavily'
import { asSearchProviderId, getProviderApiKey } from './settings'
import { getSearchSettingsRow } from '../database/mapper/search'
import type {
  SearchOutcome,
  SearchProvider,
  SearchProviderId,
  SearchRequest
} from './types'
import {
  MAX_SEARCH_QUERY_CHARS,
  MAX_SEARCH_RESULTS,
  SEARCH_TIMEOUT_MS,
  clipText
} from './types'

/** Adapter table (adding a service only needs one line here + one adapter file) */
export const SEARCH_PROVIDERS: Record<SearchProviderId, SearchProvider> = {
  builtin: builtinSearchProvider,
  deepseek: deepseekSearchProvider,
  tavily: tavilySearchProvider
}

export interface SearchWebOptions {
  query: string
  maxResults?: number
  includeContent?: boolean
}

/** Normalize the request (truncate query, clamp result count) */
function normalizeRequest(
  query: string,
  maxResults: number | undefined,
  includeContent: boolean
): SearchRequest | null {
  const trimmed = query.trim()
  if (!trimmed) return null
  return {
    query: clipText(trimmed, MAX_SEARCH_QUERY_CHARS),
    maxResults: Math.max(1, Math.min(MAX_SEARCH_RESULTS, maxResults ?? 8)),
    includeContent
  }
}

/**
 * Unified search entry.
 *
 * Fallback rule: when the default service fails or is not configured and `autoFallback` is enabled,
 * retry once with builtin search; successful results carry a `fallbackFrom` marker so UI/tools can
 * indicate that a fallback happened.
 */
export async function searchWeb(options: SearchWebOptions): Promise<SearchOutcome> {
  const settings = await getSearchSettingsRow()
  const includeContent = options.includeContent ?? settings.includeContent
  const request = normalizeRequest(options.query, options.maxResults, includeContent)
  if (!request) {
    return { ok: false, provider: 'builtin', code: 'invalid-query', message: 'empty query' }
  }
  const primary = asSearchProviderId(settings.defaultProvider) ?? 'builtin'
  const chain: SearchProviderId[] =
    primary === 'builtin' ? ['builtin'] : [primary, 'builtin']

  let firstFailure: Extract<SearchOutcome, { ok: false }> | null = null
  for (const providerId of chain) {
    const provider = SEARCH_PROVIDERS[providerId]
    if (!provider) continue
    const apiKey = provider.requiresKey ? await getProviderApiKey(providerId) : undefined
    if (provider.requiresKey && !apiKey) {
      firstFailure = {
        ok: false,
        provider: providerId,
        code: 'not-configured',
        message: 'missing API key'
      }
      continue
    }
    const outcome = await withTimeout(provider.search(request, apiKey), SEARCH_TIMEOUT_MS + 2_000)
    if (outcome.ok) {
      if (providerId !== primary && firstFailure) {
        return { ...outcome, fallbackFrom: firstFailure.provider }
      }
      return outcome
    }
    if (!firstFailure) firstFailure = outcome
    // Auto fallback off: fail immediately; on: keep trying builtin search
    if (!settings.autoFallback) return outcome
  }
  return (
    firstFailure ?? {
      ok: false,
      provider: primary,
      code: 'provider-error',
      message: 'no search provider available'
    }
  )
}

/** Add another hard timeout layer around the adapter (so a broken SDK timeout cannot stall the turn) */
async function withTimeout(promise: Promise<SearchOutcome>, timeoutMs: number): Promise<SearchOutcome> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<SearchOutcome>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, provider: 'builtin', code: 'timeout', message: 'search timed out' }),
      timeoutMs
    )
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Settings page "Test": send one minimal search with the stored key and return only the outcome */
export async function testSearchProvider(providerId: SearchProviderId): Promise<{
  ok: boolean
  provider: SearchProviderId
  elapsedMs: number
  itemCount: number
  code?: string
  message?: string
}> {
  const provider = SEARCH_PROVIDERS[providerId]
  if (!provider) {
    return { ok: false, provider: providerId, elapsedMs: 0, itemCount: 0, code: 'invalid-query' }
  }
  const apiKey = provider.requiresKey ? await getProviderApiKey(providerId) : undefined
  if (provider.requiresKey && !apiKey) {
    return {
      ok: false,
      provider: providerId,
      elapsedMs: 0,
      itemCount: 0,
      code: 'not-configured'
    }
  }
  const startedAt = Date.now()
  const outcome = await withTimeout(
    provider.search({ query: 'ping', maxResults: 1, includeContent: false }, apiKey),
    SEARCH_TIMEOUT_MS + 2_000
  )
  if (outcome.ok) {
    return {
      ok: true,
      provider: providerId,
      elapsedMs: Date.now() - startedAt,
      itemCount: outcome.items.length
    }
  }
  return {
    ok: false,
    provider: providerId,
    elapsedMs: Date.now() - startedAt,
    itemCount: 0,
    code: outcome.code,
    message: outcome.message
  }
}
