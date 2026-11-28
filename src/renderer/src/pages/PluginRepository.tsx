import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { App, Button, Dropdown, Modal, Select, Switch, Tooltip, theme } from 'antd'
import type { MenuProps } from 'antd'
import { useNavigate } from 'react-router-dom'
import {
  RiArrowDownSLine,
  RiArrowUpLine,
  RiCheckboxCircleLine,
  RiCloudLine,
  RiCodeSSlashLine,
  RiDownloadLine,
  RiErrorWarningLine,
  RiFileZipLine,
  RiFolderOpenLine,
  RiGitMergeLine,
  RiHammerLine,
  RiInboxLine,
  RiLoginBoxLine,
  RiRefreshLine,
  RiSearchLine,
  RiSettings3Line,
  RiTimeLine,
  RiUploadCloud2Line
} from '@remixicon/react'
import { useTranslation } from '@renderer/i18n'
import { usePlugins, usePluginSettingsSections } from '@renderer/plugin-host/PluginHostContext'
import { PluginBoundary } from '@renderer/plugin-host/PluginBoundary'
import PluginIcon from '@renderer/components/system/PluginIcon'
import { SkeletonBlock, SkeletonStyle } from '@renderer/components/system/Skeleton'
import { skeletonVars, useSkeletonPalette } from '@renderer/components/system/skeleton-palette'
import WorkshopSettings from '../components/harness/settings/WorkshopSettings'
import {
  subscribeWorkshopModalRequest,
  takeWorkshopModalRequest
} from '../components/harness/workshop/workshop-modal-request'
import { useLattice } from '@renderer/lattice/useLattice'
import UploadProgressModal from '@renderer/lattice/UploadProgressModal'
import { latticeErrorMessage } from '@renderer/lattice/api'
import { formatCount, formatSyncTime } from '@renderer/lattice/format'
import { isChatOpened, isFolderFallback } from '@renderer/lattice/source'
import { isVersionNewer } from '@shared/plugin/version'
import type {
  HubEntryV2,
  HubListResultV2,
  LatticeSyncConflict,
  LatticeSyncDetails
} from '@renderer/lattice/types'
import type { PluginListEntry } from '@shared/plugin/types'

/**
 * In-session snapshot of the platform catalog (keyed by "account + base URL").
 *
 * Why keep one: the catalog is fetched again on every visit to the plugin repository, and the page can only show a skeleton before the request returns;
 * switching back and forth between "chat ↔ plugin repository", the same person has to look at the placeholder before seeing the cards every time,
 * which looks like a loading flicker (user 2026-11-25).
 *
 * On a hit, fill the grid with the previous catalog first and refresh in the background; a changed account / base URL is a miss —
 * that is another set of install records, and painting A's "installed" onto B's catalog would be wrong.
 */
let hubSnapshot: { account: string; list: HubListResultV2 } | null = null

/**
 * Plugin repository (system page `/plugins`).
 *
 * This page has **only the platform as a remote source**:
 * - The catalog comes from `lattice.list` (search/category are filtered locally); there is no second data source;
 * - Install, update, publish and source download all go through the `lattice.*` channels;
 * - Publish-related entries are grouped into the "Publish" dropdown in the top bar (user 2026-11-23: too many buttons with similar functions):
 *   publish plugin directory / publish .zip / publish installer + source directory / import local plugin directory;
 *   "Install from local" (install a local zip/directory into the app) is a different kind of action and stays separate.
 *
 * Cards show: version / author / description / tags / downloads / installed・update available / source marker;
 * Actions: install, update, open source (installed with source). Plugins installed locally but not published to the platform and catalog cards
 * sit in the **same grid** (user 2026-11-23: "don't show local and online separately, merge them"),
 * so the "publish to plugin hub" entry stays reachable.
 */
