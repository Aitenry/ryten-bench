import { ElectronAPI } from '@electron-toolkit/preload'
import type { LlmProviderInput, LlmProviderConfig } from '../main/database/mapper/provider'
import type { SystemSettings } from '../main/types/settings'
import type { PluginListEntry } from '../shared/plugin/types'

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
    /** 插件仓库（GitHub）里可安装的插件清单（网络失败会抛错） */
    available: () => Promise<{
      repo: string
      tag?: string
      plugins: {
        id: string
        name: string
        version: string
        description?: string
        asset: string
        size?: number
        installed: boolean
      }[]
    }>
    /** 从插件仓库安装（或升级）某个插件 */
    installFromGithub: (id: string) => Promise<{ ok: boolean; id?: string; error?: string }>
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
