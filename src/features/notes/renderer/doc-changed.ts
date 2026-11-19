/**
 * 「文档被 AI 工具改写」通知的插件内中转。
 *
 * 事件源是 harness 插件：它把主进程的 `plugin:harness:harness-doc-changed` 桥接成**宿主事件
 * 总线**上的语义事件 `doc:changed`（见 `src/plugins/harness/renderer/plugin.tsx`）。
 * 本插件的 `plugin.tsx` 在 install 里订阅该事件并转投到这个模块级订阅表，组件
 * （DocEditorPane）只订阅本模块——它不认识 harness 的通道名，也不 import harness 的任何东西。
 *
 * 为什么不让组件直接订阅宿主事件总线：`HostServices.events` 只在插件 install 作用域里可用
 * （经 `ctx.use('events')` 取），React 组件拿不到宿主实例。这与音乐插件的
 * 「模块级可订阅快照 + 外壳插槽」是同一套做法（见独立插件 music-player 的 audio/store.ts）。
 */
export interface DocChangedPayload {
  docId: number
  action: 'updated' | 'deleted'
}

const listeners = new Set<(payload: DocChangedPayload) => void>()

/** install 侧：把宿主事件总线上的 `doc:changed` 转投给订阅中的组件 */
export const publishDocChanged = (payload: DocChangedPayload): void => {
  for (const listener of [...listeners]) {
    try {
      listener(payload)
    } catch (err) {
      console.error('[plugin:notes] doc:changed 处理异常:', err)
    }
  }
}

/** 组件侧：订阅「文档被 AI 改写」通知，返回退订函数 */
export const subscribeDocChanged = (
  listener: (payload: DocChangedPayload) => void
): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
