import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { App, Button, Modal, Segmented, theme } from 'antd'
import { useNavigate } from 'react-router-dom'
import {
  RiCheckboxCircleLine,
  RiDownloadLine,
  RiHammerLine,
  RiPuzzleLine,
  RiRefreshLine,
  RiSearchLine,
  RiSettings3Line,
  RiTimeLine
} from '@remixicon/react'
import { useTranslation } from '@renderer/i18n'
import { usePlugins, usePluginSettingsSections } from '@renderer/plugin-host/PluginHostContext'
import { PluginBoundary } from '@renderer/plugin-host/PluginBoundary'
import WorkshopSettings from '../components/harness/settings/WorkshopSettings'
import type { PluginListEntry } from '@shared/plugin/types'

/** 插件仓库索引里可安装的一条（与主进程 plugin:available 返回同口径） */
interface AvailableEntry {
  id: string
  name: string
  version: string
  description?: string
  asset: string
  size?: number
  installed: boolean
}

const ICON_COLORS = [
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
  return ICON_COLORS[hash % ICON_COLORS.length] as [string, string]
}

const PluginIcon: React.FC<{ id: string; size?: number }> = ({ id, size = 42 }) => {
  const [from, to] = colorFor(id)
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: size >= 50 ? 15 : 12,
        background: `linear-gradient(135deg, ${from}, ${to})`,
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.16), 0 2px 5px rgba(17,24,39,.12)'
      }}
    >
      <RiPuzzleLine size={size >= 50 ? 24 : 19} />
    </span>
  )
}

