import i18n from 'i18next'
import { initReactI18next, useTranslation, Trans } from 'react-i18next'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import 'dayjs/locale/en'

import { DEFAULT_NS, resources } from './resources'
import { DEFAULT_LANGUAGE, LANGUAGES, detectSystemLanguage, type ResolvedLanguage } from './types'

export * from './types'
export { DEFAULT_NS, resources }
export { useTranslation, Trans }
/* Named export of the instance: where hooks are unavailable (tiptap NodeViews, non-component modules), use i18n.t() to read copy in the current language */
export { i18n }

/* Synchronous initialization: resources are bundled inline, so no backend loading is needed;
   the first-frame language follows the OS language first (the default preference is "follow system"),
   and the persisted preference is reconciled asynchronously afterwards by LanguageProvider. */
i18n.use(initReactI18next).init({
  resources,
  lng: detectSystemLanguage(),
  fallbackLng: DEFAULT_LANGUAGE,
  supportedLngs: ['zh-CN', 'en-US'],
  // Accept only full locales (zh-CN / en-US) so i18next does not try zh / en variants
  load: 'currentOnly',
  defaultNS: DEFAULT_NS,
  ns: [DEFAULT_NS],
  interpolation: { escapeValue: false },
  // Initialize synchronously with inline resources so the first frame never shows untranslated key names (option name in i18next v23+)
  initAsync: false,
  returnNull: false
})

/** Synchronize language-related global state outside React: `<html lang>` and the dayjs locale */
export function applyLanguageGlobals(language: ResolvedLanguage): void {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = language
  }
  dayjs.locale(LANGUAGES[language].dayjs)
}

/** Switch the UI language (react-i18next broadcasts languageChanged, so subscribers re-render automatically) */
export async function changeLanguage(language: ResolvedLanguage): Promise<void> {
  applyLanguageGlobals(language)
  if (i18n.resolvedLanguage !== language) {
    await i18n.changeLanguage(language)
  }
}

// Align <html lang> and the dayjs locale with the initial language on the first frame
applyLanguageGlobals(i18n.resolvedLanguage === 'en-US' ? 'en-US' : DEFAULT_LANGUAGE)

export default i18n
