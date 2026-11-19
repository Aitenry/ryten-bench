import React, { useEffect, useRef, useState, useCallback } from 'react'
import { App, Button, Checkbox, Dropdown, Modal, Tag, theme, type MenuProps } from 'antd'
import { RiMore2Line } from '@remixicon/react'
import { useTranslation } from '@renderer/i18n'
import { usePlugins } from '@renderer/plugin-host/PluginHostContext'
import type { PluginListEntry, PluginState } from '@shared/plugin/types'
import { SkeletonListRows } from '@renderer/components/system/Skeleton'
import { SettingsPageHeader, SettingsSection } from './SettingsUI'

/** 插件仓库（GitHub）里可安装的一条（`api.plugin.available()` 的返回） */
interface AvailableEntry {
  id: string
  name: string
  version: string
  description?: string
  asset: string
  size?: number
  installed: boolean
}

/**
 * 插件管理面板（设置 → 插件）。
 *
 * 列表数据来自主进程 `plugins-list`，口径是「`userData/plugins/<id>/` 里装了什么」：
 * - **已安装**：名字 + 内置/第三方标签 + 版本 + 描述（停用会标出来），右侧一个「⋯」菜单；
 * - **可安装的内置插件**（应用包里带着、但已被卸载）：列表末尾单独一区，行内「安装」。
 *
 * 行内操作为什么收进「⋯」菜单（2026-09-26 用户要求）：一列「卸载」文字按钮 + 一个开关
 * 在列表里很吵，而且**启停与卸载是同一层级的三件事**（更新 / 启用停用 / 卸载）。
 * 菜单项按可用性出现：没有更新来源的插件（本地装的、又不在仓库里）就不显示更新项。
 *
 * 卸载是**物理卸载**（删目录），两件事分开（用户口径）：
 * - 卸载本身 = **移除插件代码**（删 `userData/plugins/<id>/`，记 `uninstalled`，重启不复活）；
 * - 勾「同时删除该插件的全部数据」= 连表内记录与应用托管的文件一起清（调 `plugin.purge`）；
 *   不勾 = 数据留在库里，重装后照旧可用。
 *
 * 实时 fiber 状态来自宿主描述符；启停经 `api.plugin.setEnabled` 持久化并广播，
 * 渲染层 host 即时装载/卸载（路由/菜单/设置页/Provider 立即反应）。
 */
