import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { App, Badge, Dropdown, Modal, theme } from 'antd'
import type { MenuProps } from 'antd'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import {
  RiAccountCircleLine,
  RiAiAgentLine,
  RiApps2Line,
  RiBellLine,
  RiBook2Line,
  RiCalendar2Line,
  RiBrain4Line,
  RiFileAi2Line,
  RiLoader4Line,
  RiLogoutBoxRLine,
  RiMoonLine,
  RiPlug2Line,
  RiRefreshLine,
  RiSettings3Line,
  RiSunLine,
  RiUserLine
} from '@remixicon/react'
import MainRoutes from '@renderer/route/MainRoutes'
import logo from '@renderer/assets/logo.png'
import { useNotification } from '@renderer/hooks/useNotification'
import { useTheme } from '@renderer/hooks/useTheme'
import { usePlugins, usePluginRoutes } from '@renderer/plugin-host/PluginHostContext'
import { setWindowTitleSource } from '@renderer/window-title'
import { rememberLoginReturn } from '@renderer/utils/login-return'
import { useTranslation } from '@renderer/i18n'
import { useLattice } from '@renderer/lattice/useLattice'
import { LatticeUserAvatar } from '@renderer/lattice/UserAvatar'
import { formatSyncTime } from '@renderer/lattice/format'
import NotificationList from '../NotificationList'
import { openSettingsModal } from '../settings/settings-modal-state'
import AssistantSidebar from './AssistantSidebar'
import AppUpdateEntry from '../update/AppUpdateEntry'
import ShellTitleBar from './ShellTitleBar'

/**
 * The new system shell.
 *
 * Structurally three layers:
 * - Custom title bar (Windows / macOS): app menu (App / Edit) on the left, and on the right the
 *   **system-drawn** minimize/maximize/close (Window Controls Overlay, see main-window.ts);
 * - System sidebar: brand → library / plugin repository / more content → harness capsule sidebar
 *   (conversation/work/plugins) → memory (inside AssistantSidebar) → user area;
 * - Main content area: the current system page (conversation / library / plugin repository / more
 *   content).
 *
 * Linux has no WCO: the main process falls back to the native system frame and no title bar is
 * rendered here, avoiding two title strips. All colors are derived from antd theme tokens, so the
 * whole shell changes together when the light/dark setting switches. The former CustomFrame /
 * TitleBar / RightBar / BottomBar are removed; the shell is no longer driven by a plugin registry.
 */
/**
 * Display copy for known roles; unknown roles are shown as-is (do not guess "member", to avoid
 * misleading)
 */
const ROLE_LABEL_KEYS = {
  admin: 'lattice.account.roleAdmin',
  owner: 'lattice.account.roleAdmin',
  maintainer: 'lattice.account.roleMaintainer',
  ops: 'lattice.account.roleMaintainer',
  member: 'lattice.account.roleMember',
  user: 'lattice.account.roleMember'
} as const

