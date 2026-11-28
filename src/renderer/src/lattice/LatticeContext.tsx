import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  EMPTY_HUB_LIST,
  EMPTY_LATTICE_STATUS,
  emptySyncResult,
  type HubDetailV2,
  type HubListResultV2,
  type LatticeAutoInstallSettingResult,
  type LatticeDownloadKind,
  type LatticeDownloadResult,
  type LatticeImportLocalDirResult,
  type LatticeInstallResultV2,
  type LatticeListQuery,
  type LatticeLoginInput,
  type LatticeLoginResult,
  type LatticeOpenSourceResult,
  type LatticeRepublishInput,
  type LatticeRepublishResult,
  type LatticeSourcePathResult,
  type LatticeStatus,
  type LatticeSyncDetails,
  type LatticeSyncDirection,
  type LatticeSyncResult,
  type LatticeUploadProgress,
  type LatticeUploadResult
} from './types'
import { LATTICE_BRIDGE_MISSING, getLatticeBridge, latticeErrorMessage } from './api'
import { detectLatticeV2Capabilities, getLatticeV2Bridge } from './source'
import { LatticeContext, type LatticeContextValue } from './LatticeContextCore'

/**
 * Plugin center provider: funnels `window.api.lattice` state and events into a single React state.
 *
 * Responsibilities:
 * - Read `lattice:status` once at startup and subscribe to the three pushes
 *   `lattice:state-changed` / `lattice:sync-state` / `lattice:upload-progress`;
 * - Wrap each IPC method (refresh status automatically after login/logout/sync);
 * - Don't crash when the main-process channel is not registered yet: `available=false` and every
 *   method returns an "unavailable" fallback result;
 * - Wrap the v2 source/publish/import methods the same way and add **capability detection**
 *   (these methods are undefined on an older main process, so the page disables entries through
 *   `capabilities` instead of hitting a runtime `not a function`).
 *
 * Convention: the provider only holds state; it does not route or show toasts — pages do that.
 * The context object lives in `LatticeContextCore.ts` (react-refresh requires component files to
 * export components only).
 */
function normalizeStatus(next: LatticeStatus | null | undefined): LatticeStatus {
  if (!next) return EMPTY_LATTICE_STATUS
  const rawUser = next.user
  /**
   * `user.avatar` fallback: the status from an older main process has no such field (undefined)
   * → null; an explicit empty/blank string from the platform is likewise treated as no avatar.
   * Invalid addresses are filtered again by `normalizeAvatarSrc()` in the display layer, which
   * falls back to the initial.
   */
  const user = rawUser
    ? {
        ...rawUser,
        avatar:
          typeof rawUser.avatar === 'string' && rawUser.avatar.trim() !== ''
            ? rawUser.avatar.trim()
            : null
      }
    : undefined
  return {
    ...EMPTY_LATTICE_STATUS,
    ...next,
    configured: Boolean(next.configured),
    loggedIn: Boolean(next.loggedIn),
    baseUrl: next.baseUrl ?? '',
    ...(user ? { user } : {})
  }
}

