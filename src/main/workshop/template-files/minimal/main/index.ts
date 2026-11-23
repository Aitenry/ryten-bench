import type { MainPluginContext } from './context'

/**
 * 本插件当前不需要主进程能力。
 *
 * 保留这个入口的原因是插件包契约要求 main.cjs 存在（缺入口的包装不上），
 * 需要通道/后台逻辑时在这里 ctx.registerIpc / ctx.effect 即可。
 */
export function install(ctx: MainPluginContext): void {
  void ctx
}
