import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { theme } from 'antd'
import { NavLink, useLocation } from 'react-router-dom'
import {
  RiApps2Line,
  RiBellLine,
  RiBook2Line,
  RiMoonLine,
  RiSettings3Line,
  RiSunLine
} from '@remixicon/react'
import MainRoutes from '@renderer/route/MainRoutes'
import logo from '@renderer/assets/logo.png'
import { useNotification } from '@renderer/hooks/useNotification'
import { useTheme } from '@renderer/hooks/useTheme'
import { usePlugins, usePluginRoutes } from '@renderer/plugin-host/PluginHostContext'
import { setWindowTitleSource } from '@renderer/window-title'
import { useTranslation } from '@renderer/i18n'
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
 * - 系统侧栏：品牌 → 资料库 / 插件仓库 → harness 的胶囊侧栏（对话/工作/插件）
 *   → 记忆（在 AssistantSidebar 内部）→ 用户区；
 * - 主内容区：当前系统页面（对话 / 资料库 / 插件仓库）。
 *
 * Linux 没有 WCO：主进程回退系统原生边框，这里不渲染标题栏，避免出现两条标题条。
 * 所有颜色都从 antd 主题 token 派生，亮色/暗色设置切换时整个外壳一起变化。
 * 原来的 CustomFrame / TitleBar / RightBar / BottomBar 已移除；外壳不再由插件注册表驱动。
 */
const ShellUserArea: React.FC = () => {
  const [notifOpen, setNotifOpen] = useState(false)
  const { unreadCount } = useNotification()
  const { effectiveTheme, setThemeMode } = useTheme()
  const { token } = theme.useToken()
  const { t } = useTranslation()
  /** 铃铛 + 消息面板同属一个定位容器：面板浮在用户区之上、左侧对齐、宽度 = 侧边栏宽度 */
  const dockRef = useRef<HTMLDivElement>(null)
  const handleSettings = useCallback(() => {
    setNotifOpen(false)
    openSettingsModal(undefined, 'full')
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
        <div className="shell-avatar">E</div>
        <div className="shell-user-copy">
          <div className="shell-user-name">Eddie</div>
          <div className="shell-user-sub">本地工作区</div>
        </div>
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
          <button className="shell-icon-btn" onClick={handleSettings} title="设置">
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
  const pluginRoutes = usePluginRoutes()
  const plugins = usePlugins()

  /**
   * 原生窗口标题：按当前页面/插件/模式算成 `xxx - RytenBench`。
   *
   * - 资料库 / 插件仓库：固定页面名；
   * - 对话页（/harness）：交给 harness 侧栏按「对话/工作/插件」模式写入；
   * - 第三方插件路由：用插件 manifest 里的名称。
   */
  useEffect(() => {
    const path = location.pathname
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

  useEffect(() => {
    const handler = (e: Event): void => {
      const detail = (e as CustomEvent).detail as { tab?: string; scope?: string } | undefined
      openSettingsModal(detail?.tab, detail?.scope === 'assistant' ? 'assistant' : 'full')
    }
    window.addEventListener('open-system-settings', handler)
    return () => window.removeEventListener('open-system-settings', handler)
  }, [])

  const shellVars = {
    '--shell-bg': token.colorBgLayout,
    '--shell-titlebar-bg': token.colorBgLayout,
    '--shell-sidebar-bg': token.colorBgLayout,
    '--shell-border': token.colorBorderSecondary,
    '--shell-text': token.colorText,
    '--shell-text-secondary': token.colorTextSecondary,
    '--shell-text-tertiary': token.colorTextTertiary,
    '--shell-hover': token.colorFillQuaternary,
    '--shell-active': token.colorFillTertiary
  } as React.CSSProperties

  const platform = (window as unknown as Window).api.platform
  // Windows 改用系统原生标题栏（不再渲染自绘标题条）；macOS 仍保留自绘条 + 交通灯留白
  const showTitleBar = platform === 'darwin'

  return (
    <div className="shell-root" style={shellVars}>
      <NativeThemeSync />
      {showTitleBar && <ShellTitleBar />}

      <div className="shell-body">
        <aside className="shell-sidebar">
          <div className="shell-brand">
            <img className="shell-brand-logo" src={logo} alt="RytenBench" />
            <span className="shell-brand-name">RytenBench</span>
            <span className="shell-brand-ver">0.1.0</span>
          </div>

          <nav className="shell-nav">
            <NavLink
              to="/notes"
              className={({ isActive }) => `shell-nav-item${isActive ? ' active' : ''}`}
            >
              <RiBook2Line size={16} />
              资料库
            </NavLink>
            <NavLink
              to="/plugins"
              className={({ isActive }) => `shell-nav-item${isActive ? ' active' : ''}`}
            >
              <RiApps2Line size={16} />
              插件仓库
            </NavLink>
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
