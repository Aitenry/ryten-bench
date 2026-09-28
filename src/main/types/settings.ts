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

/**
 * 侧栏某一侧「当前那一条内容」：工作区 id（插件侧 = 它的「插件工作区」id）+ 选中的会话 id。
 * `topicId` 为 null = 这个工作区里的空白会话（还没发过消息，话题行还没落库）。
 */
export interface HarnessContentRef {
  workspaceId: number
  topicId: number | null
}

/** 侧栏停在哪一侧：工作（工作区 → 会话）/ 插件（插件草稿） */
export type HarnessSidebarMode = 'chat' | 'plugin'

export interface HarnessSettings {
  /** 技能（Skills）存储目录，空/未设置表示不启用；目录下每个含 SKILL.md 的子目录即一个技能 */
  skillsPath?: string
  /** 启用的技能 ID 列表，undefined 表示全部启用，[] 表示全部禁用 */
  enabledSkills?: string[]
  /** AI 工作区目录，挂载为 FilesystemBackend 的根目录（虚拟 /）；未设置时回退到 skillsPath */
  workspacePath?: string
  /** 当前活跃的工作区 ID，用于按工作区筛选话题 */
  activeWorkspaceId?: number
  /**
   * 侧栏停在哪一侧 + 两侧各自「当前那一条内容」——**重启后照着它恢复**
   * （用户口径 2026-09-28「要记住工作模式和插件模式，选中的会话，下次进来可以记住」）。
   *
   * 覆盖早先「模式开关不持久化」的口径（2026-09-27「一进来默认不能选中插件这个栏，要看当前
   * 是在工作的选中内容还是插件的选中内容」）：当时恢复不了内容，模式一旦持久化就会让开关与
   * 主区域打架（侧栏列着插件、内容还是工作会话）；现在两侧内容一起记，开关跟着恢复出来的
   * 内容走，两边始终一致。命中不了（会话/工作区/插件已删）就退回该侧的默认落点，不报错。
   */
  activeMode?: HarnessSidebarMode
  /** 工作模式当前那一条内容（没选过 = null） */
  workContent?: HarnessContentRef | null
  /** 插件模式当前那一条内容（含是哪份插件；没选过 = null） */
  pluginContent?: (HarnessContentRef & { pluginId: string }) | null
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
