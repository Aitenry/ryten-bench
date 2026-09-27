export interface Lock {
  code: string
  view: boolean
}

export interface GraphSettings {
  maxConcurrency: number
  enableGleaning: boolean
  gleaningThreshold: number
  maxChunkSize: number
}

export interface HarnessSettings {
  /** 技能（Skills）存储目录，空/未设置表示不启用；目录下每个含 SKILL.md 的子目录即一个技能 */
  skillsPath?: string
  /** 启用的技能 ID 列表，undefined 表示全部启用，[] 表示全部禁用 */
  enabledSkills?: string[]
  /** AI 工作区目录，挂载为 FilesystemBackend 的根目录（虚拟 /）；未设置时回退到 skillsPath */
  workspacePath?: string
  /** 当前活跃的工作区 ID，用于按工作区筛选话题 */
  activeWorkspaceId?: number
  /** 记忆（Memory）存储根目录，空/未设置表示不启用；其下按工作区 ID 目录隔离（workspace-<id>/），每个工作区一套独立记忆 */
  memoryPath?: string
  /**
   * **插件存放路径**（插件工坊里所有插件的源码根目录）。
   *
   * 刻意**没有默认值**（用户口径 2026-09-27「不要有默认目录，需要配置所有插件的存放路径」）：
   * 未配置时工坊不列草稿也不能新建，界面入口先去选文件夹。每个插件占一个子目录
   * （`<pluginsPath>/<插件 id>/`），根目录本身永远不会被删。
   */
  pluginsPath?: string
}

export type ThemeMode = 'light' | 'dark' | 'auto'

/**
 * UI 语言。只有「简体中文 / English」两项：未选择过时默认选中与操作系统语言一致的那一项，
 * 因此不存在独立的「跟随系统」档位。
 */
export type AppLanguage = 'zh-CN' | 'en-US'

/** 系统托盘设置 */
export interface TraySettings {
  /** 关闭窗口时最小化到系统托盘（默认开启）；关闭后应用完全退出 */
  closeToTray: boolean
}

export interface SystemSettings {
  ip?: Record<string, unknown>
  lock: Lock
  graph: GraphSettings
  harness: HarnessSettings
  defaultModelId?: number
  defaultEmbeddingModelId?: number
  musicDirectory?: string
  theme?: ThemeMode
  /** UI 语言；未设置时按操作系统语言取其对应项 */
  language?: AppLanguage
  /** 系统托盘设置 */
  tray?: TraySettings
  /** 天气缓存数据 */
  weatherData?: Record<string, unknown>
  /** 天气自动刷新间隔（分钟），默认 60 */
  weatherRefreshInterval?: number
  /** 上次天气数据获取时间戳 */
  weatherLastFetched?: number
}
