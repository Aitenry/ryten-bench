/**
 * Lattice 插件中心（平台用户面 `/v1/hub`）在 main / preload / renderer 之间的共享类型。
 *
 * 边界：本文件被三端 import，因此**不得**引入 electron / node / React 依赖——
 * preload 与渲染层都要能直接打包。契约见 `.dev/ryten-lattice-contract.md` 第 2、3 节；
 * 平台权威契约见 `lattice/platform/docs/Lattice-平台接口文档.md` §12。
 */

/**
 * 登录用户（`/v1/auth/login`、`/v1/auth/refresh` 的 `user` 与 `/v1/me` 归一后的形状）。
 *
 * `avatar` 是平台 v0.8 起的个人头像（`users.avatar`）：`null` = 无头像（界面回退用户名
 * 首字母），非空 = `https://` URL 或 `data:image/(png|jpeg|webp|gif);base64,...`。
 * 字段整体可缺省：**旧平台**（avatar 上线前的节点）不返回它，旧主进程也会把它省略，
 * 渲染层一律按 `null` 处理（不报错、不显示破图）。
 */
export interface LatticeUser {
  id: string
  username: string
  display_name?: string | null
  avatar?: string | null
}

/**
 * 归一化平台 / 会话文件里的 `avatar` 原始值，区分「明确没有头像」和「旧版没有这个字段」：
 * - 非空字符串 → 去掉首尾空白后原样返回（形态校验交给渲染层，坏值按首字母回退）；
 * - 空串 / `null` → `null`（平台明确表示无头像，或用户清空头像）；
 * - 其它（字段缺失 / 非法类型）→ `undefined`（旧平台 / 旧主进程没有该字段，
 *   身份校正时保留已有缓存值，不要把头像误清空）。
 */
export function normalizeLatticeAvatar(raw: unknown): string | null | undefined {
  if (typeof raw === 'string') {
    const value = raw.trim()
    return value === '' ? null : value
  }
  if (raw === null) return null
  return undefined
}

/** 最近一次同步的摘要（设置卡 / 状态条展示） */
export interface LatticeSyncSummary {
  at?: number
  pushed?: number
  pulled?: number
  conflicts?: number
  /** 最近一次同步自动补齐（换机/重装后重新安装缺失插件）成功的数量 */
  autoInstalled?: number
  /** 最近一次同步自动补齐失败的数量（失败原因在同步详情里，不静默） */
  autoInstallFailed?: number
  /** 最近一次同步发现的「平台已删除」安装记录数量（本地数据保留，标记 orphaned） */
  orphaned?: number
  error?: string
}

/** 插件中心当前状态（`lattice:status` 的返回，也是 `lattice:state-changed` 的载荷） */
export interface LatticeStatus {
  /** 是否已配置基址：默认指向 dev 节点，因此为 true */
  configured: boolean
  baseUrl: string
  loggedIn: boolean
  user?: LatticeUser
  role?: string
  /** access token 过期时间（毫秒时间戳；仅内存态，重启后由 refresh 重新取） */
  expiresAt?: number
  lastError?: string
  sync?: LatticeSyncSummary
  /**
   * 「缺失插件自动补齐」开关当前值（默认 **开启**）。
   *
   * 开启时每次 pull 会把「平台有安装记录、本机没有插件包」的插件自动重新安装
   * （换机/重装/用户手动删目录后的恢复）；关闭时只在同步结果的 `pending` 里列出。
   */
  autoInstallMissing?: boolean
}

/** 目录页的一条插件（平台字段原样 + 调用者视角的安装态） */
export interface HubEntry {
  plugin_id: string
  name: string
  description?: string
  icon?: string
  category: string
  tags: string[]
  owner: { id: string; username: string; display_name?: string | null }
  latest_version?: string
  size?: number
  downloads: number
  versions_count: number
  updated_at: string
  installed: boolean
  installed_version?: string
  update_available: boolean
  install_enabled?: boolean
  /** 最新版本是否带源码包（v2 §1.5；旧平台不返回时按 false 处理） */
  has_source?: boolean
}

/** 详情页里的一个发布版本 */
export interface HubVersion {
  version: string
  asset_name: string
  size: number
  sha256: string
  changelog: string
  manifest: unknown
  downloads: number
  published_at?: string
  /** 该版本是否带源码包（v2 §1.5） */
  has_source?: boolean
  source_asset_name?: string
  source_size?: number
  source_sha256?: string
}

/** 详情（目录字段 + readme + 版本清单 + 调用者的安装记录） */
export interface HubDetail extends HubEntry {
  readme: string
  versions: HubVersion[]
  my_install?: {
    version: string
    enabled: boolean
    data_rev: number
    data_updated_at?: string
  } | null
}

/** 目录分页结果 */
export interface HubListResult {
  items: HubEntry[]
  total: number
  page: number
  page_size: number
}

