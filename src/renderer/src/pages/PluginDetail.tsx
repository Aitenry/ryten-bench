import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { App, Button, Checkbox, Input, Modal, Table, Tooltip, theme } from 'antd'
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
import { isVersionNewer } from '@shared/plugin/version'

/** Version: semver (allows 1.2.3 / 1.2.3-beta.1); the platform server also validates strictly */
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** Localized publish time (ISO → `YYYY-MM-DD HH:mm`; shown as-is when unparseable) */
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
 * Plugin detail page (system page `/plugins/:pluginId`).
 *
 * - Version table: version / size / source available + size / publish time / changelog / download installer / download source;
 * - When installed, show the local version and source path (`lattice.sourcePath`);
 * - "Modify in chat" → `lattice.openSource` (when it returns `opened:'folder'`, truthfully say only the folder was opened);
 * - "Publish new version" → version + release notes Modal → `lattice.republish`, then refresh and notify on success;
 * - Local installer (not on the platform) → "Publish to plugin hub", reusing `lattice.pickAndUpload`;
 * - Uninstall / enable-disable / open plugin page / plugin settings keep their original capabilities;
 * - The only remote source is the plugin hub (Lattice platform); there is no extra external repository entry.
 */
const PluginDetail: React.FC = () => {
  const { pluginId = '' } = useParams<{ pluginId: string }>()
  const { token } = theme.useToken()
  const { message } = App.useApp()
  const { effectiveTheme } = useTheme()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const descriptors = usePlugins()
  const routes = usePluginRoutes()

  const [entry, setEntry] = useState<PluginListEntry | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  /** The plugin's own settings modal (settings content always goes in a modal, never laid out in the page) */
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** Mutually exclusive busy state for open source / download / publish (button loading) */
  const [openSourceBusy, setOpenSourceBusy] = useState(false)
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null)
  /** Version currently installing from the version table ("install this version"), separate from the main install button's busy so they do not block each other's loading */
  const [installingVersion, setInstallingVersion] = useState<string | null>(null)
  const [publishing, setPublishing] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  /** Publish-new-version modal */
  const [republishOpen, setRepublishOpen] = useState(false)
  const [republishVersion, setRepublishVersion] = useState('')
  const [republishChangelog, setRepublishChangelog] = useState('')
  /** Validation error for the version field (red border + shown below the input only) */
  const [republishVersionError, setRepublishVersionError] = useState<string | null>(null)
  /** Error of the publish action itself (build/package/upload; shown at the bottom of the form, no red border on the version) */
  const [republishError, setRepublishError] = useState<string | null>(null)
  const [republishing, setRepublishing] = useState(false)
  /**
   * Uninstall confirmation (user 2026-11-23: "uninstalling no longer has the checkbox to clear local data, it used to").
   *
   * A controlled Modal instead of `modal.confirm`: the checkbox decides the `purgeData` passed to the main process,
   * so it needs real state; the confirm button also needs a loading state (uninstall first revokes the cloud install record, up to a few seconds).
   */
  const [uninstallOpen, setUninstallOpen] = useState(false)
  const [purgeData, setPurgeData] = useState(false)
  const [uninstalling, setUninstalling] = useState(false)

  /**
   * Plugin hub (available only after login):
   * - `hubDetail`: the plugin's latest version / version list / source info on the platform (empty when unpublished, silently ignored);
   * - Publish action: already published goes through `republish` (repackages the source directory), unpublished goes through `pickAndUpload`.
   */
  const {
    available: latticeReady,
    loggedIn,
    pickAndUpload,
    publishInstalled,
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
  /**
   * Current state of the platform detail.
   *
   * Previously `hubDetail === null` was the only signal, conflating "loading / not logged in / network failure / truly unpublished
   * (404)" into one thing: opening an uninstalled plugin from the plugin repository, the local list came back first while the platform detail was still
   * in flight, so the page rendered "plugin does not exist or has been uninstalled"; a network failure then stayed there forever. An installed and published
   * plugin would also briefly flash "installed locally / publish to plugin hub" during the loading window.
   */
  const [hubDetailState, setHubDetailState] = useState<
    'idle' | 'loading' | 'loaded' | 'notFound' | 'error' | 'unauthenticated' | 'unavailable'
  >('idle')
  const [hubDetailError, setHubDetailError] = useState<string | null>(null)
  const [sourceInfo, setSourceInfo] = useState<LatticeSourcePathResult>({ path: null })
  const [localSourcePath, setLocalSourcePath] = useState<string | null>(null)
  /**
   * Any install/uninstall/publish/download action is in progress (ref version, so callbacks read the latest value).
   *
   * The detail page has a row of mutually exclusive actions: update, install specific version, enable/disable, uninstall, publish, download, open source.
   * Previously each button only managed its own loading, so "click update → immediately uninstall" let the uninstall finish first while the install landed later,
   * and the UI messages contradicted each other (uninstall succeeded, then the plugin auto-installed again seconds later).
   */
  const actionBusyRef = useRef(false)
  actionBusyRef.current =
    busy ||
    openSourceBusy ||
    publishing ||
    republishing ||
    uninstalling ||
    installingVersion !== null ||
    downloadingKey !== null
  const anyActionBusy = actionBusyRef.current

  /** Install list → current plugin (null when not installed, but it may still be visible from the platform detail) */
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

  /** Local source path / local install directory: read once when installed (silently empty while the v2 channel is not ready) */
  const loadSourceInfo = useCallback(
    async (found: PluginListEntry | null): Promise<void> => {
      if (!found) {
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
    if (!latticeReady) {
      setHubDetail(null)
      setHubDetailState('unavailable')
      setHubDetailError(null)
      return
    }
    if (!loggedIn) {
      setHubDetail(null)
      setHubDetailState('unauthenticated')
      setHubDetailError(null)
      return
    }
    setHubDetailState((previous) =>
      previous === 'loaded' || previous === 'notFound' ? previous : 'loading'
    )
    setHubDetailError(null)
    try {
      // Not published to the platform → the main process normalizes 404 to null; a network failure throws (must be distinguished from "really absent")
      const detail = await detailHub(pluginId)
      if (detail) {
        setHubDetail(detail)
        setHubDetailState('loaded')
      } else {
        setHubDetail(null)
        setHubDetailState('notFound')
      }
    } catch (err) {
      setHubDetailError(latticeErrorMessage(err))
      // Keep the last successfully fetched detail (a failed refresh should not downgrade the whole page to "does not exist")
      setHubDetailState('error')
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

  // Native window title: the plugin detail page shows the plugin name
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
   * Settings pages registered by this plugin: the plugin's own config items moved from "Settings" into the plugin detail (user wording 2026-11-19
   * "remove these two items from settings and put them in the plugin repository"). Once the plugin is disabled/uninstalled it is gone from the registry,
   * so this is naturally empty here.
   */
  const allSettingsSections = usePluginSettingsSections()
  const settingsSections = useMemo(
    () => allSettingsSections.filter((s) => s.pluginId === pluginId),
    [allSettingsSections, pluginId]
  )

  const installed = Boolean(entry)
  const enabled = Boolean(entry?.enabled)
  const failed = descriptor?.state === 'error'
  /**
   * Whether data can really be purged: only a loaded plugin registers the `plugin.purge` contribution (after disabling/uninstalling
   * the contribution is removed). Without the contribution the main process only deletes the code and keeps the data as-is — the checkbox must reflect this.
   */
  const canPurgePluginData = Boolean(entry?.purgeLabel)
  const localVersion = entry?.version
  const hubLatestVersion = hubDetail?.latest_version
  /**
   * Update available = the hub's latest version is **strictly newer** than the local version.
   *
   * "Version strings differ" must not be used: with local v0.4.1 and hub latest v0.3.0 the strings differ, so the page would show
   * "update available" and offer a downgrade entry "update to v0.3.0" (2026-11-23 user feedback
   * "the local version is obviously higher, why update"). With a semver comparison this is null when the local version is newer.
   */
  const updateVersion =
    installed && isVersionNewer(hubLatestVersion, localVersion) ? (hubLatestVersion ?? null) : null

  const name = entry?.name ?? hubDetail?.name ?? pluginId
  const description = entry?.description ?? hubDetail?.description ?? ''
  const version = localVersion ?? hubLatestVersion ?? '—'
  const icon = entry?.icon ?? hubDetail?.icon
  const menuIcon = entry?.menu?.icon
  const publishedOnHub = Boolean(hubDetail)
  const hubConfirmedNotPublished = hubDetailState === 'notFound'
  const versions = hubDetail?.versions ?? []
  /** The platform version list is in reverse chronological order; the entry `latest_version` points at is the "latest", otherwise take the first one */
  const latestVersionEntry =
    versions.find((item) => item.version === hubDetail?.latest_version) ?? versions[0]
  const latestVersionHasSource = Boolean(hubDetail?.has_source || latestVersionEntry?.has_source)
  const resolvedSourcePath = sourceInfo.path ?? null
  /**
   * "Runtime status" in one phrase: not installed / load failed / in use / disabled.
   *
   * Previously anything not in error showed "in use", and an uninstalled plugin (no descriptor) also showed a green "in use",
   * conflicting with "not installed" in the same card (2026-11-23 user feedback "a pile of problems").
   */
  const runtimeLabel = !installed
    ? t('settings.plugins.notInstalledState')
    : failed
      ? t('settings.plugins.loadFailed')
      : enabled
        ? t('harness.sidebar.pluginState.enabled')
        : t('harness.sidebar.pluginState.disabled')
  const runtimeColor = !installed
    ? token.colorTextTertiary
    : failed
      ? token.colorError
      : enabled
        ? token.colorSuccess
        : token.colorTextTertiary

  const toggle = useCallback(async (): Promise<void> => {
    if (!entry || actionBusyRef.current) return
    setBusy(true)
    try {
      await window.api.plugin.setEnabled(entry.id, !entry.enabled)
      await load()
    } catch (err) {
      message.error(t('settings.plugins.switchFail'))
      console.error('[plugins] Failed to switch enabled state:', err)
      // The main process rolls back state on failure: read again so the button does not stay in the wrong direction
      await load()
    } finally {
      setBusy(false)
    }
  }, [entry, load, message, t])

  /** Install / update: goes through the platform `lattice.install` (the main process downloads and extracts the source too) */
  const installOrUpdate = useCallback(async (): Promise<void> => {
    if (actionBusyRef.current) return
    if (!loggedIn) {
      navigate('/login')
      return
    }
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
      if (result.sourceBackupPath) {
        message.warning(t('plugins.hub.source.backedUp', { path: result.sourceBackupPath }), 8)
      }
      await Promise.all([load(), loadHubDetail()])
    } catch (err) {
      message.error(t('settings.plugins.installFail'))
      console.error('[plugins] Failed to install:', err)
    } finally {
      setBusy(false)
    }
  }, [
    hubLatestVersion,
    installed,
    installFromHub,
    load,
    loadHubDetail,
    loggedIn,
    message,
    name,
    navigate,
    pluginId,
    t
  ])

  /**
   * Install a **specific version** from the version table (both upgrade and downgrade go through here).
   *
   * User wording "needs version management": being able to download historical versions is not enough — the hub's latest version may be broken/incompatible,
   * and the user must be able to pin the plugin on the machine to a verified version. The main process `lattice.install` already accepts
   * a `version` parameter, so this just exposes the entry point and truthfully reports source download failures.
   */
  const installSpecificVersion = useCallback(
    async (targetVersion: string): Promise<void> => {
      if (!targetVersion || actionBusyRef.current) return
      if (!loggedIn) {
        navigate('/login')
        return
      }
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
        if (result.sourceBackupPath) {
          message.warning(t('plugins.hub.source.backedUp', { path: result.sourceBackupPath }), 8)
        }
        await Promise.all([load(), loadHubDetail()])
      } catch (err) {
        message.error(t('settings.plugins.installFail'))
        console.error('[plugins] Failed to install specified version:', err)
      } finally {
        setInstallingVersion(null)
      }
    },
    [installFromHub, load, loadHubDetail, loggedIn, message, name, navigate, pluginId, t]
  )

  /**
   * Publish to the plugin hub (installed locally, not yet on the platform).
   *
   * Defaults to **publishing directly**: the installer directory (`userData/plugins/<id>`) and the source directory are already there, no need to
   * pop a system directory picker (user 2026-11-23: "why does publishing a local plugin still require the user to pick one").
   * Only when the old main process lacks the `publishInstalled` channel does it fall back to "pick a directory and publish".
   */
  const handlePublish = useCallback(async (): Promise<void> => {
    clearUploadProgress()
    setUploadOpen(true)
    setPublishing(true)
    try {
      const result = capabilities.publishInstalled
        ? await publishInstalled(pluginId)
        : await pickAndUpload()
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
        result.status === 'review'
          ? t('lattice.upload.submitted', { name: result.plugin_id, version: result.version })
          : t('lattice.upload.success', { name: result.plugin_id, version: result.version })
      )
      // Refresh the platform's latest version after a successful publish (after the first publish this changes from "not published yet" to a concrete version)
      await loadHubDetail()
    } catch (err) {
      setUploadOpen(false)
      message.error(t('lattice.upload.fail'))
      console.error('[lattice] Failed to publish plugin:', err)
    } finally {
      setPublishing(false)
    }
  }, [
    capabilities.publishInstalled,
    clearUploadProgress,
    loadHubDetail,
    message,
    pickAndUpload,
    pluginId,
    publishInstalled,
    t
  ])

  /** Modify in chat: the main process creates/reuses the source workspace first and opens a plugin session; on failure falls back to the file manager */
  const handleOpenSource = useCallback(async (): Promise<void> => {
    if (actionBusyRef.current) return
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
        // Truthfully report: only the folder was opened, no chat was created automatically
        message.info(t('plugins.hub.openSource.folderFallback'))
        return
      }
      message.success(t('plugins.hub.openSource.success'))
      if (isChatOpened(result)) {
        // After receiving this event the sidebar switches to the plugin session by pluginId+topicId (the main process has already persisted the settings)
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
    if (actionBusyRef.current) return
    /**
     * **Pre-fill the local current version** into the version field (user 2026-11-23: "the publish version number should be pre-filled").
     *
     * The publish dialog asks for "the version to publish this time": the version in the local source is usually already changed, so pre-filling saves
     * the user from guessing into an empty box; the input still hints "must be higher than the plugin hub's current latest vX".
     */
    setRepublishVersion(entry?.version ?? '')
    setRepublishChangelog('')
    setRepublishVersionError(null)
    setRepublishError(null)
    setRepublishOpen(true)
  }, [entry])

  /** Publish a new version: validate semver → the main process re-packages the source directory (installer + source) and uploads it */
  const submitRepublish = useCallback(async (): Promise<void> => {
    if (actionBusyRef.current) return
    const nextVersion = republishVersion.trim()
    if (!nextVersion) {
      setRepublishVersionError(t('plugins.hub.publish.versionRequired'))
      return
    }
    if (!VERSION_PATTERN.test(nextVersion)) {
      setRepublishVersionError(t('plugins.hub.publish.versionInvalid'))
      return
    }
    setRepublishVersionError(null)
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
      message.success(
        result.status === 'review'
          ? t('plugins.hub.publish.submitted', { version: result.version })
          : t('plugins.hub.publish.success', { version: result.version })
      )
      await Promise.all([load(), loadHubDetail()])
    } catch (err) {
      setRepublishError(latticeErrorMessage(err))
    } finally {
      setRepublishing(false)
    }
  }, [load, loadHubDetail, message, pluginId, republish, republishChangelog, republishVersion, t])

  /** Download the installer / source package of a version (the main process opens a save dialog) */
  const handleDownload = useCallback(
    async (target: HubVersionV2, kind: LatticeDownloadKind): Promise<void> => {
      if (actionBusyRef.current) return
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

  /** Open the uninstall confirmation: reset the checkbox on every open (default is to **keep** data) */
  const openUninstall = useCallback((): void => {
    setPurgeData(false)
    setUninstallOpen(true)
  }, [])

  /**
   * Uninstall: remove the plugin code (+ optionally purge that plugin's data) → the main process revokes the cloud install record → back to the plugin repository.
   *
   * The success message is chosen by the checkbox state (`uninstallDone` / `uninstallKeptData`), no longer always "data kept".
   */
  const confirmUninstall = useCallback(async (): Promise<void> => {
    if (!entry || actionBusyRef.current) return
    const purge = purgeData && canPurgePluginData
    setUninstalling(true)
    try {
      await window.api.plugin.uninstall(entry.id, purge)
      message.success(
        purge ? t('settings.plugins.uninstallDone') : t('settings.plugins.uninstallKeptData')
      )
      setUninstallOpen(false)
      navigate('/plugins')
    } catch (err) {
      message.error(t('settings.plugins.uninstallFail'))
      console.error('[plugins] Failed to uninstall:', err)
    } finally {
      setUninstalling(false)
    }
  }, [canPurgePluginData, entry, message, navigate, purgeData, t])

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

  /** Version table: version / size / source / publish time / release notes / download */
  const versionColumns = useMemo<NonNullable<TableProps<HubVersionV2>['columns']>>(() => {
    const downloadUnsupported = !capabilities.downloadAsset
    return [
      {
        title: t('plugins.hub.versionTable.version'),
        dataIndex: 'version',
        key: 'version',
        width: 130,
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
        width: 80,
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
        width: 130,
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
          if (!text)
            return (
              <span style={{ color: token.colorTextQuaternary }}>
                {t('plugins.hub.versionTable.noChangelog')}
              </span>
            )
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
        width: 272,
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
                  disabled={isCurrent || anyActionBusy}
                  loading={installingVersion === row.version}
                  onClick={() => void installSpecificVersion(row.version)}
                >
                  {isCurrent
                    ? t('plugins.hub.versionTable.currentVersion')
                    : t('plugins.hub.versionTable.installVersion')}
                </Button>
              </Tooltip>
              <Tooltip
                title={downloadUnsupported ? t('plugins.hub.download.unsupported') : undefined}
              >
                <Button
                  size="small"
                  type="link"
                  style={{ paddingInline: 4, fontSize: 11 }}
                  icon={<RiDownloadLine size={13} />}
                  disabled={downloadUnsupported || anyActionBusy}
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
                  disabled={downloadUnsupported || !row.has_source || anyActionBusy}
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
    anyActionBusy,
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

  /** Whole-page state card (loading / not logged in / network failure / not found share one skeleton) */
  const pageNotice = (
    title: string,
    action?: React.ReactNode,
    description?: string
  ): React.ReactNode => (
    <div
      style={{
        height: '100%',
        boxSizing: 'border-box',
        padding: '6px 9px',
        background: token.colorBgContainer,
        borderTopLeftRadius: token.borderRadiusLG,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12
      }}
    >
      <div style={{ fontSize: 13, color: token.colorTextSecondary }}>{title}</div>
      {description && (
        <div
          style={{
            maxWidth: 460,
            textAlign: 'center',
            fontSize: 11.5,
            lineHeight: 1.7,
            color: token.colorTextTertiary
          }}
        >
          {description}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {action}
        <Button
          size="small"
          icon={<RiArrowLeftLine size={13} />}
          onClick={() => navigate('/plugins')}
        >
          {t('settings.plugins.backToRepo')}
        </Button>
      </div>
    </div>
  )

  if (loading && !entry && !hubDetail) {
    return pageNotice(t('common.state.loading'))
  }

  if (!entry && !hubDetail) {
    if (hubDetailState === 'idle' || hubDetailState === 'loading') {
      return pageNotice(t('common.state.loading'))
    }
    if (hubDetailState === 'error') {
      return pageNotice(
        t('plugins.hub.loadFailTitle'),
        <Button
          size="small"
          icon={<RiRefreshLine size={13} />}
          onClick={() => void loadHubDetail()}
        >
          {t('plugins.hub.retry')}
        </Button>,
        t('plugins.hub.loadFail', { reason: hubDetailError ?? '—' })
      )
    }
    if (hubDetailState === 'unauthenticated') {
      return pageNotice(
        t('plugins.hub.loginRequiredTitle'),
        <Button size="small" type="primary" onClick={() => navigate('/login')}>
          {t('plugins.hub.goLogin')}
        </Button>,
        t('plugins.hub.loginRequiredDesc')
      )
    }
    if (hubDetailState === 'unavailable') {
      return pageNotice(
        t('plugins.hub.unavailableTitle'),
        undefined,
        t('plugins.hub.unavailableDesc')
      )
    }
    // Logged in and the platform explicitly returned 404: only this counts as "not found or unpublished"
    return pageNotice(t('settings.plugins.pluginNotFound'))
  }

  const infoRows: React.ReactNode[] = [
    // Installed: local version; not installed: the header already shows a version, so do not repeat the row
    ...(installed && localVersion
      ? [infoRow(t('plugins.hub.detail.localVersion'), `v${localVersion}`)]
      : []),
    ...(latticeReady && loggedIn
      ? [
          infoRow(
            t('plugins.hub.detail.latestVersion'),
            hubLatestVersion
              ? `v${hubLatestVersion}`
              : hubConfirmedNotPublished
                ? t('plugins.hub.detail.notPublished')
                : hubDetailState === 'loading' || hubDetailState === 'idle'
                  ? t('common.state.loading')
                  : '—'
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
          infoRow(t('plugins.hub.detail.downloadsLabel'), formatCount(hubDetail?.downloads))
        ]
      : []),
    infoRow(t('settings.plugins.entry'), entry?.entry?.renderer ?? entry?.entry?.main ?? '—')
  ]

  /**
   * Page-level CSS variables: the back button's normal/hover colors follow the theme, without writing hover as inline events.
   */
  const pageVars = {
    '--plugin-detail-back-color': token.colorTextTertiary,
    '--plugin-detail-back-hover-bg': token.colorFillQuaternary,
    '--plugin-detail-back-hover-color': token.colorText
  } as React.CSSProperties

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        boxSizing: 'border-box',
        /* Exactly the same as the plugin repository: no top gutter, 9px left/right and 6px top/bottom (user wording 2026-11-23) */
        padding: '6px 9px',
        background: token.colorBgContainer,
        borderTopLeftRadius: token.borderRadiusLG,
        ...pageVars
      }}
    >
      <div
        className="custom-scrollbar"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column'
        }}
      >
        {/*
         * Header: the back entry is **merged into the same card** (user 2026-11-23: "the back-to-plugin-repository button
         * needs to be merged with the content below it") — it no longer takes a separate 33px toolbar row.
         */}
        <section
          style={{
            border: `1px solid ${token.colorBorderSecondary}`,
            borderRadius: 16,
            background: token.colorBgContainer,
            padding: '10px 20px 18px'
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              paddingBottom: 10,
              marginBottom: 14,
              borderBottom: `1px solid ${token.colorBorderSecondary}`
            }}
          >
            <button
              className="plugin-detail-back"
              onClick={() => navigate('/plugins')}
              aria-label={t('settings.plugins.backToRepo')}
            >
              <RiArrowLeftLine size={13} />
              {t('settings.plugins.backToRepo')}
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 15 }}>
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
                  {t('settings.plugins.externalBadge')}
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
              {installed && hubConfirmedNotPublished && latticeReady && loggedIn && (
                <div style={{ marginTop: 7, fontSize: 10, color: token.colorTextTertiary }}>
                  {t('plugins.hub.detail.notPublishedHint')}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              {installed && (
                <Button
                  size="small"
                  loading={busy}
                  disabled={anyActionBusy && !busy}
                  onClick={() => void toggle()}
                >
                  {enabled ? t('settings.plugins.disable') : t('settings.plugins.enable')}
                </Button>
              )}
              {updateVersion ? (
                <Button
                  size="small"
                  loading={busy}
                  disabled={anyActionBusy && !busy}
                  icon={<RiRefreshLine size={14} />}
                  onClick={() => void installOrUpdate()}
                >
                  {t('plugins.hub.updateTo', { version: updateVersion })}
                </Button>
              ) : !installed ? (
                <Button
                  size="small"
                  type={loggedIn ? 'default' : 'primary'}
                  loading={busy}
                  disabled={anyActionBusy && !busy}
                  icon={<RiDownloadLine size={14} />}
                  onClick={() => void installOrUpdate()}
                >
                  {!loggedIn
                    ? t('plugins.hub.goLogin')
                    : hubLatestVersion
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
        </section>

        {/* Body: "Actions" on the left; "Information" + "Runtime status" on the right */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1.4fr) minmax(320px, 1fr)',
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
                  loggedIn ? t('plugins.hub.install') : t('plugins.hub.goLogin'),
                  t('plugins.hub.source.hint'),
                  () => void installOrUpdate(),
                  anyActionBusy
                )}
              {installed &&
                actionRow(
                  <RiChatSmile2Line size={15} />,
                  t('plugins.hub.detail.openInChat'),
                  capabilities.openSource
                    ? t('plugins.hub.detail.openInChatDesc')
                    : t('plugins.hub.openSource.unsupported'),
                  () => void handleOpenSource(),
                  openSourceBusy || !capabilities.openSource || anyActionBusy
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
                  republishing || !loggedIn || !capabilities.republish || anyActionBusy
                )}
              {installed &&
                hubConfirmedNotPublished &&
                actionRow(
                  <RiUploadCloud2Line size={15} />,
                  t('plugins.hub.detail.publishLocal'),
                  t('plugins.hub.detail.publishLocalDesc'),
                  () => void handlePublish(),
                  publishing || !loggedIn || anyActionBusy
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
                    anyActionBusy
                  )
                : null}
              {installed
                ? actionRow(
                    <RiDeleteBin6Line size={15} />,
                    t('settings.plugins.uninstall'),
                    t('settings.plugins.uninstallBody'),
                    openUninstall,
                    anyActionBusy,
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
              {/* Source/publish flow explanation: install brings the source automatically → modify in chat → publish a new version */}
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
                    color: runtimeColor
                  }}
                >
                  ● {runtimeLabel}
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

        {/* Plugin description: platform README (Markdown, already sanitized), long content scrolls within a max height */}
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

        {/* Version history (platform version management + installer/source package downloads) */}
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
              <span style={{ fontWeight: 400, fontSize: 10.5, color: token.colorTextTertiary }}>
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
                tableLayout="fixed"
                locale={{ emptyText: t('plugins.hub.versionTable.empty') }}
              />
            </div>
          </section>
        )}
      </div>

      {/* Publish a new version: version + release notes → lattice.republish (re-packages the local source directory) */}
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
                if (republishVersionError) setRepublishVersionError(null)
                if (republishError) setRepublishError(null)
              }}
              placeholder={t('plugins.hub.publish.versionPlaceholder')}
              status={republishVersionError ? 'error' : undefined}
              onPressEnter={() => void submitRepublish()}
            />
            <div style={{ marginTop: 5, fontSize: 10, color: token.colorTextTertiary }}>
              {hubLatestVersion
                ? t('plugins.hub.publish.versionHint', { version: hubLatestVersion })
                : t('plugins.hub.local.desc')}
            </div>
            {republishVersionError && (
              <div style={{ marginTop: 5, fontSize: 10.5, color: token.colorError }}>
                {republishVersionError}
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
            />
            {/*
              Draw the character count ourselves (not antd's `showCount`): it absolutely positions the count **below** the input
              (`bottom: -22px`), so when the modal body is not tall enough the lower half is covered by the bottom button bar
              (2026-11-23 user feedback "the number below the description is covered"). In the normal flow the position is stable.
            */}
            <div
              style={{
                marginTop: 4,
                textAlign: 'right',
                fontSize: 10,
                color: token.colorTextTertiary
              }}
            >
              {republishChangelog.length} / 2000
            </div>
            {/*
              The error of the publish action itself (build / package / upload) goes at the bottom of the form: it is not a version problem,
              but it used to be shown below the version input with a red border, looking like "the version is wrong"
              (2026-11-23 user feedback: why did "plugin.json entry is missing main / renderer" appear under the version field).
            */}
            {republishError && (
              <div
                style={{
                  marginTop: 8,
                  fontSize: 10.5,
                  lineHeight: 1.6,
                  color: token.colorError,
                  whiteSpace: 'pre-wrap'
                }}
              >
                {republishError}
              </div>
            )}
          </div>
        </div>
      </Modal>

      {/* The plugin's own settings page (modal): originally inside the "Settings" modal, moved here at the user's 2026-11-19 request */}
      <Modal
        open={settingsOpen}
        onCancel={() => setSettingsOpen(false)}
        footer={null}
        width={760}
        title={t('settings.plugins.pluginSettings')}
        destroyOnHidden
      >
        <div
          className="custom-scrollbar app-modal-scroll"
          style={{ maxHeight: '68vh', overflowY: 'auto' }}
        >
          {settingsSections.map((section) => (
            <PluginBoundary key={section.tabKey} pluginId={section.pluginId} surface="settings">
              <section.Component />
            </PluginBoundary>
          ))}
        </div>
      </Modal>

      {/* Uninstall confirmation: code and data are separate (the checkbox decides whether to purge data too) — unchecked by default = keep data */}
      <Modal
        open={uninstallOpen}
        title={t('settings.plugins.uninstallTitle', { name })}
        okText={t('settings.plugins.uninstallConfirm')}
        cancelText={t('common.action.cancel')}
        okButtonProps={{ danger: true }}
        confirmLoading={uninstalling}
        onOk={() => void confirmUninstall()}
        onCancel={() => {
          if (!uninstalling) setUninstallOpen(false)
        }}
        width={460}
        destroyOnHidden
      >
        <div style={{ fontSize: 12.5, color: token.colorTextSecondary, lineHeight: 1.7 }}>
          {t('settings.plugins.uninstallBody')}
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 16, alignItems: 'flex-start' }}>
          <Checkbox
            checked={purgeData}
            disabled={!canPurgePluginData}
            onChange={(event) => setPurgeData(event.target.checked)}
            style={{ marginTop: 1 }}
          />
          {/* The whole text area is clickable: clicking the title/description is equivalent to clicking the box (no need to hit the 16px box precisely) */}
          <div
            style={{
              cursor: canPurgePluginData ? 'pointer' : 'not-allowed',
              userSelect: 'none',
              opacity: canPurgePluginData ? 1 : 0.6
            }}
            onClick={() => canPurgePluginData && setPurgeData((value) => !value)}
          >
            <div style={{ fontSize: 13, color: token.colorText }}>
              {canPurgePluginData
                ? t('settings.plugins.purgeCheckbox')
                : t('settings.plugins.purgeUnavailable')}
            </div>
            <div
              style={{
                fontSize: 12,
                color: token.colorTextTertiary,
                lineHeight: 1.6,
                marginTop: 2
              }}
            >
              {!canPurgePluginData
                ? t('settings.plugins.purgeUnavailableDetail')
                : latticeReady && loggedIn
                  ? t('settings.plugins.purgeDetailCloud')
                  : t('settings.plugins.purgeDetail')}
            </div>
          </div>
        </div>
      </Modal>

      {/* Upload progress for publishing to the plugin hub (shares the same modal component as the plugin repository page) */}
      <UploadProgressModal open={uploadOpen} />
    </div>
  )
}

export default PluginDetail
