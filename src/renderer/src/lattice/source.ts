/**
 * 插件中心契约 v2（源码 / 重新发布 / 下载资产 / 导入本地插件目录）的渲染层桥。
 *
 * 背景：主进程 v2 与渲染层是并行任务；主进程类型（`src/preload/index.d.ts`）就绪后，
 * `window.api.lattice` 上这些方法是 required，但**运行中的旧主进程 / 旧 preload**
 * 仍可能没有它们。因此页面不直接 `window.api.lattice.xxx`，而是：
 * - 用 `detectLatticeV2Capabilities()` 拿「当前运行的主进程支持哪些 v2 能力」，入口按能力禁用；
 * - 通过 `LatticeProvider` 暴露的包装方法调用（Provider 内部用 `getLatticeV2Bridge()`）。
 *
 * 这样旧主进程上 UI 只是隐藏/禁用对应入口并提示，不会抛 `xxx is not a function`。
 */
import { getLatticeBridge } from './api'
import type {
  LatticeBridgeV2,
  LatticeOpenSourceResult,
  LatticeV2CapabilityKey,
  LatticeV2Methods
} from './types'

export type { LatticeV2CapabilityKey }

/** 当前运行的主进程支持哪些 v2 能力（false = 旧主进程，UI 禁用入口并提示） */
export type LatticeV2Capabilities = Record<LatticeV2CapabilityKey, boolean>

/** 契约 v2 的六个方法名（顺序 = UI 上能力提示的顺序） */
const V2_CAPABILITY_KEYS: LatticeV2CapabilityKey[] = [
  'publishInstalled',
  'sourcePath',
  'localSource',
  'openSource',
  'republish',
  'downloadAsset',
  'importLocalDir'
]

/** 取 v1+v2 形状的桥；主进程未注册 lattice 通道时返回 null */
export function getLatticeV2Bridge(): LatticeBridgeV2 | null {
  return getLatticeBridge()
}

/** 探测当前主进程提供了哪些 v2 通道（Provider 初始化时算一次；能力在应用生命周期内不变） */
export function detectLatticeV2Capabilities(): LatticeV2Capabilities {
  const bridge = getLatticeV2Bridge()
  // await 运行时形状而不是类型：旧 preload 上这些键是 undefined
  const runtime = bridge as unknown as Partial<Record<keyof LatticeV2Methods, unknown>> | null
  const capabilities = {} as LatticeV2Capabilities
  for (const key of V2_CAPABILITY_KEYS) {
    capabilities[key] = typeof runtime?.[key] === 'function'
  }
  return capabilities
}

/** `openSource` 结果是否是「回退到文件管理器」（没有自动建对话） */
export function isFolderFallback(
  result: LatticeOpenSourceResult
): result is { ok: true; opened: 'folder'; path?: string } {
  return result.ok && 'opened' in result && result.opened === 'folder'
}

/** `openSource` 结果是否真的开了插件会话（能拿到工作区 id） */
export function isChatOpened(
  result: LatticeOpenSourceResult
): result is {
  ok: true
  workspaceId: number
  topicId?: number
  mode?: 'conversation'
  path?: string
} {
  return result.ok && 'workspaceId' in result && typeof result.workspaceId === 'number'
}
