import type { LatticeApi } from './types'

/**
 * `window.api.lattice` 的安全访问层。
 *
 * preload 已提供 `api.lattice` 的类型（`src/preload/index.d.ts`，DTO 真源是
 * `src/main/lattice/types.ts`）。这里仍然做**运行时探测**而不是直接读：
 *
 * - 主进程可能尚未注册 `lattice:*` 通道（开发期/旧版本主进程）；
 * - 单元测试/纯浏览器预览环境没有 preload，`window.api` 可能是 undefined；
 * - 探测到桥不存在时返回 null，所有 UI 安全降级（账号区显示「插件中心未就绪」）。
 */
interface LatticeBridgeHost {
  api?: {
    lattice?: Partial<LatticeApi>
  }
}

/** 取主进程暴露的插件中心桥；主进程未注册通道时返回 null（调用方必须降级） */
export function getLatticeBridge(): LatticeApi | null {
  try {
    const host = window as unknown as LatticeBridgeHost
    const bridge = host.api?.lattice
    if (!bridge) return null
    // 只校验一个核心方法：主进程注册了通道就一定能 status()，避免半初始化对象被当成可用桥
    if (typeof bridge.status !== 'function') return null
    return bridge as LatticeApi
  } catch {
    // 非浏览器 / 受限环境：当作没有桥处理
    return null
  }
}

export function isLatticeBridgeAvailable(): boolean {
  return getLatticeBridge() !== null
}

/** 把任意异常归一成可展示的一句话（主进程 IPC 抛出的错误常常是 Error 或字符串） */
export function latticeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const maybeMessage = (error as { message?: unknown }).message
    if (typeof maybeMessage === 'string') return maybeMessage
  }
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/** 主进程通道缺失时统一返回的错误文案（组件不会直接展示它，UI 会先按 available 降级） */
export const LATTICE_BRIDGE_MISSING = 'lattice bridge unavailable'
