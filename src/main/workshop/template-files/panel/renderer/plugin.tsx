import { RiSettings4Line } from '@remixicon/react'
import type { PluginRenderContext } from './context'
import Settings from './Settings'

const plugin = {
  install(ctx: PluginRenderContext): void {
    ctx.use('settingsSection').register({
      tabKey: '${vars.id}',
      labelKey: '${vars.id}.settings.title',
      icon: <RiSettings4Line size={16} />,
      // group 决定它落在设置弹窗的哪个分组：general / assistant
      group: 'assistant',
      order: 90,
      Component: Settings
    })
    ctx.use('i18n').addResources('translation', {
      'zh-CN': { '${vars.id}': { settings: { title: ${vars.titleJson} } } },
      'en-US': { '${vars.id}': { settings: { title: ${vars.titleJson} } } }
    })
  }
}

export default plugin
