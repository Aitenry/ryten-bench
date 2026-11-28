import type { AppLanguage } from '@renderer/types/settings'

/**
 * UI language. There are only two, and `AppLanguage` is exactly that:
 * there is no "follow system" option; when the user has never picked one, `detectSystemLanguage()`
 * decides which option is selected by default.
 */
export type ResolvedLanguage = AppLanguage

/** Supported UI languages (dropdown order) */
export const SUPPORTED_LANGUAGES: readonly ResolvedLanguage[] = ['zh-CN', 'en-US']

/** Fallback language = source language */
export const DEFAULT_LANGUAGE: ResolvedLanguage = 'zh-CN'

/** dayjs locale name for each language */
export const LANGUAGES: Record<ResolvedLanguage, { dayjs: string }> = {
  'zh-CN': { dayjs: 'zh-cn' },
  'en-US': { dayjs: 'en' }
}

/**
 * Normalize any locale identifier (`zh-CN` / `zh-Hans-CN` / `en-US` / `en-GB` / `ja-JP`…)
 * to a supported language: Chinese variants → Simplified Chinese, everything else → English.
 */
export function normalizeLanguage(locale: string | null | undefined): ResolvedLanguage {
  if (!locale) return DEFAULT_LANGUAGE
  return locale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
}

/**
 * Read the OS language and use it as the default when the user has not picked a language yet.
 * In the Electron renderer, `navigator.language` equals the main process `app.getLocale()` (e.g.
 * `zh-CN`, `en-US`).
 */
export function detectSystemLanguage(): ResolvedLanguage {
  if (typeof navigator === 'undefined') return DEFAULT_LANGUAGE
  return normalizeLanguage(navigator.language || navigator.languages?.[0])
}

/** Check that a persisted value is a usable language (older versions may have stored deprecated values like 'system') */
export function isSupportedLanguage(value: unknown): value is ResolvedLanguage {
  return value === 'zh-CN' || value === 'en-US'
}
