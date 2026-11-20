import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { theme } from 'antd'
import { useTranslation } from '@renderer/i18n'
import { useTheme } from '@renderer/hooks/useTheme'
import logo from '@renderer/assets/logo.png'
import type { Window } from '../../../resource/types/window'

/**
 * 主窗口内的启动页（用户 2026-11-20 口径）。
 *
 * 背景：原先是一个独立的「加载窗口」在初始化时显示，初始化完成后再交接主窗口。
 * 现在把启动页搬进主窗口：主窗口先显示（盖着这一页），所有初始化任务
 * （数据库 / 迁移 / 工作区 / 插件预取）完成、主界面首帧就绪后，这里淡出进入主界面。
 *
 * 2026-11-21 调整（用户口径）：去掉吉祥物 GIF、标语（标题）和进度条，
 * 整页只留 logo —— logo 淡入后缓慢浮动，表面周期性扫过一道高光（亮片），
 * 四周点缀星芒；背景是漂移的暖色柔光 + 点阵 + 浮尘。
 * 默认最短展示 2s；初始化失败时才在 logo 下方补一行错误信息。
 */
interface StartupSplashProps {
  /** 淡出结束后通知根组件移除启动页 */
  onDone: () => void
}

/** 启动页最短展示时间：默认 2s（初始化再快也完整看一轮 logo 动画；要调整改这里） */
const MIN_SPLASH_MS = 2000
/** 淡出动画时长（与 main.css 里的 transition 一致） */
const LEAVE_MS = 420
/** 完成后再停留一小会儿，让淡出衔接得自然些 */
const FINAL_HOLD_MS = 160

const StartupSplash: React.FC<StartupSplashProps> = ({ onDone }) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const { effectiveTheme } = useTheme()
  const isDark = effectiveTheme === 'dark'
  const [error, setError] = useState<string | null>(null)
  const [leaving, setLeaving] = useState(false)
  const mountedAtRef = useRef(performance.now())
  const finishedRef = useRef(false)

  /** 启动页配色跟随应用主题：亮色是奶油底 + 暖金星光，暗色是深底 + 更亮的金 */
  const splashVars = useMemo(
    () =>
      ({
        '--startup-bg': token.colorBgLayout,
        '--startup-error': token.colorError,
        '--startup-glow': isDark ? 'rgba(255, 241, 216, 0.22)' : 'rgba(214, 150, 40, 0.16)',
        '--startup-spark': isDark ? '#ffd88a' : '#d9a01f',
        '--startup-spark-glow': isDark ? 'rgba(255, 200, 110, 0.65)' : 'rgba(217, 160, 31, 0.5)',
        '--startup-shadow': isDark ? 'rgba(0, 0, 0, 0.6)' : 'rgba(28, 24, 18, 0.22)',
        '--startup-logo-ring': isDark ? 'rgba(255, 236, 196, 0.16)' : 'rgba(28, 24, 18, 0.06)',
        // 背景：三团柔光色块（金 / 品牌红 / 暖白）+ 点阵
        '--startup-orb-a': isDark ? 'rgba(255, 178, 92, 0.24)' : 'rgba(246, 198, 118, 0.45)',
        '--startup-orb-b': isDark ? 'rgba(206, 72, 60, 0.22)' : 'rgba(228, 124, 108, 0.3)',
        '--startup-orb-c': isDark ? 'rgba(255, 240, 214, 0.1)' : 'rgba(255, 253, 247, 0.9)',
        '--startup-dot': isDark ? 'rgba(255, 236, 196, 0.07)' : 'rgba(28, 24, 18, 0.055)',
        '--startup-mote': isDark ? 'rgba(255, 220, 160, 0.9)' : 'rgba(198, 140, 48, 0.6)',
        '--startup-mote-glow': isDark ? 'rgba(255, 200, 110, 0.5)' : 'rgba(198, 140, 48, 0.35)'
      }) as React.CSSProperties,
    [token, isDark]
  )

  const finish = useCallback(() => {
    if (finishedRef.current) return
    finishedRef.current = true
    const elapsed = performance.now() - mountedAtRef.current
    const wait = Math.max(0, MIN_SPLASH_MS - elapsed) + FINAL_HOLD_MS
    window.setTimeout(() => {
      setLeaving(true)
      window.setTimeout(onDone, LEAVE_MS)
    }, wait)
  }, [onDone])

  useEffect(() => {
    const loading = (window as unknown as Window).loading
    if (!loading) {
      onDone()
      return
    }
    let disposed = false
    const offComplete = loading.onInitComplete(() => {
      if (!disposed) finish()
    })
    const offError = loading.onInitError((message) => {
      if (!disposed) setError(message)
    })
    // 启动页可能晚于初始化开始（极端情况下甚至已完成）：先取一次快照
    void loading
      .getInitState()
      .then((snapshot) => {
        if (disposed) return
        if (snapshot.error) {
          setError(snapshot.error)
          return
        }
        if (snapshot.complete) finish()
      })
      .catch(() => {})
    return () => {
      disposed = true
      offComplete?.()
      offError?.()
    }
  }, [finish, onDone])

  return (
    <div
      className={`startup-splash${leaving ? ' is-leaving' : ''}`}
      style={splashVars}
      role="status"
      aria-live="polite"
      aria-busy={!error}
      aria-label={t('shell.startup.preparing')}
    >
      <div className="startup-splash-bg" aria-hidden="true">
        <span className="startup-splash-orb startup-splash-orb-a" />
        <span className="startup-splash-orb startup-splash-orb-b" />
        <span className="startup-splash-orb startup-splash-orb-c" />
        <span className="startup-splash-grid" />
        <span className="startup-splash-mote startup-splash-mote-a" />
        <span className="startup-splash-mote startup-splash-mote-b" />
        <span className="startup-splash-mote startup-splash-mote-c" />
        <span className="startup-splash-mote startup-splash-mote-d" />
        <span className="startup-splash-mote startup-splash-mote-e" />
      </div>
      <div className="startup-splash-inner">
        <div className="startup-splash-logo">
          <span className="startup-splash-logo-glow" aria-hidden="true" />
          <div className="startup-splash-logo-float">
            <div
              className={`startup-splash-logo-frame${error ? ' is-error' : ''}`}
              aria-hidden="true"
            >
              <img src={logo} alt="" draggable={false} />
              <span className="startup-splash-logo-sheen" />
            </div>
            <span className="startup-splash-spark startup-splash-spark-a" aria-hidden="true" />
            <span className="startup-splash-spark startup-splash-spark-b" aria-hidden="true" />
            <span className="startup-splash-spark startup-splash-spark-c" aria-hidden="true" />
          </div>
        </div>
        {error ? <div className="startup-splash-error">{error}</div> : null}
      </div>
    </div>
  )
}

export default StartupSplash
