/**
 * 宿主给插件主进程的上下文（最小契约；完整说明见 WORKSHOP.md）。
 */
export interface MainPluginContext {
  /** 插件 id（= 目录名 = plugin.json.id） */
  readonly id: string
  /** 通道命名空间：plugin:<namespace>:* 里的 namespace（= id 去掉开头的 plugin. 段） */
  readonly namespace: string
  /** 注册 IPC 处理器（通道必须以 plugin:<namespace>: 开头，否则装载期抛错） */
  registerIpc(handlers: Record<string, (...args: never[]) => unknown>): () => void
  /** 声明只有发送方的事件通道（主进程 → 渲染层推送；不声明则渲染层订阅不到） */
  registerEvent(...channels: string[]): void
  /** 注册可逆效果（定时器 / 监听器），插件停用时 LIFO 回滚 */
  effect(register: () => void | (() => void)): void
  /** 挂载多值贡献（例如给 AI 助手贡献工具：HARNESS_TOOL_CONTRIBUTION） */
  contribute<T>(key: string, value: T): void
}