const PluginRepository: React.FC = () => {
  const { token } = theme.useToken()
  const { message } = App.useApp()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const descriptors = usePlugins()

  /**
   * Real login state of the plugin hub. When not logged in / the main-process channel is not ready this safely degrades,
   * and the page shows the corresponding action card (the catalog is only available after login).
   */
  const {
    available: latticeReady,
    /** Whether the login state has been read back: without it we can only show the skeleton, not render as "not logged in" */
    ready: latticeStatusReady,
    status: latticeStatus,
    loggedIn,
    syncing: latticeSyncing,
    sync: syncLattice,
    syncDetails,
    setAutoInstallMissing,
    listHub,
    installFromHub: installLatticePlugin,
    pickAndUpload,
    pickAndUploadZip,
    pickAndUploadWithSource,
    clearUploadProgress,
    capabilities,
    openSource,
    sourcePath,
    importLocalDir
  } = useLattice()

  /** Ownership of the catalog snapshot: only the same account + same base URL counts as a hit (a different account / platform is a miss) */
  const hubAccount = latticeStatus.user?.id
    ? `${latticeStatus.baseUrl}#${latticeStatus.user.id}`
    : ''

  const [entries, setEntries] = useState<PluginListEntry[]>([])
  /**
   * Set of plugin ids whose source **really exists locally**.
   *
   * The catalog's `has_source` must not be used instead: it says "the latest version ships a source package", while the local install may be
   * an older version, or the source download failed during install (the source only lands in the installer directory). Relying on it would render a
   * "source" button that only opens the file explorer window of the installer directory when clicked (user 2026-11-25).
   */
  const [localSourceIds, setLocalSourceIds] = useState<Set<string>>(() => new Set())
  /**
   * Whether the local list has come back at least once.
   *
   * The login hint has two shapes when logged out (local cards below → compact hint bar; the whole page is only about logging in → centered guide).
   * Before the list returns, `entries` is still an empty array, so rendering as "no local plugins" would make the whole guide flash and then collapse into one line.
   */
  const [localLoaded, setLocalLoaded] = useState(false)
  /**
   * Whether the local list has been read **successfully** at least once.
   *
   * `localLoaded` only means "the request has finished" (the logged-out guide shape needs it to avoid flicker);
   * card checks for "installed / enabled" use this one: only when the local list was really read may
   * "not in the list = not installed" override the platform fields; on a read failure fall back to the platform view instead of
   * misreporting every plugin as not installed.
   */
  const [localTrusted, setLocalTrusted] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadingZip, setUploadingZip] = useState(false)
  const [uploadingWithSource, setUploadingWithSource] = useState(false)
  const [importing, setImporting] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [openBusy, setOpenBusy] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  /**
   * Platform catalog (fetched in full once from the server; search/category are filtered locally so input responds immediately).
   * When the in-session snapshot hits, fill it in directly; the background refresh is handled by the effect below.
   */
  const [hub, setHub] = useState<HubListResultV2 | null>(() =>
    hubSnapshot && hubSnapshot.account === hubAccount ? hubSnapshot.list : null
  )
  const [hubLoading, setHubLoading] = useState(false)
  const [hubError, setHubError] = useState<string | null>(null)
  const [hubCategory, setHubCategory] = useState('all')
  const [uploadOpen, setUploadOpen] = useState(false)
  /** Unresolved plugin data conflicts (the sync modal asks the user to choose "use local / use cloud" one by one) */
  const [conflictOpen, setConflictOpen] = useState(false)
  const [conflicts, setConflicts] = useState<LatticeSyncConflict[]>([])
  const [conflictLoading, setConflictLoading] = useState(false)
  const [conflictBusy, setConflictBusy] = useState<string | null>(null)
  const [mergeBusy, setMergeBusy] = useState(false)
  /** "Update all" bulk upgrade in progress (installs one by one; a failure does not abort) */
  const [bulkUpdating, setBulkUpdating] = useState(false)

  /**
   * "Sync details" modal: per-item auto-repair success/failure details + install records deleted on the platform (orphaned) + data conflicts.
   * Auto-repair failures are **not silent**: the sync bar always has an "N auto-repair failures (view reason)" entry.
   */
  const [syncDetailsOpen, setSyncDetailsOpen] = useState(false)
  const [syncDetailsData, setSyncDetailsData] = useState<LatticeSyncDetails | null>(null)
  const [syncDetailsLoading, setSyncDetailsLoading] = useState(false)
  const [autoInstallSaving, setAutoInstallSaving] = useState(false)

  /**
   * Plugin workshop (modal): drafts/build/accept/install. The entry is compressed into an icon button,
   * so it does not compete with high-frequency actions like "upload/install local".
   */
  const [workshopOpen, setWorkshopOpen] = useState(false)
  const [workshopDraftPending, setWorkshopDraftPending] = useState<string | null>(null)
  const [settingsPlugin, setSettingsPlugin] = useState<{ id: string; name: string } | null>(null)
  const allSettingsSections = usePluginSettingsSections()
  const sectionsOf = useCallback(
    (id: string) => allSettingsSections.filter((s) => s.pluginId === id),
    [allSettingsSections]
  )

  /** Local install list (installed/enabled state, version) */
  const refresh = useCallback(async (): Promise<void> => {
    try {
      const list = await window.api.plugin.list()
      setEntries(Array.isArray(list) ? list : [])
      setLocalTrusted(true)
    } catch (err) {
      console.error('[plugins] Failed to load list:', err)
    } finally {
      setLocalLoaded(true)
    }
  }, [])

  /** Ask the main process one by one whether each plugin has source locally (very few; recomputed with entries after install/uninstall) */
  const loadLocalSources = useCallback(
    async (list: PluginListEntry[]): Promise<void> => {
      if (!capabilities.sourcePath || list.length === 0) {
        setLocalSourceIds(new Set())
        return
      }
      const results = await Promise.all(
        list.map(async (entry) => {
          try {
            const info = await sourcePath(entry.id)
            return info.path ? entry.id : null
          } catch {
            return null
          }
        })
      )
      setLocalSourceIds(new Set(results.filter((id): id is string => Boolean(id))))
    },
    [capabilities.sourcePath, sourcePath]
  )

  useEffect(() => {
    void loadLocalSources(entries)
  }, [entries, loadLocalSources])

  const loadHub = useCallback(async (): Promise<void> => {
    if (!latticeReady) {
      setHub(null)
      setHubLoading(false)
      return
    }
    setHubError(null)
    setHubLoading(true)
    try {
      const result = await listHub()
      setHub(result)
      // Only cache a catalog that has an owner (when logged out / account info is missing, do not cache, so the anonymous view is not left for the next person)
      if (hubAccount) hubSnapshot = { account: hubAccount, list: result }
    } catch (err) {
      // Do not clear the catalog already obtained when a refresh fails: one network blip / a background refresh triggered by a plugin
      // state broadcast would wipe the whole page's catalog, categories and search context (the user did nothing, yet the page becomes "load failed").
      setHubError(latticeErrorMessage(err))
    } finally {
      setHubLoading(false)
    }
  }, [hubAccount, latticeReady, listHub])

  useEffect(() => {
    void refresh()
    const unsub = window.api.plugin.onStateChanged(() => void refresh())
    return unsub
  }, [refresh])

  /** Conflict list: fetched once more when the sync summary reports conflicts (includes cloud data snapshots) */
  const loadConflicts = useCallback(async (): Promise<void> => {
    if (!latticeReady || !loggedIn) {
      setConflicts([])
      return
    }
    setConflictLoading(true)
    try {
      setConflicts(await window.api.lattice.syncConflicts())
    } catch (err) {
      console.warn('[lattice] Failed to read conflict list:', err)
      setConflicts([])
    } finally {
      setConflictLoading(false)
    }
  }, [loggedIn, latticeReady])

  useEffect(() => {
    if ((latticeStatus.sync?.conflicts ?? 0) > 0) void loadConflicts()
  }, [latticeStatus.sync?.conflicts, loadConflicts])

  /** Resolve one conflict explicitly: local = local overrides cloud; cloud = cloud overrides local */
  const resolveConflict = useCallback(
    async (pluginId: string, strategy: 'local' | 'cloud' | 'merge'): Promise<void> => {
      const key = `${pluginId}:${strategy}`
      setConflictBusy(key)
      try {
        const result = await window.api.lattice.resolveConflict(pluginId, strategy)
        if (!result.ok) {
          message.error(result.error || t('sync.error', { reason: '' }))
          return
        }
        if (strategy === 'merge' && result.summary) {
          message.success(result.summary)
        } else {
          message.success(t('sync.resolve.done'))
        }
        await loadConflicts()
        await loadHub()
        await refresh()
      } catch (err) {
        message.error(latticeErrorMessage(err))
      } finally {
        setConflictBusy(null)
      }
    },
    [loadConflicts, loadHub, message, refresh, t]
  )

  /**
   * Clicking a plugin row in the sidebar (Harness route) → request "navigate to /plugins, open the plugin workshop and expand this plugin".
   * The request is staged in a module-level snapshot (events dispatched before navigation are not received by this page), so this page picks it up whether it is already mounted or mounts later.
   */
  useEffect(() => {
    const apply = (request: { draftId?: string } | null): void => {
      if (!request) return
      setWorkshopOpen(true)
      if (request.draftId) setWorkshopDraftPending(request.draftId)
    }
    apply(takeWorkshopModalRequest())
    return subscribeWorkshopModalRequest(() => apply(takeWorkshopModalRequest()))
  }, [])

  /** The workshop modal is open with a specified draft: dispatch the expand event after `WorkshopSettings` mounts (it subscribes itself) */
  useEffect(() => {
    if (!workshopOpen || !workshopDraftPending) return
    const id = workshopDraftPending
    const timer = window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('workshop-open-draft', { detail: { id } }))
      setWorkshopDraftPending(null)
    }, 80)
    return () => window.clearTimeout(timer)
  }, [workshopOpen, workshopDraftPending])

  /** Platform catalog: loaded after login and refreshed on plugin enable/disable/install broadcasts (installed/update_available change after install) */
  useEffect(() => {
    if (!latticeReady || !loggedIn) {
      /**
       * After logging out, the previous account's catalog snapshot must not be kept: it is an install state computed per account, and it would
       * misjudge locally installed plugins as "already on the platform" (localOnly filters them out) → the guest state cannot see local plugins.
       * The branch below fetches it again after logging back in.
       */
      setHub(null)
      setHubError(null)
      setHubLoading(false)
      return
    }
    void loadHub()
    const unsub = window.api.plugin.onStateChanged(() => void loadHub())
    return unsub
  }, [latticeReady, loggedIn, loadHub])

  const runtimeState = useCallback(
    (id: string) => descriptors.find((d) => d.manifest.id === id)?.state,
    [descriptors]
  )

  const localById = useMemo(() => {
    const map = new Map<string, PluginListEntry>()
    for (const entry of entries) map.set(entry.id, entry)
    return map
  }, [entries])

  /**
   * Whether a catalog entry really has an update locally: compare **the locally installed version** with the platform's latest.
   *
   * Do not use the platform's `update_available`: it is computed from the account's install records and only updates on the next sync after a local uninstall/downgrade,
   * producing inconsistencies like "shows update available though not installed locally" or "repository has an update but the detail page does not".
   *
   * Compare **version precedence** rather than string inequality: with local v0.4.1 and hub latest v0.3.0 the strings differ,
   * but that is not "an update available", it is "the local version is newer" (2026-11-23 user feedback); a semver comparison no longer
   * gives the user a downgrade button "update to v0.3.0".
   */
  const hasLocalUpdate = useCallback(
    (item: HubEntryV2): boolean => {
      const local = localById.get(item.plugin_id)
      if (!local) return false
      return isVersionNewer(item.latest_version, local.version)
    },
    [localById]
  )

  const hubItems = hub?.items ?? []
  const hubCategories = useMemo(() => {
    const set = new Set<string>()
    for (const item of hubItems) {
      const category = item.category?.trim()
      if (category) set.add(category)
    }
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [hubItems])

  const normalizedQuery = query.trim().toLowerCase()

  /** Search/category are filtered locally (the catalog is fetched as a whole), so input responds immediately without hitting the server per keystroke */
  const visibleHub = useMemo(() => {
    return hubItems.filter((item) => {
      if (hubCategory !== 'all' && item.category !== hubCategory) return false
      if (!normalizedQuery) return true
      const haystack = [
        item.name,
        item.plugin_id,
        item.description ?? '',
        item.category ?? '',
        item.owner?.display_name ?? '',
        item.owner?.username ?? '',
        ...(item.tags ?? [])
      ]
        .join(' ')
        .toLowerCase()
      return haystack.includes(normalizedQuery)
    })
  }, [hubCategory, hubItems, normalizedQuery])

  /**
   * Plugins installed but not on the platform (installed from a local upload).
   *
   * They are no longer shown as a separate group (user 2026-11-23: "don't show local and online separately, merge them"):
   * they sit in the same grid as catalog cards; only the detail page/publish entry must stay reachable.
   */
  const localOnlyAll = useMemo(() => {
    const hubIds = new Set(hubItems.map((item) => item.plugin_id))
    return entries
      .filter((entry) => !hubIds.has(entry.id))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [entries, hubItems])

  /** Further filter the group above by search term (the login-hint shape only looks at the unfiltered localOnlyAll) */
  const localOnly = useMemo(() => {
    return localOnlyAll.filter((entry) => {
      if (!normalizedQuery) return true
      return (
        entry.name.toLowerCase().includes(normalizedQuery) ||
        entry.id.toLowerCase().includes(normalizedQuery) ||
        Boolean(entry.description?.toLowerCase().includes(normalizedQuery))
      )
    })
  }, [localOnlyAll, normalizedQuery])

  /**
   * Local plugins that actually appear in the grid.
   *
   * They are hidden when a platform category is selected: local plugins are not registered in catalog categories, so showing them under any category would be a mismatch
   * (especially obvious after merging into one grid); the search box can still find them, and clearing the category brings them back.
   */
  const visibleLocal = hubCategory === 'all' ? localOnly : []

  /** Top bar "Upload plugin": choose a plugin package directory → the main process packages and uploads it (installer + source) */
  const handleUpload = useCallback(async (): Promise<void> => {
    if (!loggedIn) {
      navigate('/login')
      return
    }
    clearUploadProgress()
    setUploading(true)
    setUploadOpen(true)
    try {
      const result = await pickAndUpload()
      if (!result.ok) {
        setUploadOpen(false)
        message.error(result.error || t('lattice.upload.fail'))
        return
      }
      if ('canceled' in result) {
        setUploadOpen(false)
        return
      }
      message.success(
        result.status === 'review'
          ? t('lattice.upload.submitted', { name: result.plugin_id, version: result.version })
          : t('lattice.upload.success', { name: result.plugin_id, version: result.version })
      )
      setUploadOpen(false)
      await Promise.all([refresh(), loadHub()])
    } catch (err) {
      setUploadOpen(false)
      message.error(t('lattice.upload.fail'))
      console.error('[lattice] Failed to upload plugin:', err)
    } finally {
      setUploading(false)
    }
  }, [clearUploadProgress, loadHub, loggedIn, message, navigate, pickAndUpload, refresh, t])

  /** Top bar zip entry: choose a .zip installer to publish (also supports the existing pipeline of readme/manifest parsing and source package upload) */
  const handleUploadZip = useCallback(async (): Promise<void> => {
    if (!loggedIn) {
      navigate('/login')
      return
    }
    clearUploadProgress()
    setUploadingZip(true)
    setUploadOpen(true)
    try {
      const result = await pickAndUploadZip()
      if (!result.ok) {
        setUploadOpen(false)
        message.error(result.error || t('lattice.upload.fail'))
        return
      }
      if ('canceled' in result) {
        setUploadOpen(false)
        return
      }
      message.success(
        result.status === 'review'
          ? t('lattice.upload.submitted', { name: result.plugin_id, version: result.version })
          : t('lattice.upload.success', { name: result.plugin_id, version: result.version })
      )
      setUploadOpen(false)
      await Promise.all([refresh(), loadHub()])
    } catch (err) {
      setUploadOpen(false)
      message.error(t('lattice.upload.fail'))
      console.error('[lattice] Failed to upload zip:', err)
    } finally {
      setUploadingZip(false)
    }
  }, [clearUploadProgress, loadHub, loggedIn, message, navigate, pickAndUploadZip, refresh, t])

  /**
   * Top bar "Publish with source directory": first choose the build output directory (installer), then the source directory.
   *
   * The installer and the source are two different zips: for repository plugins dist/<id>/ is the artifact and plugins/<id>/ is the source;
   * only what the platform "Source code" download gives you is the real source, not the installer itself.
   */
  const handleUploadWithSource = useCallback(async (): Promise<void> => {
    if (!loggedIn) {
      navigate('/login')
      return
    }
    clearUploadProgress()
    setUploadingWithSource(true)
    setUploadOpen(true)
    try {
      const result = await pickAndUploadWithSource()
      if (!result.ok) {
        setUploadOpen(false)
        message.error(result.error || t('lattice.upload.fail'))
        return
      }
      if ('canceled' in result) {
        setUploadOpen(false)
        return
      }
      message.success(
        result.status === 'review'
          ? t('lattice.upload.submitted', { name: result.plugin_id, version: result.version })
          : t('lattice.upload.success', { name: result.plugin_id, version: result.version })
      )
      setUploadOpen(false)
      await Promise.all([refresh(), loadHub()])
    } catch (err) {
      setUploadOpen(false)
      message.error(t('lattice.upload.fail'))
      console.error('[lattice] Failed to upload plugin with source:', err)
    } finally {
      setUploadingWithSource(false)
    }
  }, [
    clearUploadProgress,
    loadHub,
    loggedIn,
    message,
    navigate,
    pickAndUploadWithSource,
    refresh,
    t
  ])

  /** Top bar "Install from local": choose a zip / directory to install into the app (no publishing) */
  const handleInstallLocal = useCallback(async (): Promise<void> => {
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
      await Promise.all([refresh(), loadHub()])
    } catch (err) {
      message.error(t('settings.plugins.installFail'))
      console.error('[plugins] Failed to install local plugin:', err)
    }
  }, [loadHub, message, refresh, t])

  /**
   * Top bar "Import local plugin directory": the main process opens a directory picker and batch-publishes every plugin under that directory
   * containing a plugin.json to the platform (installer + source). The path is chosen by the user; the renderer hardcodes no directory.
   */
  const handleImportLocalDir = useCallback(async (): Promise<void> => {
    if (!loggedIn) {
      navigate('/login')
      return
    }
    if (!capabilities.importLocalDir) {
      message.info(t('plugins.hub.import.unsupported'))
      return
    }
    setImporting(true)
    try {
      const result = await importLocalDir()
      if (!result.ok) {
        message.error(t('plugins.hub.import.fail', { reason: result.error }))
        return
      }
      if (result.canceled) return
      const imported = Array.isArray(result.imported) ? result.imported : []
      const skipped = Array.isArray(result.skipped) ? result.skipped : []
      if (imported.length === 0 && skipped.length === 0) {
        message.info(t('plugins.hub.import.empty'))
      } else {
        message.success(
          t('plugins.hub.import.success', { imported: imported.length, skipped: skipped.length })
        )
      }
      await Promise.all([refresh(), loadHub()])
    } catch (err) {
      message.error(t('plugins.hub.import.fail', { reason: latticeErrorMessage(err) }))
      console.error('[lattice] Failed to import local plugin directory:', err)
    } finally {
      setImporting(false)
    }
  }, [
    capabilities.importLocalDir,
    importLocalDir,
    loadHub,
    loggedIn,
    message,
    navigate,
    refresh,
    t
  ])

  /** Card primary action: install (not installed) / update (update available); during install the main process downloads and extracts the source automatically */
  const handleHubInstall = useCallback(
    async (item: HubEntryV2): Promise<void> => {
      const wasInstalled = Boolean(localById.get(item.plugin_id))
      setBusy(item.plugin_id)
      try {
        const result = await installLatticePlugin(item.plugin_id, item.latest_version)
        if (!result.ok) {
          message.error(result.error || t('plugins.hub.installFail'))
          return
        }
        if (wasInstalled) {
          message.success(
            t('plugins.hub.updateSuccess', {
              name: item.name,
              version: result.version ?? item.latest_version ?? ''
            })
          )
        } else {
          message.success(t('plugins.hub.installSuccess', { name: item.name }))
        }
        if (result.sourceError) {
          message.warning(t('plugins.hub.source.downloadFailed', { reason: result.sourceError }))
        }
        if (result.sourceBackupPath) {
          message.warning(t('plugins.hub.source.backedUp', { path: result.sourceBackupPath }), 8)
        }
        await Promise.all([refresh(), loadHub()])
      } catch (err) {
        message.error(t('plugins.hub.installFail'))
        console.error('[lattice] Failed to install from plugin hub:', err)
      } finally {
        setBusy(null)
      }
    },
    [installLatticePlugin, loadHub, localById, message, refresh, t]
  )

  /**
   * "Update all": upgrade every plugin currently matching `update_available && installed` to the latest version one by one.
   * A failure does not abort the remaining plugins (single failures are common: network/source package); at the end summarize the success/failure counts.
   */
  const handleUpdateAll = useCallback(async (): Promise<void> => {
    const targets = (hub?.items ?? []).filter((item) => hasLocalUpdate(item))
    if (targets.length === 0 || bulkUpdating || busy !== null || openBusy !== null) return
    setBulkUpdating(true)
    let ok = 0
    let fail = 0
    try {
      for (const item of targets) {
        setBusy(item.plugin_id)
        try {
          const result = await installLatticePlugin(item.plugin_id, item.latest_version)
          if (!result.ok) {
            fail += 1
            message.error(`${item.name}: ${result.error || t('settings.plugins.installFail')}`)
            continue
          }
          ok += 1
          if (result.sourceError) {
            message.warning(t('plugins.hub.source.downloadFailed', { reason: result.sourceError }))
          }
          if (result.sourceBackupPath) {
            message.warning(t('plugins.hub.source.backedUp', { path: result.sourceBackupPath }), 8)
          }
        } finally {
          setBusy(null)
        }
      }
      await Promise.all([refresh(), loadHub()])
      if (fail === 0) {
        message.success(t('plugins.hub.updateAll.done', { n: ok }))
      } else {
        message.warning(t('plugins.hub.updateAll.partial', { ok, fail }))
      }
    } catch (err) {
      message.error(t('settings.plugins.installFail'))
      console.error('[lattice] Failed to update all:', err)
    } finally {
      setBulkUpdating(false)
    }
  }, [
    bulkUpdating,
    busy,
    hasLocalUpdate,
    hub?.items,
    installLatticePlugin,
    loadHub,
    message,
    openBusy,
    refresh,
    t
  ])

  /**
   * Card "Open source": the main process creates/reuses a workspace and opens a plugin session first;
   * when it can only fall back to the file manager, say so truthfully (do not pretend a chat was opened).
   */
  const handleOpenSource = useCallback(
    async (pluginId: string): Promise<void> => {
      if (!capabilities.openSource) {
        message.info(t('plugins.hub.openSource.unsupported'))
        return
      }
      setOpenBusy(pluginId)
      try {
        const result = await openSource(pluginId)
        if (!result.ok) {
          message.error(t('plugins.hub.openSource.fail', { reason: result.error }))
          return
        }
        if (isFolderFallback(result)) {
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
        setOpenBusy(null)
      }
    },
    [capabilities.openSource, message, navigate, openSource, t]
  )

  /**
   * Open "Sync details": fetch the auto-repair failures / orphan record details from the latest sync.
   * Failure reasons and orphan records are all visible here item by item (not silently swallowed during sync).
   */
  const openSyncDetails = useCallback(async (): Promise<void> => {
    setSyncDetailsOpen(true)
    setSyncDetailsLoading(true)
    try {
      setSyncDetailsData(await syncDetails())
    } catch (err) {
      console.warn('[lattice] Failed to read sync details:', err)
      setSyncDetailsData(null)
    } finally {
      setSyncDetailsLoading(false)
    }
  }, [syncDetails])

  /**
   * "Auto-install missing plugins" toggle (on by default).
   * When off, pull only puts missing plugins into the `pending` list and no longer installs them automatically; marked orphan records are still kept.
   */
  const handleToggleAutoInstall = useCallback(
    async (enabled: boolean): Promise<void> => {
      setAutoInstallSaving(true)
      try {
        const result = await setAutoInstallMissing(enabled)
        if (!result.ok) {
          message.error(result.error || t('sync.autoInstall.unsupported'))
          return
        }
        message.success(result.enabled ? t('sync.autoInstall.on') : t('sync.autoInstall.off'))
      } catch (err) {
        message.error(latticeErrorMessage(err))
      } finally {
        setAutoInstallSaving(false)
      }
    },
    [message, setAutoInstallMissing, t]
  )

  const handleSyncNow = useCallback(async (): Promise<void> => {
    const result = await syncLattice('both')
    if (result.error) {
      message.error(t('sync.error', { reason: result.error }))
      return
    }
    const autoInstalled = result.autoInstall?.installed.length ?? 0
    const autoFailed = result.autoInstall?.failed.length ?? 0
    if (autoFailed > 0) {
      // Failures exist: clearly report the count and open the details (failure reasons are viewable, not silent)
      message.warning(
        autoInstalled > 0
          ? t('sync.autoInstall.partial', { ok: autoInstalled, fail: autoFailed })
          : t('sync.autoInstall.allFailed', { fail: autoFailed })
      )
      await openSyncDetails()
    } else if (autoInstalled > 0) {
      message.success(
        `${t('sync.success', { pushed: result.pushed ?? 0, pulled: result.pulled ?? 0, pushedRows: result.pushedRows ?? 0, pulledRows: result.pulledRows ?? 0 })} · ${t('sync.autoInstall.done', { n: autoInstalled })}`
      )
    } else {
      message.success(
        t('sync.success', {
          pushed: result.pushed ?? 0,
          pulled: result.pulled ?? 0,
          pushedRows: result.pushedRows ?? 0,
          pulledRows: result.pulledRows ?? 0
        })
      )
    }
    await loadHub()
  }, [loadHub, message, openSyncDetails, syncLattice, t])

  /**
   * Merge cloud data: per plugin do a git-style fast-forward / conflict based on the merge base.
   *
   * The notice has the same shape as "sync complete" (user 2026-11-25: "keep it as simple as the sync notice"):
   * - changed locally, untouched in the cloud → push it up (deletes/modifications are not backfilled);
   * - updated in the cloud, untouched locally → pull it down;
   * - changed on both sides → record a conflict and prompt the user to choose explicitly in "Resolve conflicts" (no automatic union anymore).
   */
  const handleMergeCloud = useCallback(async (): Promise<void> => {
    setMergeBusy(true)
    try {
      const result = await window.api.lattice.mergeData()
      const merged = result.merged ?? 0
      const rows = result.rows ?? 0
      const failed = result.failed ?? 0
      const conflicts = result.conflicts ?? 0
      const blocked = result.blocked ?? 0
      if (!result.ok && failed === 0 && conflicts === 0) {
        // Precondition failure (not logged in / account data not ready): give the user the reason directly instead of the three-state path
        message.error(result.error || t('sync.error', { reason: '' }))
        return
      }
      if (conflicts > 0) {
        message.warning(t('sync.merge.conflicts', { merged, rows, conflicts }))
      } else if (blocked > 0 && blocked === failed) {
        // All "no merge base established yet": suggest syncing once first, which is more actionable than a generic "merge failed"
        message.warning(t('sync.merge.blocked', { blocked }))
      } else if (failed > 0 && merged > 0) {
        message.warning(t('sync.merge.partial', { merged, rows, failed }))
      } else if (failed > 0) {
        message.error(t('sync.merge.failed', { failed }))
      } else if (result.empty) {
        message.warning(t('sync.merge.empty'))
      } else {
        message.success(t('sync.merge.success', { merged, rows }))
      }
      await loadHub()
    } catch (err) {
      message.error(latticeErrorMessage(err))
    } finally {
      setMergeBusy(false)
    }
  }, [loadHub, message, t])

  /**
   * Top bar "Publish" dropdown menu (user 2026-11-23: "too many buttons, many with similar functions").
   *
   * Publish plugin directory / publish .zip / publish installer + source / import local plugin directory are all essentially
   * "send a local plugin package/directory to the plugin hub"; grouped into one menu, the top bar keeps only:
   * workshop, install local, publish, refresh (+ "update all" when updates exist).
   */
  const publishing = uploading || uploadingZip || uploadingWithSource || importing
  const publishMenuItems: MenuProps['items'] = [
    {
      key: 'publish-dir',
      icon: <RiUploadCloud2Line size={14} />,
      label: t('plugins.hub.publishDir'),
      onClick: () => void handleUpload()
    },
    {
      key: 'publish-zip',
      icon: <RiFileZipLine size={14} />,
      label: t('plugins.hub.publishZip'),
      onClick: () => void handleUploadZip()
    },
    {
      key: 'publish-with-source',
      icon: <RiCodeSSlashLine size={14} />,
      label: t('plugins.hub.publishWithSource'),
      onClick: () => void handleUploadWithSource()
    },
    { type: 'divider' },
    {
      key: 'import-dir',
      icon: <RiFolderOpenLine size={14} />,
      label: t('plugins.hub.importLocalDir'),
      disabled: !capabilities.importLocalDir,
      onClick: () => void handleImportLocalDir()
    }
  ]

  /**
   * Page-level CSS variables: pass antd tokens down to the `.lattice-*` classes in main.css,
   * so cards and the sync bar change color together on light/dark theme switches without hardcoding colors in components.
   */
  const pageVars = {
    '--lattice-card-bg': token.colorBgElevated,
    '--lattice-card-border': token.colorBorderSecondary,
    '--lattice-card-border-hover': token.colorBorder,
    '--lattice-card-shadow': token.boxShadowTertiary,
    '--lattice-sync-bg': token.colorFillQuaternary,
    '--lattice-sync-border': token.colorBorderSecondary
  } as React.CSSProperties

  const searchBox = (
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
        placeholder={t('plugins.hub.searchPlaceholder')}
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
  )

  const chip = (
    text: React.ReactNode,
    options: { color?: string; background?: string; border?: string; title?: string } = {}
  ): React.ReactNode => (
    <span
      title={options.title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        height: 20,
        padding: '0 7px',
        borderRadius: 999,
        border: `1px solid ${options.border ?? token.colorBorderSecondary}`,
        background: options.background ?? token.colorFillQuaternary,
        color: options.color ?? token.colorTextSecondary,
        fontSize: 10,
        lineHeight: 1,
        whiteSpace: 'nowrap'
      }}
    >
      {text}
    </span>
  )

  /**
   * Fallback for local plugins while the platform catalog is in a state card (not ready / not logged in / loading / failed / empty).
   *
   * Local plugins do not depend on the platform catalog and must be manageable at any time: the state card still shows, with local cards below it.
   * This path is not used when the catalog is available — local cards then come right after catalog cards in the same grid.
   */
  const withLocalCards = (state: React.ReactNode): React.ReactNode => {
    if (visibleLocal.length === 0) return state
    return (
      <>
        {state}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
            gap: 14,
            marginTop: 16
          }}
        >
          {renderLocalCards()}
        </div>
      </>
    )
  }

  /**
   * Card click → detail page, but **ignore bubbling from buttons/input controls**.
   *
   * When `loading`, antd's Button returns directly in its internal handler (so even our
   * `e.stopPropagation()` does not run): the second click of an "install" double-click is swallowed by the button and keeps bubbling to the card,
   * so the install is still running while the user is taken to the detail page. Checking the event target is more reliable than relying on stopPropagation.
   */
  const handleCardNavigate =
    (pluginId: string) =>
    (event: React.MouseEvent<HTMLDivElement>): void => {
      const target = event.target as HTMLElement | null
      if (target?.closest('button, a, input, textarea, select, [role="button"]')) return
      navigate(`/plugins/${pluginId}`)
    }

  /**
   * Platform catalog content states: first-screen skeleton / not ready / not logged in / loading / failed / empty / card grid.
   *
   * All loading states occupy the card's final position with a **skeleton grid the same size as real cards**:
   * the old version used "centered spinner + 240px placeholder block", local cards were below it, and when the catalog returned the block disappeared and
   * the same batch of cards jumped up as a group — the "plugins were below at first, then suddenly moved up" reported by the user 2026-11-25.
   */
  const renderHubContent = (): React.ReactNode => {
    // The bridge / login state is not settled yet: lay the skeleton first. Do not draw the big "unavailable" state card first,
    // it would be replaced by real content on the next frame and the whole page would collapse once.
    if (!latticeStatusReady) return <HubGridSkeleton />
    if (!latticeReady) {
      return withLocalCards(
        <StateCard
          icon={<RiErrorWarningLine size={24} />}
          title={t('plugins.hub.unavailableTitle')}
          description={t('plugins.hub.unavailableDesc')}
          tone="warning"
        />
      )
    }
    if (!loggedIn) {
      // Do not draw before the local list returns: otherwise a guide for "no local plugins" would be laid first and then collapse into one hint
      if (!localLoaded) return <HubGridSkeleton />
      const goLogin = (): void => {
        void navigate('/login')
      }
      // When local plugin cards remain below, login is only an explanation that the catalog is unavailable → one hint;
      // only when the whole page is about logging in does it expand into a centered guide.
      return withLocalCards(
        localOnlyAll.length > 0 ? (
          <GuestNotice onLogin={goLogin} />
        ) : (
          <GuestWelcome onLogin={goLogin} />
        )
      )
    }
    if (hubError && !hub) {
      return withLocalCards(
        <StateCard
          icon={<RiErrorWarningLine size={24} />}
          title={t('plugins.hub.loadFailTitle')}
          description={t('plugins.hub.loadFail', { reason: hubError })}
          tone="error"
          action={
            <Button size="small" icon={<RiRefreshLine size={13} />} onClick={() => void loadHub()}>
              {t('plugins.hub.retry')}
            </Button>
          }
        />
      )
    }
    /**
     * The catalog has not returned yet (first fetch after login / just switched into this page).
     *
     * Here local cards **must** be hidden first: when the catalog is empty, `localOnlyAll` equals all locally installed plugins,
     * and they would first appear as "local plugins" below the placeholder; once the catalog arrives the same plugins are recognized as catalog cards,
     * the whole group moves to the top of the grid — that is the upward jump. The skeleton holds the final position and is replaced in place when it returns.
     */
    if (!hub) return <HubGridSkeleton />
    if (visibleHub.length === 0) {
      const filtered = Boolean(normalizedQuery) || hubCategory !== 'all'
      return withLocalCards(
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            minHeight: 240,
            marginTop: 18,
            color: token.colorTextTertiary
          }}
        >
          <RiInboxLine size={26} />
          <div style={{ fontSize: 12.5 }}>
            {filtered ? t('plugins.hub.noMatch') : t('plugins.hub.empty')}
          </div>
          {!filtered && <div style={{ fontSize: 11 }}>{t('plugins.hub.emptyHint')}</div>}
        </div>
      )
    }
    return (
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
          gap: 14,
          marginTop: 16
        }}
      >
        {visibleHub.map((item) => {
          const localEntry = localById.get(item.plugin_id)
          /**
           * Local view takes precedence (user 2026-11-23):
           * "installed / enabled / update available" always follow the **local plugin list**. The `installed` in the platform catalog is
           * an install-record view saved per account and only changes on the next push after a local uninstall;
           * rendering from it directly produces the contradiction "repository card says installed, detail page says not installed".
           * Only when the local list has not returned yet do we fall back to the platform fields, to avoid a first-frame flash.
           */
          const installed = localTrusted
            ? Boolean(localEntry)
            : Boolean(localEntry || item.installed)
          const hubEnabled = installed && Boolean(localEntry?.enabled)
          const localVersion = localEntry ? localEntry.version : undefined
          const hasSource = Boolean(item.has_source)
          const hasLocalSource = localSourceIds.has(item.plugin_id)
          // Update available = the hub's latest version is **strictly newer** than the local version (not "version strings differ")
          const updateAvailable = installed
            ? localVersion
              ? isVersionNewer(item.latest_version, localVersion)
              : Boolean(item.update_available)
            : false
          const ownerName = item.owner?.display_name || item.owner?.username || '—'
          const version =
            (installed ? localVersion : undefined) ??
            item.latest_version ??
            localEntry?.version ??
            '—'
          /**
           * Pick the description by "who this card represents" (2026-11-23 user feedback "the description is wrong"):
           * the card shows the locally installed version (the version number comes from local), so the description must come from the local copy too —
           * otherwise the plugin hub's **older version** description is paired with the local version number, and the two disagree.
           */
          const cardDescription =
            (installed ? (localEntry?.description ?? item.description) : item.description) ??
            t('settings.plugins.noDescription')
          const busyThis = busy === item.plugin_id
          const primaryLabel = installed
            ? updateAvailable
              ? t('plugins.hub.update')
              : ''
            : t('plugins.hub.install')
          /**
           * The "source" button: if the source exists locally, open the workspace directly; if it does not but the user is logged in and the platform
           * says the source exists, allow one click (the main process downloads the version installed locally on demand), so "clicking only pops up the file explorer" no longer happens.
           */
          const sourceOpenable =
            installed && capabilities.openSource && (hasLocalSource || (loggedIn && hasSource))
          return (
            <div
              key={item.plugin_id}
              className="lattice-hub-card is-clickable"
              onClick={handleCardNavigate(item.plugin_id)}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <PluginIcon id={item.plugin_id} icon={item.icon} size={44} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                    <span
                      style={{
                        fontSize: 14.5,
                        fontWeight: 600,
                        letterSpacing: '-0.005em',
                        color: token.colorText,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap'
                      }}
                    >
                      {item.name}
                    </span>
                    {updateAvailable && (
                      <span
                        className="lattice-hub-tag"
                        style={{
                          flexShrink: 0,
                          background: token.colorWarningBg,
                          color: token.colorWarning
                        }}
                      >
                        {t('plugins.hub.updateAvailable')}
                      </span>
                    )}
                  </div>
                  <div
                    style={{
                      marginTop: 6,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      minWidth: 0,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      fontSize: 10.5,
                      color: token.colorTextTertiary
                    }}
                  >
                    {chip(`v${version}`)}
                    <span
                      title={`${t('plugins.hub.owner')} ${ownerName}`}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 3,
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis'
                      }}
                    >
                      <span style={{ flexShrink: 0 }}>{t('plugins.hub.owner')}</span>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {ownerName}
                      </span>
                    </span>
                  </div>
                </div>
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-end',
                    gap: 6,
                    flexShrink: 0
                  }}
                >
                  {primaryLabel && (
                    <Button
                      size="small"
                      icon={
                        updateAvailable ? <RiArrowUpLine size={13} /> : <RiDownloadLine size={13} />
                      }
                      loading={busyThis}
                      disabled={
                        (busy !== null && busy !== item.plugin_id) ||
                        openBusy === item.plugin_id ||
                        bulkUpdating
                      }
                      onClick={(e) => {
                        e.stopPropagation()
                        void handleHubInstall(item)
                      }}
                    >
                      {primaryLabel}
                    </Button>
                  )}
                  {sourceOpenable && (
                    <Tooltip title={t('plugins.hub.source.open')}>
                      <Button
                        size="small"
                        icon={<RiCodeSSlashLine size={13} />}
                        loading={openBusy === item.plugin_id}
                        disabled={
                          (openBusy !== null && openBusy !== item.plugin_id) ||
                          busy === item.plugin_id ||
                          bulkUpdating
                        }
                        onClick={(e) => {
                          e.stopPropagation()
                          void handleOpenSource(item.plugin_id)
                        }}
                      >
                        {t('plugins.hub.source.badge')}
                      </Button>
                    </Tooltip>
                  )}
                </div>
              </div>

              <div
                className="lattice-hub-description"
                style={{
                  marginTop: 12,
                  minHeight: 41,
                  fontSize: 12.5,
                  lineHeight: 1.65,
                  color: token.colorTextSecondary
                }}
              >
                {cardDescription}
              </div>

              {(item.tags ?? []).length > 0 && (
                <div style={{ marginTop: 10, display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                  {(item.tags ?? []).slice(0, 4).map((tag) => (
                    <span
                      key={tag}
                      className="lattice-hub-tag"
                      style={{
                        background: token.colorFillQuaternary,
                        color: token.colorTextTertiary
                      }}
                    >
                      #{tag}
                    </span>
                  ))}
                </div>
              )}

              <div
                style={{
                  marginTop: 'auto',
                  paddingTop: 12,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  flexWrap: 'wrap',
                  fontSize: 10
                }}
              >
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    color: updateAvailable
                      ? token.colorWarning
                      : installed
                        ? hubEnabled
                          ? token.colorSuccess
                          : token.colorTextTertiary
                        : token.colorTextTertiary
                  }}
                >
                  {updateAvailable ? (
                    <>
                      <RiTimeLine size={12} />
                      {t('plugins.hub.updateTo', { version: item.latest_version ?? '' })}
                    </>
                  ) : installed ? (
                    <>
                      <RiCheckboxCircleLine size={12} />
                      {hubEnabled ? t('plugins.hub.enabled') : t('plugins.hub.disabled')}
                      {localVersion && (
                        <span style={{ color: token.colorTextTertiary }}>
                          · {t('plugins.hub.installedVersion', { version: localVersion })}
                        </span>
                      )}
                    </>
                  ) : (
                    <>
                      <RiInboxLine size={12} />
                      {t('settings.plugins.notInstalledState')}
                    </>
                  )}
                </span>
                {hasSource && (
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      color: token.colorTextTertiary
                    }}
                    title={t('plugins.hub.source.hint')}
                  >
                    <RiCodeSSlashLine size={12} />
                    {t('plugins.hub.source.hasSource')}
                  </span>
                )}
                <span
                  style={{
                    marginLeft: 'auto',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    color: token.colorTextTertiary
                  }}
                  title={t('plugins.hub.downloads', { n: item.downloads })}
                >
                  <RiDownloadLine size={12} />
                  {formatCount(item.downloads)}
                </span>
              </div>
            </div>
          )
        })}
        {/* Plugins installed locally but not yet on the platform: continue in the same grid (not a separate group) */}
        {renderLocalCards()}
      </div>
    )
  }

  /**
   * Plugins installed locally but not published to the platform (local installers): keep the detail page and "publish to plugin hub" reachable.
   *
   * They are **in the same grid** as platform catalog cards (user 2026-11-23: "don't show local and online separately, merge them"):
   * no separate grid and no separate group heading (user 2026-11-22: "this content is not needed").
   * This outer `display: contents` takes no part in layout; the cards themselves are grid items of the caller's grid —
   * so local plugins do not start a new row but follow the catalog cards with the same column width and gap.
   */
  const renderLocalCards = (): React.ReactNode => {
    if (visibleLocal.length === 0) return null
    return (
      <div style={{ display: 'contents' }}>
        {visibleLocal.map((entry) => {
          const state = runtimeState(entry.id)
          const failed = state === 'error'
          return (
            <div
              key={entry.id}
              className="lattice-hub-card is-clickable"
              onClick={handleCardNavigate(entry.id)}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <PluginIcon id={entry.id} icon={entry.icon} menuIcon={entry.menu?.icon} size={44} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                    <span
                      style={{
                        fontSize: 14.5,
                        fontWeight: 600,
                        letterSpacing: '-0.005em',
                        color: token.colorText,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap'
                      }}
                    >
                      {entry.name}
                    </span>
                    <span
                      className="lattice-hub-tag"
                      style={{
                        flexShrink: 0,
                        background: token.colorFillSecondary,
                        color: token.colorTextTertiary
                      }}
                    >
                      {t('plugins.hub.local.badge')}
                    </span>
                  </div>
                  <div
                    style={{
                      marginTop: 6,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      flexWrap: 'wrap',
                      fontSize: 10.5,
                      color: token.colorTextTertiary
                    }}
                  >
                    {chip(`v${entry.version}`)}
                    <span>{t('plugins.hub.local.desc')}</span>
                  </div>
                </div>
                {capabilities.openSource && localSourceIds.has(entry.id) && (
                  <Tooltip title={t('plugins.hub.source.open')}>
                    <Button
                      size="small"
                      icon={<RiCodeSSlashLine size={13} />}
                      loading={openBusy === entry.id}
                      disabled={openBusy !== null && openBusy !== entry.id}
                      onClick={(e) => {
                        e.stopPropagation()
                        void handleOpenSource(entry.id)
                      }}
                    />
                  </Tooltip>
                )}
              </div>
              <div
                className="lattice-hub-description"
                style={{
                  marginTop: 12,
                  minHeight: 41,
                  fontSize: 12.5,
                  lineHeight: 1.65,
                  color: token.colorTextSecondary
                }}
              >
                {entry.description || t('settings.plugins.noDescription')}
              </div>
              <div
                style={{
                  marginTop: 'auto',
                  paddingTop: 12,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 10
                }}
              >
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    color: failed
                      ? token.colorError
                      : entry.enabled
                        ? token.colorSuccess
                        : token.colorTextTertiary
                  }}
                >
                  {failed ? (
                    t('settings.plugins.loadFailed')
                  ) : entry.enabled ? (
                    <>
                      <RiCheckboxCircleLine size={12} />
                      {t('plugins.hub.enabled')}
                    </>
                  ) : (
                    t('plugins.hub.disabled')
                  )}
                </span>
                <Button
                  size="small"
                  type="text"
                  style={{ marginLeft: 'auto', fontSize: 10.5 }}
                  onClick={(e) => {
                    e.stopPropagation()
                    navigate(`/plugins/${entry.id}`)
                  }}
                >
                  {t('plugins.hub.local.detail')}
                </Button>
                {sectionsOf(entry.id).length > 0 && (
                  <Button
                    size="small"
                    type="text"
                    icon={<RiSettings3Line size={13} />}
                    onClick={(e) => {
                      e.stopPropagation()
                      setSettingsPlugin({ id: entry.id, name: entry.name })
                    }}
                  />
                )}
              </div>
            </div>
          )
        })}
      </div>
    )
  }

  /** Sync status bar: last sync / auto-repair result / conflict count / auto-repair toggle / manual sync (shown when logged in) */
  const renderSyncBar = (): React.ReactNode => {
    const syncSnapshot = latticeStatus.sync
    const conflictCount = syncSnapshot?.conflicts ?? 0
    const lastSyncTime = formatSyncTime(syncSnapshot?.at)
    const autoInstalled = syncSnapshot?.autoInstalled ?? 0
    const autoFailed = syncSnapshot?.autoInstallFailed ?? 0
    const orphanedCount = syncSnapshot?.orphaned ?? 0
    const pushedRows = syncSnapshot?.pushedRows ?? 0
    const pulledRows = syncSnapshot?.pulledRows ?? 0
    // When the main process is missing/old, display the default "on" (consistent with the main process getLatticeAutoInstallMissing default)
    const autoInstallEnabled = latticeStatus.autoInstallMissing !== false
    return (
      <div className="lattice-hub-sync-bar">
        <RiCloudLine size={13} style={{ color: token.colorTextTertiary }} />
        <span style={{ color: token.colorTextSecondary }}>
          {lastSyncTime ? t('sync.lastSync', { time: lastSyncTime }) : t('sync.never')}
        </span>
        {(pushedRows > 0 || pulledRows > 0) && (
          <span style={{ color: token.colorTextTertiary, fontSize: 11 }}>
            {t('sync.rowsSummary', { pushed: pushedRows, pulled: pulledRows })}
          </span>
        )}
        {conflictCount > 0 && (
          <Button
            size="small"
            type="text"
            icon={<RiErrorWarningLine size={12} />}
            style={{ color: token.colorWarning, fontSize: 11 }}
            onClick={() => {
              setConflictOpen(true)
              void loadConflicts()
            }}
          >
            {t('sync.resolve.button', { n: conflictCount })}
          </Button>
        )}
        {/* PL-18: auto-repair result after switching machines (failures are not silent; open sync details to see reasons) */}
        {autoFailed > 0 ? (
          <Button
            size="small"
            type="text"
            icon={<RiErrorWarningLine size={12} />}
            style={{ color: token.colorWarning, fontSize: 11 }}
            onClick={() => void openSyncDetails()}
          >
            {t('sync.autoInstall.failed', { fail: autoFailed })}
          </Button>
        ) : autoInstalled > 0 ? (
          <span
            className="lattice-auto-install-ok"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              color: token.colorSuccess,
              fontSize: 11
            }}
          >
            <RiCheckboxCircleLine size={12} />
            {t('sync.autoInstall.done', { n: autoInstalled })}
          </span>
        ) : null}
        {orphanedCount > 0 && (
          <Button
            size="small"
            type="text"
            icon={<RiErrorWarningLine size={12} />}
            style={{ color: token.colorTextTertiary, fontSize: 11 }}
            onClick={() => void openSyncDetails()}
          >
            {t('sync.autoInstall.orphaned', { n: orphanedCount })}
          </Button>
        )}
        {syncSnapshot?.error && (
          <span style={{ color: token.colorError }}>
            {t('sync.error', { reason: syncSnapshot.error })}
          </span>
        )}
        <span style={{ color: token.colorTextTertiary }}>
          {t('plugins.hub.total', { n: hub?.total ?? 0 })}
        </span>
        <span
          title={t('sync.autoInstall.toggleHint')}
          style={{
            marginLeft: 'auto',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 11,
            color: token.colorTextTertiary,
            whiteSpace: 'nowrap'
          }}
        >
          <Switch
            size="small"
            checked={autoInstallEnabled}
            loading={autoInstallSaving}
            onChange={(checked) => void handleToggleAutoInstall(checked)}
          />
          {t('sync.autoInstall.toggle')}
        </span>
        <Button
          size="small"
          type="text"
          icon={<RiRefreshLine size={13} />}
          loading={latticeSyncing}
          onClick={() => void handleSyncNow()}
          style={{ fontSize: 11 }}
        >
          {t('sync.now')}
        </Button>
        <Tooltip title={t('sync.merge.hint')}>
          <Button
            size="small"
            type="text"
            icon={<RiGitMergeLine size={13} />}
            loading={mergeBusy}
            onClick={() => void handleMergeCloud()}
            style={{ fontSize: 11 }}
          >
            {t('sync.merge.button')}
          </Button>
        </Tooltip>
      </div>
    )
  }

  const showContent = Boolean(latticeReady && loggedIn)
  /** Number of installed plugins with updates (top bar "update all" entry; hidden when 0; same rule as cards: installed locally + version differs) */
  const updatableCount = (hub?.items ?? []).filter((item) => hasLocalUpdate(item)).length

  /** Data preview in the conflict modal: only the first 240 characters, so a 256KiB JSON does not blow up the modal */
  const conflictPreview = (value: unknown): string => {
    if (value === undefined) return t('sync.resolve.noData')
    try {
      const text = JSON.stringify(value)
      return text.length > 240 ? `${text.slice(0, 240)}…` : text
    } catch {
      return String(value)
    }
  }

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        boxSizing: 'border-box',
        /* No top gutter: the first row stays aligned with the sidebar brand area; 12px left/right/bottom, consistent with the library */
        padding: '6px 9px',
        background: token.colorBgContainer,
        borderTopLeftRadius: token.borderRadiusLG,
        ...pageVars
      }}
    >
      {/* Content fills the page; the first row is still a toolbar at the same height as the brand area */}
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
        <div className="shell-topbar" style={{ gap: 10, flexWrap: 'wrap' }}>
          {searchBox}
          <Select
            size="small"
            value={hubCategory}
            onChange={(value) => setHubCategory(value)}
            style={{ width: 148 }}
            options={[
              { value: 'all', label: t('plugins.hub.categoryAll') },
              ...hubCategories.map((category) => ({ value: category, label: category }))
            ]}
            placeholder={t('plugins.hub.categoryLabel')}
            disabled={!showContent}
          />
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            <Tooltip title={t('settings.plugins.viewWorkshop')}>
              <Button
                size="small"
                icon={<RiHammerLine size={14} />}
                aria-label={t('settings.plugins.viewWorkshop')}
                onClick={() => setWorkshopOpen(true)}
              />
            </Tooltip>
            <Button
              size="small"
              icon={<RiDownloadLine size={14} />}
              onClick={() => void handleInstallLocal()}
            >
              {t('plugins.hub.installLocal')}
            </Button>
            <Dropdown
              menu={{ items: publishMenuItems }}
              trigger={['click']}
              disabled={!loggedIn || uploadOpen}
            >
              <Button
                size="small"
                icon={<RiUploadCloud2Line size={14} />}
                loading={publishing}
                disabled={!loggedIn || uploadOpen}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                  {t('plugins.hub.publishMenu')}
                  <RiArrowDownSLine size={12} />
                </span>
              </Button>
            </Dropdown>
            {updatableCount > 0 && (
              <Button
                size="small"
                icon={<RiArrowUpLine size={14} />}
                loading={bulkUpdating}
                disabled={!loggedIn}
                onClick={() => void handleUpdateAll()}
              >
                {t('plugins.hub.updateAll.button', { n: updatableCount })}
              </Button>
            )}
            <Tooltip title={t('plugins.hub.refresh')}>
              <Button
                size="small"
                icon={<RiRefreshLine size={14} />}
                aria-label={t('plugins.hub.refresh')}
                loading={hubLoading}
                disabled={!loggedIn}
                onClick={() => void loadHub()}
              />
            </Tooltip>
          </div>
        </div>

        {showContent && renderSyncBar()}
        {renderHubContent()}
      </div>

      {/* Upload progress (publish to plugin hub): progress comes from lattice:upload-progress pushes */}
      <UploadProgressModal open={uploadOpen} />

      {/* Sync details: auto-repair success/failure details + records deleted on the platform (orphaned) + data conflicts (failure reasons are not silent) */}
      <Modal
        open={syncDetailsOpen}
        onCancel={() => setSyncDetailsOpen(false)}
        footer={
          <Button size="small" onClick={() => setSyncDetailsOpen(false)}>
            {t('sync.details.close')}
          </Button>
        }
        title={t('sync.details.title')}
        width={720}
        destroyOnHidden
      >
        {syncDetailsLoading ? (
          <div style={{ padding: 16, textAlign: 'center', color: token.colorTextTertiary }}>
            {t('common.state.loading')}
          </div>
        ) : (
          <div>
            <p style={{ marginTop: 0, fontSize: 12, color: token.colorTextSecondary }}>
              {t('sync.details.description')}
            </p>
            {(() => {
              const last = syncDetailsData?.last ?? null
              const installed = last?.autoInstall?.installed ?? []
              const failed = last?.autoInstall?.failed ?? []
              const conflictItems = syncDetailsData?.conflicts ?? []
              const orphanItems = syncDetailsData?.orphaned ?? []
              const sectionStyle: React.CSSProperties = {
                border: `1px solid ${token.colorBorderSecondary}`,
                borderRadius: 8,
                padding: 12,
                marginBottom: 10
              }
              const emptyStyle: React.CSSProperties = {
                fontSize: 11.5,
                color: token.colorTextTertiary
              }
              return (
                <>
                  {/* Auto-repair */}
                  <div style={sectionStyle}>
                    <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
                      {t('sync.details.autoInstallTitle')}
                    </div>
                    {installed.length === 0 && failed.length === 0 ? (
                      <div style={emptyStyle}>{t('sync.details.autoInstallEmpty')}</div>
                    ) : (
                      <>
                        {installed.length > 0 && (
                          <div style={{ marginBottom: failed.length > 0 ? 8 : 0 }}>
                            <div
                              style={{ fontSize: 11.5, color: token.colorSuccess, marginBottom: 4 }}
                            >
                              {t('sync.details.installedTitle', { n: installed.length })}
                            </div>
                            {installed.map((item) => (
                              <div
                                key={`ok-${item.plugin_id}`}
                                style={{ fontSize: 11.5, color: token.colorTextSecondary }}
                              >
                                {item.plugin_id}
                                {item.version ? ` · v${item.version}` : ''}
                                {item.sourceError ? ` · ${item.sourceError}` : ''}
                              </div>
                            ))}
                          </div>
                        )}
                        {failed.length > 0 && (
                          <div>
                            <div
                              style={{ fontSize: 11.5, color: token.colorWarning, marginBottom: 4 }}
                            >
                              {t('sync.details.failedTitle', { n: failed.length })}
                            </div>
                            {failed.map((item) => (
                              <div
                                key={`fail-${item.plugin_id}`}
                                style={{ marginBottom: 6, fontSize: 11.5 }}
                              >
                                <span style={{ color: token.colorText, fontWeight: 500 }}>
                                  {item.plugin_id}
                                  {item.version ? ` · v${item.version}` : ''}
                                </span>
                                <div style={{ color: token.colorTextTertiary, marginTop: 2 }}>
                                  {item.error}
                                </div>
                              </div>
                            ))}
                            <div style={{ ...emptyStyle, marginTop: 4 }}>
                              {t('sync.details.failedHint')}
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>

                  {/* Install records deleted on the platform (orphaned) */}
                  <div style={sectionStyle}>
                    <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
                      {t('sync.details.orphanedTitle', { n: orphanItems.length })}
                    </div>
                    {orphanItems.length === 0 ? (
                      <div style={emptyStyle}>{t('sync.details.orphanedEmpty')}</div>
                    ) : (
                      <>
                        {orphanItems.map((item) => (
                          <div
                            key={`orphan-${item.plugin_id}`}
                            style={{ marginBottom: 6, fontSize: 11.5 }}
                          >
                            <span style={{ color: token.colorText, fontWeight: 500 }}>
                              {item.plugin_id}
                              {item.version ? ` · v${item.version}` : ''}
                            </span>
                            {item.error && (
                              <div style={{ color: token.colorTextTertiary, marginTop: 2 }}>
                                {item.error}
                              </div>
                            )}
                          </div>
                        ))}
                        <div style={{ ...emptyStyle, marginTop: 4 }}>
                          {t('sync.details.orphanedHint')}
                        </div>
                      </>
                    )}
                  </div>

                  {/* Data conflicts: the same modal as "Resolve conflicts" in the sync bar */}
                  <div style={sectionStyle}>
                    <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
                      {t('sync.details.conflictsTitle', { n: conflictItems.length })}
                    </div>
                    {conflictItems.length === 0 ? (
                      <div style={emptyStyle}>{t('sync.resolve.empty')}</div>
                    ) : (
                      <>
                        {conflictItems.map((conflict) => (
                          <div
                            key={`conflict-${conflict.plugin_id}`}
                            style={{ marginBottom: 4, fontSize: 11.5 }}
                          >
                            {conflict.plugin_id} ·{' '}
                            {t('sync.resolve.localRev', { n: conflict.local_rev })} ·{' '}
                            {t('sync.resolve.serverRev', { n: conflict.server_rev })}
                          </div>
                        ))}
                        <div style={{ marginTop: 6 }}>
                          <Button
                            size="small"
                            onClick={() => {
                              setSyncDetailsOpen(false)
                              setConflictOpen(true)
                              void loadConflicts()
                            }}
                          >
                            {t('sync.resolve.button', { n: conflictItems.length })}
                          </Button>
                        </div>
                        <div style={{ ...emptyStyle, marginTop: 4 }}>
                          {t('sync.details.conflictsHint')}
                        </div>
                      </>
                    )}
                  </div>
                </>
              )
            })()}
          </div>
        )}
      </Modal>

      {/* Plugin data conflicts: ask the user to choose "use local / use cloud" explicitly for each (no automatic overwrite) */}
      <Modal
        open={conflictOpen}
        onCancel={() => setConflictOpen(false)}
        footer={
          <Button size="small" onClick={() => setConflictOpen(false)}>
            {t('common.action.close')}
          </Button>
        }
        title={t('sync.resolve.title')}
        width={760}
        destroyOnHidden
      >
        <p style={{ marginTop: 0, fontSize: 12, color: token.colorTextSecondary }}>
          {t('sync.resolve.description')}
        </p>
        {conflictLoading ? (
          <div style={{ padding: 16, textAlign: 'center', color: token.colorTextTertiary }}>
            {t('common.state.loading')}
          </div>
        ) : conflicts.length === 0 ? (
          <div style={{ padding: 16, textAlign: 'center', color: token.colorTextTertiary }}>
            {t('sync.resolve.empty')}
          </div>
        ) : (
          conflicts.map((conflict) => {
            const localKey = `${conflict.plugin_id}:local`
            const cloudKey = `${conflict.plugin_id}:cloud`
            const mergeKey = `${conflict.plugin_id}:merge`
            return (
              <div
                key={conflict.plugin_id}
                style={{
                  border: `1px solid ${token.colorBorderSecondary}`,
                  borderRadius: 8,
                  padding: 12,
                  marginBottom: 10
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 600 }}>{conflict.plugin_id}</div>
                <div style={{ marginTop: 3, fontSize: 11, color: token.colorTextTertiary }}>
                  {t('sync.resolve.localRev', { n: conflict.local_rev })} ·{' '}
                  {t('sync.resolve.serverRev', { n: conflict.server_rev })}
                </div>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    gap: 8,
                    marginTop: 8
                  }}
                >
                  <div>
                    <div style={{ fontSize: 11, color: token.colorTextSecondary }}>
                      {t('sync.resolve.localData')}
                    </div>
                    <pre
                      style={{
                        margin: '4px 0 0',
                        padding: 6,
                        borderRadius: 6,
                        background: token.colorFillQuaternary,
                        fontSize: 11,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-all',
                        maxHeight: 96,
                        overflow: 'auto'
                      }}
                    >
                      {conflictPreview(conflict.local_data)}
                    </pre>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: token.colorTextSecondary }}>
                      {t('sync.resolve.serverData')}
                    </div>
                    <pre
                      style={{
                        margin: '4px 0 0',
                        padding: 6,
                        borderRadius: 6,
                        background: token.colorFillQuaternary,
                        fontSize: 11,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-all',
                        maxHeight: 96,
                        overflow: 'auto'
                      }}
                    >
                      {conflictPreview(conflict.server_data)}
                    </pre>
                  </div>
                </div>
                <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <Button
                    size="small"
                    loading={conflictBusy === localKey}
                    disabled={conflictBusy !== null}
                    onClick={() => void resolveConflict(conflict.plugin_id, 'local')}
                  >
                    {t('sync.resolve.useLocal')}
                  </Button>
                  <Button
                    size="small"
                    loading={conflictBusy === cloudKey}
                    disabled={conflictBusy !== null}
                    onClick={() => void resolveConflict(conflict.plugin_id, 'cloud')}
                  >
                    {t('sync.resolve.useCloud')}
                  </Button>
                  {conflict.merge_supported === true && (
                    <Button
                      size="small"
                      type="primary"
                      loading={conflictBusy === mergeKey}
                      disabled={conflictBusy !== null}
                      onClick={() => void resolveConflict(conflict.plugin_id, 'merge')}
                    >
                      {t('sync.resolve.merge')}
                    </Button>
                  )}
                </div>
              </div>
            )
          })
        )}
      </Modal>

      {/* Plugin workshop (modal): draft list + build/accept/install */}
      <Modal
        open={workshopOpen}
        onCancel={() => {
          setWorkshopOpen(false)
          setWorkshopDraftPending(null)
        }}
        footer={null}
        width={880}
        title={t('settings.plugins.viewWorkshop')}
        destroyOnHidden
      >
        <div
          className="custom-scrollbar app-modal-scroll"
          style={{ maxHeight: '68vh', overflowY: 'auto' }}
        >
          <WorkshopSettings embedded />
        </div>
      </Modal>

      {/* A single plugin's own settings page (modal) */}
      <Modal
        open={settingsPlugin !== null}
        onCancel={() => setSettingsPlugin(null)}
        footer={null}
        width={760}
        title={t('settings.plugins.pluginSettings')}
        destroyOnHidden
      >
        <div
          className="custom-scrollbar app-modal-scroll"
          style={{ maxHeight: '68vh', overflowY: 'auto' }}
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

