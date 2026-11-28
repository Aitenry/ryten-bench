import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, App, Button, Checkbox, Form, Input, theme } from 'antd'
import type { InputRef } from 'antd'
import { useNavigate } from 'react-router-dom'
import {
  RiArrowDownSLine,
  RiArrowLeftLine,
  RiCloudLine,
  RiLockPasswordLine,
  RiPlug2Line,
  RiServerLine,
  RiShieldCheckLine,
  RiUser3Line
} from '@remixicon/react'
import logo from '@renderer/assets/logo.png'
import { useTranslation } from '@renderer/i18n'
import { useLattice } from '@renderer/lattice/useLattice'
import { resolveLoginReturn } from '@renderer/utils/login-return'

/**
 * Standalone login page (`/login`).
 *
 * Layout: brand panel on the left (logo + tagline + 3 capability points + a very faint grid and
 * soft-light background), login card on the right (account / password / remember me + collapsible
 * advanced server address / error alert). The shell renders `/login` through a standalone branch
 * (no sidebar), so this page fills the whole window.
 *
 * All colours come from antd tokens (passed to the stylesheet as inline CSS variables) and from
 * the same `--shell-*` colour semantics; dark mode adapts with the theme, with no new dependency.
 */

interface LoginFormValues {
  username: string
  password: string
}

interface RememberedLogin {
  username?: string
  baseUrl?: string
}

/** "Remember me" only stores the username and server address (never the password locally) */
const REMEMBER_KEY = 'rytenbench.lattice.login'

