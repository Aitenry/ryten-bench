import { ElectronAPI } from '@electron-toolkit/preload'
import type { LlmProviderInput, LlmProviderConfig } from '../main/database/mapper/provider'
import type { SystemSettings } from '../main/types/settings'
import type { PluginListEntry } from '../shared/plugin/types'
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
  LatticeUploadProgress,
  LatticeUploadResult
} from '../main/lattice/types'

/**
 * 本地安装插件（压缩包 / 文件夹）的结果。
 *
 * `canceled` 与 `error` 分开：用户在系统选择框里点取消不是失败，面板不该弹红字
 * （`ok: true, canceled: true`）。
 */
interface LocalPluginInstallResult {
  ok: boolean
  canceled?: boolean
  id?: string
  name?: string
  version?: string
  /** true = 覆盖了同 id 的既有安装（面板提示「已升级」） */
  upgraded?: boolean
  error?: string
}

/**
 * preload 暴露给渲染层的 core 能力（`window.api`）。
 *
 * - `api.system`：系统功能（AI 助手 / 资料库）的通道桥，普通 `harness:*` / `notes:*`；
 * - `api.plugin`：第三方插件的通用桥（`plugin:<命名空间>:*` + 通道白名单），
 *   类型由插件自己的 `shared/types.ts` 提供。
 */
