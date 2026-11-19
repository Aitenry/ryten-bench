import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { App, Button, Modal, theme } from 'antd'
import { useNavigate, useParams } from 'react-router-dom'
import {
  RiArrowLeftLine,
  RiDeleteBin6Line,
  RiDownloadLine,
  RiExternalLinkLine,
  RiInformationLine,
  RiPlayCircleLine,
  RiPuzzleLine,
  RiRefreshLine,
  RiSettings3Line,
  RiShieldCheckLine
} from '@remixicon/react'
import { useTranslation } from '@renderer/i18n'
import {
  usePlugins,
  usePluginRoutes,
  usePluginSettingsSections
} from '@renderer/plugin-host/PluginHostContext'
import { PluginBoundary } from '@renderer/plugin-host/PluginBoundary'
import { setWindowTitleSource } from '@renderer/window-title'
import type { PluginListEntry } from '@shared/plugin/types'

interface AvailableEntry {
  id: string
  name: string
  version: string
  description?: string
  asset: string
  size?: number
  installed: boolean
}

const COLORS = [
  ['#2dd4bf', '#0d9488'],
  ['#fb923c', '#ef4444'],
  ['#a78bfa', '#7c3aed'],
  ['#fbbf24', '#f59e0b'],
  ['#60a5fa', '#2563eb'],
  ['#34d399', '#059669']
]

function colorFor(id: string): [string, string] {
  let hash = 0
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  return COLORS[hash % COLORS.length] as [string, string]
}

