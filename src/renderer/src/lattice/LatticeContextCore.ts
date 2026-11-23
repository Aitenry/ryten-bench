import { createContext } from 'react'
import { EMPTY_HUB_LIST, EMPTY_LATTICE_STATUS, emptySyncResult } from './types'
import type {
  HubDetailV2,
  HubListResultV2,
  LatticeAutoInstallSettingResult,
  LatticeDownloadKind,
  LatticeDownloadResult,
  LatticeImportLocalDirResult,
  LatticeInstallResultV2,
  LatticeListQuery,
  LatticeLoginInput,
  LatticeLoginResult,
  LatticeOpenSourceResult,
  LatticeRepublishInput,
  LatticeRepublishResult,
  LatticeSourcePathResult,
  LatticeStatus,
  LatticeSyncDetails,
  LatticeSyncDirection,
  LatticeSyncResult,
  LatticeUploadProgress,
  LatticeUploadResult,
  LatticeUser
} from './types'
import type { LatticeV2Capabilities } from './source'
import { LATTICE_BRIDGE_MISSING } from './api'

/**
 * 插件中心上下文的**契约**（Provider 的消费面）。
 *
 * 单独放一个文件（与 `contexts/ThemeContextCore.ts` 同一约定）有两个原因：
 * 1. `react-refresh/only-export-components` 要求「只导出组件」的文件才可热更新，
 *    上下文对象不能和 `<LatticeProvider>` 放在同一个模块里；
 * 2. 页面只依赖这个类型/上下文，而不直接依赖 Provider 实现。
 *
 * 职责：Provider 持有 `window.api.lattice` 的全部状态（登录态、同步、上传进度、目录数据），
 * 并把每个 IPC 方法包一层（登录/退出/同步后自动刷新状态）。主进程通道尚未注册时
 * `available=false`，所有方法返回「不可用」的兜底结果，UI 安全降级。
 */
export interface LatticeContextValue {
  /** 主进程是否暴露了 `window.api.lattice`（false = 插件中心未就绪，UI 需要降级） */
  available: boolean
  /** 是否已完成首次状态读取（false 时账号区显示「连接中…」而不是闪一下未登录） */
  ready: boolean
  status: LatticeStatus
  loggedIn: boolean
  user: LatticeUser | undefined
  role: string | undefined
  /**
   * 账号头像（`user.avatar` 的归一化视图）：非空 = 平台头像地址（https/data:image），
   * null = 无头像（界面回退首字母）。旧主进程没有 avatar 字段时也是 null，不报错。
   */
  avatar: string | null
  /** 同步动作进行中（账号区显示小 spinner） */
  syncing: boolean
  /** 最近一次上传进度（上传弹窗消费；没有上传时为 null） */
  uploadProgress: LatticeUploadProgress | null
  clearUploadProgress: () => void
  refresh: () => Promise<LatticeStatus>
  login: (input: LatticeLoginInput) => Promise<LatticeLoginResult>
  logout: () => Promise<{ ok: boolean }>
  /** 手动同步（direction 缺省 both；`installMissing` 缺省跟随设置项，默认开启自动补齐） */
  sync: (
    direction?: LatticeSyncDirection,
    options?: { installMissing?: boolean }
  ) => Promise<LatticeSyncResult>
  /** 同步详情：最近一次同步的自动补齐成功/失败明细 + 孤儿记录（失败原因可查看） */
  syncDetails: () => Promise<LatticeSyncDetails>
  /** 保存「缺失插件自动补齐」开关（持久化；默认开启） */
  setAutoInstallMissing: (enabled: boolean) => Promise<LatticeAutoInstallSettingResult>
  listHub: (params?: LatticeListQuery) => Promise<HubListResultV2>
  detailHub: (pluginId: string) => Promise<HubDetailV2 | null>
  installFromHub: (pluginId: string, version?: string) => Promise<LatticeInstallResultV2>
  /** 直接发布本机已安装插件（安装包 + 源码，不弹目录选择框） */
  publishInstalled: (pluginId: string) => Promise<LatticeUploadResult>
  pickAndUpload: () => Promise<LatticeUploadResult>
  /** 选 .zip 安装包发布（目录上传的补充入口） */
  pickAndUploadZip: () => Promise<LatticeUploadResult>
  /** 选「安装包目录 + 源码目录」发布：安装包与源码是两份不同的 zip */
  pickAndUploadWithSource: () => Promise<LatticeUploadResult>
  /** 按显式路径发布：`source` 是安装包目录/zip；`sourcePath` 给出时源码单独上传 */
  uploadSource: (source: string, sourcePath?: string) => Promise<LatticeUploadResult>

