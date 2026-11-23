import { ${vars.menuIcon} } from '@remixicon/react'
import type { PluginRenderContext } from './context'
import Page from './Page'

/**
 * 渲染层入口：宿主装载本插件时调用 install(ctx)。
 *
 * 注册的都是**可逆装配**：插件停用时宿主会把这些注册项一并摘除
 * （菜单消失、路由卸载、词条移除），不需要自己写反注册。
 *
 * 注意 icon 用的 `${vars.menuIcon}`：名字必须是 `@remixicon/react` 里真实存在的导出
 * （写错 = 运行期 undefined → JSX 抛「Element type is invalid」白屏），
 * 并且与 `plugin.json` 的 `menu.icon` 保持同一枚（清单图标只影响首帧）。
 */
const plugin = {
  install(ctx: PluginRenderContext): void {
    ctx.use('route').register({
      path: '/${vars.id}',
      load: () => import('./Page')
    })
    ctx.use('menu').register({
      // 菜单键必须与路由路径一致：点击菜单是 navigate('/' + key)
      key: '${vars.id}',
      labelKey: '${vars.id}.menu.title',
      icon: <${vars.menuIcon} size={16} />,
      order: 60
    })
    ctx.use('i18n').addResources('translation', {
      'zh-CN': { '${vars.id}': { menu: { title: ${vars.titleJson} } } },
      'en-US': { '${vars.id}': { menu: { title: ${vars.titleJson} } } }
    })
  }
}

export default plugin
