import type { PluginRenderContext } from './context'

/**
 * Minimal skeleton: the host calls install(ctx) on load and rolls back every registration on
 * unload.
 *
 * To add UI, register mount points below (route / menu / settingsSection / appProvider).
 */
const plugin = {
  install(ctx: PluginRenderContext): void {
    // Example: a global Provider that renders nothing (useful for always-on background logic with no UI)
    ctx.use('appProvider').register({
      order: 90,
      Provider: ({ children }: { children?: unknown }) => children
    })
  }
}

export default plugin
