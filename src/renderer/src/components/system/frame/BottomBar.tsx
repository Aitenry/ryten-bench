import React, { useEffect, useState, useRef, useCallback, useReducer } from 'react'
import { RiRefreshLine, RiSunCloudyLine } from '@remixicon/react'
import { useTheme } from '@renderer/hooks/useTheme'
import { useTranslation } from '@renderer/i18n'
import { useBottomBarItems } from '@renderer/plugin-host/PluginHostContext'
import { PluginBoundary } from '@renderer/plugin-host/PluginBoundary'
import type { BottomBarItemRegistration } from '@renderer/plugin-host/types'
import { Window } from '../../../../resource/types/window'

/**
 * 底部信息栏（外壳）。
 *
 * 它**不认识任何插件**：轮播项 = 内置的「天气」+ 各插件经宿主 `bottomBar` 插槽注册
 * 且当前 `isVisible()` 为真的条目（按 order 排序，音乐 10 在天气之前）。
 * 每一项的标题行渲染注册项的 `Tab`、弹层渲染 `Popup`——音乐的状态与界面都留在
 * music 插件里，插件停用后这里什么都不剩，外壳照常渲染。
 */

interface WeatherData {
  location: string
  current: Record<string, unknown>
  daily: Record<string, unknown>[]
}

interface BottomBarProps {
  colorBgContainer: string
  colorPrimary: string
  colorText: string
  colorTextSecondary: string
}

const CAROUSEL_INTERVAL = 4000

/** 轮播项：插件注册项，或内置的天气项 */
type CarouselItem = { kind: 'plugin'; reg: BottomBarItemRegistration } | { kind: 'weather' }