/**
 * Skeleton card grid for the catalog's first screen.
 *
 * The card shape reuses `.lattice-hub-card` directly (same radius/border/background/min height), with only the inside replaced by
 * gray skeleton blocks: the placeholder has the same size and grid column width as a real card, so when the catalog returns it is "filled in place",
 * and the page does not shift up as a whole when the placeholder disappears (the flicker reported by the user 2026-11-25).
 * Block widths vary in a fixed pattern — random values would make every render jitter.
 */
const HUB_SKELETON_CARDS = 6
const HUB_SKELETON_TITLE = ['58%', '46%', '62%', '52%', '44%', '56%']
const HUB_SKELETON_DESC = ['100%', '84%', '92%', '76%', '96%', '88%']

const HubGridSkeleton: React.FC = () => {
  const palette = useSkeletonPalette()
  return (
    <div
      data-hub-loading="skeleton"
      aria-busy="true"
      style={{
        ...skeletonVars(palette),
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
        gap: 14,
        marginTop: 16
      }}
    >
      <SkeletonStyle />
      {Array.from({ length: HUB_SKELETON_CARDS }, (_, index) => (
        <div key={index} className="lattice-hub-card" aria-hidden>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <SkeletonBlock w={44} h={44} r={13} />
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 9 }}>
              <SkeletonBlock w={HUB_SKELETON_TITLE[index % HUB_SKELETON_TITLE.length]} h={14} />
              <SkeletonBlock w="36%" h={10} />
            </div>
          </div>
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 7 }}>
            <SkeletonBlock h={10} />
            <SkeletonBlock w={HUB_SKELETON_DESC[index % HUB_SKELETON_DESC.length]} h={10} />
          </div>
          <div
            style={{
              marginTop: 'auto',
              paddingTop: 16,
              display: 'flex',
              alignItems: 'center',
              gap: 8
            }}
          >
            <SkeletonBlock w={68} h={22} r={11} />
            <SkeletonBlock w={38} h={10} />
            <SkeletonBlock w={30} h={10} />
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * Plugin hub hint bar for the logged-out state.
 *
 * Locally installed plugins do not depend on the account, so cards still appear below the page; this used to be a full-page empty state (52px large icon +
 * dashed large card) sitting on top of the cards, which looked like an error and stole visual weight from the content that is actually clickable.
 * It is now one bar at the same scale as the sync status bar: one title line + one description line + "Log in" on the right.
 */
const GuestNotice: React.FC<{ onLogin: () => void }> = ({ onLogin }) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  return (
    <div
      data-hub-guest="notice"
      style={{
        marginTop: 12,
        padding: '10px 12px',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: 11,
        background: token.colorFillQuaternary
      }}
    >
      <RiLoginBoxLine size={15} style={{ flexShrink: 0, color: token.colorPrimary }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.4, color: token.colorText }}>
          {t('plugins.hub.loginRequiredTitle')}
        </div>
        <div
          style={{
            marginTop: 1,
            fontSize: 11.5,
            lineHeight: 1.45,
            color: token.colorTextTertiary
          }}
        >
          {t('plugins.hub.loginRequiredDesc')}
        </div>
      </div>
      <Button size="small" type="primary" onClick={onLogin} style={{ flexShrink: 0 }}>
        {t('plugins.hub.goLogin')}
      </Button>
    </div>
  )
}