  // ---- 契约 v2：源码 / 重新发布 / 导入本地插件目录 ----
  /** 当前主进程支持哪些 v2 能力（false = 旧主进程，对应入口禁用并提示） */
  capabilities: LatticeV2Capabilities
  /** 本机已下载的源码目录（未下载 / 无源码 → path:null） */
  sourcePath: (pluginId: string) => Promise<LatticeSourcePathResult>
  /** 本机安装目录（`userData/plugins/<id>`，本地安装后发布用；拿不到 → null） */
  localSource: (pluginId: string) => Promise<string | null>
  /** 打开源码：优先建/复用工作区与插件会话，失败回退文件管理器 */
  openSource: (pluginId: string) => Promise<LatticeOpenSourceResult>
  /** 读本机源码目录，重新打包安装包 + 源码并发布新版本 */
  republish: (input: LatticeRepublishInput) => Promise<LatticeRepublishResult>
  /** 下载某个版本的安装包 / 源码包（主进程弹保存框并落盘） */
  downloadAsset: (
    pluginId: string,
    version: string,
    kind: LatticeDownloadKind
  ) => Promise<LatticeDownloadResult>
  /** 弹目录选择框，把目录下所有 plugin.json 插件批量发布到插件中心 */
  importLocalDir: () => Promise<LatticeImportLocalDirResult>
}

/** 未挂 Provider（或 Provider 初始化前）时也能安全调用：一律走「不可用」分支 */
const LATTICE_FALLBACK: LatticeContextValue = {
  available: false,
  ready: false,
  status: EMPTY_LATTICE_STATUS,
  loggedIn: false,
  user: undefined,
  role: undefined,
  avatar: null,
  syncing: false,
  uploadProgress: null,
  clearUploadProgress: () => {},
  refresh: async () => EMPTY_LATTICE_STATUS,
  login: async () => ({ ok: false, error: LATTICE_BRIDGE_MISSING }),
  logout: async () => ({ ok: false }),
  sync: async () => emptySyncResult(LATTICE_BRIDGE_MISSING),
  syncDetails: async () => ({ last: null, conflicts: [], orphaned: [] }),
  setAutoInstallMissing: async () => ({ ok: false, enabled: true, error: LATTICE_BRIDGE_MISSING }),
  listHub: async () => EMPTY_HUB_LIST,
  detailHub: async () => null,
  installFromHub: async () => ({ ok: false, error: LATTICE_BRIDGE_MISSING }),
  publishInstalled: async () => ({ ok: false, error: LATTICE_BRIDGE_MISSING }),
  pickAndUpload: async () => ({ ok: false, error: LATTICE_BRIDGE_MISSING }),
  pickAndUploadZip: async () => ({ ok: false, error: LATTICE_BRIDGE_MISSING }),
  pickAndUploadWithSource: async () => ({ ok: false, error: LATTICE_BRIDGE_MISSING }),
  uploadSource: async () => ({ ok: false, error: LATTICE_BRIDGE_MISSING }),
  capabilities: {
    publishInstalled: false,
    sourcePath: false,
    openSource: false,
    republish: false,
    localSource: false,
    downloadAsset: false,
    importLocalDir: false
  },
  sourcePath: async () => ({ path: null }),
  localSource: async () => null,
  openSource: async () => ({ ok: false, error: LATTICE_BRIDGE_MISSING }),
  republish: async () => ({ ok: false, error: LATTICE_BRIDGE_MISSING }),
  downloadAsset: async () => ({ ok: false, error: LATTICE_BRIDGE_MISSING }),
  importLocalDir: async () => ({ ok: false, error: LATTICE_BRIDGE_MISSING })
}

export const LatticeContext = createContext<LatticeContextValue>(LATTICE_FALLBACK)
