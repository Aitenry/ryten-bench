import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { LlmProviderInput, LlmProviderConfig } from '../main/database/mapper/provider'
import type { SystemSettings } from '../main/types/settings'
import type { PluginListEntry } from '../shared/plugin/types'
import { PLUGIN_CHANNEL_RE } from '../shared/plugin/protocol'
import { LATTICE_IPC } from '../main/lattice/types'
import type {
  HubDetail,
  HubListResult,
  LatticeAutoInstallSettingResult,
  LatticeDownloadAssetKind,
  LatticeDownloadAssetResult,
  LatticeImportLocalDirResult,
  LatticeInstallResult,
  LatticeInstallSummary,
  LatticeListQuery,
  LatticeLocalSourcePathResult,
  LatticeLoginInput,
  LatticeLoginResult,
  LatticeMeResult,
  LatticeOpenSourceResult,
  LatticeRepublishInput,
  LatticeRepublishResult,
  LatticeSetBaseUrlResult,
  LatticeSetPluginRootResult,
  LatticeSourcePathResult,
  LatticeStatus,
  LatticeSyncDetails,
  LatticeSyncInput,
  LatticeSyncResult,
  LatticeSyncConflict,
  LatticeResolveConflictResult,
  LatticeMergeDataResult,
  LatticeUploadProgress,
  LatticeUploadResult
} from '../main/lattice/types'

/**
 * 系统级功能通道的允许前缀。
 *
 * 这些通道属于随应用编译进来的功能，不是可装卸代码，因此不需要“已启用通道白名单”；
 * 但仍然在 preload 侧卡前缀，保证第三方插件（只有 `window.api.plugin`）够不到它们。
 */
const SYSTEM_CHANNEL_RE = /^(harness|notes):[a-z0-9-]+$/

/**
 * 已启用插件通道白名单缓存（主进程权威注册表 + plugin-channels-updated 推送刷新）。
 * 仅作 preload 侧快速门控：真正权威校验在主进程（通道归属插件且插件已启用）。
 */
const enabledPluginChannels = new Set<string>()
const applyPluginChannels = (list: unknown): void => {
  enabledPluginChannels.clear()
  if (Array.isArray(list)) {
    for (const channel of list) {
      if (typeof channel === 'string') enabledPluginChannels.add(channel)
    }
  }
}

ipcRenderer.on('plugin-channels-updated', (_event, list: unknown) => {
  applyPluginChannels(list)
})

// 启动竞态修复：推送（含 did-finish-load 补推）晚于渲染层首帧，插件 Provider 在
// useEffect 里订阅事件通道时会撞上「白名单还没到」。preload 先于页面脚本执行，
// 这里同步取一次权威清单，保证首个 window.api.plugin.on(...) 就能拿到正确结果。
try {
  applyPluginChannels(ipcRenderer.sendSync('plugin-channels-sync'))
} catch {
  // 主进程入口尚未注册（异常启动路径）：退回纯推送模式
}

interface WeatherData {
  location: string
  current: {
    temp: string
    weatherCode: number
    weatherDesc: string
    windSpeed: string
    humidity: number
    apparentTemp: string
  }
  daily: {
    label: string
    weatherDesc: string
    tempMax: string
    tempMin: string
    precipProb: number
  }[]
}

