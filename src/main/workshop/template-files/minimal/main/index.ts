import type { MainPluginContext } from './context'

/**
 * This plugin does not need main-process capabilities yet.
 *
 * The entry is kept because the plugin package contract requires main.cjs to exist (packages
 * without an entry cannot be installed); when channels or background logic are needed, call
 * ctx.registerIpc / ctx.effect here.
 */
export function install(ctx: MainPluginContext): void {
  void ctx
}