export const LatticeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [available, setAvailable] = useState(false)
  const [ready, setReady] = useState(false)
  const [status, setStatus] = useState<LatticeStatus>(EMPTY_LATTICE_STATUS)
  const [syncing, setSyncing] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<LatticeUploadProgress | null>(null)
  /**
   * v2 capability detection: the methods exposed by preload never change during the app
   * lifetime, so computing them once at init is enough. On an older main process
   * `sourcePath/openSource/republish/...` are all undefined → entries disabled.
   */
  const [capabilities] = useState(() => detectLatticeV2Capabilities())
  /** No setState after unmount (async status reads / event pushes can outlive it) */
  const disposedRef = useRef(false)

  const refresh = useCallback(async (): Promise<LatticeStatus> => {
    const bridge = getLatticeBridge()
    if (!bridge) {
      setAvailable(false)
      setReady(true)
      return EMPTY_LATTICE_STATUS
    }
    setAvailable(true)
    try {
      const next = normalizeStatus(await bridge.status())
      if (!disposedRef.current) setStatus(next)
      return next
    } catch (error) {
      const failed: LatticeStatus = {
        ...EMPTY_LATTICE_STATUS,
        lastError: latticeErrorMessage(error)
      }
      if (!disposedRef.current) setStatus(failed)
      return failed
    } finally {
      if (!disposedRef.current) setReady(true)
    }
  }, [])

  useEffect(() => {
    disposedRef.current = false
    const bridge = getLatticeBridge()
    if (!bridge) {
      setAvailable(false)
      setReady(true)
      return () => {
        disposedRef.current = true
      }
    }

    setAvailable(true)
    void refresh()

    const unsubscribers: Array<() => void> = []
    /** A failing push subscription must not block the others (the main process may implement only some events) */
    const safeSubscribe = (subscribe: () => unknown): void => {
      try {
        const dispose = subscribe()
        if (typeof dispose === 'function') unsubscribers.push(dispose as () => void)
      } catch {
        // Ignore an unavailable single event channel
      }
    }

    safeSubscribe(() =>
      bridge.onStateChanged?.((next) => {
        if (disposedRef.current) return
        setStatus(normalizeStatus(next))
      })
    )
    safeSubscribe(() =>
      bridge.onSyncState?.((snapshot: LatticeSyncResult) => {
        if (disposedRef.current) return
        // The event payload is the full sync result (including autoInstall details / orphaned array); the status bar stores only summary counts
        setStatus((prev) => ({
          ...prev,
          sync: {
            at: snapshot.at,
            pushed: snapshot.pushed,
            pulled: snapshot.pulled,
            pushedRows: snapshot.pushedRows ?? 0,
            pulledRows: snapshot.pulledRows ?? 0,
            conflicts: snapshot.conflicts,
            autoInstalled: snapshot.autoInstall?.installed.length ?? prev.sync?.autoInstalled ?? 0,
            autoInstallFailed:
              snapshot.autoInstall?.failed.length ?? prev.sync?.autoInstallFailed ?? 0,
            orphaned: snapshot.orphaned?.length ?? prev.sync?.orphaned ?? 0,
            ...(snapshot.error ? { error: snapshot.error } : {})
          }
        }))
      })
    )
    safeSubscribe(() =>
      bridge.onUploadProgress?.((progress) => {
        if (disposedRef.current) return
        setUploadProgress(progress)
      })
    )

    return () => {
      disposedRef.current = true
      for (const unsubscribe of unsubscribers) {
        try {
          unsubscribe()
        } catch {
          // A failed unsubscribe must not break unmount
        }
      }
    }
  }, [refresh])

  const clearUploadProgress = useCallback(() => setUploadProgress(null), [])

  const login = useCallback(
    async (input: LatticeLoginInput): Promise<LatticeLoginResult> => {
      const bridge = getLatticeBridge()
      if (!bridge) return { ok: false, error: LATTICE_BRIDGE_MISSING }
      try {
        const result = await bridge.login(input)
        if (result?.ok) await refresh()
        return result ?? { ok: false, error: LATTICE_BRIDGE_MISSING }
      } catch (error) {
        return { ok: false, error: latticeErrorMessage(error) }
      }
    },
    [refresh]
  )

  const logout = useCallback(async (): Promise<{ ok: boolean }> => {
    const bridge = getLatticeBridge()
    if (!bridge) return { ok: false }
    try {
      const result = await bridge.logout()
      setUploadProgress(null)
      await refresh()
      return result ?? { ok: true }
    } catch {
      return { ok: false }
    }
  }, [refresh])

  const sync = useCallback(
    async (
      direction: LatticeSyncDirection = 'both',
      options?: { installMissing?: boolean }
    ): Promise<LatticeSyncResult> => {
      const bridge = getLatticeBridge()
      if (!bridge) return emptySyncResult(LATTICE_BRIDGE_MISSING)
      setSyncing(true)
      try {
        const result = await bridge.sync({
          direction,
          ...(typeof options?.installMissing === 'boolean'
            ? { installMissing: options.installMissing }
            : {})
        })
        await refresh()
        return result ?? emptySyncResult()
      } catch (error) {
        const message = latticeErrorMessage(error)
        await refresh()
        return emptySyncResult(message)
      } finally {
        if (!disposedRef.current) setSyncing(false)
      }
    },
    [refresh]
  )

  /** Sync details: per-item auto-install failures and orphaned records (failures are never silent) */
  const fetchSyncDetails = useCallback(async (): Promise<LatticeSyncDetails> => {
    const bridge = getLatticeBridge()
    if (!bridge) return { last: null, conflicts: [], orphaned: [] }
    try {
      return (await bridge.syncDetails()) ?? { last: null, conflicts: [], orphaned: [] }
    } catch (error) {
      console.warn('[lattice] Failed to read sync details:', latticeErrorMessage(error))
      return { last: null, conflicts: [], orphaned: [] }
    }
  }, [])

  /** Persist the "auto-install missing plugins" toggle (the main process persists it and broadcasts status) */
  const saveAutoInstallMissing = useCallback(
    async (enabled: boolean): Promise<LatticeAutoInstallSettingResult> => {
      const bridge = getLatticeBridge()
      if (!bridge) return { ok: false, enabled: true, error: LATTICE_BRIDGE_MISSING }
      try {
        const result = await bridge.setAutoInstallMissing(enabled)
        if (result?.status) {
          if (!disposedRef.current) setStatus(normalizeStatus(result.status))
        } else {
          await refresh()
        }
        return result ?? { ok: false, enabled: true, error: LATTICE_BRIDGE_MISSING }
      } catch (error) {
        return { ok: false, enabled: true, error: latticeErrorMessage(error) }
      }
    },
    [refresh]
  )

  /**
   * Platform catalog. Without pagination params it **fetches every page** (the catalog page needs
   * the complete list: only the first page would mislabel published plugins beyond #100 as
   * "installed locally / not published", and search would not find them). When the caller passes
   * page/pageSize explicitly, return a single page as requested.
   */
  const listHub = useCallback(async (params?: LatticeListQuery): Promise<HubListResultV2> => {
    const bridge = getLatticeBridge()
    if (!bridge) return EMPTY_HUB_LIST
    const paged = params?.page !== undefined || params?.pageSize !== undefined
    const first = ((await bridge.list({ page: 1, pageSize: 100, ...params })) ??
      EMPTY_HUB_LIST) as HubListResultV2
    if (paged) return first
    const total = Number(first.total) || first.items.length
    const pageSize = Number(first.page_size) || 100
    if (first.items.length >= total || first.items.length === 0) return first
    const items = [...first.items]
    // Cap the page count so an abnormal server total (or non-converging paging) cannot loop forever
    const maxPages = Math.min(50, Math.ceil(total / Math.max(pageSize, 1)))
    for (let page = 2; page <= maxPages && items.length < total; page += 1) {
      const next = ((await bridge.list({ page, pageSize, ...params })) ??
        EMPTY_HUB_LIST) as HubListResultV2
      if (!next.items || next.items.length === 0) break
      items.push(...next.items)
    }
    return { ...first, items, total, page: 1, page_size: items.length }
  }, [])

  /**
   * Platform details. `null` = this plugin is not published to the platform (installed locally
   * only / deleted from the platform): the main process normalizes 404 to null, and the detail
   * page renders "not published yet" without producing error logs.
   */
  const detailHub = useCallback(async (pluginId: string): Promise<HubDetailV2 | null> => {
    const bridge = getLatticeBridge()
    if (!bridge) return null
    // v2 adds source fields to the version object; until main-process types land, fall back to a local all-optional type
    return (await bridge.detail(pluginId)) as HubDetailV2 | null
  }, [])

  const installFromHub = useCallback(
    async (pluginId: string, version?: string): Promise<LatticeInstallResultV2> => {
      const bridge = getLatticeBridge()
      if (!bridge) return { ok: false, error: LATTICE_BRIDGE_MISSING }
      try {
        return (
          ((await bridge.install(pluginId, version)) as LatticeInstallResultV2) ?? {
            ok: false,
            error: LATTICE_BRIDGE_MISSING
          }
        )
      } catch (error) {
        return { ok: false, error: latticeErrorMessage(error) }
      }
    },
    []
  )

  /** Publish a locally installed plugin directly (package + source): no directory picker */
  const publishInstalled = useCallback(async (pluginId: string): Promise<LatticeUploadResult> => {
    const bridge = getLatticeBridge()
    if (!bridge) return { ok: false, error: LATTICE_BRIDGE_MISSING }
    setUploadProgress(null)
    try {
      return (
        (await bridge.publishInstalled(pluginId)) ?? { ok: false, error: LATTICE_BRIDGE_MISSING }
      )
    } catch (error) {
      return { ok: false, error: latticeErrorMessage(error) }
    }
  }, [])

  const pickAndUpload = useCallback(async (): Promise<LatticeUploadResult> => {
    const bridge = getLatticeBridge()
    if (!bridge) return { ok: false, error: LATTICE_BRIDGE_MISSING }
    setUploadProgress(null)
    try {
      return (await bridge.pickAndUpload()) ?? { ok: false, error: LATTICE_BRIDGE_MISSING }
    } catch (error) {
      return { ok: false, error: latticeErrorMessage(error) }
    }
  }, [])

  const pickAndUploadZip = useCallback(async (): Promise<LatticeUploadResult> => {
    const bridge = getLatticeBridge()
    if (!bridge) return { ok: false, error: LATTICE_BRIDGE_MISSING }
    setUploadProgress(null)
    try {
      return (await bridge.pickAndUploadZip()) ?? { ok: false, error: LATTICE_BRIDGE_MISSING }
    } catch (error) {
      return { ok: false, error: latticeErrorMessage(error) }
    }
  }, [])

  /** Publish by picking "package directory + source directory": package and source upload separately */
  const pickAndUploadWithSource = useCallback(async (): Promise<LatticeUploadResult> => {
    const bridge = getLatticeBridge()
    if (!bridge) return { ok: false, error: LATTICE_BRIDGE_MISSING }
    setUploadProgress(null)
    try {
      return (
        (await bridge.pickAndUploadWithSource()) ?? { ok: false, error: LATTICE_BRIDGE_MISSING }
      )
    } catch (error) {
      return { ok: false, error: latticeErrorMessage(error) }
    }
  }, [])

  const uploadSource = useCallback(
    async (source: string, sourcePath?: string): Promise<LatticeUploadResult> => {
      const bridge = getLatticeBridge()
      if (!bridge) return { ok: false, error: LATTICE_BRIDGE_MISSING }
      setUploadProgress(null)
      try {
        return (
          (await bridge.uploadSource(source, sourcePath)) ?? {
            ok: false,
            error: LATTICE_BRIDGE_MISSING
          }
        )
      } catch (error) {
        return { ok: false, error: latticeErrorMessage(error) }
      }
    },
    []
  )

  // ---- v2 API ----

  const readSourcePath = useCallback(async (pluginId: string): Promise<LatticeSourcePathResult> => {
    const bridge = getLatticeV2Bridge()
    if (!bridge?.sourcePath) return { path: null }
    try {
      return (await bridge.sourcePath(pluginId)) ?? { path: null }
    } catch (error) {
      console.warn('[lattice] Failed to read source path:', latticeErrorMessage(error))
      return { path: null }
    }
  }, [])

  const localSource = useCallback(async (pluginId: string): Promise<string | null> => {
    const bridge = getLatticeV2Bridge()
    if (!bridge?.localSource) return null
    try {
      const result = await bridge.localSource(pluginId)
      if (typeof result === 'string') return result || null
      return result?.path ?? null
    } catch (error) {
      console.warn('[lattice] Failed to read local install directory:', latticeErrorMessage(error))
      return null
    }
  }, [])

  const openSource = useCallback(async (pluginId: string): Promise<LatticeOpenSourceResult> => {
    const bridge = getLatticeV2Bridge()
    if (!bridge?.openSource) return { ok: false, error: LATTICE_BRIDGE_MISSING }
    try {
      return (await bridge.openSource(pluginId)) ?? { ok: false, error: LATTICE_BRIDGE_MISSING }
    } catch (error) {
      return { ok: false, error: latticeErrorMessage(error) }
    }
  }, [])

  const republish = useCallback(
    async (input: LatticeRepublishInput): Promise<LatticeRepublishResult> => {
      const bridge = getLatticeV2Bridge()
      if (!bridge?.republish) return { ok: false, error: LATTICE_BRIDGE_MISSING }
      try {
        return (await bridge.republish(input)) ?? { ok: false, error: LATTICE_BRIDGE_MISSING }
      } catch (error) {
        return { ok: false, error: latticeErrorMessage(error) }
      }
    },
    []
  )

  const downloadAsset = useCallback(
    async (
      pluginId: string,
      version: string,
      kind: LatticeDownloadKind
    ): Promise<LatticeDownloadResult> => {
      const bridge = getLatticeV2Bridge()
      if (!bridge?.downloadAsset) return { ok: false, error: LATTICE_BRIDGE_MISSING }
      try {
        return (
          (await bridge.downloadAsset(pluginId, version, kind)) ?? {
            ok: false,
            error: LATTICE_BRIDGE_MISSING
          }
        )
      } catch (error) {
        return { ok: false, error: latticeErrorMessage(error) }
      }
    },
    []
  )

  const importLocalDir = useCallback(async (): Promise<LatticeImportLocalDirResult> => {
    const bridge = getLatticeV2Bridge()
    if (!bridge?.importLocalDir) return { ok: false, error: LATTICE_BRIDGE_MISSING }
    setUploadProgress(null)
    try {
      return (
        (await bridge.importLocalDir()) ?? {
          ok: false,
          error: LATTICE_BRIDGE_MISSING
        }
      )
    } catch (error) {
      return { ok: false, error: latticeErrorMessage(error) }
    }
  }, [])

  const value = useMemo<LatticeContextValue>(
    () => ({
      available,
      ready,
      status,
      loggedIn: status.loggedIn,
      user: status.user,
      role: status.role,
      avatar: status.user?.avatar ?? null,
      syncing,
      uploadProgress,
      clearUploadProgress,
      refresh,
      login,
      logout,
      sync,
      syncDetails: fetchSyncDetails,
      setAutoInstallMissing: saveAutoInstallMissing,
      listHub,
      detailHub,
      installFromHub,
      publishInstalled,
      pickAndUpload,
      pickAndUploadZip,
      pickAndUploadWithSource,
      uploadSource,
      capabilities,
      sourcePath: readSourcePath,
      localSource,
      openSource,
      republish,
      downloadAsset,
      importLocalDir
    }),
    [
      available,
      ready,
      status,
      syncing,
      uploadProgress,
      clearUploadProgress,
      refresh,
      login,
      logout,
      sync,
      fetchSyncDetails,
      saveAutoInstallMissing,
      listHub,
      detailHub,
      installFromHub,
      publishInstalled,
      pickAndUpload,
      pickAndUploadZip,
      pickAndUploadWithSource,
      uploadSource,
      capabilities,
      readSourcePath,
      localSource,
      openSource,
      republish,
      downloadAsset,
      importLocalDir
    ]
  )

  return <LatticeContext.Provider value={value}>{children}</LatticeContext.Provider>
}