const PluginRepository: React.FC = () => {
  const { token } = theme.useToken()
  const { message } = App.useApp()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const descriptors = usePlugins()

  const [entries, setEntries] = useState<PluginListEntry[]>([])
  const [available, setAvailable] = useState<AvailableEntry[]>([])
  const [repoUrl, setRepoUrl] = useState('')
  const [repoError, setRepoError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'installed' | 'discover'>('all')
  /**
   * 设置类内容一律用**弹窗**（用户 2026-11-19 口径「设置是点击弹出窗口的，不是在页面搞内容」）：
   * - 插件工坊：从设置挪到插件仓库，点按钮弹窗管理草稿/构建/验收/安装；
   * - 插件自己的设置：点插件卡片上的齿轮弹窗。
   */
  const [workshopOpen, setWorkshopOpen] = useState(false)
  const [settingsPlugin, setSettingsPlugin] = useState<{ id: string; name: string } | null>(null)
  const allSettingsSections = usePluginSettingsSections()
  const sectionsOf = useCallback(
    (id: string) => allSettingsSections.filter((s) => s.pluginId === id),
    [allSettingsSections]
  )

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const list = await window.api.plugin.list()
      setEntries(list)
    } catch (err) {
      console.error('[plugins] 列表加载失败:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadAvailable = useCallback(async (): Promise<void> => {
    setRepoError(null)
    try {
      const result = await window.api.plugin.available()
      setRepoUrl(result.repo)
      setAvailable(result.plugins as AvailableEntry[])
    } catch (err) {
      setRepoError(err instanceof Error ? err.message : String(err))
      setAvailable([])
    }
  }, [])

  useEffect(() => {
    void refresh()
    void loadAvailable()
    const unsub = window.api.plugin.onStateChanged(() => {
      void refresh()
      void loadAvailable()
    })
    return unsub
  }, [refresh, loadAvailable])

  const runtimeState = useCallback(
    (id: string) => descriptors.find((d) => d.manifest.id === id)?.state,
    [descriptors]
  )

  /** 已安装 + 可发现去重合并：卡片是统一的入口，点击进入插件操作页 */
  const cards = useMemo(() => {
    const merged = new Map<
      string,
      {
        id: string
        name: string
        version: string
        description?: string
        installed: boolean
        enabled: boolean
        builtin: boolean
        updateVersion?: string
      }
    >()
    for (const e of entries) {
      merged.set(e.id, {
        id: e.id,
        name: e.name,
        version: e.version,
        description: e.description,
        installed: e.installed,
        enabled: e.enabled,
        builtin: Boolean(e.builtin)
      })
    }
    for (const a of available) {
      const existing = merged.get(a.id)
      if (existing) {
        existing.updateVersion = existing.version !== a.version ? a.version : existing.updateVersion
      } else {
        merged.set(a.id, {
          id: a.id,
          name: a.name,
          version: a.version,
          description: a.description,
          installed: false,
          enabled: false,
          builtin: false
        })
      }
    }
    const q = query.trim().toLowerCase()
    return [...merged.values()]
      .filter((c) => {
        if (filter === 'installed' && !c.installed) return false
        if (filter === 'discover' && c.installed) return false
        if (!q) return true
        return (
          c.name.toLowerCase().includes(q) ||
          c.id.toLowerCase().includes(q) ||
          Boolean(c.description?.toLowerCase().includes(q))
        )
      })
      .sort((a, b) => Number(b.installed) - Number(a.installed) || a.name.localeCompare(b.name))
  }, [entries, available, query, filter])

  const installLocal = useCallback(async (): Promise<void> => {
    try {
      const result = await window.api.plugin.installLocalFromDialog()
      if (result.canceled) return
      if (!result.ok) {
        message.error(result.error || t('settings.plugins.installFail'))
        return
      }
      message.success(
        t('settings.plugins.localInstalled', { name: result.name ?? result.id ?? '' })
      )
      await refresh()
      await loadAvailable()
    } catch (err) {
      message.error(t('settings.plugins.installFail'))
      console.error('[plugins] 本地安装失败:', err)
    }
  }, [message, t, refresh, loadAvailable])

  const installFromRepo = useCallback(
    async (entry: AvailableEntry): Promise<void> => {
      setBusy(entry.id)
      try {
        const result = await window.api.plugin.installFromGithub(entry.id)
        if (!result.ok) {
          message.error(result.error || t('settings.plugins.installFail'))
        } else {
          message.success(
            entry.installed
              ? t('settings.plugins.repoUpgraded')
              : t('settings.plugins.repoInstalled')
          )
          await refresh()
          await loadAvailable()
        }
      } catch (err) {
        message.error(t('settings.plugins.installFail'))
        console.error('[plugins] 从插件仓库安装失败:', err)
      } finally {
        setBusy(null)
      }
    },
    [message, t, refresh, loadAvailable]
  )

  const installedCount = entries.filter((e) => e.installed).length
  const discoverCount = cards.filter((c) => !c.installed).length

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        boxSizing: 'border-box',
        /* 顶部不留白：首行仍与侧栏品牌区同线；左右下留 12px，与资料库一致 */
        padding: '6px 9px',
        background: token.colorBgContainer,
        borderTopLeftRadius: token.borderRadiusLG
      }}
    >
      {/* 内容排满页面；首行仍是与品牌区同高的工具条 */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <div className="shell-topbar" style={{ gap: 10, flexWrap: 'wrap' }}>
          <div
            style={{
              width: 280,
              height: 28,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '0 11px',
              border: `1px solid ${token.colorBorderSecondary}`,
              borderRadius: 9,
              background: token.colorBgContainer,
              color: token.colorTextTertiary,
              fontSize: 12
            }}
          >
            <RiSearchLine size={14} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('settings.plugins.searchPlaceholder')}
              style={{
                flex: 1,
                minWidth: 0,
                border: 'none',
                outline: 'none',
                background: 'transparent',
                fontSize: 12,
                color: token.colorText
              }}
            />
          </div>
          <Segmented
            size="small"
            value={filter}
            onChange={(v) => setFilter(v as typeof filter)}
            options={[
              { label: `${t('settings.plugins.filterAll')} ${cards.length}`, value: 'all' },
              {
                label: `${t('settings.plugins.filterInstalled')} ${installedCount}`,
                value: 'installed'
              },
              {
                label: `${t('settings.plugins.filterDiscover')} ${discoverCount}`,
                value: 'discover'
              }
            ]}
          />
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <Button
              size="small"
              icon={<RiRefreshLine size={14} />}
              onClick={() => void loadAvailable()}
            >
              {t('settings.plugins.checkUpdates')}
            </Button>
            <Button
              size="small"
              icon={<RiHammerLine size={14} />}
              onClick={() => setWorkshopOpen(true)}
            >
              {t('settings.plugins.viewWorkshop')}
            </Button>
            <Button
              size="small"
              icon={<RiDownloadLine size={14} />}
              onClick={() => void installLocal()}
            >
              {t('settings.plugins.installLocal')}
            </Button>
          </div>
        </div>

        {repoError !== null && (
          <div style={{ marginTop: 12, fontSize: 12, color: token.colorError }}>
            {t('settings.plugins.repoFailed', { reason: repoError })}
          </div>
        )}

        <div
          style={{
            marginTop: 22,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 12,
            color: token.colorTextTertiary
          }}
        >
          <span style={{ fontWeight: 600, color: token.colorText }}>
            {t('settings.plugins.listTitle')}
          </span>
          <span>{installedCount}</span>
          <span style={{ marginLeft: 'auto' }}>
            {repoUrl ? t('settings.plugins.repoSource', { repo: repoUrl }) : ''}
          </span>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
            gap: 12,
            marginTop: 10
          }}
        >
          {loading && cards.length === 0 ? (
            <div style={{ fontSize: 12, color: token.colorTextTertiary }}>
              {t('common.state.loading')}
            </div>
          ) : cards.length === 0 ? (
            <div style={{ fontSize: 12, color: token.colorTextTertiary }}>
              {t('settings.plugins.repoEmpty')}
            </div>
          ) : (
            cards.map((card) => {
              const state = runtimeState(card.id)
              const failed = state === 'error'
              return (
                <div
                  key={card.id}
                  onClick={() => navigate(`/plugins/${card.id}`)}
                  style={{
                    border: `1px solid ${token.colorBorderSecondary}`,
                    borderRadius: 14,
                    background: token.colorBgContainer,
                    padding: 16,
                    minHeight: 166,
                    display: 'flex',
                    flexDirection: 'column',
                    cursor: 'pointer',
                    transition: 'border-color .16s, box-shadow .16s, transform .16s'
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = token.colorBorder
                    e.currentTarget.style.boxShadow = '0 12px 28px rgba(17,24,39,.08)'
                    e.currentTarget.style.transform = 'translateY(-1px)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = token.colorBorderSecondary
                    e.currentTarget.style.boxShadow = 'none'
                    e.currentTarget.style.transform = 'none'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
                    <PluginIcon id={card.id} />
                    <div style={{ minWidth: 0 }}>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          fontSize: 13.5,
                          fontWeight: 600,
                          color: token.colorText
                        }}
                      >
                        <span
                          style={{
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap'
                          }}
                        >
                          {card.name}
                        </span>
                        {card.builtin && (
                          <span
                            style={{
                              fontSize: 9,
                              padding: '1px 5px',
                              borderRadius: 4,
                              background: token.colorFillTertiary,
                              color: token.colorTextTertiary,
                              fontWeight: 500
                            }}
                          >
                            {t('settings.plugins.builtinBadge')}
                          </span>
                        )}
                      </div>
                      <div style={{ marginTop: 3, fontSize: 10, color: token.colorTextTertiary }}>
                        v{card.version}
                        {card.updateVersion ? ` → v${card.updateVersion}` : ''}
                      </div>
                    </div>
                  </div>
                  <div
                    style={{
                      marginTop: 12,
                      fontSize: 11.5,
                      lineHeight: 1.65,
                      color: token.colorTextSecondary,
                      display: '-webkit-box',
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden'
                    }}
                  >
                    {card.description || t('settings.plugins.noDescription')}
                  </div>
                  <div
                    style={{
                      marginTop: 'auto',
                      paddingTop: 12,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8
                    }}
                  >
                    <span
                      style={{
                        fontSize: 10,
                        padding: '2px 7px',
                        borderRadius: 999,
                        background: failed
                          ? token.colorErrorBg
                          : card.installed
                            ? token.colorSuccessBg
                            : token.colorFillTertiary,
                        color: failed
                          ? token.colorError
                          : card.installed
                            ? token.colorSuccess
                            : token.colorTextTertiary
                      }}
                    >
                      {failed
                        ? t('settings.plugins.loadFailed')
                        : card.installed
                          ? card.enabled
                            ? t('harness.sidebar.pluginState.enabled')
                            : t('settings.plugins.disabledBadge')
                          : t('settings.plugins.repoInstall')}
                    </span>
                    {!card.installed && (
                      <Button
                        size="small"
                        type="primary"
                        loading={busy === card.id}
                        style={{ marginLeft: 'auto' }}
                        onClick={(e) => {
                          e.stopPropagation()
                          const entry = available.find((a) => a.id === card.id)
                          if (entry) void installFromRepo(entry)
                        }}
                      >
                        {t('settings.plugins.repoInstall')}
                      </Button>
                    )}
                    {card.installed && card.updateVersion && (
                      <span
                        style={{
                          marginLeft: 'auto',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 4,
                          fontSize: 10,
                          color: token.colorWarning
                        }}
                      >
                        <RiTimeLine size={12} />
                        {t('settings.plugins.updateTo', { version: card.updateVersion })}
                      </span>
                    )}
                    {card.installed && !card.updateVersion && (
                      <span
                        style={{
                          marginLeft: 'auto',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 4,
                          fontSize: 10,
                          color: token.colorTextTertiary
                        }}
                      >
                        <RiCheckboxCircleLine size={12} />
                        {t('settings.plugins.openDetail')}
                      </span>
                    )}
                    {card.installed && sectionsOf(card.id).length > 0 && (
                      <Button
                        size="small"
                        type="text"
                        icon={<RiSettings3Line size={14} />}
                        onClick={(e) => {
                          e.stopPropagation()
                          setSettingsPlugin({ id: card.id, name: card.name })
                        }}
                      />
                    )}
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>

      {/* 插件工坊（弹窗）：草稿列表 + 构建/验收/安装 */}
      <Modal
        open={workshopOpen}
        onCancel={() => setWorkshopOpen(false)}
        footer={null}
        width={880}
        title={t('settings.plugins.viewWorkshop')}
        destroyOnHidden
      >
        <div
          className="custom-scrollbar"
          style={{ maxHeight: '68vh', overflowY: 'auto', paddingRight: 6 }}
        >
          <WorkshopSettings embedded />
        </div>
      </Modal>

      {/* 单个插件自己的设置页（弹窗） */}
      <Modal
        open={settingsPlugin !== null}
        onCancel={() => setSettingsPlugin(null)}
        footer={null}
        width={760}
        title={t('settings.plugins.pluginSettings')}
        destroyOnHidden
      >
        <div
          className="custom-scrollbar"
          style={{ maxHeight: '68vh', overflowY: 'auto', paddingRight: 6 }}
        >
          {settingsPlugin &&
            sectionsOf(settingsPlugin.id).map((section) => (
              <PluginBoundary key={section.tabKey} pluginId={section.pluginId} surface="settings">
                <section.Component />
              </PluginBoundary>
            ))}
        </div>
      </Modal>
    </div>
  )
}

export default PluginRepository
