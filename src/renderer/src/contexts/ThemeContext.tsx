import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { ConfigProvider, theme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import enUS from 'antd/locale/en_US'
import type { ThemeMode } from '@renderer/types/settings'
import { useLanguage } from '../hooks/useLanguage'
import { ThemeContext, type ThemeContextType } from './ThemeContextCore'

const { defaultAlgorithm, darkAlgorithm } = theme

/**
 * Primary buttons (`type="primary"`) switch to a **neutral inverted** style instead of antd's
 * default bright-blue solid block.
 *
 * User directive of 2026-11-27 (with a screenshot of the "Approve and start execution" button):
 * "Remove every button in the project that uses this style; it's too ugly." Button styling is
 * shared across the whole project, so it is changed on the ConfigProvider Button component token:
 * every `type="primary"` (including the Modal default OK, confirmation dialogs, and the send
 * button) takes effect at once, without editing components one by one and without missing newly
 * added buttons.
 *
 * Values:
 * - dark: light background, dark text (`#f2f2f2` / `#141414`); hover is brighter, pressed is
 *   dimmer;
 * - light: dark background, white text (`#1f1f1f` / `#ffffff`); hover is darker, pressed is
 *   lighter.
 *
 * `primaryShadow` is also cleared: antd gives primary buttons a primary-colored shadow by default,
 * which shows up as a blue glow on dark surfaces and clashes with the neutral button. `danger`
 * primary buttons still use the error color and are unaffected (destructive actions stay red).
 */
const NEUTRAL_PRIMARY_BUTTON_DARK = {
  colorPrimary: '#f2f2f2',
  colorPrimaryHover: '#ffffff',
  colorPrimaryActive: '#d9d9d9',
  primaryColor: '#141414'
} as const

const NEUTRAL_PRIMARY_BUTTON_LIGHT = {
  colorPrimary: '#1f1f1f',
  colorPrimaryHover: '#000000',
  colorPrimaryActive: '#3d3d3d',
  primaryColor: '#ffffff'
} as const

/**
 * Pick light or dark theme based on the current hour.
 * 6:00–18:00 is daytime → light; the rest of the day is night → dark.
 */
const getTimeBasedTheme = (): 'light' | 'dark' => {
  const hour = new Date().getHours()
  return hour >= 6 && hour < 18 ? 'light' : 'dark'
}

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { language } = useLanguage()
  const [themeMode, setThemeModeState] = useState<ThemeMode>('auto')
  const [effectiveTheme, setEffectiveTheme] = useState<'light' | 'dark'>(getTimeBasedTheme())

  // Load the theme preference from system settings on mount (async, doesn't block first paint)
  useEffect(() => {
    const loadTheme = async (): Promise<void> => {
      try {
        const settings = await window.api.systemSettings.getAll()
        const savedTheme = settings.theme as ThemeMode | undefined
        const mode = savedTheme || 'auto'
        setThemeModeState(mode)
        setEffectiveTheme(mode === 'auto' ? getTimeBasedTheme() : mode)
      } catch {
        // Fall back to the defaults when loading fails
      }
    }
    loadTheme()
  }, [])

  // Auto mode: refresh the effective theme once per minute based on the time
  useEffect(() => {
    if (themeMode !== 'auto') return
    setEffectiveTheme(getTimeBasedTheme())
    const interval = setInterval(() => {
      setEffectiveTheme(getTimeBasedTheme())
    }, 60_000)
    return () => clearInterval(interval)
  }, [themeMode])

  // Sync Tailwind v4's dark class onto the document root element
  const isDark = effectiveTheme === 'dark'
  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
  }, [isDark])

  /**
   * Switch theme: commit React state in one go (the whole tree switches together); persistence is
   * done asynchronously and does not block the UI.
   *
   * The system button strip on the right of the title bar (Window Controls Overlay) is sent the new
   * colors by ShellTitleBar in useLayoutEffect, **before paint**—so it recolors in the same frame
   * as the UI. Do not change shell CSS variables earlier or delay the React commit: that splits the
   * UI into "shell changes first, content later", leaving half a theme for a few hundred
   * milliseconds, which looks even worse (user 2026-11-19: "it's getting worse the more you edit").
   */
  const setThemeMode = useCallback(async (mode: ThemeMode): Promise<void> => {
    const next = mode === 'auto' ? getTimeBasedTheme() : mode
    setThemeModeState(mode)
    setEffectiveTheme(next)
    try {
      await window.api.systemSettings.update({ theme: mode })
    } catch {
      // Handle silently
    }
  }, [])

  const contextValue = useMemo<ThemeContextType>(
    () => ({
      themeMode,
      effectiveTheme,
      setThemeMode
    }),
    [themeMode, effectiveTheme, setThemeMode]
  )

  /**
   * antd theme config: algorithms + neutral primary button styles (see the comments above)
   */
  const themeConfig = useMemo(
    () => ({
      algorithm: isDark ? darkAlgorithm : defaultAlgorithm,
      components: {
        Button: {
          ...(isDark ? NEUTRAL_PRIMARY_BUTTON_DARK : NEUTRAL_PRIMARY_BUTTON_LIGHT),
          primaryShadow: 'none'
        }
      }
    }),
    [isDark]
  )

  /**
   * Center all dialogs vertically (user 2026-11-23: "none of the popups on the page are centered").
   *
   * antd defaults to `top: 100px`: the taller the window, the closer dialogs hug the top half, and
   * tall dialogs such as the settings modal get their bottom clipped by the window. `centered` uses
   * the wrap's inline-block + vertical centering, so the position depends only on window height.
   * Set once on ConfigProvider so every `Modal` (including confirm from `Modal.useModal()`)
   * follows. Adding `centered` per component is bound to miss one, and that one sticks to the top.
   */
  return (
    <ThemeContext.Provider value={contextValue}>
      <ConfigProvider
        locale={language === 'en-US' ? enUS : zhCN}
        theme={themeConfig}
        getPopupContainer={() => document.body}
        modal={{ centered: true }}
      >
        {children}
      </ConfigProvider>
    </ThemeContext.Provider>
  )
}
