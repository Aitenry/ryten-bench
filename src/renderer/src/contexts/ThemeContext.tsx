import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { ConfigProvider, theme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import enUS from 'antd/locale/en_US'
import type { ThemeMode } from '@renderer/types/settings'
import { Window } from '../../resource/types/window'
import { useLanguage } from '../hooks/useLanguage'
import { ThemeContext, type ThemeContextType } from './ThemeContextCore'

const { defaultAlgorithm, darkAlgorithm } = theme

/**
 * 根据当前时间（小时）判断应该使用亮色还是暗色主题。
 * 6:00 ~ 18:00 为白天 → 亮色，其余时间为夜间 → 暗色。
 */
const getTimeBasedTheme = (): 'light' | 'dark' => {
  const hour = new Date().getHours()
  return hour >= 6 && hour < 18 ? 'light' : 'dark'
}

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { language } = useLanguage()
  const [themeMode, setThemeModeState] = useState<ThemeMode>('auto')
  const [effectiveTheme, setEffectiveTheme] = useState<'light' | 'dark'>(getTimeBasedTheme())

  // 挂载时从系统设置加载主题偏好（异步，不阻塞首屏渲染）
  useEffect(() => {
    const loadTheme = async (): Promise<void> => {
      try {
        const settings = await (window as unknown as Window).api.systemSettings.getAll()
        const savedTheme = settings.theme as ThemeMode | undefined
        const mode = savedTheme || 'auto'
        setThemeModeState(mode)
        setEffectiveTheme(mode === 'auto' ? getTimeBasedTheme() : mode)
      } catch {
        // 加载失败时使用默认值
      }
    }
    loadTheme()
  }, [])

  // 自动模式：每分钟根据时间更新一次有效主题
  useEffect(() => {
    if (themeMode !== 'auto') return
    setEffectiveTheme(getTimeBasedTheme())
    const interval = setInterval(() => {
      setEffectiveTheme(getTimeBasedTheme())
    }, 60_000)
    return () => clearInterval(interval)
  }, [themeMode])

  // 同步 Tailwind v4 的 dark 类名到 document 根元素
  const isDark = effectiveTheme === 'dark'
  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
  }, [isDark])

  /**
   * 切换主题：一次性提交 React 状态（整棵树一起换），落库异步做、不阻塞界面。
   *
   * 标题栏右侧的系统按钮条（Window Controls Overlay）由 ShellTitleBar 在
   * useLayoutEffect 里、**绘制之前**把新配色发给主进程——和界面同一帧换色。
   * 不要再提前改外壳 CSS 变量或推迟 React 提交：那会把界面拆成「外壳先变、内容后变」，
   * 中间几百毫秒里是半套主题，反而更难看（用户 2026-11-19「越改越不行了」）。
   */
  const setThemeMode = useCallback(async (mode: ThemeMode): Promise<void> => {
    const next = mode === 'auto' ? getTimeBasedTheme() : mode
    setThemeModeState(mode)
    setEffectiveTheme(next)
    try {
      await (window as unknown as Window).api.systemSettings.update({ theme: mode })
    } catch {
      // 静默处理
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

  return (
    <ThemeContext.Provider value={contextValue}>
      <ConfigProvider
        locale={language === 'en-US' ? enUS : zhCN}
        theme={{ algorithm: isDark ? darkAlgorithm : defaultAlgorithm }}
        getPopupContainer={() => document.body}
      >
        {children}
      </ConfigProvider>
    </ThemeContext.Provider>
  )
}
