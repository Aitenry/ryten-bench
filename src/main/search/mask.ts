/**
 * Pure utility functions for web search (no DB / electron / SDK dependencies, offline-testable).
 */
/** Available search service ids (order matches UI order) */
export const SEARCH_PROVIDER_IDS = ['builtin', 'deepseek', 'tavily'] as const

export type SearchProviderIdPure = (typeof SEARCH_PROVIDER_IDS)[number]

/**
 * Key mask: when longer than 12 characters show the first 6 + last 6, otherwise only the last 4.
 *
 * User requirement (2026-11-27): keys in search settings must show the first and last 6 characters.
 */
export function maskApiKey(key: string): string {
  const trimmed = key.trim()
  if (trimmed.length <= 12) {
    return `••••${trimmed.slice(-4)}`
  }
  return `${trimmed.slice(0, 6)}••••••${trimmed.slice(-6)}`
}

/** Normalize a provider argument (returns null for invalid values) */
export function asSearchProviderId(value: unknown): SearchProviderIdPure | null {
  return typeof value === 'string' && (SEARCH_PROVIDER_IDS as readonly string[]).includes(value)
    ? (value as SearchProviderIdPure)
    : null
}
