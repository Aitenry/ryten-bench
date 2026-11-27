/**
 * 联网搜索的统一契约（主进程内部，无 electron / DB 依赖）。
 *
 * 设计目标：新增搜索服务只加一个 adapter（实现 `SearchProvider`），
 * UI、工具、设置存储都不改；入口统一在 `registry.searchWeb()`。
 */

/** 可选的搜索服务 */
export type SearchProviderId = 'builtin' | 'deepseek' | 'tavily'

/** 稳定的错误码（UI / 工具层负责翻成界面语言） */
export type SearchErrorCode =
  | 'not-configured'
  | 'unauthorized'
  | 'rate-limited'
  | 'timeout'
  | 'network'
  | 'provider-error'
  | 'invalid-response'
  | 'invalid-query'

/** 一次搜索请求 */
export interface SearchRequest {
  query: string
  /** 期望条数（1–10） */
  maxResults: number
  /** 是否请求正文摘要 */
  includeContent: boolean
}

/** 归一化后的单条结果（三个 adapter 都映射到它） */
export interface SearchResultItem {
  title: string
  url: string
  snippet: string
  /** 正文摘要（仅 includeContent 且有值时） */
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
  /** 是否由默认服务失败后回退到内置搜索 */
  fallbackFrom?: SearchProviderId
}

export interface SearchFailure {
  ok: false
  provider: SearchProviderId
  code: SearchErrorCode
  /** 服务商原始错误信息（已截断；用于日志/详情，不直接展示给用户） */
  message: string
}

export type SearchOutcome = SearchSuccess | SearchFailure

/** 搜索服务适配器 */
export interface SearchProvider {
  id: SearchProviderId
  /** 需要密钥的服务返回 true；内置搜索为 false */
  requiresKey: boolean
  search(request: SearchRequest, apiKey?: string): Promise<SearchOutcome>
}

/** 查询长度上限（与 DeepSeek 搜索接口一致） */
export const MAX_SEARCH_QUERY_CHARS = 128
/** 单次返回条数上限 */
export const MAX_SEARCH_RESULTS = 10
/** 单次搜索请求超时 */
export const SEARCH_TIMEOUT_MS = 10_000

/** 截断字符串（保持 UI/日志可读） */
export function clipText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}…`
}
