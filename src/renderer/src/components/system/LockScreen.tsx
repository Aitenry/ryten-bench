import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Input, theme } from 'antd'
import { RiLock2Line } from '@remixicon/react'
import logo from '@renderer/assets/logo.png'
import { useTranslation } from '@renderer/i18n'
import { useTheme } from '@renderer/hooks/useTheme'
import type { LockScreenProps } from '@renderer/types/components'

/**
 * Lock screen UI (full-window frosted layer).
 *
 * Design rationale (user, 2026-11-24: "this feature is useless and cannot protect user data; the
 * popup window is not blurry enough"):
 * - the content underneath gets `filter: blur(64px)` directly (**not** the lock layer's
 *   backdrop-filter: without a GPU / on remote desktop / with software compositing it is silently
 *   ignored, leaving only a translucent overlay and still-readable content), plus a radial
 *   darkening in the theme color;
 * - the card is a translucent frosted surface (the 18px backdrop-filter is only a bonus; it does
 *   not carry privacy);
 * - all interaction (verification, backoff, failure reason) happens inside the card and no longer
 *   relies on antd message (message's z-index is below this layer, so in the old implementation
 *   the wrong-password hint was actually covered).
 *
 * The security boundary is not this DOM layer (content in the DOM can always be read with
 * devtools): what really prevents bypassing is that the main process holds `locked`, verification
 * runs in the main process, screenshots are blocked while locked, and refresh/DevTools are
 * intercepted (see `src/main/lock/service.ts`).
 */
