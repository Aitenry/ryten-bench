/**
 * Context the host provides to the plugin renderer (minimal contract).
 *
 * The draft directory has no host type declarations, so this interface is the local source of truth for "what can be called":
 * mount points are obtained via ctx.use(key), and reversible effects registered with effect are rolled back LIFO when the plugin is deactivated.
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
   * Locale registration. The first argument is the **i18next namespace** (host UI always uses 'translation'),
   * the second is "language → locale tree"; calling addResources('zh-CN', …) treats 'zh-CN' as the namespace,
   * so menus show raw key names (x.menu.title) — see addResources in
   * src/renderer/src/plugin-host/host.ts for the host API definition.
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

/** Invocation bridge for main-process channels (the generic bridge exposed by preload; channel names must be plugin:<id>:<name>) */
export const invoke = (channel: string, ...args: unknown[]): Promise<unknown> =>
  window.api.plugin.invoke(channel, ...args)
