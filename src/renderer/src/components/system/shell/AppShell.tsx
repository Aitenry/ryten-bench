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
import ShellTitleBar from './ShellTitleBar'
import type { Window } from '../../../../resource/types/window'

/**
 * 新系统外壳。
 *
 * 结构上分三层：
 * - 自绘标题栏（Windows / macOS）：左侧应用菜单（应用 / 编辑），右侧是**系统绘制**的
 *   最小化/最大化/关闭（Window Controls Overlay，见 main-window.ts）；
 * - 系统侧栏：品牌 → 资料库 / 插件仓库 / 更多内容 → harness 的胶囊侧栏（对话/工作/插件）
 *   → 记忆（在 AssistantSidebar 内部）→ 用户区；
 * - 主内容区：当前系统页面（对话 / 资料库 / 插件仓库 / 更多内容）。
 *
 * Linux 没有 WCO：主进程回退系统原生边框，这里不渲染标题栏，避免出现两条标题条。
 * 所有颜色都从 antd 主题 token 派生，亮色/暗色设置切换时整个外壳一起变化。
 * 原来的 CustomFrame / TitleBar / RightBar / BottomBar 已移除；外壳不再由插件注册表驱动。
 */
/** 已知角色的展示文案；未知角色原样显示（不瞎猜成「成员」，避免误导） */
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
  /** 铃铛 + 消息面板同属一个定位容器：面板浮在用户区之上、左侧对齐、宽度 = 侧边栏宽度 */
  const dockRef = useRef<HTMLDivElement>(null)
  const handleSettings = useCallback(() => {
    setNotifOpen(false)
    openSettingsModal()
  }, [])

  /** 设置按钮右侧的明暗快捷切换：月亮 / 太阳一个按钮来回切（自动模式仍在设置里可选） */
  const isDark = effectiveTheme === 'dark'
  const toggleTheme = useCallback(() => {
    // 自动模式下点击任意一次 → 落到显式的另一种主题
    void setThemeMode(isDark ? 'light' : 'dark')
  }, [isDark, setThemeMode])

  // 面板打开时：点击面板/铃铛之外的任何地方、或按 Esc 关闭
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

  /** 账号区展示数据全部来自真实登录态（原写死的 E / Eddie / 本地工作区已删除） */
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
      // 有插件没补齐：提示数量，点提示去插件仓库的「同步详情」看每条失败原因（不静默）
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
   * 账号信息弹窗的字段行。头像 / display_name / username / role 在弹窗顶部身份卡里展示，
   * 这里只留其余诊断字段（避免同一信息重复两遍）。
   */
  const accountRows: Array<[string, string]> = [
    [t('lattice.account.userId'), user?.id || '—'],
    [t('lattice.account.server'), status.baseUrl || '—'],
    /* 值是右侧一列，标签里不能再塞 {{time}} / {{n}} 占位符（t() 不做插值就会原样显示） */
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
              {/* 用户 2026-11-21：未登录态只留「未登录」，不再显示「点击登录」这行文本；
                  整行仍是按钮，悬停 title 提示可登录。桥不可用是异常态，保留提示。 */}
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

      {/* 账号信息弹窗：只读展示真实登录态。用户 2026-11-21：去掉底部「关闭 / 退出登录」
          ——右上角 X 就是关闭，退出登录在账号菜单里已经有入口，弹窗里重复一遍反而碍眼。
          头像只读展示，这里不放修改入口。 */}
      <Modal
        open={accountOpen}
        onCancel={() => setAccountOpen(false)}
        width={420}
        destroyOnHidden
        title={t('lattice.account.title')}
        footer={null}
      >
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {/* 身份卡：头像 + display_name + username + role（账号区同一份真实登录态） */}
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
 * 让**系统绘制的原生标题栏/窗口边框**跟随应用主题。
 *
 * Windows 现在用系统原生标题栏（用户 2026-11-20：放弃自绘标题栏 + WCO），
 * 它的明暗由系统的 per-window 深色模式属性决定：Electron 侧只认 nativeTheme.themeSource。
 * 在 layout effect（绘制前）里同步，界面重画时标题栏也已经是目标明暗。
 */
const NativeThemeSync: React.FC = () => {
  const { effectiveTheme } = useTheme()
  useLayoutEffect(() => {
    try {
      ;(window as unknown as Window).api.window.setNativeTheme(effectiveTheme)
    } catch {
      // 平台不支持时忽略（Linux 等）
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
   * 版本号取主进程的真实版本（`app-version` IPC），不再写死。
   * 读到之前不渲染这段文字，避免先闪一个错的版本号。
   */
  const [appVersion, setAppVersion] = useState('')
  useEffect(() => {
    let cancelled = false
    const loading = (window as unknown as Window).loading
    if (!loading) return
    void loading
      .getAppVersion()
      .then((version) => {
        if (!cancelled) setAppVersion(version)
      })
      .catch(() => {
        // 读不到就不显示版本号：宁缺勿错
      })
    return () => {
      cancelled = true
    }
  }, [])

  /**
   * 原生窗口标题：按当前页面/插件/模式算成 `xxx - RytenBench`。
   *
   * - 资料库 / 插件仓库 / 更多内容：固定页面名；
   * - 对话页（/harness）：交给 harness 侧栏按「对话/工作/插件」模式写入；
   * - 第三方插件路由：用插件 manifest 里的名称。
   */
  useEffect(() => {
    const path = location.pathname
    // 登录页：`登录 - RytenBench`（窗口标题机制与其它系统页面一致）
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
      // 「更多」是助手设置的容器：窗口标题用具体页名（智能体 / 技能 / …），
      // 没有 tab 或 tab 不认识时退回容器名。
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
   * 记住登录页要回的那一页（见 utils/login-return.ts）。
   *
   * 登录页是整窗独立布局，但它仍是同一次运行里的普通路由：从哪一页点进登录，返回时就回
   * 哪一页（对话页回来仍是那条会话，插件仓库回来仍是插件仓库）。登录页自身不记录，
   * 否则「返回工作台」会又停在登录页。
   */
  useEffect(() => {
    if (location.pathname === '/login') return
    rememberLoginReturn(`${location.pathname}${location.search}${location.hash}`)
  }, [location.pathname, location.search, location.hash])

  /**
   * 全局「打开设置」事件：
   * - `scope=assistant` 的助手设置走「更多」独立页面；
   * - 其余（标题栏应用菜单、对话页「去配置模型」等）仍打开设置弹窗。
   */
  useEffect(() => {
    /** 「更多」独立页支持的四项；其余页签（如插件工坊 workshop）仍属于设置弹窗。 */
    const MORE_TABS = ['agents', 'skills', 'memory', 'mcp']
    const handler = (e: Event): void => {
      const detail = (e as CustomEvent).detail as { tab?: string; scope?: string } | undefined
      if (detail?.scope === 'assistant') {
        // 只有这四个是真的「更多内容」页；未知页签直接打开设置弹窗对应页签，
        // 不把用户导到 /more/<unknown>（那会回落到智能体页并卡住地址栏）。
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

  /** 侧栏「更多」下拉：只放助手设置（用户 2026-11-20「只要助手的」） */
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
    /* 账号区的「点击登录」链接色与已登录头像渐变都用主色，跟随主题 */
    '--shell-primary': token.colorPrimary
  } as React.CSSProperties

  const platform = (window as unknown as Window).api.platform
  // Windows 改用系统原生标题栏（不再渲染自绘标题条）；macOS 仍保留自绘条 + 交通灯留白
  const showTitleBar = platform === 'darwin'

  /**
   * 登录页是**整窗独立布局**：不渲染侧栏、用户区与标题条，只保留主题同步与路由内容。
   * 这样 `/login` 仍是 MainRoutes 里的普通路由，但视觉上不套外壳（左右分栏占满窗口）。
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
            {/* 助手设置收在「更多」下拉里（插件仓库下面）：选一项 → 整页显示它的内容 */}
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
