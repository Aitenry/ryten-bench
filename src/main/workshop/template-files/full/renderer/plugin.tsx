import { ${vars.menuIcon}, RiSettings4Line } from '@remixicon/react'
import { ${vars.pascal}Locales } from '../locales'
import type { PluginRenderContext } from './context'
import Page from './Page'
import Settings from './Settings'

/**
 * Renderer entry for ${vars.title} (**assembly only**).
 *
 * Mount points: route (page), menu (sidebar), settingsSection (settings page), i18n (strings).
 * All assembly is reversible - the host unmounts it automatically when the plugin is disabled,
 * so no unregistration code is needed.
 *
 * Two pitfalls:
 * - The menu `icon` name must really exist in `@remixicon/react` and must be the same icon as
 *   `menu.icon` in `plugin.json` (the manifest icon only decides the first frame; the registry
 *   lives in the host's declared-icons.tsx);
 * - The first argument of the i18n mount point is the **namespace** ('translation'); passing a
 *   language name makes the UI show raw key names.
 */
const plugin = {
  install(ctx: PluginRenderContext): void {
    ctx.use('route').register({
      path: '/${vars.id}',
      load: () => import('./Page')
    })
    ctx.use('menu').register({
      // The menu key must match the route path: clicking the menu is navigate('/' + key)
      key: '${vars.id}',
      labelKey: '${vars.id}.menu.title',
      icon: <${vars.menuIcon} size={16} />,
      order: 60
    })
    ctx.use('settingsSection').register({
      tabKey: '${vars.id}',
      labelKey: '${vars.id}.settings.title',
      icon: <RiSettings4Line size={16} />,
      group: 'assistant',
      order: 90,
      Component: Settings
    })
    // Strings register with the plugin: the first argument is the namespace (always 'translation' for host UI), the second is the language → string tree map
    ctx.use('i18n').addResources('translation', ${vars.pascal}Locales)
  }
}

export default plugin