const PluginDetail: React.FC = () => {
  const { pluginId = '' } = useParams<{ pluginId: string }>()
  const { token } = theme.useToken()
  const { message, modal } = App.useApp()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const descriptors = usePlugins()
  const routes = usePluginRoutes()

  const [entry, setEntry] = useState<PluginListEntry | null>(null)

  // 原生窗口标题：插件详情页显示插件名
  useEffect(() => {
    if (!entry) return
    setWindowTitleSource('plugin', entry.name)
    return () => setWindowTitleSource('plugin', '')
  }, [entry])
  const [available, setAvailable] = useState<AvailableEntry | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  /** 插件自己的设置弹窗（设置类内容一律用弹窗，不铺在页面里） */
  const [settingsOpen, setSettingsOpen] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const list = await window.api.plugin.list()
      setEntry(list.find((e) => e.id === pluginId) ?? null)
      try {
        const repo = await window.api.plugin.available()
        setAvailable((repo.plugins as AvailableEntry[]).find((p) => p.id === pluginId) ?? null)
      } catch {
        setAvailable(null)
      }
    } finally {
      setLoading(false)
    }
  }, [pluginId])

  useEffect(() => {
    void load()
    const unsub = window.api.plugin.onStateChanged(() => void load())
    return unsub
  }, [load])

  const descriptor = useMemo(
    () => descriptors.find((d) => d.manifest.id === pluginId),
    [descriptors, pluginId]
  )
  const route = useMemo(() => routes.find((r) => r.pluginId === pluginId), [routes, pluginId])
  /**
   * 该插件注册的设置页：插件自己的配置项从「设置」挪进插件详情（用户 2026-11-19 口径
   * 「移除设置里面的这两个内容，放到插件仓库里面设置」）。插件停用/卸载后注册表里就没有它，
   * 这里自然为空。
   */
  const allSettingsSections = usePluginSettingsSections()
  const settingsSections = useMemo(
    () => allSettingsSections.filter((s) => s.pluginId === pluginId),
    [allSettingsSections, pluginId]
  )
  const installed = Boolean(entry?.installed)
  const enabled = Boolean(entry?.enabled)
  const failed = descriptor?.state === 'error'
  const updateVersion =
    available && entry && available.version !== entry.version ? available.version : null

  const name = entry?.name ?? available?.name ?? pluginId
  const description = entry?.description ?? available?.description ?? ''
  const version = entry?.version ?? available?.version ?? '—'
  const [from, to] = colorFor(pluginId)

  const toggle = useCallback(async (): Promise<void> => {
    if (!entry) return
    setBusy(true)
    try {
      await window.api.plugin.setEnabled(entry.id, !entry.enabled)
      await load()
    } catch (err) {
      message.error(t('settings.plugins.switchFail'))
      console.error('[plugins] 切换失败:', err)
    } finally {
      setBusy(false)
    }
  }, [entry, load, message, t])

  const installOrUpdate = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const result = installed
        ? await window.api.plugin.installFromGithub(pluginId)
        : await window.api.plugin.installFromGithub(pluginId)
      if (!result.ok) {
        message.error(result.error || t('settings.plugins.installFail'))
      } else {
        message.success(
          installed ? t('settings.plugins.repoUpgraded') : t('settings.plugins.repoInstalled')
        )
        await load()
      }
    } catch (err) {
      message.error(t('settings.plugins.installFail'))
      console.error('[plugins] 安装失败:', err)
    } finally {
      setBusy(false)
    }
  }, [installed, pluginId, load, message, t])

  const uninstall = useCallback((): void => {
    if (!entry) return
    modal.confirm({
      title: t('settings.plugins.uninstallTitle', { name }),
      content: t('settings.plugins.uninstallBody'),
      okText: t('settings.plugins.uninstallConfirm'),
      okButtonProps: { danger: true },
      cancelText: t('common.action.cancel'),
      onOk: async () => {
        try {
          await window.api.plugin.uninstall(entry.id, false)
          message.success(t('settings.plugins.uninstallKeptData'))
          navigate('/plugins')
        } catch (err) {
          message.error(t('settings.plugins.uninstallFail'))
          console.error('[plugins] 卸载失败:', err)
        }
      }
    })
  }, [entry, modal, message, navigate, name, t])

  if (loading && !entry && !available) {
    return (
      <div style={{ padding: 36, fontSize: 12, color: token.colorTextTertiary }}>
        {t('common.state.loading')}
      </div>
    )
  }

  if (!entry && !available) {
    return (
      <div style={{ padding: 36 }}>
        <div style={{ fontSize: 13, color: token.colorTextSecondary }}>
          {t('settings.plugins.pluginNotFound')}
        </div>
        <Button size="small" style={{ marginTop: 12 }} onClick={() => navigate('/plugins')}>
          {t('settings.plugins.backToRepo')}
        </Button>
      </div>
    )
  }

  const actionRow = (
    icon: React.ReactNode,
    title: string,
    desc: string,
    onClick?: () => void,
    disabled = false,
    danger = false
  ): React.ReactNode => (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        width: '100%',
        border: 'none',
        background: 'transparent',
        textAlign: 'left',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '9px 8px',
        borderRadius: 9,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        color: danger ? token.colorError : token.colorText
      }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.background = token.colorFillQuaternary
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent'
      }}
    >
      <span
        style={{
          width: 28,
          height: 28,
          borderRadius: 8,
          background: token.colorFillTertiary,
          color: danger ? token.colorError : token.colorTextSecondary,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0
        }}
      >
        {icon}
      </span>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ display: 'block', fontSize: 12, fontWeight: 500 }}>{title}</span>
        <span
          style={{
            display: 'block',
            marginTop: 2,
            fontSize: 10,
            color: token.colorTextTertiary
          }}
        >
          {desc}
        </span>
      </span>
    </button>
  )

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: token.colorBgContainer }}>
      <div style={{ maxWidth: 1120, margin: '0 auto', padding: '16px 36px 36px' }}>
        <button
          onClick={() => navigate('/plugins')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            border: 'none',
            background: 'transparent',
            color: token.colorTextTertiary,
            fontSize: 11,
            cursor: 'pointer',
            padding: 0
          }}
        >
          <RiArrowLeftLine size={13} />
          {t('settings.plugins.backToRepo')}
        </button>

        <div
          style={{
            marginTop: 12,
            border: `1px solid ${token.colorBorderSecondary}`,
            borderRadius: 16,
            background: token.colorBgContainer,
            padding: '18px 20px',
            display: 'flex',
            alignItems: 'center',
            gap: 15
          }}
        >
          <span
            style={{
              width: 54,
              height: 54,
              borderRadius: 15,
              background: `linear-gradient(135deg, ${from}, ${to})`,
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.16)'
            }}
          >
            <RiPuzzleLine size={24} />
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <h1
                style={{
                  margin: 0,
                  fontSize: 20,
                  fontWeight: 700,
                  letterSpacing: '-0.025em',
                  color: token.colorText
                }}
              >
                {name}
              </h1>
              <span
                style={{
                  fontSize: 9,
                  padding: '2px 6px',
                  borderRadius: 4,
                  background: token.colorFillTertiary,
                  color: token.colorTextTertiary
                }}
              >
                {entry?.builtin
                  ? t('settings.plugins.builtinBadge')
                  : t('settings.plugins.externalBadge')}
              </span>
            </div>
            <div style={{ marginTop: 5, fontSize: 11, color: token.colorTextTertiary }}>
              v{version}
              {updateVersion ? ` → v${updateVersion}` : ''}
              {' · '}
              {installed
                ? t('settings.plugins.installedState')
                : t('settings.plugins.notInstalledState')}
              {entry?.enabled ? ` · ${t('settings.plugins.enable')}` : ''}
            </div>
            {description && (
              <div
                style={{
                  marginTop: 7,
                  fontSize: 11.5,
                  color: token.colorTextSecondary,
                  lineHeight: 1.6,
                  display: '-webkit-box',
                  WebkitLineClamp: 3,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden'
                }}
              >
                {description}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            {installed && (
              <Button size="small" loading={busy} onClick={() => void toggle()}>
                {enabled ? t('settings.plugins.disable') : t('settings.plugins.enable')}
              </Button>
            )}
            {installed ? (
              <Button
                size="small"
                type="primary"
                disabled={!route}
                icon={<RiExternalLinkLine size={14} />}
                onClick={() => route && navigate(route.path)}
              >
                {t('settings.plugins.openPage')}
              </Button>
            ) : (
              <Button
                size="small"
                type="primary"
                loading={busy}
                icon={<RiDownloadLine size={14} />}
                onClick={() => void installOrUpdate()}
              >
                {t('settings.plugins.repoInstall')}
              </Button>
            )}
          </div>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1.4fr 1fr',
            gap: 12,
            marginTop: 12
          }}
        >
          <section
            style={{
              border: `1px solid ${token.colorBorderSecondary}`,
              borderRadius: 16,
              background: token.colorBgContainer,
              padding: 16
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 600, color: token.colorText }}>
              {t('settings.plugins.pluginActions')}
            </div>
            <div style={{ marginTop: 8 }}>
              {actionRow(
                <RiPlayCircleLine size={15} />,
                t('settings.plugins.openPage'),
                route ? route.path : t('settings.plugins.noPage'),
                () => route && navigate(route.path),
                !route
              )}
              {installed
                ? actionRow(
                    <RiShieldCheckLine size={15} />,
                    enabled ? t('settings.plugins.disable') : t('settings.plugins.enable'),
                    enabled ? t('settings.plugins.disabledBadge') : t('settings.plugins.enable'),
                    () => void toggle(),
                    busy
                  )
                : null}
              {updateVersion
                ? actionRow(
                    <RiRefreshLine size={15} />,
                    t('settings.plugins.updateTo', { version: updateVersion }),
                    t('settings.plugins.repoUpgrade'),
                    () => void installOrUpdate(),
                    busy
                  )
                : null}
              {installed
                ? actionRow(
                    <RiDeleteBin6Line size={15} />,
                    t('settings.plugins.uninstall'),
                    t('settings.plugins.uninstallBody'),
                    uninstall,
                    false,
                    true
                  )
                : null}
              {settingsSections.length > 0
                ? actionRow(
                    <RiSettings3Line size={15} />,
                    t('settings.plugins.pluginSettings'),
                    t('settings.plugins.pluginSettingsDescription'),
                    () => setSettingsOpen(true)
                  )
                : null}
            </div>
          </section>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <section
              style={{
                border: `1px solid ${token.colorBorderSecondary}`,
                borderRadius: 16,
                background: token.colorBgContainer,
                padding: 16
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 600, color: token.colorText }}>
                {t('settings.plugins.pluginInfo')}
              </div>
              {[
                [t('settings.plugins.version'), `v${version}`],
                [
                  t('settings.plugins.source'),
                  entry?.builtin
                    ? t('settings.plugins.builtinBadge')
                    : t('settings.plugins.externalBadge')
                ],
                [t('settings.plugins.entry'), entry?.entry?.renderer ?? entry?.entry?.main ?? '—']
              ].map(([k, v]) => (
                <div
                  key={k}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 12,
                    padding: '7px 0',
                    borderBottom: `1px solid ${token.colorBorderSecondary}`,
                    fontSize: 10.5,
                    color: token.colorTextTertiary
                  }}
                >
                  <span>{k}</span>
                  <span
                    style={{
                      color: token.colorTextSecondary,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {v}
                  </span>
                </div>
              ))}
            </section>

            <section
              style={{
                border: `1px solid ${token.colorBorderSecondary}`,
                borderRadius: 16,
                background: token.colorBgContainer,
                padding: 16
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  fontSize: 12,
                  fontWeight: 600,
                  color: token.colorText
                }}
              >
                {t('settings.plugins.pluginRuntime')}
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 400,
                    color: failed ? token.colorError : token.colorSuccess
                  }}
                >
                  ●{' '}
                  {failed
                    ? t('settings.plugins.loadFailed')
                    : t('harness.sidebar.pluginState.enabled')}
                </span>
              </div>
              <div
                style={{
                  marginTop: 9,
                  fontSize: 10.5,
                  lineHeight: 1.8,
                  color: token.colorTextTertiary
                }}
              >
                <div>state: {descriptor?.state ?? (installed ? 'inactive' : '—')}</div>
                <div>enabled: {String(enabled)}</div>
                <div>
                  <RiInformationLine size={11} style={{ verticalAlign: -1 }} />{' '}
                  {installed
                    ? t('settings.plugins.installedState')
                    : t('settings.plugins.notInstalledState')}
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>

      {/* 插件自己的设置页（弹窗）：原先在「设置」弹窗里，用户 2026-11-19 要求挪到插件仓库 */}
      <Modal
        open={settingsOpen}
        onCancel={() => setSettingsOpen(false)}
        footer={null}
        width={760}
        title={t('settings.plugins.pluginSettings')}
        destroyOnHidden
      >
        <div
          className="custom-scrollbar"
          style={{ maxHeight: '68vh', overflowY: 'auto', paddingRight: 6 }}
        >
          {settingsSections.map((section) => (
            <PluginBoundary key={section.tabKey} pluginId={section.pluginId} surface="settings">
              <section.Component />
            </PluginBoundary>
          ))}
        </div>
      </Modal>
    </div>
  )
}

export default PluginDetail