function readRemembered(): RememberedLogin {
  try {
    const raw = window.localStorage.getItem(REMEMBER_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as RememberedLogin | null
    if (!parsed || typeof parsed !== 'object') return {}
    return {
      username: typeof parsed.username === 'string' ? parsed.username : undefined,
      baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : undefined
    }
  } catch {
    return {}
  }
}

function writeRemembered(value: RememberedLogin | null): void {
  try {
    if (value) window.localStorage.setItem(REMEMBER_KEY, JSON.stringify(value))
    else window.localStorage.removeItem(REMEMBER_KEY)
  } catch {
    // When localStorage is unavailable (private mode, etc.) skip silently: remember-me degrades
    // to not remembering
  }
}

const Login: React.FC = () => {
  const { token } = theme.useToken()
  const { message } = App.useApp()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { available, ready, status, loggedIn, login } = useLattice()

  const [remembered] = useState<RememberedLogin>(() => readRemembered())
  const [remember, setRemember] = useState<boolean>(Boolean(remembered.username))
  const [serverUrl, setServerUrl] = useState(remembered.baseUrl ?? '')
  const [serverTouched, setServerTouched] = useState(false)
  const [serverOpen, setServerOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const usernameRef = useRef<InputRef>(null)
  const passwordRef = useRef<InputRef>(null)
  const passwordRefAutoFocused = useRef(false)

  /**
   * Auto focus: focus the username field when no username was remembered, otherwise jump
   * straight to the password field. An effect instead of autoFocus keeps the focus in the right
   * place when a username was pre-filled.
   */
  useEffect(() => {
    if (passwordRefAutoFocused.current) return
    passwordRefAutoFocused.current = true
    if (remembered.username) passwordRef.current?.focus()
    else usernameRef.current?.focus()
  }, [remembered.username])

  /** Server address defaults to the base URL in main-process status; manual edits are kept */
  useEffect(() => {
    if (serverTouched || serverUrl || !status.baseUrl) return
    setServerUrl(status.baseUrl)
  }, [serverTouched, serverUrl, status.baseUrl])

  /**
   * Single exit for the login page: return to **the page the user came from** (see
   * utils/login-return.ts).
   *
   * The three exits used to hard-code `/plugins`: arriving from the "not logged in" prompt on a
   * conversation page and clicking "back to workbench" landed in the plugin repository, with the
   * plugin session still remembered in the sidebar while the main area showed a different page
   * (user feedback 2026-11-23). Arriving from the plugin repository still records the plugin
   * repository, so that behaviour is unchanged.
   *
   * Uses replace instead of push: the login page is a one-off intermediate page and "back" must
   * not return to it after leaving.
   */
  const leaveLogin = useCallback((): void => {
    navigate(resolveLoginReturn(), { replace: true })
  }, [navigate])

  /** Logged-in users hitting /login go straight back to the previous page (to switch accounts,
   *  log out from the account menu first) */
  useEffect(() => {
    if (loggedIn) leaveLogin()
  }, [loggedIn, leaveLogin])

  const handleFinish = useCallback(
    async (values: LoginFormValues): Promise<void> => {
      setError(null)
      setSubmitting(true)
      try {
        const username = values.username.trim()
        const result = await login({
          username,
          password: values.password,
          baseUrl: serverUrl.trim() || undefined
        })
        if (!result.ok) {
          setError(result.error || t('login.failure'))
          return
        }
        writeRemembered(remember ? { username, baseUrl: serverUrl.trim() } : null)
        message.success(t('login.success'))
        leaveLogin()
      } catch (err) {
        setError(err instanceof Error ? err.message : t('login.failure'))
      } finally {
        setSubmitting(false)
      }
    },
    [login, message, leaveLogin, remember, serverUrl, t]
  )

  /** Inline style variables: map antd tokens to CSS variables for the stylesheet (the light and
   *  dark themes follow automatically) */
  const loginVars = useMemo(
    () =>
      ({
        '--login-bg': token.colorBgLayout,
        '--login-panel-bg': token.colorBgContainer,
        '--login-border': token.colorBorderSecondary,
        '--login-grid-line': token.colorFillQuaternary,
        '--login-glow-a': token.colorPrimaryBg,
        '--login-glow-b': token.colorFillTertiary,
        '--login-text': token.colorText,
        '--login-text-secondary': token.colorTextSecondary,
        '--login-text-tertiary': token.colorTextTertiary,
        '--login-primary': token.colorPrimary,
        '--login-primary-bg': token.colorPrimaryBg,
        '--login-primary-border': token.colorPrimaryBorder,
        '--login-card-shadow': token.boxShadow
      }) as React.CSSProperties,
    [token]
  )

  const capabilities = useMemo(
    () => [
      {
        key: 'hub',
        icon: <RiPlug2Line size={17} />,
        title: t('login.brand.point1Title'),
        description: t('login.brand.point1Desc')
      },
      {
        key: 'sync',
        icon: <RiCloudLine size={17} />,
        title: t('login.brand.point2Title'),
        description: t('login.brand.point2Desc')
      },
      {
        key: 'local',
        icon: <RiShieldCheckLine size={17} />,
        title: t('login.brand.point3Title'),
        description: t('login.brand.point3Desc')
      }
    ],
    [t]
  )

  const submitDisabled = !available
  const connecting = ready === false && available

  return (
    <div className="login-page" style={loginVars}>
      {/* Keeps a draggable region under the macOS traffic lights; harmless with the native
          Windows/Linux title bar */}
      <div className="login-drag-region" />

      <div className="login-shell">
        <section className="login-brand" aria-label={t('login.brand.tagline')}>
          <div className="login-brand-grid" aria-hidden="true" />
          <div className="login-brand-glow login-brand-glow-a" aria-hidden="true" />
          <div className="login-brand-glow login-brand-glow-b" aria-hidden="true" />
          <div className="login-brand-inner">
            <div className="login-brand-mark">
              <img className="login-brand-logo" src={logo} alt="RytenBench" />
              <span className="login-brand-name">RytenBench</span>
            </div>
            <h2 className="login-brand-tagline">{t('login.brand.tagline')}</h2>
            <ul className="login-capabilities">
              {capabilities.map((capability) => (
                <li className="login-capability" key={capability.key}>
                  <span className="login-capability-icon">{capability.icon}</span>
                  <span className="login-capability-copy">
                    <span className="login-capability-title">{capability.title}</span>
                    <span className="login-capability-desc">{capability.description}</span>
                  </span>
                </li>
              ))}
            </ul>
            <div className="login-brand-foot">
              <span className="login-brand-dot" aria-hidden="true" />
              {t('login.brand.footer')}
            </div>
          </div>
        </section>

        <section className="login-panel custom-scrollbar">
          <div className="login-card">
            <header className="login-card-head">
              <h1 className="login-card-title">{t('login.title')}</h1>
              <p className="login-card-subtitle">{t('login.subtitle')}</p>
            </header>

            {!available && (
              <Alert
                className="login-alert"
                type="warning"
                showIcon
                message={t('login.bridgeUnavailableTitle')}
                description={t('login.bridgeUnavailableDesc')}
              />
            )}

            {error && (
              <Alert
                className="login-alert"
                type="error"
                showIcon
                closable
                onClose={() => setError(null)}
                message={t('login.errorTitle')}
                description={error}
              />
            )}

            <Form<LoginFormValues>
              className="login-form"
              layout="vertical"
              requiredMark={false}
              initialValues={{ username: remembered.username ?? '', password: '' }}
              onFinish={(values) => void handleFinish(values)}
            >
              <Form.Item
                name="username"
                label={t('login.username')}
                rules={[{ required: true, whitespace: true, message: t('login.usernameRequired') }]}
              >
                <Input
                  ref={usernameRef}
                  size="large"
                  prefix={<RiUser3Line size={15} />}
                  placeholder={t('login.usernamePlaceholder')}
                  autoComplete="username"
                  autoFocus
                  spellCheck={false}
                />
              </Form.Item>
              <Form.Item
                name="password"
                label={t('login.password')}
                rules={[{ required: true, message: t('login.passwordRequired') }]}
              >
                <Input.Password
                  ref={passwordRef}
                  size="large"
                  prefix={<RiLockPasswordLine size={15} />}
                  placeholder={t('login.passwordPlaceholder')}
                  autoComplete="current-password"
                />
              </Form.Item>

              <div className="login-form-row">
                <Checkbox checked={remember} onChange={(e) => setRemember(e.target.checked)}>
                  {t('login.remember')}
                </Checkbox>
                {/* The server address is a secondary action: right-aligned on the "remember me"
                    row, with its input opening on the next line */}
                <button
                  type="button"
                  className="login-advanced-toggle"
                  onClick={() => setServerOpen((open) => !open)}
                  aria-expanded={serverOpen}
                >
                  <RiServerLine size={13} />
                  <span>{t('login.server.label')}</span>
                  <RiArrowDownSLine
                    size={13}
                    className={`login-advanced-chevron${serverOpen ? ' is-open' : ''}`}
                  />
                </button>
              </div>

              {serverOpen && (
                <div className="login-advanced-body">
                  <Input
                    value={serverUrl}
                    onChange={(e) => {
                      setServerTouched(true)
                      setServerUrl(e.target.value)
                    }}
                    placeholder={t('login.server.placeholder')}
                    spellCheck={false}
                  />
                  <div className="login-advanced-hint">{t('login.server.hint')}</div>
                </div>
              )}

              <Button
                className="login-submit"
                type="primary"
                size="large"
                htmlType="submit"
                block
                loading={submitting || connecting}
                disabled={submitDisabled}
              >
                {submitting ? t('login.submitting') : t('login.submit')}
              </Button>
            </Form>
          </div>

          <button type="button" className="login-back" onClick={leaveLogin}>
            <RiArrowLeftLine size={13} />
            {t('login.back')}
          </button>
        </section>
      </div>
    </div>
  )
}

export default Login
