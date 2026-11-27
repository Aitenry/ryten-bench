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
 * 平台目录的会话内快照（按「账号 + 基址」记账）。
 *
 * 为什么要留一份：每次进插件仓库都会重新拉目录，请求回来之前页面只能铺骨架；
 * 在「对话 ↔ 插件仓库」之间来回切时，同一个人每次都要看一眼占位再看到卡片，
 * 观感上就是加载闪屏（用户 2026-11-25）。
 *
 * 命中时先用上一份目录把网格铺满，再在后台刷新；账号 / 基址变了不命中——
 * 那是另一套安装记录，把 A 的「已安装」画到 B 的目录上是错的。
 */
let hubSnapshot: { account: string; list: HubListResultV2 } | null = null

/**
 * 插件仓库（系统页面 `/plugins`）。
 *
 * 本页**只有平台一个远程来源**：
 * - 目录来自 `lattice.list`（搜索/分类在本地过滤），没有第二个数据源；
 * - 安装、更新、发布、源码下载都走 `lattice.*` 通道；
 * - 发布相关的入口收进顶栏「发布」下拉（用户 2026-11-23：按钮太多、功能相似）：
 *   发布插件目录 / 发布 .zip / 发布安装包+源码目录 / 导入本地插件目录；
 *   「从本地安装」（本机 zip/目录装进应用）是另一类动作，单独保留。
 *
 * 卡片按契约 v2 显示：版本 / 作者 / 描述 / tags / 下载数 / 已安装・可更新 / 源码标记；
 * 操作：安装、更新、打开源码（已安装且有源码）。本机已安装但未发布到平台的插件与目录卡片
 * 排在**同一张网格**里（用户 2026-11-23：「本地的和线上的不要分开显示，合并」），
 * 保证「发布到插件中心」这条入口可达。
 */
