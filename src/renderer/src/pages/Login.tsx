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

/**
 * 独立登录页（`/login`）。
 *
 * 布局：左品牌面板（logo + 定位语 + 3 条能力点 + 极淡网格/柔光背景），右登录卡片
 * （账号 / 密码 / 记住我 + 服务器地址高级折叠 / 错误提示）。外壳在 AppShell 里对
 * `/login` 走独立渲染分支（不显示侧栏），所以这一页占满整个窗口。
 *
 * 颜色全部来自 antd token（经内联 CSS 变量下发给样式表）与 `--shell-*` 同源的颜色语义，
 * 深色模式随主题自动适配；不新增任何依赖。
 */

interface LoginFormValues {
  username: string
  password: string
}

interface RememberedLogin {
  username?: string
  baseUrl?: string
}

/** 「记住我」只保存用户名与服务器地址（绝不在本地保存密码） */
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
    // localStorage 不可用（隐私模式等）时静默跳过：记住我退化为不记忆
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
   * 自动聚焦：没记住用户名时聚焦账号框；记住过用户名时直接跳到密码框。
   * 用 effect 而不是 autoFocus，是为了在「回填了用户名」的场景下把焦点放对位置。
   */
  useEffect(() => {
    if (passwordRefAutoFocused.current) return
    passwordRefAutoFocused.current = true
    if (remembered.username) passwordRef.current?.focus()
    else usernameRef.current?.focus()
  }, [remembered.username])

  /** 服务器地址默认取主进程 status 的基址；用户手动改过之后不再覆盖 */
  useEffect(() => {
    if (serverTouched || serverUrl || !status.baseUrl) return
    setServerUrl(status.baseUrl)
  }, [serverTouched, serverUrl, status.baseUrl])

  /** 已登录用户访问 /login：直接回插件仓库（如需要换号，先在账号菜单里退出登录） */
  useEffect(() => {
    if (loggedIn) navigate('/plugins', { replace: true })
  }, [loggedIn, navigate])

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
        navigate('/plugins', { replace: true })
      } catch (err) {
        setError(err instanceof Error ? err.message : t('login.failure'))
      } finally {
        setSubmitting(false)
      }
    },
    [login, message, navigate, remember, serverUrl, t]
  )

  /** 内联样式变量：把 antd token 映射成样式表可用的 CSS 变量（亮/暗主题自动跟随） */
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
      {/* macOS 交通灯覆盖层下保留可拖拽区域；Windows/Linux 原生标题栏下无副作用 */}
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
                {/* 服务器地址是次要动作：与「记住我」同一行右对齐，展开后输入框落在下一行 */}
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

          <button type="button" className="login-back" onClick={() => navigate('/plugins')}>
            <RiArrowLeftLine size={13} />
            {t('login.back')}
          </button>
        </section>
      </div>
    </div>
  )
}

export default Login
