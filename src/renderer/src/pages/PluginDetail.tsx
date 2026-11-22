import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { App, Button, Input, Modal, Table, Tooltip, theme } from 'antd'
import type { TableProps } from 'antd'
import { useNavigate, useParams } from 'react-router-dom'
import {
  RiArrowLeftLine,
  RiChatSmile2Line,
  RiCloudLine,
  RiCodeSSlashLine,
  RiDeleteBin6Line,
  RiDownloadLine,
  RiExternalLinkLine,
  RiInformationLine,
  RiPlayCircleLine,
  RiRefreshLine,
  RiSendPlaneLine,
  RiSettings3Line,
  RiShieldCheckLine,
  RiUploadCloud2Line
} from '@remixicon/react'
import { useTranslation } from '@renderer/i18n'
import {
  usePlugins,
  usePluginRoutes,
  usePluginSettingsSections
} from '@renderer/plugin-host/PluginHostContext'
import { PluginBoundary } from '@renderer/plugin-host/PluginBoundary'
import PluginIcon from '@renderer/components/system/PluginIcon'
import MarkdownView from '@renderer/components/markdown/MarkdownView'
import { useTheme } from '@renderer/hooks/useTheme'
import { setWindowTitleSource } from '@renderer/window-title'
import { useLattice } from '@renderer/lattice/useLattice'
import UploadProgressModal from '@renderer/lattice/UploadProgressModal'
import { latticeErrorMessage } from '@renderer/lattice/api'
import { formatBytes, formatCount } from '@renderer/lattice/format'
import { isChatOpened, isFolderFallback } from '@renderer/lattice/source'
import type {
  HubDetailV2,
  HubVersionV2,
  LatticeDownloadKind,
  LatticeSourcePathResult
} from '@renderer/lattice/types'
import type { PluginListEntry } from '@shared/plugin/types'