const ShellUserArea: React.FC = () => {
  const [notifOpen, setNotifOpen] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)
  const { unreadCount } = useNotification()
  const { effectiveTheme, setThemeMode } = useTheme()
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const { message, modal } = App.useApp()
  const navigate = useNavigate()
  const { available, ready, status, loggedIn, user, avatar, role, syncing, sync, logout } =
    useLattice()
  /**
   * Bell + notification panel share one positioning container: the panel floats above the user
   * area, left-aligned, width = sidebar width
   */
  const dockRef = useRef<HTMLDivElement>(null)
  const handleSettings = useCallback(() => {
    setNotifOpen(false)
    openSettingsModal()
  }, [])

  /**
   * Quick light/dark toggle to the right of the settings button: one button flips between moon /
   * sun (auto mode is still selectable in settings)
   */
  const isDark = effectiveTheme === 'dark'
  const toggleTheme = useCallback(() => {
    // Clicking once in auto mode → land on the explicit opposite theme
    void setThemeMode(isDark ? 'light' : 'dark')
  }, [isDark, setThemeMode])

  // When the panel is open: clicking anywhere outside the panel/bell, or pressing Esc, closes it
  useEffect(() => {
    if (!notifOpen) return
    const onPointerDown = (e: MouseEvent): void => {
      if (!dockRef.current?.contains(e.target as Node)) setNotifOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setNotifOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [notifOpen])

  /**
   * Account area display data all comes from the real login state (the former hard-coded E /
   * Eddie / local workspace is removed)
   */
  const displayName = user?.display_name?.trim() || user?.username?.trim() || ''
  const conflicts = status.sync?.conflicts ?? 0
  const syncError = status.sync?.error
  const lastSyncLabel = formatSyncTime(status.sync?.at) ?? t('sync.never')
  const connecting = available && !ready

  const roleLabel = useMemo(() => {
    const normalized = role?.trim().toLowerCase()
    if (normalized && normalized in ROLE_LABEL_KEYS) {
      return t(ROLE_LABEL_KEYS[normalized as keyof typeof ROLE_LABEL_KEYS])
    }
    return role?.trim() || t('lattice.account.connected')
  }, [role, t])

  const handleSyncNow = useCallback(async (): Promise<void> => {
    const result = await sync('both')
    if (result.error) {
      message.error(t('sync.error', { reason: result.error }))
      return
    }
    const autoInstalled = result.autoInstall?.installed.length ?? 0
    const autoFailed = result.autoInstall?.failed.length ?? 0
    if (autoFailed > 0) {
      // Some plugins were not installed: report the count, and clicking the notice goes to the
      // plugin repository's "sync details" for each failure reason (never silent)
      message.warning({
        content:
          autoInstalled > 0
            ? t('sync.autoInstall.partial', { ok: autoInstalled, fail: autoFailed })
            : t('sync.autoInstall.allFailed', { fail: autoFailed }),
        onClick: () => navigate('/plugins')
      })
      return
    }
    const base = t('sync.success', {
      pushed: result.pushed ?? 0,
      pulled: result.pulled ?? 0,
      pushedRows: result.pushedRows ?? 0,
      pulledRows: result.pulledRows ?? 0
    })
    message.success(
      autoInstalled > 0 ? `${base} · ${t('sync.autoInstall.done', { n: autoInstalled })}` : base
    )
  }, [message, navigate, sync, t])

  const handleLogout = useCallback((): void => {
    setAccountOpen(false)
    modal.confirm({
      title: t('lattice.account.logoutTitle'),
      content: t('lattice.account.logoutBody'),
      okText: t('lattice.account.logoutConfirm'),
      cancelText: t('common.action.cancel'),
      okButtonProps: { danger: true },
      onOk: async () => {
        const result = await logout()
        if (result.ok) message.success(t('lattice.account.logoutSuccess'))
        else message.error(t('lattice.account.logoutFail'))
      }
    })
  }, [logout, message, modal, t])

  const userMenuItems = useMemo<MenuProps['items']>(
    () =>
      loggedIn
        ? [
            {
              key: 'account',
              icon: <RiAccountCircleLine size={15} />,
              label: t('lattice.account.accountInfo')
            },
            { key: 'hub', icon: <RiApps2Line size={15} />, label: t('lattice.account.hub') },
            {
              key: 'sync',
              icon: <RiRefreshLine size={15} />,
              label: t('lattice.account.syncNow'),
              disabled: syncing
            },
            { type: 'divider' as const },
            {
              key: 'logout',
              icon: <RiLogoutBoxRLine size={15} />,
              label: t('lattice.account.logout'),
              danger: true
            }
          ]
        : [],
    [loggedIn, syncing, t]
  )

  const handleUserMenuClick: MenuProps['onClick'] = useCallback(
    ({ key }) => {
      if (key === 'account') {
        setAccountOpen(true)
        return
      }
      if (key === 'hub') {
        navigate('/plugins')
        return
      }
      if (key === 'sync') {
        void handleSyncNow()
        return
      }
      if (key === 'logout') handleLogout()
    },
    [handleLogout, handleSyncNow, navigate]
  )

  /**
   * Field rows of the account info modal. Avatar / display_name / username / role are shown in the
   * identity card at the top of the modal; only the remaining diagnostic fields are kept here (to
   * avoid showing the same information twice).
   */
  const accountRows: Array<[string, string]> = [
    [t('lattice.account.userId'), user?.id || '—'],
    [t('lattice.account.server'), status.baseUrl || '—'],
    /* The value is the right column; labels must not contain {{time}} / {{n}} placeholders (t()
       shows them verbatim without interpolation) */
    [t('lattice.account.lastSync'), lastSyncLabel],
    [t('lattice.account.conflicts'), String(conflicts)]
  ]

  const guestName = !available
    ? t('lattice.account.bridgeUnavailable')
    : connecting
      ? t('lattice.account.connecting')
      : t('lattice.account.guest')

  return (
    <div className="shell-user-dock" ref={dockRef}>
      {notifOpen && (
        <div
          className="shell-notif-panel"
          role="dialog"
          aria-label={t('shell.notificationList.title')}
          style={{
            background: token.colorBgElevated,
            borderColor: token.colorBorderSecondary,
            boxShadow: '0 14px 36px rgba(0, 0, 0, 0.38), 0 2px 8px rgba(0, 0, 0, 0.24)'
          }}
        >
          <NotificationList onClose={() => setNotifOpen(false)} />
        </div>
      )}
      <div className="shell-user">
        {loggedIn ? (
          <Dropdown
            menu={{ items: userMenuItems, onClick: handleUserMenuClick }}
            trigger={['click']}
            placement="topLeft"
          >
            <button className="shell-user-trigger" type="button" title={displayName}>
              <Badge
                count={conflicts}
                size="small"
                offset={[-3, 3]}
                style={{
                  boxShadow: `0 0 0 2px ${token.colorBgLayout}`,
                  fontSize: 8,
                  height: 14,
                  minWidth: 14,
                  lineHeight: '14px',
                  padding: '0 3px'
                }}
              >
                <LatticeUserAvatar
                  avatar={avatar}
                  name={user?.display_name || user?.username}
                  size={26}
                />
              </Badge>
              <span className="shell-user-copy">
                <span className="shell-user-name" title={displayName}>
                  {displayName}
                </span>
                <span
                  className="shell-user-sub"
                  style={{
                    color: syncing
                      ? token.colorPrimary
                      : conflicts > 0
                        ? token.colorWarning
                        : token.colorTextTertiary
                  }}
                >
                  {syncing ? (
                    <>
                      <RiLoader4Line size={9} className="animate-spin" />
                      {t('sync.syncing')}
                    </>
                  ) : (
                    <>
                      {roleLabel}
                      {conflicts > 0 ? ` · ${t('sync.conflictsShort', { n: conflicts })}` : ''}
                    </>
                  )}
                </span>
              </span>
            </button>
          </Dropdown>
        ) : (
          <button
            type="button"
            className="shell-user-trigger"
            onClick={() => navigate('/login')}
            title={available ? t('lattice.account.goLogin') : t('lattice.errors.bridgeUnavailable')}
          >
            <span className="shell-avatar shell-avatar-guest">
              {connecting ? (
                <RiLoader4Line size={13} className="animate-spin" />
              ) : (
                <RiUserLine size={14} />
              )}
            </span>
            <span className="shell-user-copy">
              <span className="shell-user-name">{guestName}</span>
              {/* User 2026-11-21: in the logged-out state keep only "not logged in" and no longer
                  show the "click to log in" line; the whole row is still a button, and the hover
                  title hints that login is possible. The bridge being unavailable is an abnormal
                  state, so keep the hint. */}
              {!available && (
                <span className="shell-user-sub">{t('lattice.account.bridgeHint')}</span>
              )}
            </span>
          </button>
        )}
        <div className="shell-user-actions">
          <button
            className="shell-icon-btn shell-icon-btn-bell"
            title={t('shell.notificationList.title')}
            aria-expanded={notifOpen}
            onClick={() => setNotifOpen((v) => !v)}
          >
            <RiBellLine size={16} />
            {unreadCount > 0 && <span className="shell-unread-dot" />}
          </button>
          <button
            className="shell-icon-btn"
            onClick={handleSettings}
            title={t('shell.titleBar.settings')}
          >
            <RiSettings3Line size={16} />
          </button>
          <button
            className="shell-icon-btn"
            onClick={toggleTheme}
            title={t(isDark ? 'shell.appearance.toLight' : 'shell.appearance.toDark')}
            aria-label={t(isDark ? 'shell.appearance.toLight' : 'shell.appearance.toDark')}
          >
            {isDark ? <RiSunLine size={16} /> : <RiMoonLine size={16} />}
          </button>
        </div>
      </div>

      {/* Account info modal: read-only display of the real login state. User 2026-11-21: remove
          the bottom "Close / Log out" — the X in the top right already closes it, and log out is
          available in the account menu; repeating it in the modal is just noise. The avatar is
          read-only here; no edit entry is placed in this modal. */}
      <Modal
        open={accountOpen}
        onCancel={() => setAccountOpen(false)}
        width={420}
        destroyOnHidden
        title={t('lattice.account.title')}
        footer={null}
      >
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {/* Identity card: avatar + display_name + username + role (the same real login state as
              the account area) */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              paddingBottom: 14,
              borderBottom: `1px solid ${token.colorBorderSecondary}`
            }}
          >
            <LatticeUserAvatar
              avatar={avatar}
              name={user?.display_name || user?.username}
              size={56}
            />
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  color: token.colorText,
                  fontSize: 16,
                  fontWeight: 600,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
              >
                {displayName || '—'}
              </div>
              <div style={{ marginTop: 2, color: token.colorTextTertiary, fontSize: 12 }}>
                @{user?.username || '—'} · {roleLabel}
              </div>
            </div>
          </div>
          {accountRows.map(([label, value]) => (
            <div
              key={label}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                padding: '8px 0',
                borderBottom: `1px solid ${token.colorBorderSecondary}`,
                fontSize: 11.5
              }}
            >
              <span style={{ color: token.colorTextTertiary, flexShrink: 0 }}>{label}</span>
              <span
                style={{
                  color: token.colorTextSecondary,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  textAlign: 'right'
                }}
              >
                {value}
              </span>
            </div>
          ))}
          {syncError && (
            <div style={{ marginTop: 10, fontSize: 10.5, color: token.colorError }}>
              {t('sync.error', { reason: syncError })}
            </div>
          )}
        </div>
      </Modal>
    </div>
  )
}