/** 目录查询参数（渲染层用驼峰，IPC 层转平台下划线） */
export interface LatticeListQuery {
  q?: string
  category?: string
  sort?: 'recent' | 'popular' | 'name'
  page?: number
  pageSize?: number
}

/** 本机已安装插件视图（`lattice:hub-installs` 返回的一项） */
export interface LatticeInstallSummary {
  plugin_id: string
  version?: string
  enabled: boolean
  data_rev?: number
  updated_at?: string
}

/** 同步方向 */
export type LatticeSyncDirection = 'push' | 'pull' | 'both'

/** `lattice:sync` 的入参：`{direction?, installMissing?}`；也接受裸字符串（兼容旧渲染层） */
export interface LatticeSyncOptions {
  direction?: LatticeSyncDirection
  /**
   * pull 时是否自动补齐「平台有安装记录、本机没有插件包」的插件。
   *
   * 省略 = 使用持久化设置项（`lattice-settings.json` 的 `autoInstallMissing`，默认 **开启**）；
   * 显式传 `false` 用于「只看待安装列表、不自动安装」。自动补齐失败会进 `autoInstall.failed`，
   * 不会中断其它插件，也不会把同步整体判失败。
   */
  installMissing?: boolean
}

export type LatticeSyncInput = LatticeSyncOptions | LatticeSyncDirection

/** 自动补齐成功的一个插件 */
export interface LatticeSyncAutoInstallItem {
  plugin_id: string
  version?: string
  /** 安装时一并恢复的源码目录（该版本无源码包 / 源码下载失败时缺省） */
  sourcePath?: string
  /** 源码下载失败的可读原因（安装本身成功） */
  sourceError?: string
}

/** 自动补齐失败的一个插件（换机恢复时版本已被平台删除 / 网络失败等，逐个可见） */
export interface LatticeSyncAutoInstallFailure {
  plugin_id: string
  /** 尝试恢复的版本（= 平台安装记录里的版本；缺省表示 latest） */
  version?: string
  error: string
}

/** 一次 pull 里自动补齐的结果汇总（同步详情的「自动补齐」区块） */
export interface LatticeSyncAutoInstallResult {
  /** 本次尝试自动安装的插件数（= installed.length + failed.length） */
  attempted: number
  installed: LatticeSyncAutoInstallItem[]
  failed: LatticeSyncAutoInstallFailure[]
}

/** 安装记录在平台已不存在的原因：整个插件被删除 / 仅某接口 404（平台版本差异） */
export type LatticeSyncOrphanReason = 'plugin_deleted' | 'not_found'

/**
 * 一条「孤儿」安装记录：平台已删除该插件（push 410/404 或 pull 列表里 plugin=null）。
 *
 * 处理口径：**保留本地插件目录与 plugin-state 数据**（不自动删除用户数据），只做标记，
 * 并在同步详情里可见；插件重新出现在平台上或 push 成功后标记自动消除。
 */
export interface LatticeSyncOrphanedItem {
  plugin_id: string
  version?: string
  reason: LatticeSyncOrphanReason
  /** 首次标记时间（毫秒时间戳） */
  at: number
  /** 平台/客户端给的可读原因（排障用） */
  error?: string
}

/** 一次同步的结果（`lattice:sync` 返回、`lattice:sync-state` 载荷） */
export interface LatticeSyncResult {
  at: number
  pushed: number
  pulled: number
  conflicts: number
  error?: string
  /** 云端有安装记录、但本机没有插件包而**未自动安装**的插件 id（自动补齐关闭/不可用时） */
  pending?: string[]
  /** 自动补齐结果（pull 时；没开启或没有缺失插件时缺省） */
  autoInstall?: LatticeSyncAutoInstallResult
  /** 当前仍未解决的「平台已删除」安装记录（保留本地数据，只做标记） */
  orphaned?: LatticeSyncOrphanedItem[]
}

/** `lattice:sync-details` 返回：同步详情弹窗的数据（自动补齐失败 / 冲突 / 孤儿记录） */
export interface LatticeSyncDetails {
  /** 最近一次同步（含 autoInstall / orphaned 明细；冷启动从缓存恢复） */
  last: LatticeSyncResult | null
  conflicts: LatticeSyncConflict[]
  orphaned: LatticeSyncOrphanedItem[]
}

/** `lattice:set-auto-install-missing` 返回：开关落盘后的状态 */
export interface LatticeAutoInstallSettingResult {
  ok: boolean
  enabled: boolean
  status?: LatticeStatus
  error?: string
}

/** 未解决的插件数据冲突（`data_rev` 不一致；由「解决冲突」弹窗让用户显式选择用哪边） */
export interface LatticeSyncConflict {
  plugin_id: string
  local_rev: number
  server_rev: number
  /** 冲突当时的本机数据快照（用于预览/用本机覆盖） */
  local_data?: unknown
  /** 打开弹窗时补拉的云端数据快照（用于预览） */
  server_data?: unknown
  at: number
}

