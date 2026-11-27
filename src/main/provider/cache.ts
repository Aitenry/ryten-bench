import type { LlmProviderConfig } from '../database/mapper/provider'

/**
 * 模型 Provider 的启动期缓存（core 的 provider-* 通道与加载页预取共用）。
 *
 * 归属说明：这段缓存原先和 harness 的子代理定义缓存挤在 `src/main/services/harness/preload-cache.ts`
 * 里。harness 整块搬进 `src/main/**` 后，provider-* 是 core 的通道（模型 Provider
 * 不属于「AI 助手」插件），因此把 provider 这三项缓存留在 core，由 harness 的
 * `preloadHarnessData()` 在预取时写入（插件 → core 的只读依赖，方向合法）。
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
