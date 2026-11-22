/**
 * Lattice 插件中心：渲染层类型。
 *
 * **DTO 的真源是 `src/main/lattice/types.ts`**（main / preload / renderer 三端共享类型，
 * 契约见 `lattice/.dev/ryten-lattice-contract.md` §2 与 `ryten-lattice-contract-v2.md` §2）；
 * 这里只做类型 re-export，保证渲染层与主进程不会各写一套类型漂移（type-only 导入在构建时被
 * 完全擦除，不会把主进程代码打进渲染包）。
 *
 * v2（源码包 / 重新发布 / 下载资产 / 导入本地插件目录）的 DTO 已由主进程任务合入
 * `src/main/lattice/types.ts`，渲染层直接复用；`lattice/source.ts` 只保留**运行时能力探测**
 * （旧主进程 / 旧 preload 上这些方法可能还是 undefined，UI 按能力禁用入口）。
 *
 * 本文件额外提供：
 * - `LatticeApi`：直接取 preload 官方桥类型，preload 改签名时这里立刻编译失败；
 * - `LatticeV2Methods` / `LatticeV2CapabilityKey`：v2 方法的 optional 形状，只用于运行时能力探测；
 * - `EMPTY_LATTICE_STATUS` / `EMPTY_HUB_LIST` / `emptySyncResult()`：主进程通道缺失时的安全兜底值。
 */
import type {
  HubDetail,
  HubEntry,
  HubListResult,
  HubVersion,
  LatticeDownloadAssetKind,
  LatticeDownloadAssetResult,
  LatticeImportLocalDirResult,
  LatticeInstallResult,
  LatticeLocalSourcePathResult,
  LatticeOpenSourceResult,
  LatticeRepublishInput,
  LatticeRepublishResult,
  LatticeSourcePathResult,
  LatticeStatus,
  LatticeSyncResult
} from '../../../main/lattice/types'

export type {
  HubDetail,
  HubEntry,
  HubListResult,
  HubVersion,
  LatticeAutoInstallSettingResult,
  LatticeDownloadAssetKind,
  LatticeDownloadAssetResult,
  LatticeImportLocalDirResult,
  LatticeImportLocalItem,
  LatticeImportLocalSkipped,
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
  LatticeSourceManaged,
  LatticeSourcePathResult,
  LatticeStatus,
  LatticeSyncAutoInstallFailure,
  LatticeSyncAutoInstallItem,
  LatticeSyncAutoInstallResult,
  LatticeSyncDetails,
  LatticeSyncDirection,
  LatticeSyncInput,
  LatticeSyncOrphanedItem,
  LatticeSyncOrphanReason,
  LatticeSyncOptions,
  LatticeSyncResult,
  LatticeSyncConflict,
  LatticeResolveConflictResult,
  LatticeSyncSummary,
  LatticeUploadProgress,
  LatticeUploadResult,
  LatticeUser
} from '../../../main/lattice/types'

/**
 * `window.api.lattice` 的桥形状：**直接取 preload 的官方类型**（`Window['api']['lattice']`，
 * 由 `src/preload/index.d.ts` 声明，DTO 真源是 `src/main/lattice/types.ts`）。
 *
 * 这样渲染层不需要手写一份桥接口：preload 改签名（例如 `sourcePath(pluginId)`）
 * 时这里会立刻编译失败，而不是运行期才暴露。`getLatticeBridge()` 负责运行时探测桥是否存在
 * （主进程未注册通道 / 旧版 preload 环境下返回 null，UI 安全降级）。
 */
export type LatticeApi = Window['api']['lattice']

/** v1 桥 + v2 增量（v2 方法在主进程类型里已是 required；运行时能力探测仍按 optional 处理） */
export type LatticeBridgeV2 = LatticeApi

// ---------------------------------------------------------------------------
// 契约 v2 的页面别名：主进程 / preload 类型就绪后直接复用，避免两套 DTO 漂移
// ---------------------------------------------------------------------------

/** 目录项（含 v2 `has_source`） */
export type HubEntryV2 = HubEntry
/** 版本对象（含 v2 源码包元数据） */
export type HubVersionV2 = HubVersion
/** 详情（readme + 版本清单 + 我的安装记录） */
export type HubDetailV2 = HubDetail
/** 目录分页结果 */
export type HubListResultV2 = HubListResult
/** 安装结果（v2 多了 sourcePath / sourceManaged / sourceError，源码失败不影响安装） */
export type LatticeInstallResultV2 = LatticeInstallResult
/** 下载资产类型（安装包 / 源码包） */
export type LatticeDownloadKind = LatticeDownloadAssetKind
/** 下载资产结果 */
export type LatticeDownloadResult = LatticeDownloadAssetResult
/** 本机安装目录（`lattice:local-source-path`） */
export type LatticeLocalSourceResult = LatticeLocalSourcePathResult

/**
 * 契约 v2 的桥增量方法（**optional 形状，只用于运行时能力探测**）。
 *
 * 主进程类型就绪后这些方法在 `window.api.lattice` 上已经是 required；但**运行中的旧主进程 /
 * 旧 preload** 上仍然没有它们。`detectLatticeV2Capabilities()` 逐方法 `typeof === 'function'`，
 * 页面按结果禁用入口并提示，而不是运行期 `not a function`。
 */
export interface LatticeV2Methods {
  /** 本机源码目录（path/version/managed） */
  sourcePath?: (pluginId: string) => Promise<LatticeSourcePathResult>
  /** 本机已安装插件包目录（userData/plugins/<id>） */
  localSource?: (pluginId: string) => Promise<LatticeLocalSourceResult>
  /** 打开源码：优先插件会话，失败回退文件管理器 */
  openSource?: (pluginId: string) => Promise<LatticeOpenSourceResult>
  /** 读本机源码目录重新打包（安装包 + 源码）并发布新版本 */
  republish?: (input: LatticeRepublishInput) => Promise<LatticeRepublishResult>
  /** 下载某个版本的安装包 / 源码包（主进程弹保存框） */
  downloadAsset?: (
    pluginId: string,
    version: string,
    kind: LatticeDownloadKind
  ) => Promise<LatticeDownloadResult>
  /** 弹目录选择框，把目录下所有 plugin.json 插件批量发布到插件中心 */
  importLocalDir?: () => Promise<LatticeImportLocalDirResult>
}

/** v2 能力键（`LatticeV2Capabilities` 的键集合） */
export type LatticeV2CapabilityKey = keyof LatticeV2Methods

/** 主进程未注册 lattice 通道时的安全兜底状态（不是错误：UI 会退化成「插件中心未就绪」） */
export const EMPTY_LATTICE_STATUS: LatticeStatus = {
  configured: false,
  baseUrl: '',
  loggedIn: false
}

export const EMPTY_HUB_LIST: HubListResultV2 = {
  items: [],
  total: 0,
  page: 1,
  page_size: 0
}

/** 同步失败/不可用时的兜底结果（字段齐全，UI 先看 error 再展示计数） */
export function emptySyncResult(error?: string): LatticeSyncResult {
  return { at: 0, pushed: 0, pulled: 0, conflicts: 0, error }
}