export type LatticeResolveConflictStrategy = 'local' | 'cloud'

export type LatticeResolveConflictResult = { ok: true } | { ok: false; error: string }

/** 上传阶段进度（`lattice:upload-progress` 载荷） */
export interface LatticeUploadProgress {
  phase: 'zip' | 'meta' | 'upload'
  sent: number
  total: number
}

/** 登录入参。`baseUrl` 省略时使用当前基址（设置项 / RB_LATTICE_URL / 默认值） */
export interface LatticeLoginInput {
  baseUrl?: string
  username: string
  password: string
}

/** 登录结果：失败不抛错，返回 `{ok:false,error}` 由界面展示平台 message */
export type LatticeLoginResult =
  { ok: true; user: LatticeUser; role?: string } | { ok: false; error: string }

/** 上传结果。用户取消选择框不是失败（`canceled:true`） */
export type LatticeUploadResult =
  | { ok: true; canceled: true }
  | { ok: true; plugin_id: string; version: string }
  | { ok: false; error: string }

/** 下载安装结果：失败不抛到渲染层，返回 `{ok:false,error}` */
export type LatticeInstallResult =
  | {
      ok: true
      id: string
      name: string
      version: string
      /**
       * 安装时自动下载并解压的源码目录（v2 §2）。
       *
       * 目录优先级：用户配置的「插件存放路径」`<pluginsPath>/<id>/`（= workshop 草稿目录，
       * 插件模式侧栏能看到、能和模型对话修改）→ 未配置时回退
       * `userData/plugin-sources/<id>/<version>/`。
       */
      sourcePath?: string
      sourceVersion?: string
      /** 源码落在哪类目录：pluginsPath = 用户插件存放路径；userData = 应用数据目录回退 */
      sourceManaged?: LatticeSourceManaged
      /** 源码下载/解压失败的可读原因（**不影响安装成功**，本地插件包已经装好） */
      sourceError?: string
      /** 覆盖本机已有源码前留的备份目录（源码曾在本机被修改过时才有） */
      sourceBackupPath?: string
    }
  | { ok: false; error: string }

/** 源码在本机的落地位置（`lattice:source-path` / 安装结果的 `sourceManaged`） */
export type LatticeSourceManaged = 'pluginsPath' | 'userData'

/** `lattice:source-path` 返回：当前可编辑的源码目录 */
export interface LatticeSourcePathResult {
  path: string | null
  version?: string
  /**
   * 源码目录种类：
   * - `pluginsPath` = 用户配置的插件存放路径（workshop 草稿目录，插件模式可开对话）；
   * - `userData` = 应用数据目录回退（未配置插件存放路径时）；
   * 没有源码时整个字段缺省。
   */
  managed?: LatticeSourceManaged
}

/** `lattice:local-source-path` 返回：本机已安装插件包目录（`userData/plugins/<id>`，本地安装后发布用） */
export interface LatticeLocalSourcePathResult {
  path: string | null
  version?: string
}

/**
 * `lattice:open-source` 返回（v2 §2 + Lead 2026-11-21 补充）：
 * - 成功开对话：`{ok:true,workspaceId,topicId?}`（工作区=插件源码目录，话题=插件会话）；
 * - 无法可靠切换插件模式时回退文件管理器：`{ok:true,opened:'folder',path}`（不假装开了对话）；
 * - 失败：`{ok:false,error}`。
 */
export type LatticeOpenSourceResult =
  | {
      ok: true
      workspaceId: number
      topicId?: number
      /** 'conversation' = 真的建/复用了插件工作区并开了一条插件会话 */
      mode?: 'conversation'
      /** 对话使用的工作目录（= 插件源码目录） */
      path?: string
    }
  | { ok: true; opened: 'folder'; path?: string }
  | { ok: false; error: string }

/** `lattice:republish` 入参 */
export interface LatticeRepublishInput {
  pluginId: string
  /** 新版本号（必填 semver；必须大于平台当前最新版本，服务端 409 会转成可读错误） */
  version: string
  changelog?: string
  /** 源码目录；缺省 = sourcePath，再缺省 = localSourcePath（userData/plugins/<id>） */
  sourceDir?: string
}

/** `lattice:republish` 返回：安装包 = 源码目录整包 zip，源码包 = 同一份字节 */
export type LatticeRepublishResult =
  | { ok: true; plugin_id: string; version: string; sourcePath?: string }
  | { ok: false; error: string }

/** 下载类型：安装包 / 源码包 */
export type LatticeDownloadAssetKind = 'package' | 'source'

