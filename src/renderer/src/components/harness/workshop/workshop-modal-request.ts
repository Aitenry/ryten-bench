/**
 * 「插件工坊」弹窗的跨路由打开请求。
 *
 * 背景：插件工坊 UI 从设置弹窗搬到了插件仓库页（`PluginRepository` 里的 `Modal` +
 * `WorkshopSettings embedded`），而侧栏（`HarnessSidebar`）在 Harness 路由下、跟插件仓库
 * 不是同一棵子树——侧栏点插件行要「导航到 /plugins 并打开工坊、展开这份插件」，
 * 只能靠一个跨路由的待处理请求（与 `settings-modal-state.ts` 同一套模块级快照思路）。
 *
 * 为什么不用 CustomEvent：事件在导航前派发，目标页还没挂载 → 监听不到（旧实现就是这样
 * 丢了事件，用户只看到设置弹窗或空白页）。这里把请求暂存，目标页挂载后 `take()` 取走。
 */
export interface WorkshopModalRequest {
  /** 要展开详情的草稿 id；undefined = 只打开工坊列表 */
  draftId?: string
}

let pending: WorkshopModalRequest | null = null
const listeners = new Set<() => void>()

/** 请求打开插件工坊（通常紧接着 navigate('/plugins')） */
export function requestWorkshopModal(draftId?: string): void {
  pending = { draftId }
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (err) {
      console.error('[workshop] Error in open-request subscription callback:', err)
    }
  }
}

/** 取走待处理请求（取走后清空，避免再次进入页面时重复弹窗） */
export function takeWorkshopModalRequest(): WorkshopModalRequest | null {
  const request = pending
  pending = null
  return request
}

/** 订阅「有新的打开请求」（插件仓库页在已挂载时也能即时响应） */
export function subscribeWorkshopModalRequest(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}