// Custom APIs for renderer
// 系统功能（AI 助手 / 资料库）走 `api.system`（普通 harness:* / notes:* 通道）；
// 第三方插件走通用桥 `api.plugin.invoke/on`（通道 plugin:<命名空间>:*，
// 白名单由主进程推送）。这里只放 core 的外壳能力。
const api = {
  file: {
    selectImageFile: (allowImages?: boolean) =>
      ipcRenderer.invoke('select-image-file', allowImages),
    selectTextFile: () =>
      ipcRenderer.invoke('select-text-file') as Promise<{
        fileName: string
        filePath: string
      } | null>,
    // 取剪贴板/拖拽 File 的真实磁盘路径；无对应磁盘文件（如从网页复制的图片）返回空串
    getPathForFile: (file: File) => {
      try {
        return webUtils.getPathForFile(file)
      } catch {
        return ''
      }
    }
  },
  lock: {
    /** 主进程持有的锁屏快照（摘要永不下发） */
    getState: () => ipcRenderer.invoke('lock-screen-state'),
    /** 手动锁屏（Esc）；未启用 / 没有解锁码时主进程不会锁 */
    lock: () => ipcRenderer.invoke('lock-screen-lock'),
    /** 解锁：校验在主进程完成（加盐 scrypt + 退避） */
    unlock: (code: string) => ipcRenderer.invoke('lock-screen-unlock', code),
    /** 开关 / 自动锁屏时长（落盘也在主进程） */
    configure: (patch: { enabled?: boolean; autoLockMinutes?: number }) =>
      ipcRenderer.invoke('lock-screen-configure', patch),
    /** 改码：原密码在主进程校验，成功后才写新摘要 */
    changeCode: (oldCode: string, newCode: string) =>
      ipcRenderer.invoke('lock-screen-change-code', oldCode, newCode),
    /** 锁屏状态推送（自动锁屏 / 手动锁 / 解锁；返回取消订阅函数） */
    onChanged: (callback: (state: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, state: unknown): void => {
        callback(state)
      }
      ipcRenderer.on('lock-screen-changed', listener)
      return () => {
        ipcRenderer.removeListener('lock-screen-changed', listener)
      }
    }
  },
  providers: {
    getAll: () => ipcRenderer.invoke('provider-get-all') as Promise<LlmProviderConfig[]>,
    getById: (id: number) =>
      ipcRenderer.invoke('provider-get-by-id', id) as Promise<LlmProviderConfig | null>,
    getDefault: () =>
      ipcRenderer.invoke('provider-get-default') as Promise<LlmProviderConfig | null>,
    getEnabled: () => ipcRenderer.invoke('provider-get-enabled') as Promise<LlmProviderConfig[]>,
    create: (input: LlmProviderInput) =>
      ipcRenderer.invoke('provider-create', input) as Promise<number>,
    createBatch: (inputs: LlmProviderInput[]) =>
      ipcRenderer.invoke('provider-create-batch', inputs) as Promise<{
        created: number
        skipped: number
      }>,
    update: (id: number, updates: Partial<LlmProviderInput>) =>
      ipcRenderer.invoke('provider-update', id, updates) as Promise<boolean>,
    delete: (id: number) => ipcRenderer.invoke('provider-delete', id) as Promise<boolean>,
    deleteBatch: (ids: number[]) =>
      ipcRenderer.invoke('provider-delete-batch', ids) as Promise<number>,
    setDefault: (id: number) => ipcRenderer.invoke('provider-set-default', id) as Promise<boolean>,
    lookupProfile: (modelId: string) =>
      ipcRenderer.invoke('provider-lookup-profile', modelId) as Promise<Record<
        string,
        unknown
      > | null>,
    fetchModels: (
      providerType: string,
      baseUrl?: string,
      apiKey?: string
    ): Promise<{ id: string; metadata: Record<string, unknown> | null }[]> =>
      ipcRenderer.invoke('provider-fetch-models', providerType, baseUrl, apiKey),
    onChanged: (callback: () => void) => {
      const handler = (): void => callback()
      ipcRenderer.on('providers-changed', handler)
      return () => {
        ipcRenderer.off('providers-changed', handler)
      }
    }
  },
  systemSettings: {
    getAll: () => ipcRenderer.invoke('system-settings-get-all') as Promise<SystemSettings>,
    update: (updates: Partial<SystemSettings>) =>
      ipcRenderer.invoke('system-settings-update', updates) as Promise<boolean>
  },
  window: {
    minimize: () => ipcRenderer.send('window-minimize'),
    maximize: () => ipcRenderer.send('window-maximize'),
    close: () => ipcRenderer.send('window-close'),
    isMaximized: () => ipcRenderer.invoke('window-is-maximized') as Promise<boolean>,
    onMaximized: (callback: (maximized: boolean) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, maximized: boolean): void => {
        callback(maximized)
      }
      ipcRenderer.on('window-maximized', handler)
      return () => {
        ipcRenderer.off('window-maximized', handler)
      }
    },
    /**
     * 自绘标题栏与系统窗口按钮覆盖层（Window Controls Overlay）的主题同步。
     * 只影响系统绘制按钮的配色与标题栏底色，不改变按钮行为。
     */
    setTitleBarOverlay: (options: { color?: string; symbolColor?: string; height?: number }) => {
      ipcRenderer.send('window-titlebar-overlay', options)
    },
    /** 让系统窗口边框/标题栏明暗跟随应用主题（亮色应用顶部不再残留深色 DWM 边框） */
    setNativeTheme: (mode: 'light' | 'dark' | 'system') => {
      ipcRenderer.send('window-native-theme', mode)
    },
    /** 设置窗口标题（原生标题栏：内容 - RytenBench） */
    setTitle: (title: string) => ipcRenderer.send('window-set-title', title),
    /** 重新加载当前窗口（标题栏「应用 → 重新加载」） */
    reload: () => ipcRenderer.send('window-reload'),
    /** 退出应用（标题栏「应用 → 退出」；走正常退出清理，不是隐藏到托盘） */
    quit: () => ipcRenderer.send('app-quit'),
    /** 编辑命令（标题栏「编辑」菜单）：交给主进程调用 webContents 的原生编辑动作 */
    edit: (command: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll') => {
      ipcRenderer.send('window-edit-command', command)
    }
  },
  /** 当前平台（渲染层据此决定是否绘制自绘标题栏、是否给 macOS 交通灯留位） */
  platform: process.platform as NodeJS.Platform,
  mermaid: {
    preview: (svg: string) => ipcRenderer.invoke('mermaid-preview', svg) as Promise<void>
  },
  weather: {
    getCurrent: (force?: boolean) =>
      ipcRenderer.invoke('weather-get', force) as Promise<WeatherData>,
    onUpdate: (callback: (data: WeatherData) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: WeatherData): void => callback(data)
      ipcRenderer.on('weather-update', handler)
      return () => {
        ipcRenderer.off('weather-update', handler)
      }
    }
  },
  /** 系统级功能（AI 助手 / 资料库）的通道桥：普通 `harness:*` / `notes:*`，不经插件宿主 */
  system: {
    /** 调用系统功能通道；前缀不符直接拒绝（第三方插件拿不到这条桥） */
    invoke: (channel: string, ...args: unknown[]) => {
      if (typeof channel !== 'string' || !SYSTEM_CHANNEL_RE.test(channel)) {
        throw new Error(`非法系统通道名: ${String(channel)}`)
      }
      return ipcRenderer.invoke(channel, ...args) as Promise<unknown>
    },
    /** 订阅系统功能事件通道（返回取消订阅函数） */
    on: (channel: string, callback: (data: unknown) => void) => {
      if (typeof channel !== 'string' || !SYSTEM_CHANNEL_RE.test(channel)) {
        throw new Error(`非法系统通道名: ${String(channel)}`)
      }
      const handler = (_event: Electron.IpcRendererEvent, data: unknown): void => callback(data)
      ipcRenderer.on(channel, handler)
      return () => {
        ipcRenderer.off(channel, handler)
      }
    }
  },
  plugin: {
    list: () => ipcRenderer.invoke('plugins-list') as Promise<PluginListEntry[]>,
    /**
     * **同步**取一次插件清单（含启用态）。
     *
     * 渲染层宿主在构造期要同步决定装载哪些内置插件（首帧既要有路由/菜单，又不能把用户
     * 停用的插件先装一遍再卸——那会让被停用插件的 Provider 订阅到不存在的通道）。
     * 只有同步 IPC 能在这个时机拿到主进程的权威启用态；失败时退回空数组，让上层按默认值走。
     */
    listSync: (): PluginListEntry[] => {
      try {
        const list = ipcRenderer.sendSync('plugins-list-sync')
        return Array.isArray(list) ? (list as PluginListEntry[]) : []
      } catch {
        return []
      }
    },
    /**
     * 只读诊断：当前主进程里各插件贡献的宿主生命周期钩子（数量 + 标签）
     * 与工作区事件订阅数。用于验证「停用插件后钩子不再执行」（见 main/ipc/misc.ts）。
     */
    lifecycleHooks: () =>
      ipcRenderer.invoke('app-lifecycle-hooks') as Promise<{
        preload: string[]
        beforeQuit: string[]
        memoryDump: string[]
        workspaceListeners: number
      }>,
    /**
     * 只读诊断：各插件主模块**从哪来**。
     *
     * P1 的过渡共存期里同一个插件可能来自磁盘包（`userData/plugins/<id>/main.cjs`）或静态
     * 注册表（dev 未跑打包脚本时的回退），`plugins-list` 分不出来源。工装用它断言
     * 「music 的 handler 确实由磁盘包应答」。
     */
    loadedFrom: () =>
      ipcRenderer.invoke('plugins-loaded-from') as Promise<
        Record<string, { installed: boolean; source: 'package' | 'absent'; file?: string }>
      >,
    /**
     * 只读诊断：若干张表的行数（工装用，验证「卸载并清数据后插件表行数为 0」）。
     * 表名由调用方传入并按标识符白名单校验；core 不含任何插件表名常量。
     */
    tableCounts: (tables: string[]) =>
      ipcRenderer.invoke('app-table-counts', tables) as Promise<Record<string, number>>,
    setEnabled: (id: string, enabled: boolean) =>
      ipcRenderer.invoke('plugins-set-enabled', id, enabled) as Promise<PluginListEntry[]>,
    /**
     * 从**本地路径**安装插件：`.zip` 压缩包、插件包目录，或该目录里的 `plugin.json`。
     *
     * 与插件中心的安装同一套校验与落地语义：装完自动启用并装载。失败不抛错，
     * 返回 `{ ok: false, error }`（路径不存在、包里没有 plugin.json……）。
     */
    installLocal: (source: string) =>
      ipcRenderer.invoke('plugins-install-local', source) as Promise<{
        ok: boolean
        canceled?: boolean
        id?: string
        name?: string
        version?: string
        upgraded?: boolean
        error?: string
      }>,
    /**
     * 弹系统选择框挑一个本地来源并安装（面板上**唯一**的本地安装入口）。
     * 用户取消时返回 `{ ok: true, canceled: true }`（取消不是错误）。
     */
    installLocalFromDialog: () =>
      ipcRenderer.invoke('plugins-pick-local') as Promise<{
        ok: boolean
        canceled?: boolean
        id?: string
        name?: string
        version?: string
        upgraded?: boolean
        error?: string
      }>,
    /**
     * 卸载插件（= 移除插件代码）。
     *
     * `purgeData` 只决定**要不要连数据一起清**：true = 调插件的 `plugin.purge` 删表内记录与
     * 应用托管的文件；false = 只删插件目录，数据留在库里（重装后仍然可用）。
     */
    uninstall: (id: string, purgeData: boolean) =>
      ipcRenderer.invoke('plugins-uninstall', id, purgeData) as Promise<PluginListEntry[]>,
    /**
     * 上报宿主 UI 表的「键 → 导出名」（渲染层启动最早期一次）。
     * 主进程的 `plugin://host/ui.js?m=<key>` 桥按这份清单生成 ESM 具名导出。
     */
    reportHostUi: (names: Record<string, string[]>) => {
      ipcRenderer.send('plugin-host-ui-exports', names)
    },
    onStateChanged: (callback: () => void) => {
      const handler = (): void => callback()
      ipcRenderer.on('plugin-state-changed', handler)
      return () => {
        ipcRenderer.off('plugin-state-changed', handler)
      }
    },
    /** 外部插件通道调用：前缀格式强校验；未注册通道由主进程抛错 */
    invoke: (channel: string, ...args: unknown[]) => {
      if (typeof channel !== 'string' || !PLUGIN_CHANNEL_RE.test(channel)) {
        throw new Error(`非法插件通道名: ${String(channel)}`)
      }
      return ipcRenderer.invoke(channel, ...args) as Promise<unknown>
    },
    /**
     * 订阅插件事件通道。
     *
     * 只强校验通道名格式；**白名单只用于提示，不再抛错**。原因（2026-09-26 实测事故）：
     * 白名单是主进程已装载通道的缓存，天然可能滞后于渲染层（插件停用后的空窗期、主进程
     * 插件模块装载失败、dev 下 HMR 重载顺序……）。此前这里直接抛错，异常从插件 Provider 的
     * useEffect 逃逸 → ErrorBoundary 接管 → 整个界面变成「RUNTIME ERROR」。
     * 现在的语义：订阅照常建立（真正权威在主进程——插件没装载就没人往该通道发消息），
     * 通道当时不在白名单里只提示一条告警。
     */
    on: (channel: string, callback: (data: unknown) => void) => {
      if (typeof channel !== 'string' || !PLUGIN_CHANNEL_RE.test(channel)) {
        throw new Error(`非法插件通道名: ${String(channel)}`)
      }
      if (!enabledPluginChannels.has(channel)) {
        console.warn(
          `[plugin] Subscribed channel is not enabled (the main process is authoritative; no events until the plugin loads): ${channel}`
        )
      }
      const handler = (_event: Electron.IpcRendererEvent, data: unknown): void => callback(data)
      ipcRenderer.on(channel, handler)
      return () => {
        ipcRenderer.off(channel, handler)
      }
    }
  },
  /**
   * Lattice 插件中心（core 通道：登录 / 目录 / 上传 / 下载安装 / 数据同步）。
   *
   * 与插件桥不同，这些通道**不经过**插件白名单：它们属于应用外壳能力，
   * 由 `src/main/ipc/lattice.ts` 常驻注册。事件订阅统一返回 unsubscribe。
   */
  lattice: {
    status: () => ipcRenderer.invoke(LATTICE_IPC.status) as Promise<LatticeStatus>,
    login: (input: LatticeLoginInput) =>
      ipcRenderer.invoke(LATTICE_IPC.login, input) as Promise<LatticeLoginResult>,
    logout: () => ipcRenderer.invoke(LATTICE_IPC.logout) as Promise<{ ok: boolean }>,
    me: () => ipcRenderer.invoke(LATTICE_IPC.me) as Promise<LatticeMeResult>,
    setBaseUrl: (url: string) =>
      ipcRenderer.invoke(LATTICE_IPC.setBaseUrl, url) as Promise<LatticeSetBaseUrlResult>,
    /** 插件目录（分页/搜索/分类） */
    list: (query?: LatticeListQuery) =>
      ipcRenderer.invoke(LATTICE_IPC.hubList, query ?? {}) as Promise<HubListResult>,
    /** 插件详情（含 readme / 版本清单 / 我的安装记录） */
    detail: (pluginId: string) =>
      ipcRenderer.invoke(LATTICE_IPC.hubDetail, pluginId) as Promise<HubDetail | null>,
    /** 直接发布本机已安装插件（安装包 + 源码，不弹目录选择框） */
    publishInstalled: (pluginId: string) =>
      ipcRenderer.invoke(LATTICE_IPC.hubPublishInstalled, pluginId) as Promise<LatticeUploadResult>,
    /** 弹系统目录选择框并发布（取消返回 `{ok:true,canceled:true}`） */
    pickAndUpload: () =>
      ipcRenderer.invoke(LATTICE_IPC.hubPickUpload) as Promise<LatticeUploadResult>,
    /** 选 .zip 安装包发布（目录上传的补充入口） */
    pickAndUploadZip: () =>
      ipcRenderer.invoke(LATTICE_IPC.hubPickUploadZip) as Promise<LatticeUploadResult>,
    /** 选「安装包目录 + 源码目录」发布：安装包与源码是两份不同的 zip */
    pickAndUploadWithSource: () =>
      ipcRenderer.invoke(LATTICE_IPC.hubPickUploadWithSource) as Promise<LatticeUploadResult>,
    /** 按显式路径发布：`source` 是安装包目录/zip；`sourcePath` 可选，给出时源码单独上传 */
    uploadSource: (source: string, sourcePath?: string) =>
      ipcRenderer.invoke(LATTICE_IPC.hubUpload, {
        source,
        ...(sourcePath ? { sourcePath } : {})
      }) as Promise<LatticeUploadResult>,
    /** 下载并安装（或升级）插件；失败返回 `{ok:false,error}`，不抛错 */
    install: (pluginId: string, version?: string) =>
      ipcRenderer.invoke(
        LATTICE_IPC.hubInstall,
        pluginId,
        version
      ) as Promise<LatticeInstallResult>,
    /** 本机已安装插件视图（本地口径，不联网） */
    listInstalls: () =>
      ipcRenderer.invoke(LATTICE_IPC.hubInstalls) as Promise<{
        items: LatticeInstallSummary[]
      }>,
    /**
     * 当前源码目录（v2）：安装时自动下载的源码解压位置。
     * `managed='pluginsPath'` = 用户配置的插件存放路径（= workshop 草稿目录，插件模式可开对话）；
     * `managed='userData'` = 应用数据目录回退；`path=null` = 本机没有该插件源码。
     */
    sourcePath: (pluginId: string) =>
      ipcRenderer.invoke(LATTICE_IPC.sourcePath, pluginId) as Promise<LatticeSourcePathResult>,
    /** 本机已安装插件包目录（`userData/plugins/<id>`，本地安装后发布用） */
    localSource: (pluginId: string) =>
      ipcRenderer.invoke(
        LATTICE_IPC.localSourcePath,
        pluginId
      ) as Promise<LatticeLocalSourcePathResult>,
    /**
     * 「在对话中修改」：为源码目录建/复用插件工作区并开一条插件会话。
     * 成功开对话返回 `{ok:true,workspaceId,topicId}`；做不到时回退文件管理器并返回
     * `{ok:true,opened:'folder'}`（不会假装开了对话）。
     */
    openSource: (pluginId: string) =>
      ipcRenderer.invoke(LATTICE_IPC.openSource, pluginId) as Promise<LatticeOpenSourceResult>,
    /** 「发布新版本」：源码目录整包 zip 同时作为安装包与源码包上传；失败返回 `{ok:false,error}` */
    republish: (input: LatticeRepublishInput) =>
      ipcRenderer.invoke(LATTICE_IPC.republish, input) as Promise<LatticeRepublishResult>,
    /** 下载安装包 / 源码包到本机（主进程弹保存框 + sha256 校验；用户取消不是失败） */
    downloadAsset: (pluginId: string, version: string, kind: LatticeDownloadAssetKind) =>
      ipcRenderer.invoke(
        LATTICE_IPC.downloadAsset,
        pluginId,
        version,
        kind
      ) as Promise<LatticeDownloadAssetResult>,
    /**
     * 「从本地导入」：弹目录选择框，把所选目录下带 plugin.json 的插件逐个发布到平台
     * （安装包 + 源码包都是这个目录的整包 zip）。
     */
    importLocalDir: (dir?: string) =>
      ipcRenderer.invoke(LATTICE_IPC.importLocalDir, dir) as Promise<LatticeImportLocalDirResult>,
    /**
     * 显式设置「插件存放路径」并立即生效（导入本地插件目录后，让这些源码出现在「插件」模式）。
     * 只接受非空路径；清除路径请走设置页。
     */
    setPluginRoot: (dir: string) =>
      ipcRenderer.invoke(LATTICE_IPC.setPluginRoot, dir) as Promise<LatticeSetPluginRootResult>,
    /** 手动同步：`{direction, installMissing?}` 或裸字符串（installMissing 缺省跟随设置项，默认开启） */
    sync: (input?: LatticeSyncInput) =>
      ipcRenderer.invoke(
        LATTICE_IPC.sync,
        input ?? { direction: 'both' }
      ) as Promise<LatticeSyncResult>,
    /** 同步详情：最近一次同步的自动补齐成功/失败明细与孤儿记录（失败原因可查看） */
    syncDetails: () => ipcRenderer.invoke(LATTICE_IPC.syncDetails) as Promise<LatticeSyncDetails>,
    /** 「缺失插件自动补齐」开关（持久化；默认开启） */
    setAutoInstallMissing: (enabled: boolean) =>
      ipcRenderer.invoke(
        LATTICE_IPC.setAutoInstallMissing,
        enabled
      ) as Promise<LatticeAutoInstallSettingResult>,
    /** 未解决的插件数据冲突（含补拉的云端数据快照） */
    syncConflicts: () =>
      ipcRenderer.invoke(LATTICE_IPC.syncConflicts) as Promise<LatticeSyncConflict[]>,
    /** 显式解决冲突：local=用本机覆盖云端；cloud=用云端覆盖本机；merge=两边合并（插件支持时） */
    resolveConflict: (pluginId: string, strategy: 'local' | 'cloud' | 'merge') =>
      ipcRenderer.invoke(
        LATTICE_IPC.resolveConflict,
        pluginId,
        strategy
      ) as Promise<LatticeResolveConflictResult>,
    /** 合并云端数据：把各已安装插件（支持合并的）的云端快照并进本机并推回云端 */
    mergeData: () => ipcRenderer.invoke(LATTICE_IPC.mergeData) as Promise<LatticeMergeDataResult>,
    /** 登录态/基址/同步摘要变化推送 */
    onStateChanged: (callback: (status: LatticeStatus) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: LatticeStatus): void =>
        callback(status)
      ipcRenderer.on(LATTICE_IPC.stateChanged, handler)
      return () => {
        ipcRenderer.off(LATTICE_IPC.stateChanged, handler)
      }
    },
    /** 发布阶段进度（zip / meta / upload） */
    onUploadProgress: (callback: (progress: LatticeUploadProgress) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: LatticeUploadProgress): void =>
        callback(progress)
      ipcRenderer.on(LATTICE_IPC.uploadProgress, handler)
      return () => {
        ipcRenderer.off(LATTICE_IPC.uploadProgress, handler)
      }
    },
    /** 同步结果推送（手动同步与后台防抖同步都会发） */
    onSyncState: (callback: (result: LatticeSyncResult) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, result: LatticeSyncResult): void =>
        callback(result)
      ipcRenderer.on(LATTICE_IPC.syncState, handler)
      return () => {
        ipcRenderer.off(LATTICE_IPC.syncState, handler)
      }
    }
  }
}

