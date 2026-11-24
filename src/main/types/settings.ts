/**
 * 锁屏设置（落盘形态）。
 *
 * `code` 是**解锁码摘要**，只在主进程使用：渲染层通过 `lock-screen-*` 通道拿到的是
 * `LockScreenSnapshot`（只有 hasCode，没有摘要本身），因此无法离线爆破
 * （见 `src/main/lock/credentials.ts`）。
 *
 * `code` 仍保持可选是为了兼容「升级前从未初始化过锁屏」的旧设置文件；读不到就按未设置处理。
 */
export interface Lock {
  /** `scrypt$N$r$p$salt$hash`；旧版本是 6 位数字的裸 MD5，首次校验成功后自动升级 */
  code?: string
  /** 是否启用锁屏（Esc 手动锁屏 / 空闲自动锁屏） */
  view: boolean
  /** 系统空闲多少分钟后自动锁屏；0 = 关闭，未设置按 5 分钟（见 lock/constants.ts） */
  autoLockMinutes?: number
}

/** 渲染层可读的锁屏快照（**绝不含**解锁码摘要） */
export interface LockScreenSnapshot {
  /** 设置里的「启用锁屏」开关（只表示用户意愿，不表示当前已锁） */
  enabled: boolean
  /** 是否已经设置过解锁码（没设置时不允许锁屏，否则会把人锁在进不去的界面里） */
  hasCode: boolean
  /** 是否仍在使用出厂默认码 123456（设置页据此提示尽快修改） */
  usingDefaultCode: boolean
  /** 自动锁屏时长（分钟），0 = 关闭；取值见 lock/constants.ts */
  autoLockMinutes: number
  /** 当前是否处于锁屏状态（由主进程持有，刷新/崩溃重建窗口都不会丢） */
  locked: boolean
}

export type LockUnlockFailure = 'invalid' | 'throttled' | 'unavailable'

export interface LockUnlockResult {
  ok: boolean
  reason?: LockUnlockFailure
  /** reason=throttled 时还要等多久（毫秒） */
  retryAfterMs?: number
  /** 本次失败后还剩几次「不等待」的尝试机会 */
  attemptsLeft?: number
}

export type LockCodeChangeFailure = 'wrong-old' | 'invalid-new' | 'unavailable'

export interface LockCodeChangeResult {
  ok: boolean
  reason?: LockCodeChangeFailure
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

/**
 * 侧栏停在哪一侧：
 * - `work`：工作（工作区 → 会话）；
 * - `chat`：**对话**（没有工作区概念，只有一份会话列表；应用自带一个按系统初始化的目录）；
 * - `plugin`：插件（插件工坊里的草稿）。
 *
 * 历史：`work` 这一档早先叫 `'chat'`（那时还没有「对话」模式）。改名后盘上可能存着旧的
 * `'chat'` 值——渲染层读取时按 `'work'` 归一（见 HarnessSidebar 的 restoreLastContent），
 * 因此不必为它写数据迁移。
 */
export type HarnessSidebarMode = 'work' | 'chat' | 'plugin'

export interface HarnessSettings {
  /**
   * 技能（Skills）存储目录，空/未设置表示不启用；目录下每个含 SKILL.md 的子目录即一个技能。
   * 首次启动会预置为 `<安装目录>/data/skills`（安装目录不可写时退回 `<userData>/data/skills`）；
   * 用户改到别处时，旧目录里的技能会整体迁过去。
   */
  skillsPath?: string
  /** 启用的技能 ID 列表，undefined 表示全部启用，[] 表示全部禁用 */
  enabledSkills?: string[]
  /** AI 工作区目录，挂载为 FilesystemBackend 的根目录（虚拟 /）；未设置时回退到 skillsPath */
  workspacePath?: string
  /** 当前活跃的工作区 ID，用于按工作区筛选话题 */
  activeWorkspaceId?: number
  /**
   * 侧栏停在哪一侧 + 各侧「当前那一条内容」——**重启后照着它恢复**
   * （用户口径 2026-09-28「要记住工作模式和插件模式，选中的会话，下次进来可以记住」）。
   *
   * 覆盖早先「模式开关不持久化」的口径（2026-09-27「一进来默认不能选中插件这个栏，要看当前
   * 是在工作的选中内容还是插件的选中内容」）：当时恢复不了内容，模式一旦持久化就会让开关与
   * 主区域打架（侧栏列着插件、内容还是工作会话）；现在各侧内容一起记，开关跟着恢复出来的
   * 内容走，两边始终一致。命中不了（会话/工作区/插件已删）就退回该侧的默认落点，不报错。
   */
  activeMode?: HarnessSidebarMode
  /** 工作模式当前那一条内容（没选过 = null） */
  workContent?: HarnessContentRef | null
  /** 「对话」模式当前那一条内容（那一侧的 workspaceId 就是应用初始化的对话工作区） */
  chatContent?: HarnessContentRef | null
  /** 插件模式当前那一条内容（含是哪份插件；没选过 = null） */
  pluginContent?: (HarnessContentRef & { pluginId: string }) | null
  /**
   * 记忆（Memory）存储根目录，空/未设置表示不启用；其下按工作区 ID 目录隔离
   * （workspace-<id>/），每个工作区一套独立记忆。
   * 首次启动会预置为 `<安装目录>/data/memory`（安装目录不可写时退回 `<userData>/data/memory`）；
   * 用户改到别处时，旧目录里的全部记忆会整体迁过去。
   */
  memoryPath?: string
  /**
   * **插件存放路径**（插件工坊里所有插件的源码根目录）。
   *
   * 首次启动会预置为 `<安装目录>/data/plugins`（安装目录不可写时退回
   * `<userData>/data/plugins`），因此开箱即可用工坊；用户也可以改到任意可写目录，
   * 改地址时旧路径下的插件源码会整体迁到新路径（同名文件保留目标那份，旧文件另存
   * `*.migrated-*`，绝不覆盖）。
   *
   * 每个插件占一个子目录（`<pluginsPath>/<插件 id>/`），根目录本身永远不会被删。
   */
  pluginsPath?: string
  /**
   * 内部标记：**按安装目录预置默认存储布局**是否已执行过。
   *
   * 只写入一次。有了它，用户在设置里主动清空某个路径（= 停用该能力）后，
   * 后续启动不会再把默认值强行塞回去；升级前的老用户若已配置记忆/技能目录，
   * 也只会补上还空着的那几项，不会覆盖已有选择。
   */
  storageDefaultsApplied?: boolean
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
