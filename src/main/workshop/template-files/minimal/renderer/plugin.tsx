import type { PluginRenderContext } from './context'

/**
 * 最小骨架：宿主装载时 install(ctx) 被调用，停用时全部注册项回滚。
 *
 * 想加界面就在下面挂挂载点（route / menu / settingsSection / appProvider），
 * 完整清单见 WORKSHOP.md。
 */
const plugin = {
  install(ctx: PluginRenderContext): void {
    // 示例：一个不做任何渲染的全局 Provider（不需要界面、只想常驻后台逻辑时用）
    ctx.use('appProvider').register({
      order: 90,
      Provider: ({ children }: { children?: unknown }) => children
    })
  }
}

export default plugin
