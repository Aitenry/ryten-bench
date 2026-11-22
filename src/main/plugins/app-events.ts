import logger from 'electron-log'

/**
 * 主进程侧的极简应用事件总线（core 所有）。
 *
 * 用途：core 在固定时机「通知」插件（例如系统设置里切换了工作区），插件订阅后自己响应。
 * 与 `contributions.ts` 的分工：贡献点是**拉取**语义（宿主要在固定时机主动执行插件提供的钩子），
 * 事件是**推送**语义（时机由 core 触发，参与者数量不定、可为零）。两者互补，不互相替代。
 *
 * 语义：
 * - **同步派发**：`emitAppEvent` 依次调用订阅者，订阅者若返回 Promise 不会被等待
 *   （钩子类时机用贡献点做，那里才需要等待）；
 * - **异常吞掉**：单个订阅者抛错只记 `logger.warn`，不影响后续订阅者、不影响 core 流程
 *   （插件出错不能把外壳拖下水）；
 * - **可逆**：`onAppEvent` 返回解绑函数，插件在 `ctx.effect(() => onAppEvent(...))` 里订阅，
 *   停用即自动解绑（不需要宿主知道有哪些插件在听）。
 */

type AppEventHandler = (payload: unknown) => void

/** 事件名 → 订阅者集合（插入顺序派发） */
const handlers = new Map<string, Set<AppEventHandler>>()

/** 订阅应用事件；返回解绑函数（幂等） */
export function onAppEvent(name: string, handler: AppEventHandler): () => void {
  let set = handlers.get(name)
  if (!set) {
    set = new Set()
    handlers.set(name, set)
  }
  set.add(handler)
  return () => {
    const current = handlers.get(name)
    if (!current) return
    current.delete(handler)
    if (current.size === 0) handlers.delete(name)
  }
}

/** 派发应用事件（同步；单个订阅者异常只记日志） */
export function emitAppEvent(name: string, payload?: unknown): void {
  const set = handlers.get(name)
  if (!set || set.size === 0) return
  for (const handler of [...set]) {
    try {
      handler(payload)
    } catch (err) {
      logger.warn(`[AppEvents] Subscriber for event '${name}' failed:`, err)
    }
  }
}

/** 当前某事件的订阅者数量（仅供诊断/工装断言） */
export function appEventListenerCount(name: string): number {
  return handlers.get(name)?.size ?? 0
}