/** `lattice:download-asset` 返回：弹保存框下载；用户取消不是失败（canceled=true，savedPath 为空串） */
export type LatticeDownloadAssetResult =
  { ok: true; savedPath: string; canceled?: boolean } | { ok: false; error: string }

/** 本地目录批量导入：一个成功发布的插件 */
export interface LatticeImportLocalItem {
  plugin_id: string
  version: string
}

/** 本地目录批量导入：一个被跳过的插件目录（reason 是平台/校验给的可读原因） */
export interface LatticeImportLocalSkipped {
  dir: string
  reason: string
}

/**
 * `lattice:import-local-dir` 返回：弹目录选择框 → 扫描直接子目录（也支持所选目录本身是单个插件）
 * 中带 `plugin.json` 的插件 → 逐个发布到平台（安装包 + 源码同包上传）。
 */
export type LatticeImportLocalDirResult =
  | {
      ok: true
      canceled?: boolean
      imported: LatticeImportLocalItem[]
      skipped: LatticeImportLocalSkipped[]
      /** 本次扫描的根目录（UI 可提示"设为插件存放路径"） */
      root?: string
    }
  | { ok: false; error: string }

/** 显式设置「插件存放路径」（立即生效；插件中心导入本地目录后使用） */
export type LatticeSetPluginRootResult = { ok: true; dir: string } | { ok: false; error: string }

/** 基址设置结果 */
export interface LatticeSetBaseUrlResult {
  ok: boolean
  status: LatticeStatus
  error?: string
}

/** `lattice:me` 返回 */
export interface LatticeMeResult {
  user: LatticeUser
  role: string
}

// ---------- 平台 API 记录类型（main 内部使用，preload 不直接用） ----------

/** `GET /v1/hub/installs?include_data=1` 里的一项 */
export interface LatticeRemoteInstall {
  plugin_id: string
  version?: string
  enabled?: boolean
  data_rev?: number
  data_updated_at?: string
  last_device?: string | null
  updated_at?: string
  plugin?: {
    name?: string
    icon?: string
    latest_version?: string
    /** 插件状态（平台对已下架插件返回 `removed`；老平台可能不返回） */
    status?: string
  } | null
  /**
   * 平台安装记录指向的插件已删除：平台明确返回 `plugin:null`，或 `plugin.status==='removed'`
   * （平台是软删：插件行仍在，`status=removed`）。老平台两者都没有时保持 false，避免误标。
   */
  plugin_deleted?: boolean
  data?: unknown
}

/** `PUT /v1/hub/installs/{plugin_id}` 的请求体 */
export interface LatticeInstallPutBody {
  version?: string
  enabled?: boolean
  data?: unknown
  /** 提交 data 时必填：客户端上次看到的数据版本号（新记录填 0） */
  data_rev?: number
  device_id?: string
  force?: boolean
}

/** IPC 通道名（main 注册 / preload 调用共用一份常量，避免字符串漂移） */
export const LATTICE_IPC = {
  status: 'lattice:status',
  login: 'lattice:login',
  logout: 'lattice:logout',
  me: 'lattice:me',
  setBaseUrl: 'lattice:set-base-url',
  hubList: 'lattice:hub-list',
  hubDetail: 'lattice:hub-detail',
  hubPickUpload: 'lattice:hub-pick-upload',
  hubUpload: 'lattice:hub-upload',
  hubPickUploadZip: 'lattice:hub-pick-upload-zip',
  hubInstall: 'lattice:hub-install',
  hubInstalls: 'lattice:hub-installs',
  /** 当前源码目录（path/version/managed） */
  sourcePath: 'lattice:source-path',
  /** 本机已安装插件包目录（userData/plugins/<id>） */
  localSourcePath: 'lattice:local-source-path',
  /** 在对话中修改源码：建/复用插件工作区并开插件会话，失败回退文件管理器 */
  openSource: 'lattice:open-source',
  /** 重新发布新版本（安装包 + 源码同包上传） */
  republish: 'lattice:republish',
  /** 下载安装包 / 源码包到本机（弹保存框） */
  downloadAsset: 'lattice:download-asset',
  /** 弹目录选择框，把本地插件源码目录批量发布到平台 */
  importLocalDir: 'lattice:import-local-dir',
  setPluginRoot: 'lattice:set-plugin-root',
  sync: 'lattice:sync',
  syncConflicts: 'lattice:sync-conflicts',
  /** 同步详情：最近一次同步的自动补齐/孤儿记录明细（失败可查看原因） */
  syncDetails: 'lattice:sync-details',
  resolveConflict: 'lattice:resolve-conflict',
  /** 缺失插件自动补齐开关（持久化设置；默认开启） */
  setAutoInstallMissing: 'lattice:set-auto-install-missing',
  stateChanged: 'lattice:state-changed',
  uploadProgress: 'lattice:upload-progress',
  syncState: 'lattice:sync-state'
} as const