// 将特定的 API 暴露给渲染进程
const loadingAPI = {
  /** 应用版本（启动页可展示） */
  getAppVersion: () => ipcRenderer.invoke('app-version') as Promise<string>,

  /** 初始化进度快照：启动页挂载时先取一次（初始化可能已经推进/完成） */
  getInitState: () =>
    ipcRenderer.invoke('init-state') as Promise<{
      complete: boolean
      error: string | null
      currentTask: string
      progress: number
      taskIndex: number
      totalTasks: number
    }>,

  /** 初始化进度（返回取消订阅函数） */
  onInitProgress: (
    callback: (data: {
      currentTask: string
      progress: number
      taskIndex: number
      totalTasks: number
    }) => void
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: Parameters<typeof callback>[0]
    ): void => {
      callback(data)
    }
    ipcRenderer.on('init-progress', handler)
    return () => ipcRenderer.off('init-progress', handler)
  },

  /** 初始化完成（返回取消订阅函数） */
  onInitComplete: (callback: () => void) => {
    const handler = (): void => callback()
    ipcRenderer.on('init-complete', handler)
    return () => ipcRenderer.off('init-complete', handler)
  },

  /** 初始化失败（返回取消订阅函数） */
  onInitError: (callback: (errorMessage: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, message: string): void => callback(message)
    ipcRenderer.on('init-error', handler)
    return () => ipcRenderer.off('init-error', handler)
  }
}
// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
    contextBridge.exposeInMainWorld('loading', loadingAPI)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
  // @ts-ignore (define in dts)
  window.loading = loadingAPI
}
