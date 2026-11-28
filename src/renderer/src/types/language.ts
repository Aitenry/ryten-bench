import type { AppLanguage } from './settings'

/** UI language (only Simplified Chinese / English) */
export type ResolvedLanguage = AppLanguage

export interface LanguageContextType {
  /** Current UI language, which is also the selected value of the dropdown */
  language: ResolvedLanguage
  /** Switch the UI language: takes effect immediately and is persisted */
  setLanguage: (language: ResolvedLanguage) => Promise<void>
}