const PluginsPanel: React.FC = () => {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const { token } = theme.useToken()
  const descriptors = usePlugins()
  const [entries, setEntries] = useState<PluginListEntry[]>([])
  /** 卸载确认框的目标（null = 未打开） */
  const [pending, setPending] = useState<PluginListEntry | null>(null)
  /** 确认框里的「是否同时删除数据」勾选态；每次打开都重置为未勾选 */
  const [purgeData, setPurgeData] = useState(false)
  /** 插件仓库面板：null = 未打开；[] = 已加载但仓库为空 */
  const [repoOpen, setRepoOpen] = useState(false)
  const [repoPlugins, setRepoPlugins] = useState<AvailableEntry[] | null>(null)
  const [repoUrl, setRepoUrl] = useState('')
  const [repoError, setRepoError] = useState<string | null>(null)
  const [repoBusy, setRepoBusy] = useState<string | null>(null)
  /**
   * 仓库里各插件的版本（id → version）：第三方插件的「更新」来源。
   *
   * 单独拉、失败就当没有（不阻断列表）：离线时面板照常可用，只是不显示更新项。
   * 主进程侧索引有 60s 缓存，所以这里频繁调用不会反复打网络。
   */
  const [repoVersions, setRepoVersions] = useState<Record<string, string>>({})
  const repoCheckedAt = useRef(0)

  const refresh = useCallback((): void => {
    window.api.plugin
      .list()
      .then(setEntries)
      .catch((err) => console.error('[plugins] 列表加载失败:', err))
  }, [])

  useEffect(() => {
    refresh()
    // 启停/安装/卸载后主进程广播，面板实时刷新
    const unsub = window.api.plugin.onStateChanged(() => refresh())
    return unsub
  }, [refresh])

  /** 拉取插件仓库索引（打开面板时、点「刷新」时） */
  const loadRepo = useCallback(async (): Promise<void> => {
    setRepoError(null)
    setRepoPlugins(null)
    try {
      const result = await window.api.plugin.available()
      setRepoUrl(result.repo)
      setRepoPlugins(result.plugins)
      setRepoVersions(Object.fromEntries(result.plugins.map((p) => [p.id, p.version])))
    } catch (err) {
      setRepoError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  /**
   * 静默拉一次仓库版本（只为行菜单的「更新」项）：失败就保持空表，不弹错误。
   * 60s 内不重复尝试——离线时打开面板不该每次都卡一次网络超时。
   */
  const loadRepoVersions = useCallback(async (): Promise<void> => {
    if (Date.now() - repoCheckedAt.current < 60_000) return
    repoCheckedAt.current = Date.now()
    try {
      const result = await window.api.plugin.available()
      setRepoVersions(Object.fromEntries(result.plugins.map((p) => [p.id, p.version])))
    } catch {
      setRepoVersions({})
    }
  }, [])

  useEffect(() => {
    void loadRepoVersions()
  }, [loadRepoVersions])

  const openRepo = useCallback((): void => {
    setRepoOpen(true)
    void loadRepo()
  }, [loadRepo])

  /** 从插件仓库安装/升级一个插件 */
  const installFromRepo = useCallback(
    async (entry: AvailableEntry): Promise<void> => {
      setRepoBusy(entry.id)
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
          refresh()
          void loadRepo()
        }
      } catch (err) {
        message.error(t('settings.plugins.installFail'))
        console.error('[plugins] 从插件仓库安装失败:', err)
      } finally {
        setRepoBusy(null)
      }
    },
    [message, t, refresh, loadRepo]
  )

  const toggle = useCallback(
    async (id: string, enabled: boolean): Promise<void> => {
      try {
        setEntries(await window.api.plugin.setEnabled(id, enabled))
      } catch (err) {
        message.error(t('settings.plugins.switchFail'))
        console.error('[plugins] 切换失败:', err)
      }
    },
    [message, t]
  )

  /**
   * 该插件可用的「更新来源」版本：内置看应用包里的副本，第三方看插件仓库索引。
   * 都没有（本地自己装的、又不在仓库里）→ null = 行菜单不显示更新项。
   */
  const updateSourceVersion = useCallback(
    (entry: PluginListEntry): string | null => {
      const source = entry.builtin ? entry.bundledVersion : repoVersions[entry.id]
      return source ?? null
    },
    [repoVersions]
  )

  /**
   * 更新 / 重新安装：内置插件从应用包重新铺包，第三方插件从插件仓库重新下载。
   * 两者语义相同——**用来源里的那份代码覆盖当前安装**，数据不动（用户口径：代码与数据是两件事）。
   */
  const applyUpdate = useCallback(
    async (entry: PluginListEntry, kind: 'update' | 'reinstall'): Promise<void> => {
      try {
        const result = entry.builtin
          ? await window.api.plugin.install(entry.id)
          : await window.api.plugin.installFromGithub(entry.id)
        if (!result.ok) {
          message.error(result.error || t('settings.plugins.installFail'))
          return
        }
        message.success(
          kind === 'update'
            ? t('settings.plugins.updateDone', { name: entry.name })
            : t('settings.plugins.reinstallDone')
        )
        refresh()
        void loadRepoVersions()
      } catch (err) {
        message.error(t('settings.plugins.installFail'))
        console.error('[plugins] 更新失败:', err)
      }
    },
    [message, t, refresh, loadRepoVersions]
  )

  /**
   * 从本地安装（面板上**唯一**的本地安装入口）。
   *
   * 走主进程的系统选择框（渲染层拿不到真实路径）：一个对话框两个筛选器——
   * `.zip` 压缩包，或插件文件夹里的 `plugin.json`（Windows 的选择框不能同时选文件与目录）。
   * 装完主进程会自动启用并装载，面板收到广播后刷新列表；用户取消时 `canceled: true`——
   * **不算失败**，不弹错误。
   */
  const installLocal = useCallback(async (): Promise<void> => {
    try {
      const result = await window.api.plugin.installLocalFromDialog()
      if (result.canceled) return
      if (!result.ok) {
        message.error(result.error || t('settings.plugins.installFail'))
        return
      }
      message.success(
        result.upgraded
          ? t('settings.plugins.localUpgraded', { name: result.name ?? result.id ?? '' })
          : t('settings.plugins.localInstalled', { name: result.name ?? result.id ?? '' })
      )
      refresh()
    } catch (err) {
      message.error(t('settings.plugins.installFail'))
      console.error('[plugins] 本地安装失败:', err)
    }
  }, [message, t, refresh])

  /** 从应用包重装某个内置插件 */
  const reinstall = useCallback(
    async (id: string): Promise<void> => {
      try {
        const result = await window.api.plugin.install(id)
        if (!result.ok) {
          message.error(result.error || t('settings.plugins.installFail'))
        } else {
          message.success(t('settings.plugins.reinstallDone'))
        }
      } catch (err) {
        message.error(t('settings.plugins.installFail'))
        console.error('[plugins] 重装失败:', err)
      }
    },
    [message, t]
  )

  /** 打开卸载确认框（数据勾选项每次重置为未勾选 = 默认保留数据） */
  const uninstall = useCallback((entry: PluginListEntry): void => {
    setPurgeData(false)
    setPending(entry)
  }, [])

  const confirmUninstall = useCallback(async (): Promise<void> => {
    const target = pending
    if (!target) return
    try {
      // 卸载 = 移除插件代码；purgeData 只决定要不要连数据一起清（P5 起的用户口径）
      setEntries(await window.api.plugin.uninstall(target.id, purgeData))
      message.success(
        purgeData ? t('settings.plugins.uninstallDone') : t('settings.plugins.uninstallKeptData')
      )
      setPending(null)
    } catch (err) {
      message.error(t('settings.plugins.uninstallFail'))
      console.error('[plugins] 卸载失败:', err)
    }
  }, [pending, purgeData, message, t])

  const runtimeState = useCallback(
    (id: string): PluginState | undefined => descriptors.find((d) => d.manifest.id === id)?.state,
    [descriptors]
  )

  const installed = entries.filter((e) => e.installed)
  const available = entries.filter((e) => !e.installed)

  const renderRow = (entry: PluginListEntry): React.ReactNode => {
    const state = runtimeState(entry.id)
    const failed = state === 'error'
    const sourceVersion = updateSourceVersion(entry)
    // 有更新来源才给「更新 / 重新安装」项；版本相同就写「重新安装」（同一条动作，名字照实说）
    const hasSource = sourceVersion !== null
    const updateKind: 'update' | 'reinstall' =
      hasSource && sourceVersion !== entry.version ? 'update' : 'reinstall'
    const menuItems: MenuProps['items'] = [
      hasSource
        ? {
            key: 'update',
            label:
              updateKind === 'update'
                ? t('settings.plugins.updateTo', { version: String(sourceVersion) })
                : t('settings.plugins.reinstallAction')
          }
        : null,
      {
        key: 'toggle',
        label: entry.enabled ? t('settings.plugins.disable') : t('settings.plugins.enable')
      },
      { type: 'divider' as const },
      { key: 'uninstall', danger: true, label: t('settings.plugins.uninstall') }
    ].filter(Boolean) as MenuProps['items']

    const onMenuClick: MenuProps['onClick'] = ({ key }) => {
      if (key === 'update') void applyUpdate(entry, updateKind)
      else if (key === 'toggle') void toggle(entry.id, !entry.enabled)
      else if (key === 'uninstall') uninstall(entry)
    }

    return (
      <div
        key={entry.id}
        className="sui-row"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          padding: '10px 16px'
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="flex items-center gap-2">
            <span style={{ fontSize: 13.5, fontWeight: 600, color: token.colorText }}>
              {entry.name}
            </span>
            <Tag
              bordered={false}
              color={entry.builtin ? 'default' : 'geekblue'}
              style={{
                fontSize: 10,
                lineHeight: '16px',
                padding: '0 6px',
                marginInlineEnd: 0
              }}
            >
              {t(
                entry.builtin ? 'settings.plugins.builtinBadge' : 'settings.plugins.externalBadge'
              )}
            </Tag>
            <span style={{ fontSize: 11, color: token.colorTextTertiary }}>v{entry.version}</span>
            {/* 开关收进菜单后，启停状态要在这里说清楚（只在停用时出现 = 结构携带信息） */}
            {!entry.enabled && (
              <span style={{ fontSize: 11, color: token.colorTextTertiary }}>
                {t('settings.plugins.disabledBadge')}
              </span>
            )}
          </div>
          <div
            style={{
              fontSize: 12,
              color: token.colorTextSecondary,
              marginTop: 2,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {entry.description}
            {failed && (
              <span style={{ color: token.colorError, marginLeft: 8 }}>
                {t('settings.plugins.loadFailed')}
              </span>
            )}
          </div>
        </div>
        {/* 行内操作收进「⋯」菜单：更新 / 启用停用 / 卸载（2026-09-26 用户要求）。
            已安装的插件都能物理卸载：磁盘包（内置或第三方）都在 userData/plugins/<id>/ 下，
            卸载 = 问数据 → 清数据 → 删目录 → 记账。 */}
        <Dropdown
          menu={{ items: menuItems, onClick: onMenuClick }}
          trigger={['click']}
          placement="bottomRight"
        >
          <Button size="small" type="text" aria-label={t('settings.plugins.moreActions')}>
            <RiMore2Line size={16} />
          </Button>
        </Dropdown>
      </div>
    )
  }

  return (
    <div>
      <SettingsPageHeader
        title={t('settings.plugins.pageTitle')}
        description={t('settings.plugins.pageDescription')}
        extra={
          <div className="flex items-center gap-2">
            <Button size="small" onClick={() => void installLocal()}>
              {t('settings.plugins.installLocal')}
            </Button>
            <Button size="small" onClick={openRepo}>
              {t('settings.plugins.installFromRepo')}
            </Button>
          </div>
        }
      />
      <SettingsSection
        title={t('settings.plugins.listTitle')}
        description={t('settings.plugins.listDescription')}
      >
        {installed.map(renderRow)}
      </SettingsSection>
      {available.length > 0 && (
        <SettingsSection
          title={t('settings.plugins.availableTitle')}
          description={t('settings.plugins.availableDescription')}
        >
          {available.map((entry) => (
            <div
              key={entry.id}
              className="sui-row"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 16,
                padding: '10px 16px'
              }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="flex items-center gap-2">
                  <span style={{ fontSize: 13.5, fontWeight: 600, color: token.colorText }}>
                    {entry.name}
                  </span>
                  <Tag
                    bordered={false}
                    color="default"
                    style={{
                      fontSize: 10,
                      lineHeight: '16px',
                      padding: '0 6px',
                      marginInlineEnd: 0
                    }}
                  >
                    {t('settings.plugins.builtinBadge')}
                  </Tag>
                  <span style={{ fontSize: 11, color: token.colorTextTertiary }}>
                    v{entry.version}
                  </span>
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: token.colorTextSecondary,
                    marginTop: 2,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {entry.description}
                </div>
              </div>
              <div className="flex items-center gap-2" style={{ flexShrink: 0 }}>
                <Button size="small" onClick={() => void reinstall(entry.id)}>
                  {t('settings.plugins.reinstall')}
                </Button>
              </div>
            </div>
          ))}
        </SettingsSection>
      )}

      {/* 卸载确认框：卸载 = 移除插件代码；「同时删除数据」是一个**勾选项**（默认不勾 = 留数据） */}
      <Modal
        open={pending !== null}
        title={t('settings.plugins.uninstallTitle', { name: pending?.name ?? '' })}
        okText={t('settings.plugins.uninstallConfirm')}
        cancelText={t('common.action.cancel')}
        okButtonProps={{ danger: true }}
        onOk={() => void confirmUninstall()}
        onCancel={() => setPending(null)}
        width={430}
        destroyOnHidden
      >
        <div style={{ fontSize: 12.5, color: token.colorTextSecondary, lineHeight: 1.7 }}>
          {t('settings.plugins.uninstallBody')}
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <Checkbox
            checked={purgeData}
            onChange={(e) => setPurgeData(e.target.checked)}
            style={{ marginTop: 1 }}
          />
          <div style={{ cursor: 'pointer' }} onClick={() => setPurgeData((v) => !v)}>
            <div style={{ fontSize: 13, color: token.colorText }}>
              {t('settings.plugins.purgeCheckbox')}
            </div>
            <div
              style={{
                fontSize: 12,
                color: token.colorTextTertiary,
                lineHeight: 1.6,
                marginTop: 2
              }}
            >
              {pending?.purgeLabel
                ? t('settings.plugins.purgeDetail', { label: pending.purgeLabel })
                : t('settings.plugins.purgeDetailFallback')}
            </div>
          </div>
        </div>

        <div
          style={{
            fontSize: 12,
            color: token.colorTextTertiary,
            lineHeight: 1.6,
            marginTop: 12
          }}
        >
          {t('settings.plugins.purgeHint')}
        </div>
      </Modal>

      {/* 插件仓库（GitHub）：列出可安装/可升级的独立插件 */}
      <Modal
        open={repoOpen}
        title={t('settings.plugins.repoTitle')}
        onCancel={() => setRepoOpen(false)}
        width={520}
        destroyOnHidden
        footer={
          <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center' }}>
            <span style={{ display: 'flex', gap: 8 }}>
              <Button size="small" onClick={() => void loadRepo()} disabled={repoPlugins === null}>
                {t('settings.plugins.repoRefresh')}
              </Button>
              <Button size="small" type="primary" onClick={() => setRepoOpen(false)}>
                {t('common.action.close')}
              </Button>
            </span>
          </div>
        }
      >
        <div style={{ fontSize: 12, color: token.colorTextTertiary, lineHeight: 1.6 }}>
          {repoUrl ? t('settings.plugins.repoSource', { repo: repoUrl }) : ''}
        </div>

        {repoError !== null && (
          <div style={{ fontSize: 12.5, color: token.colorError, marginTop: 12, lineHeight: 1.7 }}>
            {t('settings.plugins.repoFailed', { reason: repoError })}
          </div>
        )}

        {repoError === null && repoPlugins === null && (
          // 加载态走骨架物料（全项目统一：不再用 antd Spin，见 test/verify-skeleton-unification.mjs）
          <div style={{ marginTop: 16 }}>
            <SkeletonListRows rows={2} icon />
            <div style={{ fontSize: 12, color: token.colorTextTertiary, marginTop: 8 }}>
              {t('settings.plugins.repoLoading')}
            </div>
          </div>
        )}

        {repoPlugins !== null && repoPlugins.length === 0 && (
          <div style={{ fontSize: 12.5, color: token.colorTextSecondary, marginTop: 12 }}>
            {t('settings.plugins.repoEmpty')}
          </div>
        )}

        {repoPlugins !== null &&
          repoPlugins.map((entry) => (
            <div
              key={entry.id}
              className="sui-row"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                padding: '10px 0'
              }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 13.5, fontWeight: 600, color: token.colorText }}>
                    {entry.name}
                  </span>
                  <span style={{ fontSize: 11, color: token.colorTextTertiary }}>
                    v{entry.version}
                  </span>
                  {entry.installed && (
                    <span style={{ fontSize: 11, color: token.colorTextTertiary }}>
                      {t('settings.plugins.repoInstalledBadge')}
                    </span>
                  )}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: token.colorTextSecondary,
                    marginTop: 2,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {entry.description}
                </div>
              </div>
              <Button
                size="small"
                loading={repoBusy === entry.id}
                onClick={() => void installFromRepo(entry)}
              >
                {entry.installed
                  ? t('settings.plugins.repoUpgrade')
                  : t('settings.plugins.repoInstall')}
              </Button>
            </div>
          ))}
      </Modal>
    </div>
  )
}

export default PluginsPanel