const LockScreen: React.FC<LockScreenProps> = ({ onUnlock }) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const { effectiveTheme } = useTheme()
  const isDark = effectiveTheme === 'dark'

  const [code, setCode] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Backoff deadline timestamp; while > now the input is disabled and a countdown is shown */
  const [retryUntil, setRetryUntil] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const otpRef = useRef<React.ComponentRef<typeof Input.OTP>>(null)
  /** Re-entrancy guard: filling all 6 digits submits automatically, so a following Enter must not
   * trigger a second verification */
  const submittingRef = useRef(false)

  const retrySeconds = Math.max(0, Math.ceil((retryUntil - now) / 1000))
  const throttled = retrySeconds > 0

  /** Countdown tick; clears the disabled state once it expires */
  useEffect(() => {
    if (!retryUntil) return
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [retryUntil])

  useEffect(() => {
    if (!retryUntil) return
    if (now < retryUntil) return
    setRetryUntil(0)
    setError(null)
    setCode('')
    otpRef.current?.focus()
  }, [now, retryUntil])

  /**
   * While locked, make the whole app root inert and apply the gaussian blur directly to the root.
   *
   * Why not rely only on the lock layer's own `backdrop-filter` (reproduced on a real device):
   * without a GPU / on remote desktop / with software compositing Chromium silently ignores
   * backdrop-filter, leaving only a translucent overlay and still-readable content.
   * `filter: blur(64px)` is a regular filter that does not depend on compositor capabilities and
   * truly blurs the DOM text into color blocks.
   *
   * Also hide the direct children of body other than #root and the lock layer (antd Modal /
   * message / tooltip portals): they are not inside #root, are not reached by the filter above,
   * and a "clear floating layer" must not be left under the frosted layer while locked.
   *
   * Uses a layout effect: the blur is in effect before the browser paints, so the first frame of
   * the lock layer never shows clear content.
   */
  useLayoutEffect(() => {
    const root = document.getElementById('root')
    document.body.classList.add('lock-screen-active')
    if (root) {
      root.setAttribute('inert', '')
      root.setAttribute('aria-hidden', 'true')
      root.classList.add('app-root--locked')
    }
    return () => {
      document.body.classList.remove('lock-screen-active')
      if (!root) return
      root.removeAttribute('inert')
      root.removeAttribute('aria-hidden')
      root.classList.remove('app-root--locked')
    }
  }, [])

  const submit = useCallback(
    async (value: string): Promise<void> => {
      if (submittingRef.current || throttled) return
      if (!/^\d{6}$/.test(value)) return
      submittingRef.current = true
      setPending(true)
      setError(null)
      try {
        const result = await onUnlock(value)
        if (result.ok) return // parent unmounts this component after locked=false broadcast
        setCode('')
        if (result.reason === 'throttled') {
          const waitMs = Math.max(result.retryAfterMs ?? 5_000, 1_000)
          setRetryUntil(Date.now() + waitMs)
          setNow(Date.now())
          setError(t('shell.unlock.throttled', { seconds: Math.ceil(waitMs / 1_000) }))
        } else if (result.reason === 'unavailable') {
          setError(t('shell.unlock.unavailable'))
        } else if ((result.attemptsLeft ?? 0) > 0) {
          setError(t('shell.unlock.attemptsLeft', { n: result.attemptsLeft }))
          if (result.retryAfterMs) {
            setRetryUntil(Date.now() + result.retryAfterMs)
            setNow(Date.now())
          }
        } else {
          setError(t('shell.unlock.failed'))
          if (result.retryAfterMs) {
            setRetryUntil(Date.now() + result.retryAfterMs)
            setNow(Date.now())
          }
        }
        // In the error state put focus back on the first cell so the user can retype right away
        setTimeout(() => otpRef.current?.focus(), 0)
      } catch (err) {
        console.error('[lock-screen] Unlock request failed:', err)
        setError(t('shell.unlock.verifyFailed'))
        setCode('')
      } finally {
        submittingRef.current = false
        setPending(false)
      }
    },
    [onUnlock, t, throttled]
  )

  const handleChange = (value: string): void => {
    const digits = value.replace(/\D/g, '').slice(0, 6)
    setCode(digits)
    if (error) setError(null)
    // Submit once 6 digits are filled in (one step fewer than pressing Enter again); Enter still
    // works
    if (digits.length === 6) void submit(digits)
  }

  const handleKeyUp = (event: React.KeyboardEvent): void => {
    if (event.key === 'Enter') void submit(code)
  }

  /* All theme colors are derived from antd tokens / the current light-or-dark mode, so the lock
     layer changes along with them. The base is more opaque than before (0.84/0.88): the content
     underneath is already blurred into color blocks by blur(64px), so this only needs to hide the
     last bit of detail that might still hint at shapes. */
  const surface = isDark ? 'rgba(23, 24, 28, 0.84)' : 'rgba(255, 255, 255, 0.88)'
  const borderColor = isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(15, 23, 42, 0.08)'
  const shadow = isDark
    ? '0 36px 100px rgba(0, 0, 0, 0.62), 0 2px 10px rgba(0, 0, 0, 0.32)'
    : '0 36px 100px rgba(15, 23, 42, 0.2), 0 2px 10px rgba(15, 23, 42, 0.08)'
  const emblemBg = isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(15, 23, 42, 0.035)'

  return createPortal(
    <div
      className={`lock-screen-overlay lock-screen-overlay--${isDark ? 'dark' : 'light'}`}
      data-lock-screen="true"
      role="dialog"
      aria-modal="true"
      aria-labelledby="lock-screen-title"
    >
      {/* Brand-color soft glow: the content below is already blurred into blocks, so add a little
          depth here to keep the whole screen from going dead black */}
      <div
        className="lock-screen-glow"
        aria-hidden="true"
        style={{
          background: `radial-gradient(circle, color-mix(in srgb, ${token.colorPrimary} 24%, transparent) 0%, transparent 68%)`
        }}
      />
      <div
        className="lock-screen-card"
        style={{ background: surface, borderColor, boxShadow: shadow }}
      >
        <div className="lock-screen-emblem" style={{ background: emblemBg, borderColor }}>
          <img src={logo} alt="" draggable={false} />
          <span
            className="lock-screen-emblem-badge"
            style={{ background: token.colorPrimary, boxShadow: `0 0 0 3px ${surface}` }}
          >
            <RiLock2Line size={11} color="#fff" />
          </span>
        </div>

        <div className="lock-screen-heading">
          <h2 id="lock-screen-title" style={{ color: token.colorText }}>
            {t('shell.unlock.title')}
          </h2>
          <p style={{ color: token.colorTextSecondary }}>{t('shell.unlock.prompt')}</p>
        </div>

        <div className={`lock-screen-otp-wrap${error ? ' lock-screen-otp-wrap--error' : ''}`}>
          {/* `type="password"` instead of antd's `mask`: the boolean mask in 6.5.1 draws the raw
              digits on top of the cells (fixed in 6.5.3), so the lock screen content is not hidden
              at all. Native password works in every version. */}
          <Input.OTP
            ref={otpRef}
            className="lock-screen-otp otp-fill"
            length={6}
            size="large"
            value={code}
            onChange={handleChange}
            onKeyUp={handleKeyUp}
            formatter={(str) => str.replace(/\D/g, '')}
            type="password"
            autoFocus
            inputMode="numeric"
            autoComplete="off"
            disabled={pending || throttled}
            aria-label={t('shell.unlock.prompt')}
          />
        </div>

        <div className="lock-screen-status" aria-live="polite">
          {error ? (
            <span className="lock-screen-status-error" style={{ color: token.colorError }}>
              {error}
            </span>
          ) : pending ? (
            <span
              className="lock-screen-status-pending"
              style={{ color: token.colorTextSecondary }}
            >
              {t('shell.unlock.verifying')}
            </span>
          ) : (
            <span style={{ color: token.colorTextTertiary }}>{t('shell.unlock.hint')}</span>
          )}
        </div>

        <div
          className="lock-screen-footnote"
          style={{ color: token.colorTextTertiary, borderColor }}
        >
          {t('shell.unlock.privacyNote')}
        </div>
      </div>
    </div>,
    document.body
  )
}

export default LockScreen