const BottomBar: React.FC<BottomBarProps> = ({
  colorBgContainer,
  colorPrimary,
  colorText,
  colorTextSecondary
}) => {
  const { effectiveTheme } = useTheme()
  const { t, i18n } = useTranslation()
  const isDark = effectiveTheme === 'dark'

  // 底栏插槽：条目来自插件注册表（音乐插件注册；插件停用即消失）
  const pluginItems = useBottomBarItems()
  // 可见性触发器：插件在 subscribe 回调里 bump 一次，宿主重渲染时重新读 isVisible()
  const [, forceVisibilityRefresh] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    const unsubscribes: Array<() => void> = []
    for (const reg of pluginItems) {
      // 插件的 subscribe 是第三方代码：它抛错不能连累宿主底栏（否则整条底栏消失）
      try {
        const unsub = reg.subscribe?.(forceVisibilityRefresh)
        if (typeof unsub === 'function') unsubscribes.push(unsub)
      } catch (err) {
        console.error(`[plugin:${reg.pluginId}] 底栏 subscribe 失败（已忽略）:`, err)
      }
    }
    return () => {
      for (const unsub of unsubscribes) {
        try {
          unsub()
        } catch (err) {
          console.error('[plugins] 底栏 unsubscribe 失败（已忽略）:', err)
        }
      }
    }
  }, [pluginItems])

  const [carouselIndex, setCarouselIndex] = useState(0)
  const [carouselPaused, setCarouselPaused] = useState(false)
  const [popupOpen, setPopupOpen] = useState(false)
  const [weatherData, setWeatherData] = useState<WeatherData | null>(null)
  const [weatherCity, setWeatherCity] = useState<string>('')
  const [weatherLoading, setWeatherLoading] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const api = (window as unknown as Window).api

  const refreshWeather = useCallback(async (): Promise<void> => {
    setWeatherLoading(true)
    try {
      const data = (await api.weather.getCurrent(true)) as unknown as WeatherData
      setWeatherData(data)
    } catch {
      // 静默处理
    } finally {
      setWeatherLoading(false)
    }
  }, [])

  // 依赖语言：天气文案由主进程按当前语言渲染后下发，切语言要重新拉一次缓存
  // （主进程缓存里存的是天气码，不重新取就会留上一次语言的中文描述）
  useEffect(() => {
    api.systemSettings.getAll().then((s) => {
      const city = s.ip?.city as string | undefined
      if (city) setWeatherCity(city)
    })
    const unsub = api.weather.onUpdate((data: unknown) => {
      const wd = data as WeatherData
      if (wd?.current) setWeatherData(wd)
    })
    api.weather.getCurrent().then((data: unknown) => {
      const wd = data as WeatherData
      if (wd?.current) setWeatherData(wd)
    })
    return unsub
  }, [i18n.resolvedLanguage])

  // 插件条目在前（order 已由宿主排好）、天气恒在最后——保持原有的「音乐 → 天气」顺序。
  // 刻意不 memo：可见性来自插件侧快照，每次渲染都要重新读 isVisible()。
  // isVisible 是插件代码：抛错只当作「这一项不可见」，不能把整条底栏带下去。
  const carouselItems: CarouselItem[] = []
  for (const reg of pluginItems) {
    let visible = false
    try {
      visible = Boolean(reg.isVisible())
    } catch (err) {
      console.error(`[plugin:${reg.pluginId}] 底栏 isVisible() 抛错（按不可见处理）:`, err)
    }
    if (visible) carouselItems.push({ kind: 'plugin', reg })
  }
  carouselItems.push({ kind: 'weather' })

  useEffect(() => {
    setCarouselIndex(0)
  }, [carouselItems.length])

  useEffect(() => {
    if (carouselPaused || carouselItems.length <= 1) return
    timerRef.current = setInterval(() => {
      setCarouselIndex((prev) => (prev + 1) % carouselItems.length)
    }, CAROUSEL_INTERVAL)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
    // 依赖条目数（修复：此前只依赖 carouselPaused——首启无音乐时定时器永不建立,
    // 播放中清空列表时旧定时器以旧 length 自旋导致索引越界/内容错位）
  }, [carouselPaused, carouselItems.length])

  const handleCarouselEnter = useCallback(() => {
    setCarouselPaused(true)
    setPopupOpen(true)
  }, [])

  const handleCarouselLeave = useCallback(() => {
    setCarouselPaused(false)
    setPopupOpen(false)
  }, [])

  // 索引兜底：可见性变化（例如播放结束）会让条目数减少，避免渲染越界
  const activeItem = carouselItems[Math.min(carouselIndex, carouselItems.length - 1)]
  const activePluginId = activeItem?.kind === 'plugin' ? activeItem.reg.pluginId : ''
  const ActiveTab = activeItem?.kind === 'plugin' ? activeItem.reg.Tab : null
  const ActivePopup = activeItem?.kind === 'plugin' ? activeItem.reg.Popup : null

  return (
    <div className="frame-bottombar">
      <div className="frame-bottombar-inner" onMouseLeave={handleCarouselLeave}>
        {popupOpen && (
          <div
            className="frame-bottombar-popup"
            style={{
              background: colorBgContainer,
              color: colorText,
              boxShadow: `0 -2px 12px rgba(0,0,0,${isDark ? '0.3' : '0.08'})`
            }}
          >
            {ActivePopup ? (
              // 插件弹层自己炸掉时退化成一行占位：底栏与天气照常可用
              <PluginBoundary
                pluginId={activePluginId}
                surface="bottomBar"
                quiet
                fallback={
                  <div className="text-sm" style={{ color: colorTextSecondary }}>
                    {t('shell.pluginBoundary.unavailable')}
                  </div>
                }
              >
                <ActivePopup />
              </PluginBoundary>
            ) : (
              <div className="text-sm">
                {weatherLoading ? (
                  <span style={{ color: colorTextSecondary }}>{t('common.state.loading')}</span>
                ) : weatherData?.current ? (
                  <>
                    <div className="flex items-center justify-between mb-2">
                      <div className="font-medium" style={{ color: colorText }}>
                        {weatherData.location as string}
                      </div>
                      <button
                        className="frame-titlebar-btn"
                        onClick={refreshWeather}
                        title={t('shell.bottomBar.refreshWeather')}
                      >
                        <RiRefreshLine size={14} />
                      </button>
                    </div>
                    <div className="flex items-baseline gap-2 mb-2">
                      <span className="text-2xl font-semibold" style={{ color: colorText }}>
                        {weatherData.current.temp as string}°C
                      </span>
                      <span style={{ color: colorTextSecondary }}>
                        {weatherData.current.weatherDesc as string}
                      </span>
                    </div>
                    <div className="flex gap-3 text-xs" style={{ color: colorTextSecondary }}>
                      <span>
                        {t('shell.bottomBar.apparentTemp', {
                          temp: weatherData.current.apparentTemp as string
                        })}
                      </span>
                      <span>
                        {t('shell.bottomBar.humidity', {
                          percent: weatherData.current.humidity as number
                        })}
                      </span>
                      <span>
                        {t('shell.bottomBar.windSpeed', {
                          speed: weatherData.current.windSpeed as string
                        })}
                      </span>
                    </div>
                    {(weatherData.daily as Record<string, unknown>[]).length > 0 && (
                      <div
                        className="mt-3 pt-2 border-t flex gap-3 text-xs"
                        style={{ borderColor: colorTextSecondary }}
                      >
                        {(weatherData.daily as Record<string, unknown>[])
                          .slice(0, 3)
                          .map((d, i) => (
                            <div key={i} className="text-center flex-1">
                              <div style={{ color: colorText }}>{d.label as string}</div>
                              <div style={{ color: colorTextSecondary }}>
                                {d.weatherDesc as string}
                              </div>
                              <div style={{ color: colorText }}>
                                {d.tempMax as string}°/{d.tempMin as string}°
                              </div>
                            </div>
                          ))}
                      </div>
                    )}
                  </>
                ) : (
                  <span style={{ color: colorTextSecondary }}>
                    {t('shell.bottomBar.weatherUnavailable')}
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        <div className="frame-bottombar-track">
          <div
            className="frame-bottombar-item"
            style={{ color: colorText }}
            onMouseEnter={handleCarouselEnter}
          >
            {ActiveTab ? (
              <PluginBoundary
                pluginId={activePluginId}
                surface="bottomBar"
                quiet
                fallback={
                  <span className="flex items-center gap-1.5" style={{ color: colorTextSecondary }}>
                    {t('shell.pluginBoundary.unavailable')}
                  </span>
                }
              >
                <ActiveTab />
              </PluginBoundary>
            ) : (
              <span className="flex items-center gap-1.5">
                <RiSunCloudyLine size={14} />
                {weatherData?.current
                  ? `${weatherData.current.temp}° ${weatherData.current.weatherDesc}`
                  : weatherCity || t('shell.bottomBar.weather')}
              </span>
            )}
          </div>
          <div className="frame-bottombar-dots">
            {carouselItems.map((_, idx) => (
              <span
                key={idx}
                className="frame-bottombar-dot"
                style={
                  idx === carouselIndex
                    ? { width: 16, borderRadius: 3, background: colorPrimary }
                    : undefined
                }
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

export default BottomBar
