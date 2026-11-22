/**
 * 视图 chunk 预加载（注册表驱动版）
 *
 * 背景：懒加载页面（Harness / Planner / Music 及外部插件页）首次切换时才现场加载
 * 对应 chunk。重型 chunk（如 Harness 的整套代码编辑器）下载 + 求值期间界面会
 * 「卡在上一页」一会儿。
 *
 * 方案（与旧实现一致，改为注册表驱动）：
 * 1. 启动后的空闲时段分批提前 import 各 chunk（重 → 轻），首次切换时模块
 *    已求值完毕，直接渲染目标页面；
 * 2. 侧边栏悬停/聚焦时也提前加载对应 chunk，作为空闲预加载未完成时的兜底；
 * 3. 万一仍未就绪，Suspense 会展示对应页面的骨架屏（见 RouteSkeleton）。
 *
 * 插件化语义：任务列表来自宿主注册表中「已启用插件」的路由 loader，
 * 停用的插件不参与预加载。
 */

export type LazyModule = () => Promise<{ default: unknown }>

const inflight = new Map<string, Promise<void>>()

/** 立即加载指定插件的 chunk；幂等，重复调用共享同一次加载 */
export function preloadView(key: string, load: LazyModule): Promise<void> {
  const running = inflight.get(key)
  if (running) return running
  const task = load()
    .then(() => undefined)
    .catch((err) => {
      // 预加载失败不阻塞使用：Suspense 仍会按需加载并显示骨架屏
      console.warn(`[preload] Failed to preload view "${key}"`, err)
    })
  inflight.set(key, task)
  return task
}

const scheduledKeys = new Set<string>()

/**
 * 启动后空闲预加载：按传入顺序分批（先重后轻由调用方排序），
 * 每个 key 只调度一次（插件在运行中重新启用后仍能补调度新 key）。
 */
export function scheduleViewPreload(tasks: { key: string; load: LazyModule }[]): void {
  let slot = 0
  for (const task of tasks) {
    if (scheduledKeys.has(task.key)) continue
    scheduledKeys.add(task.key)
    const delay = 3000 + slot * 2000
    slot += 1
    runWhenIdle(() => preloadView(task.key, task.load), delay, 2500)
  }
}

function runWhenIdle(task: () => void, minDelay: number, idleTimeout: number): void {
  window.setTimeout(() => {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(() => task(), { timeout: idleTimeout })
    } else {
      task()
    }
  }, minDelay)
}