/**
 * Make the **system-drawn native title bar / window frame** follow the app theme.
 *
 * Windows now uses the native system title bar (user 2026-11-20: drop the custom title bar + WCO).
 * Its light/dark appearance is determined by the system's per-window dark mode property: on the
 * Electron side only nativeTheme.themeSource is honored. Syncing in a layout effect (before paint)
 * means the title bar already has the target appearance when the UI repaints.
 */
const NativeThemeSync: React.FC = () => {
  const { effectiveTheme } = useTheme()
  useLayoutEffect(() => {
    try {
      ;window.api.window.setNativeTheme(effectiveTheme)
    } catch {
      // Ignore when the platform does not support it (Linux etc.)
    }
  }, [effectiveTheme])
  return null
}

const AppShell: React.FC = () => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const location = useLocation()
  const navigate = useNavigate()
  const pluginRoutes = usePluginRoutes()
  const plugins = usePlugins()

  /**
   * The version number comes from the real version in the main process (`app-version` IPC), no
   * longer hard-coded. The text is not rendered before it is read, to avoid flashing a wrong
   * version first.
   */
  const [appVersion, setAppVersion] = useState('')
  useEffect(() => {
    let cancelled = false
    const loading = window.loading
    if (!loading) return
    void loading
      .getAppVersion()
      .then((version) => {
        if (!cancelled) setAppVersion(version)
      })
      .catch(() => {
        // If it cannot be read, do not show a version number: better absent than wrong
      })
    return () => {
      cancelled = true
    }
  }, [])

  /**
   * Native window title: computed as `xxx - RytenBench` from the current page/plugin/mode.
   *
   * - Library / plugin repository / more content: fixed page names;
   * - Conversation page (/harness): written by the harness sidebar according to the
   *   "conversation/work/plugins" mode;
   * - Third-party plugin routes: the name from the plugin manifest.
   */
  useEffect(() => {
    const path = location.pathname
    // Login page: `Login - RytenBench` (window title mechanism same as other system pages)
    if (path === '/login') {
      setWindowTitleSource('route', t('login.windowTitle'))
      return
    }
    if (path === '/harness' || path.startsWith('/harness/')) {
      setWindowTitleSource('route', '')
      return
    }
    if (path === '/notes' || path.startsWith('/notes/')) {
      setWindowTitleSource('route', t('shell.windowTitle.library'))
      return
    }
    if (path === '/plugins' || path.startsWith('/plugins/')) {
      setWindowTitleSource('route', t('shell.windowTitle.pluginRepo'))
      return
    }
    if (path === '/more' || path.startsWith('/more/')) {
      // "More" is the container for assistant settings: the window title uses the specific page
      // name (agents / skills / …), falling back to the container name when there is no tab or it
      // is unknown.
      const tab = path.split('/')[2]
      const label =
        tab && ['agents', 'skills', 'memory', 'mcp'].includes(tab)
          ? t(`settings.nav.${tab}` as never)
          : t('shell.windowTitle.more')
      setWindowTitleSource('route', label)
      return
    }
    const matched = pluginRoutes
      .filter((r) => path === r.path || path.startsWith(`${r.path}/`))
      .sort((a, b) => b.path.length - a.path.length)[0]
    if (matched) {
      const name = plugins.find((p) => p.manifest.id === matched.pluginId)?.manifest.name
      setWindowTitleSource('route', name || t('shell.windowTitle.pluginRepo'))
      return
    }
    setWindowTitleSource('route', '')
  }, [location.pathname, pluginRoutes, plugins, t])

  /**
   * Remember the page the login page should return to (see utils/login-return.ts).
   *
   * The login page is a full-window standalone layout, but it is still an ordinary route in the
   * same run: whichever page login was entered from, returning goes back to that page (coming back
   * to the conversation page still shows that session, coming back to the plugin repository still
   * shows the plugin repository). The login page itself does not record this, otherwise "back to
   * workspace" would stop at the login page again.
   */
  useEffect(() => {
    if (location.pathname === '/login') return
    rememberLoginReturn(`${location.pathname}${location.search}${location.hash}`)
  }, [location.pathname, location.search, location.hash])

  /**
   * Global "open settings" event:
   * - assistant settings with `scope=assistant` go to the standalone "more" page;
   * - everything else (title bar app menu, "configure model" on the conversation page, etc.) still
   *   opens the settings modal.
   */
  useEffect(() => {
    /**
     * The four items supported by the standalone "more" page; other tabs (e.g. the plugin workshop)
     * still belong to the settings modal.
     */
    const MORE_TABS = ['agents', 'skills', 'memory', 'mcp']
    const handler = (e: Event): void => {
      const detail = (e as CustomEvent).detail as { tab?: string; scope?: string } | undefined
      if (detail?.scope === 'assistant') {
        // Only these four are real "more content" pages; an unknown tab opens the corresponding
        // tab of the settings modal directly, rather than sending the user to /more/<unknown>
        // (which would fall back to the agents page and get the address bar stuck).
        if (!detail.tab || MORE_TABS.includes(detail.tab)) {
          navigate(detail.tab ? `/more/${detail.tab}` : '/more')
        } else {
          openSettingsModal(detail.tab)
        }
        return
      }
      openSettingsModal(detail?.tab)
    }
    window.addEventListener('open-system-settings', handler)
    return () => window.removeEventListener('open-system-settings', handler)
  }, [navigate])

  /** Sidebar "More" dropdown: only assistant settings (user 2026-11-20: "only the assistant's") */
  const assistantSettingsItems: MenuProps['items'] = [
    { key: 'agents', icon: <RiAiAgentLine size={15} />, label: t('settings.nav.agents') },
    { key: 'skills', icon: <RiFileAi2Line size={15} />, label: t('settings.nav.skills') },
    { key: 'memory', icon: <RiBrain4Line size={15} />, label: t('settings.nav.memory') },
    { key: 'mcp', icon: <RiPlug2Line size={15} />, label: t('settings.nav.mcp') }
  ]
  const isMoreActive = location.pathname === '/more' || location.pathname.startsWith('/more/')

  const shellVars = {
    '--shell-bg': token.colorBgLayout,
    '--shell-titlebar-bg': token.colorBgLayout,
    '--shell-sidebar-bg': token.colorBgLayout,
    '--shell-border': token.colorBorderSecondary,
    '--shell-text': token.colorText,
    '--shell-text-secondary': token.colorTextSecondary,
    '--shell-text-tertiary': token.colorTextTertiary,
    '--shell-hover': token.colorFillQuaternary,
    '--shell-active': token.colorFillTertiary,
    /* The "click to log in" link color in the account area and the logged-in avatar gradient both
       use the primary color, following the theme */
    '--shell-primary': token.colorPrimary
  } as React.CSSProperties

  const platform = window.api.platform
  // Windows uses the native system title bar (the custom title strip is no longer rendered);
  // macOS still keeps the custom strip + traffic-light spacing
  const showTitleBar = platform === 'darwin'

  /**
   * The login page is a **full-window standalone layout**: no sidebar, user area or title strip is
   * rendered; only theme sync and the route content remain. Thus `/login` is still an ordinary
   * route in MainRoutes, but visually not wrapped by the shell (a two-column split filling the
   * window).
   */
  if (location.pathname === '/login') {
    return (
      <div className="shell-standalone">
        <NativeThemeSync />
        <MainRoutes />
      </div>
    )
  }

  return (
    <div className="shell-root" style={shellVars}>
      <NativeThemeSync />
      {showTitleBar && <ShellTitleBar />}

      <div className="shell-body">
        <aside className="shell-sidebar">
          <div className="shell-brand">
            <img className="shell-brand-logo" src={logo} alt="RytenBench" />
            <span className="shell-brand-text">
              <span className="shell-brand-name">RytenBench</span>
              {appVersion && <span className="shell-brand-ver">{appVersion}</span>}
            </span>
            <AppUpdateEntry currentVersion={appVersion} />
          </div>

          <nav className="shell-nav">
            <NavLink
              to="/notes"
              className={({ isActive }) => `shell-nav-item${isActive ? ' active' : ''}`}
            >
              <RiBook2Line size={16} />
              {t('shell.nav.library')}
            </NavLink>
            <NavLink
              to="/plugins"
              className={({ isActive }) => `shell-nav-item${isActive ? ' active' : ''}`}
            >
              <RiApps2Line size={16} />
              {t('shell.nav.pluginRepo')}
            </NavLink>
            <NavLink
              to="/schedules"
              className={({ isActive }) => `shell-nav-item${isActive ? ' active' : ''}`}
            >
              <RiCalendar2Line size={16} />
              {t('shell.nav.schedules')}
            </NavLink>
            {/* Assistant settings are collected in the "More" dropdown (below the plugin
                repository): pick one → the whole page shows its content */}
            <Dropdown
              menu={{
                items: assistantSettingsItems,
                onClick: ({ key }) => navigate(`/more/${key}`)
              }}
              trigger={['click']}
              placement="rightTop"
            >
              <button type="button" className={`shell-nav-item${isMoreActive ? ' active' : ''}`}>
                <RiSettings3Line size={16} />
                {t('shell.nav.more')}
              </button>
            </Dropdown>
          </nav>

          <div className="shell-assistant">
            <AssistantSidebar />
          </div>

          <ShellUserArea />
        </aside>

        <main className="shell-main">
          <div className="shell-content">
            <MainRoutes />
          </div>
        </main>
      </div>
    </div>
  )
}

export default AppShell
