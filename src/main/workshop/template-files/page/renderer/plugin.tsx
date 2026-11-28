import { ${vars.menuIcon} } from '@remixicon/react'
import type { PluginRenderContext } from './context'
import Page from './Page'

/**
 * Renderer entry: the host calls install(ctx) when it loads this plugin.
 *
 * Every registration is a **reversible assembly**: the host removes all of them when the
 * plugin is disabled (menu disappears, route unmounts, strings removed), so no manual
 * unregistering is needed.
 *
 * Note the icon uses `${vars.menuIcon}`: the name must be a real export from
 * `@remixicon/react` (a typo yields undefined at runtime → JSX throws
 * "Element type is invalid" and the page goes blank), and it must be the same icon as
 * `plugin.json`'s `menu.icon` (the manifest icon only affects the first frame).
 */
const plugin = {
  install(ctx: PluginRenderContext): void {
    ctx.use('route').register({
      path: '/${vars.id}',
      load: () => import('./Page')
    })
    ctx.use('menu').register({
      // The menu key must match the route path: clicking a menu item navigates to '/' + key
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