interface Api {
  file: {
    selectImageFile: (
      allowImages?: boolean
    ) => Promise<{ dataUrl: string; fileName: string; isImage: boolean } | null>
    selectTextFile: () => Promise<{ fileName: string; filePath: string } | null>
    /** 取剪贴板/拖拽 File 的真实磁盘路径；无磁盘文件来源（如网页复制的图片）返回空串 */
    getPathForFile: (file: File) => string
  }
  setting: {
    getLockScreenCode: () => Promise<{ code: string; view: boolean }>
    setLockScreenView: (open: boolean) => Promise<void>
  }
  providers: {
    getAll: () => Promise<LlmProviderConfig[]>
    getById: (id: number) => Promise<LlmProviderConfig | null>
    getDefault: () => Promise<LlmProviderConfig | null>
    getEnabled: () => Promise<LlmProviderConfig[]>
    create: (input: LlmProviderInput) => Promise<number>
    createBatch: (inputs: LlmProviderInput[]) => Promise<{
      created: number
      skipped: number
    }>
    update: (id: number, updates: Partial<LlmProviderInput>) => Promise<boolean>
    delete: (id: number) => Promise<boolean>
    deleteBatch: (ids: number[]) => Promise<number>
    setDefault: (id: number) => Promise<boolean>
    lookupProfile: (modelId: string) => Promise<Record<string, unknown> | null>
    fetchModels: (
      providerType: string,
      baseUrl?: string,
      apiKey?: string
    ) => Promise<{ id: string; metadata: Record<string, unknown> | null }[]>
    /** 供应商配置变化推送（启用/停用/改默认后） */
    onChanged: (callback: () => void) => () => void
  }
  systemSettings: {
    getAll: () => Promise<SystemSettings>
    update: (updates: Partial<SystemSettings>) => Promise<boolean>
  }
  window: {
    minimize: () => void
    maximize: () => void
    close: () => void
    isMaximized: () => Promise<boolean>
    onMaximized: (callback: (maximized: boolean) => void) => () => void
  }
  weather: {
    getCurrent: (force?: boolean) => Promise<WeatherData>
    onUpdate: (callback: (data: WeatherData) => void) => () => void
  }
  /**
   * 系统级功能（AI 助手 / 资料库）的通道桥。
   *
   * 通道名是普通 `harness:*` / `notes:*`：它们是随应用编译进来的功能，不是插件，
   * 因此不经过插件宿主的启用态与通道白名单；preload 只对前缀做一次校验。
   */
  system: {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
    on: (channel: string, callback: (data: unknown) => void) => () => void
  }
  plugin: {
    /** 已安装插件与启用态（内置铺包 + 第三方扫描合并；未安装的内置插件也在列） */
    list: () => Promise<PluginListEntry[]>
    /**
     * **同步**取一次插件清单（含启用态/安装态）。
     * 渲染层宿主在构造期要同步决定装载哪些静态内置插件，只有同步 IPC 能在这个时机拿到权威状态。
     */
    listSync: () => PluginListEntry[]
    /** 启用/停用插件（写入持久化并广播，渲染层即时装载/卸载） */
    setEnabled: (id: string, enabled: boolean) => Promise<PluginListEntry[]>
    /** 无参 = 第三方插件「选目录安装」；带 id = 从应用包重装某个内置插件 */
    install: (id?: string) => Promise<{ ok: boolean; id?: string; error?: string }>
    /** 从本地路径安装插件：`.zip` 压缩包、插件包目录，或该目录里的 `plugin.json` */
    installLocal: (source: string) => Promise<LocalPluginInstallResult>
    /** 弹系统选择框挑一个本地来源并安装（面板唯一的本地安装入口；取消返回 canceled） */
    installLocalFromDialog: () => Promise<LocalPluginInstallResult>
    /**
     * 卸载插件并返回最新列表。
     * 卸载本身总是移除插件代码；`purgeData` 决定要不要同时清数据（false = 数据保留在库里）。
     */
    uninstall: (id: string, purgeData: boolean) => Promise<PluginListEntry[]>
    /** 插件启用态变化推送（含安装/卸载） */
    onStateChanged: (callback: () => void) => () => void
    /** 插件通道调用（plugin:<id>: 前缀；经主进程权威校验） */
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
    /** 订阅插件事件通道（白名单缓存门控） */
    on: (channel: string, callback: (data: unknown) => void) => () => void
    /**
     * 只读诊断：主进程里各插件贡献的宿主生命周期钩子（标签）+ 工作区事件订阅数。
     * 用于验证「停用插件后 app.preload / app.before-quit / app.renderer-memory-dump
     * 与工作区订阅都不再存在」（见 src/main/ipc/misc.ts）。
     */
    lifecycleHooks: () => Promise<{
      preload: string[]
      beforeQuit: string[]
      memoryDump: string[]
      workspaceListeners: number
    }>
    /**
     * 只读诊断：各插件主模块的**装载来源**。
     * `package` = 由 `userData/plugins/<id>/main.cjs` 提供；`builtin` = 静态注册表回退。
     */
    loadedFrom: () => Promise<
      Record<
        string,
        { installed: boolean; source: 'package' | 'builtin' | 'absent'; file?: string }
      >
    >
    /** 只读诊断：若干张表的行数（表名按标识符白名单校验） */
    tableCounts: (tables: string[]) => Promise<Record<string, number>>
    /** 上报宿主 UI 表的「键 → 导出名」（`plugin://host/ui.js` 桥据此生成） */
    reportHostUi: (names: Record<string, string[]>) => void
  }
  /**
   * Lattice 插件中心（core 通道，不走插件白名单）。
   *
   * 契约见 `.dev/ryten-lattice-contract.md` §3；IPC 常量在
   * `src/main/lattice/types.ts` 的 `LATTICE_IPC`（main/preload 共用一份）。
   */
  lattice: {
    /** 当前状态（基址 / 登录态 / 用户 / 角色 / 最近同步摘要） */
    status: () => Promise<LatticeStatus>
    /** 登录；失败不抛错，返回 `{ok:false,error}`（平台 message） */
    login: (input: LatticeLoginInput) => Promise<LatticeLoginResult>
    /** 退出登录（先尽力吊销服务端 refresh，本地无条件清） */
    logout: () => Promise<{ ok: boolean }>
    /** 当前用户与角色（`/v1/me`） */
    me: () => Promise<LatticeMeResult>
    /** 设置基址（环境变量 RB_LATTICE_URL 优先；变更会清除旧登录态） */
    setBaseUrl: (url: string) => Promise<LatticeSetBaseUrlResult>
    /** 插件目录（搜索 / 分类 / 排序 / 分页） */
    list: (query?: LatticeListQuery) => Promise<HubListResult>
    /** 插件详情（readme / 版本清单 / 我的安装记录） */
    detail: (pluginId: string) => Promise<HubDetail | null>
    /** 直接发布本机已安装插件（安装包 + 源码，不弹目录选择框） */
    publishInstalled: (pluginId: string) => Promise<LatticeUploadResult>
    /** 弹目录选择框并发布；用户取消 → `{ok:true,canceled:true}` */
    pickAndUpload: () => Promise<LatticeUploadResult>
    /** 选 .zip 安装包发布 */
    pickAndUploadZip: () => Promise<LatticeUploadResult>
    /** 选「安装包目录 + 源码目录」发布：安装包与源码是两份不同的 zip */
    pickAndUploadWithSource: () => Promise<LatticeUploadResult>
    /** 按显式路径发布：`source` 是安装包目录/zip；`sourcePath` 可选，给出时源码单独上传 */
    uploadSource: (source: string, sourcePath?: string) => Promise<LatticeUploadResult>
    /** 下载并安装（或升级）；失败返回 `{ok:false,error}`，不抛错 */
    install: (pluginId: string, version?: string) => Promise<LatticeInstallResult>
    /** 本机已安装插件视图（本地口径，不联网） */
    listInstalls: () => Promise<{ items: LatticeInstallSummary[] }>
    /**
     * 当前源码目录（v2）：安装时自动下载的源码解压位置。
     * `managed='pluginsPath'` = 用户配置的插件存放路径（= workshop 草稿目录，插件模式可开对话）；
     * `managed='userData'` = 应用数据目录回退；`path=null` = 本机没有该插件源码。
     */
    sourcePath: (pluginId: string) => Promise<LatticeSourcePathResult>
    /** 本机已安装插件包目录（`userData/plugins/<id>`，本地安装后发布用） */
    localSource: (pluginId: string) => Promise<LatticeLocalSourcePathResult>
    /**
     * 「在对话中修改」：为源码目录建/复用插件工作区并开一条插件会话。
     * 成功开对话 → `{ok:true,workspaceId,topicId}`；做不到可靠切换时回退文件管理器 →
     * `{ok:true,opened:'folder'}`（**不会**假装开了对话）。
     */
    openSource: (pluginId: string) => Promise<LatticeOpenSourceResult>
    /** 「发布新版本」：源码目录整包 zip 同时作为安装包与源码包上传 */
    republish: (input: LatticeRepublishInput) => Promise<LatticeRepublishResult>
    /** 下载安装包 / 源码包到本机（弹保存框 + sha256 校验；用户取消不是失败） */
    downloadAsset: (
      pluginId: string,
      version: string,
      kind: LatticeDownloadAssetKind
    ) => Promise<LatticeDownloadAssetResult>
    /**
     * 「从本地导入」：弹目录选择框，把所选目录下带 `plugin.json` 的插件逐个发布到平台
     * （安装包 + 源码包都是这个目录的整包 zip）；返回成功/跳过摘要。
     */
    importLocalDir: (dir?: string) => Promise<LatticeImportLocalDirResult>
    /**
     * 显式设置「插件存放路径」并立即生效（插件中心导入本地目录后调用）。
     * 只接受非空路径；清除路径走设置页。
     */
    setPluginRoot: (dir: string) => Promise<LatticeSetPluginRootResult>
    /**
     * 手动同步（push / pull / both；也接受裸字符串）。
     *
     * 扩展入参：`{direction, installMissing?}` —— `installMissing` 控制本次 pull 是否自动补齐
     * 「平台有安装记录、本机没有插件包」的插件；缺省跟随设置项（默认开启）。
     * 返回的 `autoInstall` 带成功/失败明细，`orphaned` 列出平台已删除的安装记录。
     */
    sync: (input?: LatticeSyncInput) => Promise<LatticeSyncResult>
    /** 同步详情：最近一次同步的自动补齐成功/失败明细 + 孤儿记录（失败原因可查看） */
    syncDetails: () => Promise<LatticeSyncDetails>
    /** 「缺失插件自动补齐」开关（持久化设置；默认开启） */
    setAutoInstallMissing: (enabled: boolean) => Promise<LatticeAutoInstallSettingResult>
    /** 未解决的插件数据冲突（含补拉的云端数据快照） */
    syncConflicts: () => Promise<LatticeSyncConflict[]>
    /** 显式解决冲突：local=用本机覆盖云端；cloud=用云端覆盖本机 */
    resolveConflict: (
      pluginId: string,
      strategy: 'local' | 'cloud'
    ) => Promise<LatticeResolveConflictResult>
    /** 状态变化推送（返回取消订阅函数） */
    onStateChanged: (callback: (status: LatticeStatus) => void) => () => void
    /** 上传阶段进度推送（zip / meta / upload） */
    onUploadProgress: (callback: (progress: LatticeUploadProgress) => void) => () => void
    /** 同步结果推送（手动与后台防抖同步都会发） */
    onSyncState: (callback: (result: LatticeSyncResult) => void) => () => void
  }
  mermaid: {
    /** 全屏窗口预览 SVG（可拖拽/缩放画布） */
    preview: (svg: string) => Promise<void>
  }
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

declare global {
  interface Window {
    electron: ElectronAPI
    api: Api
  }
}
