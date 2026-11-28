import { RiSettings4Line } from '@remixicon/react'
import { ${vars.pascal}Locales } from '../locales'
import type { PluginRenderContext } from './context'
import Settings from './Settings'

/**
 * Renderer entry for ${vars.title} (**assembly only**): one page in the settings section plus the
 * locale entries.
 * Registration rolls back automatically when the plugin is disabled; no unregister code needed.
 */
const plugin = {
  install(ctx: PluginRenderContext): void {
    ctx.use('settingsSection').register({
      tabKey: '${vars.id}',
      labelKey: '${vars.id}.settings.title',
      icon: <RiSettings4Line size={16} />,
      // group decides which section of the settings dialog it lands in: general / assistant
      group: 'assistant',
      order: 90,
      Component: Settings
    })
    // The first argument is the **namespace** (the host UI always uses 'translation'), the second is "language -> entry tree"
    ctx.use('i18n').addResources('translation', ${vars.pascal}Locales)
  }
}

export default plugin
