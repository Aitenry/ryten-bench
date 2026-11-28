import { app } from 'electron'
import { settingsStore } from '../context'
import { enUS, zhCN } from './messages'
import { enUSToolResults, zhCNToolResults } from './tool-results'

/** Language used for copy visible from the main process (same setting as the renderer, two options, no "follow system" entry) */
export type MainLanguage = 'zh-CN' | 'en-US'

/** Same rule as the renderer's `normalizeLanguage`: Chinese locales → zh-CN, everything else → en-US */
function normalizeLocale(locale: string | undefined | null): MainLanguage {
  if (!locale) return 'zh-CN'
  return locale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
}

/**
 * Current UI language. Uses the persisted value if the user has chosen one; otherwise (or when the
 * stored value is deprecated) uses the OS language, consistent with the renderer's
 * `detectSystemLanguage()` (`navigator.language` === `app.getLocale()`).
 */
export function getMainLanguage(): MainLanguage {
  const stored = settingsStore.get('language') as unknown
  if (stored === 'zh-CN' || stored === 'en-US') return stored
  return normalizeLocale(app.isReady() ? app.getLocale() : undefined)
}

/** The whole message tree for the current language; usage: `const m = mainMessages(); m.tray.hideWindow` */
export function mainMessages(): typeof zhCN {
  return getMainLanguage() === 'en-US' ? enUS : zhCN
}

/**
 * Message tree for tool execution results (rendered on the chat tool result cards, so it
 * follows the UI language).
 * Usage: `const tm = mainToolMessages(); mainFormat(tm.mnemon.added, { count })`
 */
export function mainToolMessages(): typeof zhCNToolResults {
  return getMainLanguage() === 'en-US' ? enUSToolResults : zhCNToolResults
}

/**
 * Message interpolation: replaces `{{name}}` with the passed value (Chinese and English word
 * order differ, so each entry decides placeholder order).
 * Nullable values (projections of nullable database columns) render as an empty string — never
 * let `null` reach the UI.
 */
export function mainFormat(
  template: string,
  vars: Record<string, string | number | null | undefined>
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => String(vars[key] ?? ''))
}

/** Plural phrase: `mainPlural(one, other, count)` — both forms are identical in Chinese, English picks by count */
export function mainPlural(one: string, other: string, count: number): string {
  return mainFormat(count === 1 ? one : other, { count })
}
