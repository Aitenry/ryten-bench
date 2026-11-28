import { RiToolsLine } from '@remixicon/react'
import { ${vars.pascal}Locales } from '../locales'
import type { PluginRenderContext } from './context'
import Settings from './Settings'

/**
 * Renderer entry for ${vars.title} (**assembly only**).
 *
 * Tool plugins also need a renderer entry (the plugin package contract requires renderer.mjs to
 * exist): register one read-only settings page telling the user what the tool is called and where to
 * enable it. The tool contribution itself lives in the main process (harness.tool in main/index.ts).
 */
const plugin = {
  install(ctx: PluginRenderContext): void {
    ctx.use('settingsSection').register({
      tabKey: '${vars.id}',
      labelKey: '${vars.id}.settings.title',
      icon: <RiToolsLine size={16} />,
      group: 'assistant',
      order: 95,
      Component: Settings
    })
    // The first argument is the **namespace** (the host UI always uses 'translation'), the second is "language -> entry tree"
    ctx.use('i18n').addResources('translation', ${vars.pascal}Locales)
  }
}

export default plugin
