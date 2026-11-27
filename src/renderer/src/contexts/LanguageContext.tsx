import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type { LanguageContextType, ResolvedLanguage } from '@renderer/types/language'
import { changeLanguage, detectSystemLanguage, isSupportedLanguage } from '@renderer/i18n'
import { LanguageContext } from './LanguageContextCore'

/**
 * 界面语言：只有「简体中文 / English」两项。
 *
 * 没有独立的「跟随系统」档位——用户还没选过时，默认选中与操作系统语言一致的那一项
 * （首帧同步决定，因此默认情况下不会闪烁）；用户选过之后以落盘值为准。
 */
export const LanguageProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [language, setLanguageState] = useState<ResolvedLanguage>(() => detectSystemLanguage())

  // 挂载时读取已保存的语言（异步，不阻塞首屏渲染）
  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const settings = await window.api.systemSettings.getAll()
        if (cancelled) return
        // 存过就听用户的；没存过（或存的是已废弃的值）保持按系统语言选中的默认项
        if (isSupportedLanguage(settings.language)) {
          setLanguageState(settings.language)
        }
      } catch {
        // 读取失败时保持系统语言默认项
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  // 语言变化时同步 i18next、<html lang> 与 dayjs locale
  useEffect(() => {
    changeLanguage(language).then()
  }, [language])

  const setLanguage = useCallback(async (next: ResolvedLanguage): Promise<void> => {
    // 先落盘再切界面；落盘失败也照切，避免「点了没反应」
    try {
      await window.api.systemSettings.update({ language: next })
    } catch {
      // 静默处理：本地仍切换，重启后回到旧值
    }
    setLanguageState(next)
  }, [])

  const contextValue = useMemo<LanguageContextType>(
    () => ({ language, setLanguage }),
    [language, setLanguage]
  )

  return <LanguageContext.Provider value={contextValue}>{children}</LanguageContext.Provider>
}