/**
 * Login guide when logged out and there are no local plugins: only when the whole page is about logging in does it expand into a centered guide.
 * No border/background — it never appears together with the hint bar above, and it does not pretend there is other content here.
 */
const GuestWelcome: React.FC<{ onLogin: () => void }> = ({ onLogin }) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  return (
    <div
      data-hub-guest="welcome"
      style={{
        flex: 1,
        minHeight: 240,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px 0 40px'
      }}
    >
      <div
        style={{
          maxWidth: 430,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 10,
          textAlign: 'center'
        }}
      >
        <span
          style={{
            width: 46,
            height: 46,
            borderRadius: 14,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: token.colorPrimaryBg,
            color: token.colorPrimary
          }}
        >
          <RiLoginBoxLine size={21} />
        </span>
        <div style={{ fontSize: 15, fontWeight: 600, color: token.colorText }}>
          {t('plugins.hub.loginRequiredTitle')}
        </div>
        <div style={{ fontSize: 12, lineHeight: 1.7, color: token.colorTextSecondary }}>
          {t('plugins.hub.loginRequiredDesc')}
        </div>
        <Button
          size="small"
          type="primary"
          icon={<RiLoginBoxLine size={13} />}
          onClick={onLogin}
          style={{ marginTop: 2 }}
        >
          {t('plugins.hub.goLogin')}
        </Button>
      </div>
    </div>
  )
}

