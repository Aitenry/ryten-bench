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
 * 插件中心 Provider：把 `window.api.lattice` 的状态与事件收敛成一份 React 状态。
 *
 * 职责：
 * - 启动时读一次 `lattice:status`，并订阅 `lattice:state-changed` / `lattice:sync-state` /
 *   `lattice:upload-progress` 三个推送；
 * - 把每个 IPC 方法包一层（登录/退出/同步后自动刷新状态）；
 * - 主进程通道尚未注册时不崩：`available=false`，所有方法返回「不可用」的兜底结果；
 * - 契约 v2 的源码/发布/导入方法同样包一层，并附带**能力探测**（旧主进程上这些方法是
 *   undefined，页面按 `capabilities` 禁用入口，而不是运行期 `not a function`）。
 *
 * 约定：Provider 只持有状态，不做路由跳转、不弹提示；这些交给页面组件。
 * 上下文对象在 `LatticeContextCore.ts`（react-refresh 要求组件文件只导出组件）。
 */
function normalizeStatus(next: LatticeStatus | null | undefined): LatticeStatus {
  if (!next) return EMPTY_LATTICE_STATUS
  const rawUser = next.user
  /**
   * `user.avatar` 兜底：旧主进程的 status 里没有这个字段（undefined）→ null；
   * 平台明确返回空串/空白 → 同样按无头像处理。不合法地址由展示层
   * `normalizeAvatarSrc()` 再挡一层并回退首字母。
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
   * v2 能力探测：preload 暴露的方法在应用生命周期内不变，初始化时算一次即可。
   * 旧主进程上 `sourcePath/openSource/republish/...` 都是 undefined → 入口禁用。
   */
  const [capabilities] = useState(() => detectLatticeV2Capabilities())
  /** 卸载后不再 setState（异步 status 读取 / 事件推送都可能晚于卸载） */
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
    /** 订阅失败的推送通道不阻塞其它通道（主进程可能只实现了一部分事件） */
    const safeSubscribe = (subscribe: () => unknown): void => {
      try {
        const dispose = subscribe()
        if (typeof dispose === 'function') unsubscribers.push(dispose as () => void)
      } catch {
        // 单个事件通道不可用时忽略
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
        // 事件载荷是完整的同步结果（含 autoInstall 明细/孤儿记录数组）；状态条只存摘要计数
        setStatus((prev) => ({
          ...prev,
          sync: {
            at: snapshot.at,
            pushed: snapshot.pushed,
            pulled: snapshot.pulled,
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
          // 退订失败不影响卸载
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

  /** 同步详情：自动补齐失败/孤儿记录明细（失败原因不静默） */
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

  /** 保存「缺失插件自动补齐」开关（主进程持久化并广播状态） */
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

  const listHub = useCallback(async (params?: LatticeListQuery): Promise<HubListResultV2> => {
    const bridge = getLatticeBridge()
    if (!bridge) return EMPTY_HUB_LIST
    return ((await bridge.list({ page: 1, pageSize: 100, ...params })) ??
      EMPTY_HUB_LIST) as HubListResultV2
  }, [])

  const detailHub = useCallback(async (pluginId: string): Promise<HubDetailV2> => {
    const bridge = getLatticeBridge()
    if (!bridge) throw new Error(LATTICE_BRIDGE_MISSING)
    // 契约 v2 在版本对象上补源码字段；主进程类型未合入前按局部类型（全 optional）兜底
    return (await bridge.detail(pluginId)) as HubDetailV2
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

  const uploadSource = useCallback(async (source: string): Promise<LatticeUploadResult> => {
    const bridge = getLatticeBridge()
    if (!bridge) return { ok: false, error: LATTICE_BRIDGE_MISSING }
    setUploadProgress(null)
    try {
      return (await bridge.uploadSource(source)) ?? { ok: false, error: LATTICE_BRIDGE_MISSING }
    } catch (error) {
      return { ok: false, error: latticeErrorMessage(error) }
    }
  }, [])

  // ---- 契约 v2 ----

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
      pickAndUpload,
      pickAndUploadZip,
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
      pickAndUpload,
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
