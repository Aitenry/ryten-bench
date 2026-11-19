import { Lock } from '@renderer/types/settings'
import { LlmProviderInput, LlmProviderConfig } from '../../../main/database/mapper/provider'
import { SystemSettings } from '@renderer/types/settings'

/**
 * 渲染层 core 的 `window` / `window.api` 形状（preload 早期类型副本的延续）。
 *
 * 各插件的命名空间（music / planner / notes 六键 / harness 的 harness·agents·mainAgent·workspace）
 * 已随插件化删除；harness 渲染层也不再依赖本文件（改走插件自己的 renderer/api.ts）。
 * 插件的跨进程 DTO 现在归各插件自己的 `src/plugins/<id>/shared/types.ts`。
 */

export interface Window {
  loading: {
    /** 应用版本（启动页可展示） */
    getAppVersion: () => Promise<string>
    /** 初始化进度快照（启动页挂载时先取一次，处理初始化已经开始/已完成的情况） */
    getInitState: () => Promise<{
      complete: boolean
      error: string | null
      currentTask: string
      progress: number
      taskIndex: number
      totalTasks: number
    }>
    /** 初始化进度（返回取消订阅函数） */
    onInitProgress: (
      callback: (data: {
        currentTask: string
        progress: number
        taskIndex: number
        totalTasks: number
      }) => void
    ) => () => void
    /** 初始化完成（返回取消订阅函数） */
    onInitComplete: (callback: () => void) => () => void
    /** 初始化失败（返回取消订阅函数） */
    onInitError: (callback: (errorMessage: string) => void) => () => void
  }
  api: {
    file: {
      selectImageFile: (allowImages?: boolean) => Promise<{
        dataUrl: string
        fileName: string
        isImage: boolean
      } | null>
      selectTextFile: () => Promise<{
        fileName: string
        filePath: string
      } | null>
      /** 取剪贴板/拖拽 File 的真实磁盘路径；无磁盘文件来源（如网页复制的图片）返回空串 */
      getPathForFile: (file: File) => string
    }
    setting: {
      getLockScreenCode: () => Promise<Lock>
      setLockScreenView: (open: boolean) => void
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
      /** 同步系统窗口按钮覆盖层的配色（自绘标题栏跟随主题） */
      setTitleBarOverlay: (options: {
        color?: string
        symbolColor?: string
        height?: number
      }) => void
      /** 同步系统窗口边框/标题栏的明暗（避免亮色应用顶部残留深色 DWM 边框） */
      setNativeTheme: (mode: 'light' | 'dark' | 'system') => void
      /** 设置窗口标题（原生标题栏：`内容 - RytenBench`） */
      setTitle: (title: string) => void
      /** 重新加载当前窗口（标题栏「应用 → 重新加载」） */
      reload: () => void
      /** 退出应用（标题栏「应用 → 退出」） */
      quit: () => void
      /** 原生编辑命令（标题栏「编辑」菜单） */
      edit: (command: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll') => void
    }
    /** 当前运行平台（win32 / darwin / linux） */
    platform: NodeJS.Platform
    weather: {
      getCurrent: (force?: boolean) => Promise<WeatherData>
      onUpdate: (callback: (data: WeatherData) => void) => () => void
    }
    plugin: {
      list: () => Promise<unknown[]>
      /** 同步取一次插件清单（含启用态/安装态）；宿主首帧靠它决定只装载哪些静态内置插件 */
      listSync: () => {
        id: string
        builtin: boolean
        bundled?: boolean
        installed: boolean
        enabled: boolean
      }[]
      setEnabled: (id: string, enabled: boolean) => Promise<unknown[]>
      /** 无参 = 第三方插件选目录安装；带 id = 从应用包重装某个内置插件 */
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
      installLocal: (source: string) => Promise<{
        ok: boolean
        canceled?: boolean
        id?: string
        name?: string
        version?: string
        upgraded?: boolean
        error?: string
      }>
      /** 弹系统选择框挑一个本地来源并安装（取消返回 `{ ok: true, canceled: true }`） */
      installLocalFromDialog: () => Promise<{
        ok: boolean
        canceled?: boolean
        id?: string
        name?: string
        version?: string
        upgraded?: boolean
        error?: string
      }>
      /**
       * 卸载插件（总是移除插件代码）。`purgeData` 决定是否同时清数据：
       * false = 数据保留在库里（重装后仍可用），true = 调 `plugin.purge` 删表内记录与托管文件。
       */
      uninstall: (id: string, purgeData: boolean) => Promise<unknown[]>
      onStateChanged: (callback: () => void) => () => void
      /** 通用桥：调用插件通道（`plugin:<命名空间>:<channel>`） */
      invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
      /** 通用桥：订阅插件事件通道（preload 白名单门控） */
      on: (channel: string, callback: (data: unknown) => void) => () => void
      /** 只读诊断：插件贡献的宿主生命周期钩子 + 工作区事件订阅数 */
      lifecycleHooks: () => Promise<{
        preload: string[]
        beforeQuit: string[]
        memoryDump: string[]
        workspaceListeners: number
      }>
      /** 只读诊断：各插件主模块的装载来源（磁盘包 / 静态注册表） */
      loadedFrom: () => Promise<
        Record<
          string,
          { installed: boolean; source: 'package' | 'builtin' | 'absent'; file?: string }
        >
      >
      /** 只读诊断：若干张表的行数（表名按标识符白名单校验） */
      tableCounts: (tables: string[]) => Promise<Record<string, number>>
      /** 上报宿主 UI 表的「键 → 导出名」（plugin://host/ui.js 桥据此生成） */
      reportHostUi: (names: Record<string, string[]>) => void
    }
    mermaid: {
      /** 全屏窗口预览 SVG（可拖拽/缩放画布） */
      preview: (svg: string) => Promise<void>
    }
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
