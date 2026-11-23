/**
 * 宿主给插件渲染层的上下文（最小契约；完整说明见 WORKSHOP.md）。
 *
 * 草稿目录里没有宿主的类型声明，这份 interface 就是「能调什么」的本地真源：
 * 挂载点由 ctx.use(键) 取得，effect 登记的可逆效果会在插件停用时 LIFO 回滚。
 */
export interface PluginRenderContext {
  use(key: 'route'): {
    register(route: { path: string; skeleton?: string; load: () => Promise<unknown> }): void
  }
  use(key: 'menu'): {
    register(item: { key: string; labelKey: string; icon: unknown; order?: number }): void
  }
  use(key: 'settingsSection'): {
    register(section: {
      tabKey: string
      labelKey: string
      icon?: unknown
      group?: string
      order?: number
      Component: unknown
    }): void
  }
  use(key: 'appProvider'): { register(provider: { Provider: unknown; order?: number }): void }
  /**
   * 词条注册。第一个参数是 **i18next 命名空间**（宿主界面一律用 'translation'），
   * 第二个参数是「语言 → 词条树」；写成 addResources('zh-CN', …) 会把 'zh-CN' 当命名空间，
   * 菜单里就会显示原始键名（x.menu.title）——宿主 API 定义见
   * src/renderer/src/plugin-host/host.ts 的 addResources。
   */
  use(key: 'i18n'): {
    addResources(namespace: 'translation', resources: Record<string, Record<string, unknown>>): void
  }
  use(key: 'events'): {
    emit(name: string, data?: unknown): void
    on(name: string, handler: (data: unknown) => void): () => void
  }
  effect(register: () => void | (() => void)): void
}

/** 主进程通道的调用桥（preload 暴露的通用桥，通道名必须是 plugin:<id>:<name>） */
export const invoke = (channel: string, ...args: unknown[]): Promise<unknown> =>
  window.api.plugin.invoke(channel, ...args)