const PluginRepository: React.FC = () => {
  const { token } = theme.useToken()
  const { message } = App.useApp()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const descriptors = usePlugins()

  /**
   * 插件中心真实登录态。未登录 / 主进程通道未就绪时这里会安全降级，
   * 页面展示对应的行动卡（登录后才有目录）。
   */
  const {
    available: latticeReady,
    /** 登录态是否已经读回来过：没有它就只能先铺骨架，不能按「未登录」渲染 */
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

  /** 目录快照的归属：同一账号 + 同一基址才算命中（换号 / 换平台不命中） */
  const hubAccount = latticeStatus.user?.id
    ? `${latticeStatus.baseUrl}#${latticeStatus.user.id}`
    : ''

  const [entries, setEntries] = useState<PluginListEntry[]>([])
  /**
   * 本机**真的存在源码**的插件 id 集合。
   *
   * 不能用平台目录的 `has_source` 代替：它说的是「最新版本带源码包」，而本机装的可能
   * 是旧版本、或安装时源码下载失败（源码只落在安装包目录）。只看它会渲染出一个
   * 「源码」按钮，点下去却只能打开安装包所在的资源管理器窗口（用户 2026-11-25）。
   */
  const [localSourceIds, setLocalSourceIds] = useState<Set<string>>(() => new Set())
  /**
   * 本机清单是否已经回来过一次。
   *
   * 未登录时登录提示有两种形态（下方有本机卡片 → 紧凑提示条；整页只有登录这一件事 → 居中引导）。
   * 清单没回来之前 `entries` 还是空数组，直接按「没有本机插件」渲染会让整块引导先闪一下再塌成一条。
   */
  const [localLoaded, setLocalLoaded] = useState(false)
  /**
   * 本机清单是否**成功**读到过一次。
   *
   * `localLoaded` 只表示「请求已经结束」（未登录时的引导形态要靠它避免闪屏）；
   * 卡片判断「已安装 / 已启用」时用这个：只有真的读到了本机清单，才敢用
   * 「不在清单里 = 未安装」覆盖平台字段；读取失败时退回平台视图，而不是把
   * 所有插件都误报成未安装。
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
   * 平台目录（服务端全量拉一次，搜索/分类在本地过滤，输入即响应）。
   * 命中会话快照时直接铺满，后台刷新由下面的 effect 负责。
   */
  const [hub, setHub] = useState<HubListResultV2 | null>(() =>
    hubSnapshot && hubSnapshot.account === hubAccount ? hubSnapshot.list : null
  )
  const [hubLoading, setHubLoading] = useState(false)
  const [hubError, setHubError] = useState<string | null>(null)
  const [hubCategory, setHubCategory] = useState('all')
  const [uploadOpen, setUploadOpen] = useState(false)
  /** 未解决的插件数据冲突（同步弹窗里逐条让用户选「用本机/用云端」） */
  const [conflictOpen, setConflictOpen] = useState(false)
  const [conflicts, setConflicts] = useState<LatticeSyncConflict[]>([])
  const [conflictLoading, setConflictLoading] = useState(false)
  const [conflictBusy, setConflictBusy] = useState<string | null>(null)
  const [mergeBusy, setMergeBusy] = useState(false)
  /** 「更新全部」批量升级进行中（逐个安装，失败不中断） */
  const [bulkUpdating, setBulkUpdating] = useState(false)

  /**
   * 「同步详情」弹窗：自动补齐成功/失败明细 + 平台已删除（orphaned）的安装记录 + 数据冲突。
   * 自动补齐失败**不静默**：同步条上一直有「N 个自动补齐失败（可查看原因）」入口。
   */
  const [syncDetailsOpen, setSyncDetailsOpen] = useState(false)
  const [syncDetailsData, setSyncDetailsData] = useState<LatticeSyncDetails | null>(null)
  const [syncDetailsLoading, setSyncDetailsLoading] = useState(false)
  const [autoInstallSaving, setAutoInstallSaving] = useState(false)

  /**
   * 插件工坊（弹窗）：草稿/构建/验收/安装。入口收成图标按钮，
   * 与「上传/本地安装」这些高频动作不抢位置。
   */
  const [workshopOpen, setWorkshopOpen] = useState(false)
  const [workshopDraftPending, setWorkshopDraftPending] = useState<string | null>(null)
  const [settingsPlugin, setSettingsPlugin] = useState<{ id: string; name: string } | null>(null)
  const allSettingsSections = usePluginSettingsSections()
  const sectionsOf = useCallback(
    (id: string) => allSettingsSections.filter((s) => s.pluginId === id),
    [allSettingsSections]
  )

  /** 本机安装清单（已安装/启用态、版本） */
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

  /** 逐个问主进程「这个插件本机有没有源码」（数量很少，装/卸后随 entries 重算） */
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
      // 只缓存有归属的目录（未登录 / 账号信息缺失时不缓存，免得把匿名视图留给下一个人）
      if (hubAccount) hubSnapshot = { account: hubAccount, list: result }
    } catch (err) {
      // 刷新失败不要清掉已经拿到的目录：一次网络抖动 / 插件状态广播触发的后台刷新失败，
      // 会把整页目录、分类与搜索上下文一起抹掉（用户什么也没做，页面却变成「加载失败」）。
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

  /** 冲突列表：同步摘要出现 conflicts 时补拉一次（含云端数据快照） */
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

  /** 显式解决一个冲突：local=用本机覆盖云端；cloud=用云端覆盖本机 */
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
   * 侧栏（Harness 路由）点插件行 → 请求「导航到 /plugins 并打开插件工坊、展开这份插件」。
   * 请求由模块级快照暂存（导航前派发的事件本页收不到），本页挂载或已挂载时都能取到。
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

  /** 工坊弹窗打开且指定了草稿：等 `WorkshopSettings` 挂载后再派发展开事件（它自己订阅） */
  useEffect(() => {
    if (!workshopOpen || !workshopDraftPending) return
    const id = workshopDraftPending
    const timer = window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('workshop-open-draft', { detail: { id } }))
      setWorkshopDraftPending(null)
    }, 80)
    return () => window.clearTimeout(timer)
  }, [workshopOpen, workshopDraftPending])

  /** 平台目录：登录后加载，并跟随插件启停/安装广播刷新（安装后 installed/update_available 会变） */
  useEffect(() => {
    if (!latticeReady || !loggedIn) {
      /**
       * 退出登录后不能留着上一个账号的目录快照：它是按账号算的安装态，且会把
       * 本机已装插件误判成「平台上已有」（localOnly 过滤掉它们）→ 访客态看不到本机插件。
       * 等重新登录后由下面的分支重新拉。
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
   * 目录条目在本机是否真有更新：**以本机已装版本**与平台最新版比对。
   *
   * 不用平台的 `update_available`：它是按账号安装记录算的，本机卸载/降级后要等同步才更新，
   * 会出现「本机没装却提示可更新」「仓库有更新但详情页没有」这类不一致。
   *
   * 比的是**版本优先级**而不是字符串不等：本机 v0.4.1、中心最新 v0.3.0 时字符串不等，
   * 但那不是「有更新」，而是「本机更新」（2026-11-23 用户反馈）；按 semver 比才不会再
   * 给用户一个「更新到 v0.3.0」的降级按钮。
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

  /** 搜索/分类在本地过滤（目录已整页拉回），输入即时响应，不再逐字打服务端 */
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
   * 已装但平台上没有的插件（本地上传装的）。
   *
   * 展示上不再单独成组（用户 2026-11-23：「本地的和线上的不要分开显示，合并」）：
   * 它们和目录卡片排在同一张网格里，只是详情页/发布入口要保证可达。
   */
  const localOnlyAll = useMemo(() => {
    const hubIds = new Set(hubItems.map((item) => item.plugin_id))
    return entries
      .filter((entry) => !hubIds.has(entry.id))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [entries, hubItems])

  /** 上面这组再按搜索词过滤（登录提示的形态只看未过滤的 localOnlyAll） */
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
   * 网格里实际出现的本机插件。
   *
   * 选了平台分类时它们不出现：本机插件没有登记到目录的分类里，跟着任何分类显示都算错配
   * （合并成一张网格后尤其明显）；搜索框仍然能搜到它们，清掉分类就回来。
   */
  const visibleLocal = hubCategory === 'all' ? localOnly : []

  /** 顶栏「上传插件」：选插件包目录 → 主进程打包上传（安装包 + 源码） */
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

  /** 顶栏 zip 入口：选 .zip 安装包发布（同样支持 readme/清单解析与源码包上传的既有流水线） */
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
   * 顶栏「连同源码目录发布」：先选构建产物目录（安装包），再选源码目录。
   *
   * 安装包与源码是两份不同的 zip：仓库类插件 dist/<id>/ 是产物、plugins/<id>/ 是源码，
   * 平台「源代码」下载到的才是真正的源码，而不是安装包本身。
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

  /** 顶栏「从本地安装」：选 zip / 目录装进应用（不发布） */
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
   * 顶栏「导入本地插件目录」：主进程弹目录选择框，把目录下所有含 plugin.json 的插件
   * 批量发布到平台（安装包 + 源码）。路径由用户选，渲染层不硬编码任何目录。
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

  /** 卡片主操作：安装（未装）/ 更新（可更新）；安装时主进程会自动下载并解压源码 */
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
   * 「更新全部」：把当前所有 `update_available && installed` 的插件逐个升到最新版。
   * 失败不中断后续插件（单个失败很常见：网络/源码包），最后汇总成功/失败数量。
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
   * 卡片「打开源码」：主进程优先建/复用工作区并开一条插件会话；
   * 只能回退到文件管理器时如实提示（不假装开了对话）。
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
        setOpenBusy(null)
      }
    },
    [capabilities.openSource, message, navigate, openSource, t]
  )

  /**
   * 打开「同步详情」：拉最近一次同步的自动补齐失败/孤儿记录明细。
   * 失败原因、孤儿记录都在这里逐条可见（不在同步时静默吞掉）。
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
   * 「缺失插件自动补齐」开关（默认开启）。
   * 关闭后 pull 只把缺失插件放进 `pending` 列表，不再自动安装；已标记的孤儿记录仍保留。
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
      // 有失败：明确提示数量并打开详情（失败原因可查看，不静默）
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
   * 合并云端数据：逐插件按 merge base 做 git 式快进 / 冲突。
   *
   * 提示和「同步完成」同构（用户 2026-11-25：「要和同步一样的简化提示」）：
   * - 本机改过、云端没动 → 推上去（删除/修改不会被回填）；
   * - 云端更新、本机没动 → 拉下来；
   * - 两边都改过 → 记冲突，提示用户去「解决冲突」显式选择（不再自动并集）。
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
        // 前置失败（未登录 / 账号数据尚未就绪）：原因直接给用户，不进三态
        message.error(result.error || t('sync.error', { reason: '' }))
        return
      }
      if (conflicts > 0) {
        message.warning(t('sync.merge.conflicts', { merged, rows, conflicts }))
      } else if (blocked > 0 && blocked === failed) {
        // 全是「还没建立合并基线」：提示先同步一次，比笼统的「合并失败」可执行
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
   * 顶栏「发布」下拉菜单（用户 2026-11-23：「按键太多，很多都是功能相似的」）。
   *
   * 发布插件目录 / 发布 .zip / 发布安装包+源码 / 导入本地插件目录，本质都是
   * 「把本机的一个插件包/目录发到插件中心」，收进一个菜单后顶栏只剩：
   * 工坊、本地安装、发布、刷新（+ 有更新时的「更新全部」）。
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
   * 页面级 CSS 变量：把 antd token 下发到 main.css 里的 `.lattice-*` 类，
   * 亮/暗主题切换时卡片、同步条一起换色，不在组件里写死颜色。
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
   * 平台目录处于状态卡（未就绪 / 未登录 / 加载中 / 失败 / 空）时的本机插件兜底。
   *
   * 本机插件不依赖平台目录，任何时候都得能管理：状态卡照常显示，本机卡片接在下面。
   * 目录可用时不再走这里——本机卡片直接排在目录卡片后面，是同一张网格。
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
   * 卡片点击 → 详情页，但**忽略来自按钮/输入控件的冒泡**。
   *
   * antd 的 Button 在 `loading` 时会在内部 handler 里直接 return（连我们的
   * `e.stopPropagation()` 都不执行）：双击「安装」的第二下被按钮吞掉、继续冒泡到卡片，
   * 结果安装还在跑，人却被带到了详情页。按事件目标判断比依赖 stopPropagation 稳。
   */
  const handleCardNavigate =
    (pluginId: string) =>
    (event: React.MouseEvent<HTMLDivElement>): void => {
      const target = event.target as HTMLElement | null
      if (target?.closest('button, a, input, textarea, select, [role="button"]')) return
      navigate(`/plugins/${pluginId}`)
    }

  /**
   * 平台目录内容区状态：首屏骨架 / 未就绪 / 未登录 / 加载中 / 失败 / 空 / 卡片网格。
   *
   * 所有加载态都用**与真实卡片同尺寸的骨架网格**占住卡片最终要出现的位置：
   * 旧版用「居中转圈 + 240px 占位块」，本机卡片排在它下面，目录一回来占位块消失，
   * 同一批卡片整组向上跳——用户 2026-11-25 反馈的「一开始插件在下面，突然移动上去」。
   */
  const renderHubContent = (): React.ReactNode => {
    // 桥接 / 登录态还没定下来：先铺骨架。不要先画「不可用」大状态卡，
    // 它下一帧就会被换成真实内容，整页跟着塌一次。
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
      // 本机清单没回来之前不画：否则会先按「没有本机插件」铺一块引导，再塌成一条提示
      if (!localLoaded) return <HubGridSkeleton />
      const goLogin = (): void => {
        void navigate('/login')
      }
      // 下方还有本机插件卡片时，登录只是目录不可用的说明 → 一条提示；
      // 整页只剩登录这一件事时才铺开成居中引导。
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
     * 目录还没回来（登录后第一次拉取 / 刚切进本页）。
     *
     * 这里**必须**先不画本机卡片：目录为空时 `localOnlyAll` 等于本机全部已装插件，
     * 它们会先按「本机插件」排在占位块下面；目录一到，同一批插件被认成目录卡片，
     * 整组挪到网格顶部，就是那次向上跳。骨架占住最终位置，回来时原地换成真实卡片。
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
           * 本机视角优先（用户 2026-11-23）：
           * 「已安装 / 已启用 / 可更新」一律以**本机插件清单**为准。平台目录里的
           * `installed` 是按账号保存的安装记录视图，本机卸载后要等下一次 push 才变；
           * 直接拿它渲染就会出现「仓库卡片说已安装、点进详情说未安装」的自相矛盾。
           * 本机清单还没回来时才退回平台字段，避免首帧闪一下。
           */
          const installed = localTrusted
            ? Boolean(localEntry)
            : Boolean(localEntry || item.installed)
          const hubEnabled = installed && Boolean(localEntry?.enabled)
          const localVersion = localEntry ? localEntry.version : undefined
          const hasSource = Boolean(item.has_source)
          const hasLocalSource = localSourceIds.has(item.plugin_id)
          // 可更新 = 中心最新版**严格新于**本机版本（不是「版本号字符串不相等」）
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
           * 描述按「这张卡片代表谁」取（2026-11-23 用户反馈「描述不正确」）：
           * 卡片显示的是本机已装版本（版本号取 local），描述也必须取本机那份——
           * 否则会拿插件中心**旧版本**的描述配本机版本号，两边对不上。
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
           * 「源码」按钮：本机有源码就直接开工作区；没有源码但已登录且平台说明有源码时，
           * 允许点一次（主进程会按本机安装的版本按需下载），不再出现「点了只弹资源管理器」。
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
        {/* 本机已装、平台上还没有的插件：同一张网格里接着排（不是另一组） */}
        {renderLocalCards()}
      </div>
    )
  }

  /**
   * 本机已安装但未发布到平台的插件（本地安装包）：保证详情页与「发布到插件中心」可达。
   *
   * 和平台目录的卡片**排在同一张网格**里（用户 2026-11-23：「本地的和线上的不要分开显示，合并」）：
   * 不再单独铺一张网格，也不单起分组标题（用户 2026-11-22：「不需要这个内容」）。
   * 外面这层 `display: contents` 不参与布局，卡片本身就是调用方网格的网格项——
   * 所以本机插件不会另起一行，而是紧接在目录卡片后面按同列宽、同间距排下去。
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

  /** 同步状态条：最近同步 / 自动补齐结果 / 冲突数 / 自动补齐开关 / 手动同步（已登录时出现） */
  const renderSyncBar = (): React.ReactNode => {
    const syncSnapshot = latticeStatus.sync
    const conflictCount = syncSnapshot?.conflicts ?? 0
    const lastSyncTime = formatSyncTime(syncSnapshot?.at)
    const autoInstalled = syncSnapshot?.autoInstalled ?? 0
    const autoFailed = syncSnapshot?.autoInstallFailed ?? 0
    const orphanedCount = syncSnapshot?.orphaned ?? 0
    const pushedRows = syncSnapshot?.pushedRows ?? 0
    const pulledRows = syncSnapshot?.pulledRows ?? 0
    // 主进程缺省/旧主进程时按默认「开启」展示（与主进程 getLatticeAutoInstallMissing 默认一致）
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
        {/* PL-18：换机自动补齐结果（失败不静默，可点开同步详情看原因） */}
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
  /** 有更新的已安装插件数（顶栏「更新全部」入口；0 时隐藏；口径同卡片：本机已装 + 版本不同） */
  const updatableCount = (hub?.items ?? []).filter((item) => hasLocalUpdate(item)).length

  /** 冲突弹窗里的数据预览：只展示前 240 字符，避免 256KiB JSON 撑爆弹窗 */
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
        /* 顶部不留白：首行仍与侧栏品牌区同线；左右下留 12px，与资料库一致 */
        padding: '6px 9px',
        background: token.colorBgContainer,
        borderTopLeftRadius: token.borderRadiusLG,
        ...pageVars
      }}
    >
      {/* 内容排满页面；首行仍是与品牌区同高的工具条 */}
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

      {/* 上传进度（发布到插件中心）：进度来自 lattice:upload-progress 推送 */}
      <UploadProgressModal open={uploadOpen} />

      {/* 同步详情：自动补齐成功/失败明细 + 平台已删除（orphaned）记录 + 数据冲突（失败原因不静默） */}
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
                  {/* 自动补齐 */}
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

                  {/* 平台已删除的安装记录（orphaned） */}
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

                  {/* 数据冲突：与同步条「解决冲突」同一个弹窗 */}
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

      {/* 插件数据冲突：逐条让用户显式选择「用本机 / 用云端」（不自动覆盖） */}
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

      {/* 插件工坊（弹窗）：草稿列表 + 构建/验收/安装 */}
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
 * 目录首屏的骨架卡片网格。
 *
 * 卡片外形直接复用 `.lattice-hub-card`（同圆角/描边/底色/最小高度），内部只换成
 * 灰色骨架块：占位与真实卡片同尺寸、同网格列宽，目录回来时是「原地填充」，
 * 页面不会因为占位块消失而整体上移（用户 2026-11-25 的闪屏）。
 * 块宽按固定 pattern 递变——用随机数会让每次渲染都在抖。
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
 * 未登录时的插件中心提示条。
 *
 * 本机安装的插件不依赖账号，页面下方照常有卡片；之前这里用整页空态（52px 大图标 +
 * 虚线大卡片）压在卡片上面，既像报错又抢走了真正能点的内容的视觉重量。
 * 现在收成和同步状态条同量级的一条：一行标题 + 一行说明 + 右侧「去登录」。
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
 * 未登录且本机没有插件时的登录引导：整页只有登录这一件事可做，才铺开成居中引导。
 * 不画边框/底色——和上面的提示条不会同时出现，也不假装这里还有别的内容。
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
 * 插件中心内容区的状态卡（未就绪 / 加载失败共用）。
 *
 * 视觉与插件仓库其它空态一致：大图标 + 标题 + 说明 + 可选行动按钮。
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
