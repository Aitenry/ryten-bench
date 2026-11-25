import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Input, theme } from 'antd'
import { RiLock2Line } from '@remixicon/react'
import logo from '@renderer/assets/logo.png'
import { useTranslation } from '@renderer/i18n'
import { useTheme } from '@renderer/hooks/useTheme'
import type { LockScreenProps } from '@renderer/types/components'

/**
 * 锁屏界面（全窗口毛玻璃层）。
 *
 * 设计口径（用户 2026-11-24：「这个功能好鸡肋不能保护用户的数据，弹出窗口高斯模糊度不够」）：
 * - 底层内容直接 `filter: blur(64px)`（**不是**锁屏层的 backdrop-filter：无 GPU / 远程桌面 /
 *   软件合成下它会被静默忽略，只剩一层半透明蒙层，正文照样可读），再把主题色径向压暗；
 * - 卡片是半透明磨砂面（18px backdrop-filter 只是锦上添花，不承担隐私）；
 * - 所有交互（验证、退避、失败原因）都在卡片内完成，不再依赖 antd message
 *   （message 的 z-index 低于本层，旧实现里输错密码的提示其实被盖住了）。
 *
 * 安全边界不在这层 DOM（DOM 里的内容用开发者工具总能读到）：真正防绕过的是主进程持有
 * `locked`、验证在主进程、锁屏期间防截屏 + 拦截刷新/DevTools（见 src/main/lock/service.ts）。
 */
const LockScreen: React.FC<LockScreenProps> = ({ onUnlock }) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const { effectiveTheme } = useTheme()
  const isDark = effectiveTheme === 'dark'

  const [code, setCode] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 退避截止时间戳；> now 时输入框禁用并显示倒计时 */
  const [retryUntil, setRetryUntil] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const otpRef = useRef<React.ComponentRef<typeof Input.OTP>>(null)
  /** 防重入：6 位输满会自动提交，紧接着的 Enter 不能触发第二次校验 */
  const submittingRef = useRef(false)

  const retrySeconds = Math.max(0, Math.ceil((retryUntil - now) / 1000))
  const throttled = retrySeconds > 0

  /** 倒计时跳动；到点自动解除禁用 */
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
   * 锁屏期间把整个应用根节点设为 inert，并直接对根节点做高斯模糊。
   *
   * 为什么不是只靠锁屏层自己的 `backdrop-filter`（真机截图复现过）：无 GPU / 远程桌面 /
   * 软件合成下 Chromium 会静默忽略 backdrop-filter，只剩一层半透明蒙层，正文照样可读。
   * `filter: blur(64px)` 是普通滤镜，不依赖合成器能力，能把 DOM 里的文字真正糊成色块。
   *
   * 同时把 body 下除 #root 与锁屏层之外的直系子节点（antd Modal / message / tooltip 等
   * portal）设为不可见：它们不在 #root 里，不会被上面的滤镜带到，锁屏时不能留一个
   * 「清晰的浮层」在磨砂层下面。
   *
   * 用 layout effect：在浏览器绘制前就把模糊生效，避免锁屏层出现的第一帧里内容还是清晰的。
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
        if (result.ok) return // 主进程会广播 locked=false，父组件随即卸载本组件
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
        // 错误态下把焦点放回第一个格子，用户可以直接重输
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
    // 输满 6 位即提交（比「还要再按一次 Enter」少一步）；Enter 也仍然有效
    if (digits.length === 6) void submit(digits)
  }

  const handleKeyUp = (event: React.KeyboardEvent): void => {
    if (event.key === 'Enter') void submit(code)
  }

  /* 主题色都从 antd token / 当前明暗派生，亮暗切换时锁屏层一起变。
     底色比旧版更实（0.84/0.88）：底层内容已被 blur(64px) 糊成色块，
     这里只需要挡住「还能看出大概轮廓」的那一点细节。 */
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
      {/* 品牌色柔光：底层内容已被糊成色块，这里补一点层次，避免整屏死黑 */}
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
          {/* `type="password"` 而不是 antd 的 `mask`：6.5.1 的布尔 mask 会把原始数字画在
              格子上层（6.5.3 才修），锁屏内容等于没隐藏。原生 password 在所有版本都生效。 */}
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
