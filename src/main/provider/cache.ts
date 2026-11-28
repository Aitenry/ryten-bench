import type { LlmProviderConfig } from '../database/mapper/provider'

/**
 * Startup cache for model providers (shared by core's provider-* channels and the loading page's
 * prefetch).
 *
 * Ownership note: this cache used to be crammed together with harness's sub-agent definition cache
 * in `src/main/services/harness/preload-cache.ts`. After harness moved wholesale into
 * `src/main/**`, provider-* is a core channel (model providers do not belong to the "AI assistant"
 * plugin), so these three provider cache entries stay in core, and harness's
 * `preloadHarnessData()` writes them during prefetch (a read-only plugin -> core dependency, a
 * legal direction).
 */
let cachedEnabledProviders: LlmProviderConfig[] | null = null
let cachedDefaultProvider: LlmProviderConfig | null = null

export function clearProviderCache(): void {
  cachedEnabledProviders = null
  cachedDefaultProvider = null
}

export function getCachedEnabledProviders(): LlmProviderConfig[] | null {
  return cachedEnabledProviders
}

export function setCachedEnabledProviders(providers: LlmProviderConfig[] | null): void {
  cachedEnabledProviders = providers
}

export function getCachedDefaultProvider(): LlmProviderConfig | null {
  return cachedDefaultProvider
}

export function setCachedDefaultProvider(provider: LlmProviderConfig | null): void {
  cachedDefaultProvider = provider
}