/** 版本号：semver（允许 1.2.3 / 1.2.3-beta.1）；平台服务端还会做严格校验 */
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** 发布时间本地化展示（ISO → `YYYY-MM-DD HH:mm`；无法解析时原样显示） */
function formatPublishedAt(value?: string): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`
}

/**
 * 插件详情页（系统页面 `/plugins/:pluginId`）。
 *
 * 契约 v2（见 `lattice/.dev/ryten-lattice-contract-v2.md` §3）：
 * - 版本表：版本 / 大小 / 源码有无 + 大小 / 发布时间 / changelog / 下载安装包 / 下载源码；
 * - 已安装时显示本机版本与源码路径（`lattice.sourcePath`）；
 * - 「在对话中修改」→ `lattice.openSource`（返回 `opened:'folder'` 时如实提示只打开了文件夹）；
 * - 「发布新版本」→ 版本号 + 更新说明 Modal → `lattice.republish`，成功后刷新并提示；
 * - 本地安装包（平台上没有）→「发布到插件中心」，沿用 `lattice.pickAndUpload`；
 * - 卸载 / 启停 / 打开插件页面 / 插件设置保留原能力；
 * - 远程来源只有插件中心（Lattice 平台），没有额外的外部仓库入口。
 */
const PluginDetail: React.FC = () => {
  const { pluginId = '' } = useParams<{ pluginId: string }>()
  const { token } = theme.useToken()
  const { message, modal } = App.useApp()
  const { effectiveTheme } = useTheme()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const descriptors = usePlugins()
  const routes = usePluginRoutes()

  const [entry, setEntry] = useState<PluginListEntry | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  /** 插件自己的设置弹窗（设置类内容一律用弹窗，不铺在页面里） */
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** 打开源码 / 下载 / 发布进行中的互斥态（按钮 loading） */
  const [openSourceBusy, setOpenSourceBusy] = useState(false)
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null)
  /** 版本表里「安装此版本」进行中的版本号（与主安装按钮的 busy 分开，避免互相卡 loading） */
  const [installingVersion, setInstallingVersion] = useState<string | null>(null)
  const [publishing, setPublishing] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  /** 发布新版本 Modal */
  const [republishOpen, setRepublishOpen] = useState(false)
  const [republishVersion, setRepublishVersion] = useState('')
  const [republishChangelog, setRepublishChangelog] = useState('')
  const [republishError, setRepublishError] = useState<string | null>(null)
  const [republishing, setRepublishing] = useState(false)

  /**
   * 插件中心（登录后才可用）：
   * - `hubDetail`：该插件在平台上的最新版本 / 版本清单 / 源码信息（未发布时为空，静默忽略）；
   * - 发布动作：已发布走 `republish`（源码目录重新打包），未发布走 `pickAndUpload`。
   */
  const {
    available: latticeReady,
    loggedIn,
    pickAndUpload,
    clearUploadProgress,
    detailHub,
    installFromHub,
    sourcePath,
    localSource,
    openSource,
    republish,
    downloadAsset,
    capabilities
  } = useLattice()
  const [hubDetail, setHubDetail] = useState<HubDetailV2 | null>(null)
  const [sourceInfo, setSourceInfo] = useState<LatticeSourcePathResult>({ path: null })
  const [localSourcePath, setLocalSourcePath] = useState<string | null>(null)

  /** 安装清单 → 当前插件（未安装时为 null，但可能仍能从平台详情看到它） */
  const loadEntry = useCallback(async (): Promise<PluginListEntry | null> => {
    try {
      const list = await window.api.plugin.list()
      const found = list.find((e) => e.id === pluginId) ?? null
      setEntry(found)
      return found
    } catch (err) {
      console.error('[plugins] Failed to load plugin details:', err)
      return null
    }
  }, [pluginId])

  /** 本机源码路径 / 本机安装目录：已安装时读一次（v2 通道未就绪时静默为空） */
  const loadSourceInfo = useCallback(
    async (found: PluginListEntry | null): Promise<void> => {
      if (!found?.installed) {
        setSourceInfo({ path: null })
        setLocalSourcePath(null)
        return
      }
      const [info, local] = await Promise.all([
        capabilities.sourcePath ? sourcePath(pluginId) : Promise.resolve({ path: null }),
        capabilities.localSource ? localSource(pluginId) : Promise.resolve(null)
      ])
      setSourceInfo(info)
      setLocalSourcePath(local)
    },
    [capabilities.localSource, capabilities.sourcePath, localSource, pluginId, sourcePath]
  )

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const found = await loadEntry()
      await loadSourceInfo(found)
    } finally {
      setLoading(false)
    }
  }, [loadEntry, loadSourceInfo])

  const loadHubDetail = useCallback(async (): Promise<void> => {
    if (!latticeReady || !loggedIn) {
      setHubDetail(null)
      return
    }
    try {
      setHubDetail(await detailHub(pluginId))
    } catch {
      // 未发布 / 网络失败：详情页照常展示本机信息，不弹错
      setHubDetail(null)
    }
  }, [detailHub, latticeReady, loggedIn, pluginId])

  useEffect(() => {
    void load()
    const unsub = window.api.plugin.onStateChanged(() => void load())
    return unsub
  }, [load])

  useEffect(() => {
    void loadHubDetail()
  }, [loadHubDetail])

  // 原生窗口标题：插件详情页显示插件名
  const pageName = entry?.name ?? hubDetail?.name ?? pluginId
  useEffect(() => {
    setWindowTitleSource('plugin', pageName)
    return () => setWindowTitleSource('plugin', '')
  }, [pageName])

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
  const localVersion = entry?.version
  const hubLatestVersion = hubDetail?.latest_version
  const updateVersion =
    installed && hubLatestVersion && hubLatestVersion !== localVersion ? hubLatestVersion : null

  const name = entry?.name ?? hubDetail?.name ?? pluginId
  const description = entry?.description ?? hubDetail?.description ?? ''
  const version = localVersion ?? hubLatestVersion ?? '—'
  const icon = entry?.icon ?? hubDetail?.icon
  const menuIcon = entry?.menu?.icon
  const publishedOnHub = Boolean(hubDetail)
  const versions = hubDetail?.versions ?? []
  const latestVersionHasSource = Boolean(
    hubDetail?.has_source ??
      (versions.length > 0 ? versions[versions.length - 1]?.has_source : false)
  )
  const resolvedSourcePath = sourceInfo.path ?? null

  const toggle = useCallback(async (): Promise<void> => {
    if (!entry) return
    setBusy(true)
    try {
      await window.api.plugin.setEnabled(entry.id, !entry.enabled)
      await load()
    } catch (err) {
      message.error(t('settings.plugins.switchFail'))
      console.error('[plugins] Failed to switch enabled state:', err)
    } finally {
      setBusy(false)
    }
  }, [entry, load, message, t])

  /** 安装 / 更新：走平台 `lattice.install`（主进程会同时下载并解压源码） */
  const installOrUpdate = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await installFromHub(pluginId, hubLatestVersion ?? undefined)
      if (!result.ok) {
        message.error(result.error || t('settings.plugins.installFail'))
        return
      }
      message.success(
        installed
          ? t('plugins.hub.updateSuccess', { name, version: result.version ?? '' })
          : t('plugins.hub.installSuccess', { name })
      )
      if (result.sourceError) {
        message.warning(t('plugins.hub.source.downloadFailed', { reason: result.sourceError }))
      }
      await Promise.all([load(), loadHubDetail()])
    } catch (err) {
      message.error(t('settings.plugins.installFail'))
      console.error('[plugins] Failed to install:', err)
    } finally {
      setBusy(false)
    }
  }, [hubLatestVersion, installed, installFromHub, load, loadHubDetail, message, name, pluginId, t])

  /**
   * 版本表里安装**指定版本**（升级/降级都走这里）。
   *
   * 用户口径「需要版本管理」：光能下载历史版本不够——插件中心的最新版可能是坏的/不兼容，
   * 用户要能把机器上的插件固定到某个已验证版本。主进程 `lattice.install` 本来就接受
   * `version` 参数（契约 v2），这里只是把入口暴露出来，并如实提示源码下载失败。
   */
  const installSpecificVersion = useCallback(
    async (targetVersion: string): Promise<void> => {
      if (!targetVersion || installingVersion) return
      setInstallingVersion(targetVersion)
      try {
        const result = await installFromHub(pluginId, targetVersion)
        if (!result.ok) {
          message.error(result.error || t('settings.plugins.installFail'))
          return
        }
        message.success(
          t('plugins.hub.installVersionSuccess', {
            name,
            version: result.version ?? targetVersion
          })
        )
        if (result.sourceError) {
          message.warning(t('plugins.hub.source.downloadFailed', { reason: result.sourceError }))
        }
        await Promise.all([load(), loadHubDetail()])
      } catch (err) {
        message.error(t('settings.plugins.installFail'))
        console.error('[plugins] Failed to install specified version:', err)
      } finally {
        setInstallingVersion(null)
      }
    },
    [installFromHub, installingVersion, load, loadHubDetail, message, name, pluginId, t]
  )

  /**
   * 发布到插件中心（本地安装包，平台上还没有这个插件）：
   * 主进程弹系统选择框挑「插件包目录」，打包后上传安装包 + 源码。
   */
  const handlePublish = useCallback(async (): Promise<void> => {
    clearUploadProgress()
    setUploadOpen(true)
    setPublishing(true)
    try {
      const result = await pickAndUpload()
      if (!result.ok) {
        setUploadOpen(false)
        message.error(result.error || t('lattice.upload.fail'))
        return
      }
      if ('canceled' in result) {
        setUploadOpen(false)
        message.info(t('lattice.upload.canceled'))
        return
      }
      setUploadOpen(false)
      message.success(
        t('lattice.upload.success', { name: result.plugin_id, version: result.version })
      )
      // 发布成功后刷新平台最新版本（首次发布后这里从「尚未发布」变成具体版本）
      await loadHubDetail()
    } catch (err) {
      setUploadOpen(false)
      message.error(t('lattice.upload.fail'))
      console.error('[lattice] Failed to publish plugin:', err)
    } finally {
      setPublishing(false)
    }
  }, [clearUploadProgress, loadHubDetail, message, pickAndUpload, t])

  /** 在对话中修改：主进程优先建/复用源码工作区并开一条插件会话，失败回退文件管理器 */
  const handleOpenSource = useCallback(async (): Promise<void> => {
    if (!capabilities.openSource) {
      message.info(t('plugins.hub.openSource.unsupported'))
      return
    }
    setOpenSourceBusy(true)
    try {
      const result = await openSource(pluginId)
      if (!result.ok) {
        message.error(t('plugins.hub.openSource.fail', { reason: result.error }))
        return
      }
      if (isFolderFallback(result)) {
        // 如实告知：只打开了文件夹，没有自动创建对话
        message.info(t('plugins.hub.openSource.folderFallback'))
        return
      }
      message.success(t('plugins.hub.openSource.success'))
      if (isChatOpened(result)) {
        // 侧栏收到这个事件后按 pluginId+topicId 直接切到插件会话（主进程已把设置写盘）
        window.dispatchEvent(
          new CustomEvent('lattice-open-source', {
            detail: {
              pluginId,
              topicId: result.topicId,
              workspaceId: result.workspaceId
            }
          })
        )
        window.dispatchEvent(
          new CustomEvent('workspace-changed', { detail: { workspaceId: result.workspaceId } })
        )
        navigate('/harness')
      }
    } catch (err) {
      message.error(t('plugins.hub.openSource.fail', { reason: latticeErrorMessage(err) }))
      console.error('[lattice] Failed to open source:', err)
    } finally {
      setOpenSourceBusy(false)
    }
  }, [capabilities.openSource, message, navigate, openSource, pluginId, t])

  const openRepublishModal = useCallback((): void => {
    setRepublishVersion('')
    setRepublishChangelog('')
    setRepublishError(null)
    setRepublishOpen(true)
  }, [])

  /** 发布新版本：校验 semver → 主进程读源码目录重打包（安装包 + 源码）并上传 */
  const submitRepublish = useCallback(async (): Promise<void> => {
    const nextVersion = republishVersion.trim()
    if (!nextVersion) {
      setRepublishError(t('plugins.hub.publish.versionRequired'))
      return
    }
    if (!VERSION_PATTERN.test(nextVersion)) {
      setRepublishError(t('plugins.hub.publish.versionInvalid'))
      return
    }
    setRepublishError(null)
    setRepublishing(true)
    try {
      const result = await republish({
        pluginId,
        version: nextVersion,
        changelog: republishChangelog.trim() || undefined
      })
      if (!result.ok) {
        setRepublishError(result.error || t('lattice.upload.fail'))
        return
      }
      setRepublishOpen(false)
      message.success(t('plugins.hub.publish.success', { version: result.version }))
      await Promise.all([load(), loadHubDetail()])
    } catch (err) {
      setRepublishError(latticeErrorMessage(err))
    } finally {
      setRepublishing(false)
    }
  }, [load, loadHubDetail, message, pluginId, republish, republishChangelog, republishVersion, t])

  /** 下载某个版本的安装包 / 源码包（主进程弹保存框） */
  const handleDownload = useCallback(
    async (target: HubVersionV2, kind: LatticeDownloadKind): Promise<void> => {
      if (!capabilities.downloadAsset) {
        message.info(t('plugins.hub.download.unsupported'))
        return
      }
      const key = `${target.version}:${kind}`
      setDownloadingKey(key)
      try {
        const result = await downloadAsset(pluginId, target.version, kind)
        if (!result.ok) {
          message.error(t('plugins.hub.download.fail', { reason: result.error }))
          return
        }
        if (result.canceled) {
          message.info(t('plugins.hub.download.canceled'))
          return
        }
        message.success(t('plugins.hub.download.success', { path: result.savedPath }))
      } catch (err) {
        message.error(t('plugins.hub.download.fail', { reason: latticeErrorMessage(err) }))
      } finally {
        setDownloadingKey(null)
      }
    },
    [capabilities.downloadAsset, downloadAsset, message, pluginId, t]
  )

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
          console.error('[plugins] Failed to uninstall:', err)
        }
      }
    })
  }, [entry, modal, message, navigate, name, t])

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

  const infoRow = (label: string, value: React.ReactNode): React.ReactNode => (
    <div
      key={label}
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 12,
        padding: '7px 0',
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        fontSize: 10.5,
        color: token.colorTextTertiary
      }}
    >
      <span style={{ flexShrink: 0 }}>{label}</span>
      <span
        style={{
          color: token.colorTextSecondary,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          minWidth: 0
        }}
      >
        {value}
      </span>
    </div>
  )

  /** 版本表：版本 / 大小 / 源码 / 发布时间 / 更新说明 / 下载 */
  const versionColumns = useMemo<
    NonNullable<TableProps<HubVersionV2>['columns']>
  >(() => {
    const downloadUnsupported = !capabilities.downloadAsset
    return [
      {
        title: t('plugins.hub.versionTable.version'),
        dataIndex: 'version',
        key: 'version',
        width: 140,
        render: (_: unknown, row: HubVersionV2) => (
          <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
            v{row.version}
            {row.version === hubLatestVersion && (
              <span
                className="lattice-hub-tag"
                style={{
                  marginLeft: 6,
                  background: token.colorPrimaryBg,
                  color: token.colorPrimary
                }}
              >
                {t('plugins.hub.versionTable.latest')}
              </span>
            )}
          </span>
        )
      },
      {
        title: t('plugins.hub.versionTable.size'),
        dataIndex: 'size',
        key: 'size',
        width: 100,
        render: (size: number) => (
          <span style={{ color: token.colorTextSecondary }}>{formatBytes(size)}</span>
        )
      },
      {
        title: (
          <Tooltip title={t('plugins.hub.source.hint')}>
            <span>{t('plugins.hub.versionTable.source')}</span>
          </Tooltip>
        ),
        key: 'source',
        width: 150,
        render: (_: unknown, row: HubVersionV2) =>
          row.has_source ? (
            <Tooltip title={row.source_asset_name || t('plugins.hub.source.hasSource')}>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  color: token.colorTextSecondary
                }}
              >
                <RiCodeSSlashLine size={13} />
                {row.source_size
                  ? t('plugins.hub.source.size', { size: formatBytes(row.source_size) })
                  : t('plugins.hub.source.hasSource')}
              </span>
            </Tooltip>
          ) : (
            <span style={{ color: token.colorTextQuaternary }}>
              {t('plugins.hub.source.noSource')}
            </span>
          )
      },
      {
        title: t('plugins.hub.versionTable.publishedAt'),
        dataIndex: 'published_at',
        key: 'published_at',
        width: 150,
        render: (value?: string) => (
          <span style={{ color: token.colorTextSecondary }}>{formatPublishedAt(value)}</span>
        )
      },
      {
        title: t('plugins.hub.versionTable.changelog'),
        dataIndex: 'changelog',
        key: 'changelog',
        ellipsis: true,
        render: (value?: string) => {
          const text = value?.trim()
          if (!text) return <span style={{ color: token.colorTextQuaternary }}>{t('plugins.hub.versionTable.noChangelog')}</span>
          return (
            <Tooltip title={text}>
              <span style={{ display: 'inline-block', maxWidth: '100%' }}>{text}</span>
            </Tooltip>
          )
        }
      },
      {
        title: t('plugins.hub.versionTable.actions'),
        key: 'actions',
        width: 260,
        render: (_: unknown, row: HubVersionV2) => {
          const packageKey = `${row.version}:package`
          const sourceKey = `${row.version}:source`
          const isCurrent = installed && localVersion === row.version
          return (
            <div style={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
              <Tooltip
                title={
                  isCurrent
                    ? t('plugins.hub.versionTable.currentVersion')
                    : t('plugins.hub.versionTable.installVersion')
                }
              >
                <Button
                  size="small"
                  type="link"
                  style={{ paddingInline: 4, fontSize: 11 }}
                  icon={<RiDownloadLine size={13} />}
                  disabled={isCurrent}
                  loading={installingVersion === row.version}
                  onClick={() => void installSpecificVersion(row.version)}
                >
                  {isCurrent
                    ? t('plugins.hub.versionTable.currentVersion')
                    : t('plugins.hub.versionTable.installVersion')}
                </Button>
              </Tooltip>
              <Tooltip title={downloadUnsupported ? t('plugins.hub.download.unsupported') : undefined}>
                <Button
                  size="small"
                  type="link"
                  style={{ paddingInline: 4, fontSize: 11 }}
                  icon={<RiDownloadLine size={13} />}
                  disabled={downloadUnsupported}
                  loading={downloadingKey === packageKey}
                  onClick={() => void handleDownload(row, 'package')}
                >
                  {t('plugins.hub.versionTable.downloadPackage')}
                </Button>
              </Tooltip>
              <Tooltip
                title={
                  downloadUnsupported
                    ? t('plugins.hub.download.unsupported')
                    : !row.has_source
                      ? t('plugins.hub.source.noSource')
                      : undefined
                }
              >
                <Button
                  size="small"
                  type="link"
                  style={{ paddingInline: 4, fontSize: 11 }}
                  icon={<RiCodeSSlashLine size={13} />}
                  disabled={downloadUnsupported || !row.has_source}
                  loading={downloadingKey === sourceKey}
                  onClick={() => void handleDownload(row, 'source')}
                >
                  {t('plugins.hub.versionTable.downloadSource')}
                </Button>
              </Tooltip>
            </div>
          )
        }
      }
    ]
  }, [
    capabilities.downloadAsset,
    downloadingKey,
    handleDownload,
    hubLatestVersion,
    installSpecificVersion,
    installed,
    installingVersion,
    localVersion,
    t,
    token.colorBorderSecondary,
    token.colorPrimary,
    token.colorPrimaryBg,
    token.colorTextQuaternary,
    token.colorTextSecondary
  ])

  if (loading && !entry && !hubDetail) {
    return (
      <div style={{ padding: 36, fontSize: 12, color: token.colorTextTertiary }}>
        {t('common.state.loading')}
      </div>
    )
  }

  if (!entry && !hubDetail) {
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

  const infoRows: React.ReactNode[] = [
    // 已安装：本机版本；未安装：头部已经写了版本，不再重复一行
    ...(installed && localVersion
      ? [infoRow(t('plugins.hub.detail.localVersion'), `v${localVersion}`)]
      : []),
    ...(latticeReady && loggedIn
      ? [
          infoRow(
            t('plugins.hub.detail.latestVersion'),
            hubLatestVersion ? `v${hubLatestVersion}` : t('plugins.hub.detail.notPublished')
          )
        ]
      : []),
    ...(installed
      ? [
          resolvedSourcePath
            ? infoRow(
                t('plugins.hub.detail.sourcePath'),
                <span title={resolvedSourcePath}>{resolvedSourcePath}</span>
              )
            : localSourcePath
              ? infoRow(
                  t('plugins.hub.detail.localSourcePath'),
                  <span title={localSourcePath}>{localSourcePath}</span>
                )
              : infoRow(t('plugins.hub.detail.sourcePath'), t('plugins.hub.detail.noSourcePath'))
        ]
      : []),
    ...(publishedOnHub
      ? [
          infoRow(
            t('plugins.hub.source.badge'),
            latestVersionHasSource
              ? t('plugins.hub.source.hasSource')
              : t('plugins.hub.source.noSource')
          ),
          infoRow(t('plugins.hub.detail.category'), hubDetail?.category || '—'),
          infoRow(
            t('plugins.hub.detail.tags'),
            (hubDetail?.tags ?? []).length > 0 ? (hubDetail?.tags ?? []).join(' / ') : '—'
          ),
          infoRow(
            t('plugins.hub.detail.downloadsLabel'),
            formatCount(hubDetail?.downloads)
          )
        ]
      : []),
    infoRow(t('settings.plugins.entry'), entry?.entry?.renderer ?? entry?.entry?.main ?? '—')
  ]

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: token.colorBgContainer }}>
      <div style={{ maxWidth: 1120, margin: '0 auto', padding: '0 36px 36px' }}>
        {/* 顶行：与侧栏品牌区同高（33px），返回按钮垂直居中 */}
        <div className="shell-topbar">
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
        </div>

        {/* 头部：图标 / 名称 / 版本状态 / 描述 / 平台最新版 + 主要操作 */}
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
          <PluginIcon id={pluginId} icon={icon} menuIcon={menuIcon} size={54} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
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
              {!publishedOnHub && (
                <span
                  className="lattice-hub-tag"
                  style={{ background: token.colorFillSecondary, color: token.colorTextTertiary }}
                >
                  {t('plugins.hub.local.badge')}
                </span>
              )}
            </div>
            <div
              style={{
                marginTop: 5,
                fontSize: 11,
                color: token.colorTextTertiary,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                flexWrap: 'wrap'
              }}
            >
              <span>v{version}</span>
              {updateVersion && <span>→ v{updateVersion}</span>}
              <span>·</span>
              <span>
                {installed
                  ? t('settings.plugins.installedState')
                  : t('settings.plugins.notInstalledState')}
              </span>
              {installed && (
                <>
                  <span>·</span>
                  <span>{enabled ? t('plugins.hub.enabled') : t('plugins.hub.disabled')}</span>
                </>
              )}
              {publishedOnHub && hubLatestVersion && (
                <>
                  <span>·</span>
                  <span
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                    title={t('plugins.hub.detail.latestVersion')}
                  >
                    <RiCloudLine size={11} />
                    {t('plugins.hub.detail.latestVersion')} v{hubLatestVersion}
                  </span>
                </>
              )}
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
            {installed && !publishedOnHub && latticeReady && loggedIn && (
              <div style={{ marginTop: 7, fontSize: 10, color: token.colorTextTertiary }}>
                {t('plugins.hub.detail.notPublishedHint')}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            {installed && (
              <Button size="small" loading={busy} onClick={() => void toggle()}>
                {enabled ? t('settings.plugins.disable') : t('settings.plugins.enable')}
              </Button>
            )}
            {updateVersion ? (
              <Button
                size="small"
                loading={busy}
                icon={<RiRefreshLine size={14} />}
                onClick={() => void installOrUpdate()}
              >
                {t('plugins.hub.updateTo', { version: updateVersion })}
              </Button>
            ) : !installed ? (
              <Button
                size="small"
                loading={busy}
                icon={<RiDownloadLine size={14} />}
                onClick={() => void installOrUpdate()}
              >
                {hubLatestVersion
                  ? t('plugins.hub.detail.installVersion', { version: hubLatestVersion })
                  : t('plugins.hub.install')}
              </Button>
            ) : route ? (
              <Button
                size="small"
                icon={<RiExternalLinkLine size={14} />}
                onClick={() => navigate(route.path)}
              >
                {t('settings.plugins.openPage')}
              </Button>
            ) : null}
          </div>
        </div>

        {/* 主体：左「操作」；右「信息」+「运行状态」 */}
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
              {!installed &&
                actionRow(
                  <RiDownloadLine size={15} />,
                  t('plugins.hub.install'),
                  t('plugins.hub.source.hint'),
                  () => void installOrUpdate(),
                  busy
                )}
              {installed &&
                actionRow(
                  <RiChatSmile2Line size={15} />,
                  t('plugins.hub.detail.openInChat'),
                  capabilities.openSource
                    ? t('plugins.hub.detail.openInChatDesc')
                    : t('plugins.hub.openSource.unsupported'),
                  () => void handleOpenSource(),
                  openSourceBusy || !capabilities.openSource
                )}
              {installed &&
                publishedOnHub &&
                actionRow(
                  <RiSendPlaneLine size={15} />,
                  t('plugins.hub.detail.publishNewVersion'),
                  capabilities.republish
                    ? t('plugins.hub.detail.publishNewVersionDesc')
                    : t('plugins.hub.v2Unsupported'),
                  openRepublishModal,
                  republishing || !loggedIn || !capabilities.republish
                )}
              {installed &&
                !publishedOnHub &&
                actionRow(
                  <RiUploadCloud2Line size={15} />,
                  t('plugins.hub.detail.publishLocal'),
                  t('plugins.hub.detail.publishLocalDesc'),
                  () => void handlePublish(),
                  publishing || !loggedIn
                )}
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
              {/* 源码/发布流程说明：安装自动带源码 → 对话修改 → 发布新版本 */}
              <div
                style={{
                  marginTop: 14,
                  paddingTop: 12,
                  borderTop: `1px solid ${token.colorBorderSecondary}`
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 11,
                    fontWeight: 600,
                    color: token.colorTextSecondary
                  }}
                >
                  <RiCodeSSlashLine size={13} />
                  {t('plugins.hub.detail.workflowTitle')}
                </div>
                <div
                  style={{
                    marginTop: 6,
                    fontSize: 10.5,
                    lineHeight: 1.7,
                    color: token.colorTextTertiary
                  }}
                >
                  {t('plugins.hub.detail.workflowDesc')}
                </div>
              </div>
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
              <div style={{ marginTop: 2 }}>{infoRows}</div>
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

        {/* 插件说明：平台 README（Markdown，已做 sanitize），长文限高滚动 */}
        {publishedOnHub && hubDetail?.readme?.trim() ? (
          <section
            style={{
              marginTop: 12,
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
                gap: 6,
                fontSize: 12,
                fontWeight: 600,
                color: token.colorText
              }}
            >
              <RiInformationLine size={14} />
              {t('plugins.hub.detail.readmeTitle')}
            </div>
            <div
              className="custom-container-scrollbar"
              style={{ marginTop: 8, maxHeight: 520, overflow: 'auto' }}
            >
              <MarkdownView content={hubDetail.readme} isDarkMode={effectiveTheme === 'dark'} />
            </div>
          </section>
        ) : null}

        {/* 版本历史（平台版本管理 + 安装包/源码包下载） */}
        {publishedOnHub && (
          <section
            style={{
              marginTop: 12,
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
                gap: 8,
                flexWrap: 'wrap',
                fontSize: 12,
                fontWeight: 600,
                color: token.colorText
              }}
            >
              {t('plugins.hub.versionTable.title')}
              <span
                style={{ fontWeight: 400, fontSize: 10.5, color: token.colorTextTertiary }}
              >
                {t('plugins.hub.versions', { n: versions.length })}
              </span>
              <Tooltip title={t('plugins.hub.source.hint')}>
                <span
                  style={{
                    marginLeft: 'auto',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    fontWeight: 400,
                    fontSize: 10,
                    color: latestVersionHasSource
                      ? token.colorTextTertiary
                      : token.colorTextQuaternary
                  }}
                >
                  <RiCodeSSlashLine size={12} />
                  {latestVersionHasSource
                    ? t('plugins.hub.source.hasSource')
                    : t('plugins.hub.source.noSource')}
                </span>
              </Tooltip>
            </div>
            {!capabilities.downloadAsset && (
              <div style={{ marginTop: 6, fontSize: 10, color: token.colorTextTertiary }}>
                {t('plugins.hub.download.unsupported')}
              </div>
            )}
            <div style={{ marginTop: 10 }}>
              <Table<HubVersionV2>
                size="small"
                rowKey="version"
                columns={versionColumns}
                dataSource={versions}
                pagination={false}
                scroll={{ x: 960 }}
                locale={{ emptyText: t('plugins.hub.versionTable.empty') }}
              />
            </div>
          </section>
        )}
      </div>

      {/* 发布新版本：版本号 + 更新说明 → lattice.republish（读本机源码目录重打包） */}
      <Modal
        open={republishOpen}
        title={t('plugins.hub.publish.title')}
        okText={t('plugins.hub.publish.submit')}
        cancelText={t('common.action.cancel')}
        confirmLoading={republishing}
        onOk={() => void submitRepublish()}
        onCancel={() => {
          if (!republishing) setRepublishOpen(false)
        }}
        destroyOnHidden
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingTop: 2 }}>
          <div>
            <div style={{ fontSize: 11, color: token.colorTextSecondary, marginBottom: 6 }}>
              {t('plugins.hub.publish.version')}
            </div>
            <Input
              value={republishVersion}
              onChange={(e) => {
                setRepublishVersion(e.target.value)
                if (republishError) setRepublishError(null)
              }}
              placeholder={t('plugins.hub.publish.versionPlaceholder')}
              status={republishError ? 'error' : undefined}
              onPressEnter={() => void submitRepublish()}
            />
            <div style={{ marginTop: 5, fontSize: 10, color: token.colorTextTertiary }}>
              {hubLatestVersion
                ? t('plugins.hub.publish.versionHint', { version: hubLatestVersion })
                : t('plugins.hub.local.desc')}
            </div>
            {republishError && (
              <div style={{ marginTop: 5, fontSize: 10.5, color: token.colorError }}>
                {republishError}
              </div>
            )}
          </div>
          <div>
            <div style={{ fontSize: 11, color: token.colorTextSecondary, marginBottom: 6 }}>
              {t('plugins.hub.publish.changelog')}
            </div>
            <Input.TextArea
              value={republishChangelog}
              onChange={(e) => setRepublishChangelog(e.target.value)}
              placeholder={t('plugins.hub.publish.changelogPlaceholder')}
              rows={4}
              maxLength={2000}
              showCount
            />
          </div>
        </div>
      </Modal>

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

      {/* 发布到插件中心的上传进度（与插件仓库页共用同一个弹窗组件） */}
      <UploadProgressModal open={uploadOpen} />
    </div>
  )
}

export default PluginDetail
