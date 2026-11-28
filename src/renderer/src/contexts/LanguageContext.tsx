import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type { LanguageContextType, ResolvedLanguage } from '@renderer/types/language'
import { changeLanguage, detectSystemLanguage, isSupportedLanguage } from '@renderer/i18n'
import { LanguageContext } from './LanguageContextCore'

/**
 * UI language: only two options, Simplified Chinese / English.
 *
 * There is no separate "follow system" setting — until the user has chosen, the option matching
 * the operating system language is selected by default (decided synchronously on the first frame,
 * so there is no flicker by default); once the user has chosen, the persisted value wins.
 */
export const LanguageProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [language, setLanguageState] = useState<ResolvedLanguage>(() => detectSystemLanguage())

  // Read the saved language on mount (async, does not block first paint)
  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const settings = await window.api.systemSettings.getAll()
        if (cancelled) return
        // If saved, honor the user's choice; otherwise (or if the saved value is obsolete) keep the system-language default
        if (isSupportedLanguage(settings.language)) {
          setLanguageState(settings.language)
        }
      } catch {
        // On read failure keep the system-language default
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  // Sync i18next, <html lang> and the dayjs locale when the language changes
  useEffect(() => {
    changeLanguage(language).then()
  }, [language])

  const setLanguage = useCallback(async (next: ResolvedLanguage): Promise<void> => {
    // Persist first, then switch the UI; still switch if persisting fails so the click never seems dead
    try {
      await window.api.systemSettings.update({ language: next })
    } catch {
      // Swallow the error: switch locally anyway, reverting to the old value after restart
    }
    setLanguageState(next)
  }, [])

  const contextValue = useMemo<LanguageContextType>(
    () => ({ language, setLanguage }),
    [language, setLanguage]
  )

  return <LanguageContext.Provider value={contextValue}>{children}</LanguageContext.Provider>
}