/**
 * State card for the plugin hub content area (shared by not ready / load failed).
 *
 * Visually consistent with the other empty states of the plugin repository: large icon + title + description + optional action button.
 */
const StateCard: React.FC<{
  icon: React.ReactNode
  title: string
  description: string
  tone: 'primary' | 'warning' | 'error'
  action?: React.ReactNode
}> = ({ icon, title, description, tone, action }) => {
  const { token } = theme.useToken()
  const accent =
    tone === 'primary'
      ? token.colorPrimary
      : tone === 'warning'
        ? token.colorWarning
        : token.colorError
  const accentBg =
    tone === 'primary'
      ? token.colorPrimaryBg
      : tone === 'warning'
        ? token.colorWarningBg
        : token.colorErrorBg
  return (
    <div
      style={{
        marginTop: 22,
        padding: '38px 24px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 12,
        border: `1px dashed ${token.colorBorderSecondary}`,
        borderRadius: 18,
        background: token.colorBgElevated
      }}
    >
      <span
        style={{
          width: 52,
          height: 52,
          borderRadius: 16,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: accentBg,
          color: accent
        }}
      >
        {icon}
      </span>
      <div style={{ fontSize: 15, fontWeight: 600, color: token.colorText }}>{title}</div>
      <div
        style={{
          maxWidth: 460,
          textAlign: 'center',
          fontSize: 12,
          lineHeight: 1.7,
          color: token.colorTextSecondary
        }}
      >
        {description}
      </div>
      {action && <div style={{ marginTop: 4 }}>{action}</div>}
    </div>
  )
}

export default PluginRepository
