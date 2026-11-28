/**
 * Context the host provides to the plugin main process (minimal contract).
 */
export interface MainPluginContext {
  /** Plugin id (= directory name = plugin.json.id) */
  readonly id: string
  /** Channel namespace: the namespace in plugin:<namespace>:* (= id without the leading plugin. segment) */
  readonly namespace: string
  /** Register IPC handlers (channels must start with plugin:<namespace>:, otherwise loading throws) */
  registerIpc(handlers: Record<string, (...args: never[]) => unknown>): () => void
  /** Declare sender-only event channels (main process → renderer push; without declaring, the renderer cannot subscribe) */
  registerEvent(...channels: string[]): void
  /** Register reversible effects (timers / listeners); rolled back LIFO when the plugin is deactivated */
  effect(register: () => void | (() => void)): void
  /** Attach a multi-value contribution (e.g. contribute tools to the AI assistant: HARNESS_TOOL_CONTRIBUTION) */
  contribute<T>(key: string, value: T): void
}
