/**
 * 联网搜索的纯工具函数（无 DB / electron / SDK 依赖，可离线测试）。
 */
/** 可选搜索服务 id 列表（顺序即 UI 顺序） */
export const SEARCH_PROVIDER_IDS = ['builtin', 'deepseek', 'tavily'] as const

export type SearchProviderIdPure = (typeof SEARCH_PROVIDER_IDS)[number]

/**
 * Key 掩码：长度 > 12 时显示前 6 + 后 6，否则只露末 4。
 *
 * 用户口径（2026-11-27）：搜索设置里密钥要显示前后 6 位。
 */
export function maskApiKey(key: string): string {
  const trimmed = key.trim()
  if (trimmed.length <= 12) {
    return `••••${trimmed.slice(-4)}`
  }
  return `${trimmed.slice(0, 6)}••••••${trimmed.slice(-6)}`
}

/** 规范化 provider 参数（非法值返回 null） */
export function asSearchProviderId(value: unknown): SearchProviderIdPure | null {
  return typeof value === 'string' && (SEARCH_PROVIDER_IDS as readonly string[]).includes(value)
    ? (value as SearchProviderIdPure)
    : null
}
