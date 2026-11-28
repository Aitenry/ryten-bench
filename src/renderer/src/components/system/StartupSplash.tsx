import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { theme } from 'antd'
import { useTranslation } from '@renderer/i18n'
import { useTheme } from '@renderer/hooks/useTheme'
import logo from '@renderer/assets/logo.png'

/**
 * Startup splash inside the main window (per user direction, 2026-11-20).
 *
 * Background: initialization used to show a separate loading window, then hand over to the main
 * window. The splash now lives in the main window: the main window shows first (with this page on
 * top), and once all init tasks (database / migrations / workspace / plugin prefetch) are done and
 * the first main-UI frame is ready, this page fades out to reveal the main UI.
 *
 * 2026-11-21 revision (per user direction): drop the mascot GIF, tagline (title) and progress bar;
 * the page keeps only the logo — it fades in, then floats slowly while a highlight periodically
 * sweeps across it, with sparkles around it; the background is drifting warm soft glows + a dot
 * grid + floating dust.
 * Default minimum display is 2s; only on init failure is a single error line added below the logo.
 */
interface StartupSplashProps {
  /** Notify the root component to remove the splash once the fade-out finishes */
  onDone: () => void
}

/** Minimum splash display time: 2s by default (the full logo animation plays even if init is fast; adjust here) */
const MIN_SPLASH_MS = 2000
/** Fade-out animation duration (matches the transition in main.css) */
const LEAVE_MS = 420
/** Brief hold after completion so the fade-out transition feels natural */
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

  /** Splash palette follows the app theme: cream base + warm gold sparks in light, dark base + brighter gold in dark */
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
        // Background: three soft glow blobs (gold / brand red / warm white) + a dot grid
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
    const loading = window.loading
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
    // The splash may mount after init started (or even after it finished in rare cases): take one snapshot first
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
