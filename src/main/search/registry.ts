/**
 * 联网搜索统一入口：解析全局设置 → 调用对应 adapter → 失败按设置回退到内置搜索。
 *
 * 所有搜索（`web_search` 工具、设置页「测试」按钮）都从这里走，UI 与工具只拿归一化结果。
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

/** adapter 表（新增服务只在这里加一行 + 一个 adapter 文件） */
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

/** 规范化请求（query 截断、条数收敛） */
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
 * 统一搜索入口。
 *
 * 回退规则：默认服务失败/未配置且 `autoFallback` 开启时，改用内置搜索一次；
 * 成功结果带 `fallbackFrom` 标记，UI/工具可提示「已回退」。
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
    // 未开启自动回退：直接失败；开启则继续尝试内置搜索
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

/** 给 adapter 再加一层硬超时（避免 SDK 内部超时失效拖住整轮） */
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

/** 设置页「测试」：用已存 Key 发一次最小搜索，只返回结论 */
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
