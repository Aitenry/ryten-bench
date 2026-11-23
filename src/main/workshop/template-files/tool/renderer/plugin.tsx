import { RiToolsLine } from '@remixicon/react'
import type { PluginRenderContext } from './context'

/**
 * 工具型插件同样需要渲染层入口（插件包契约要求 renderer.mjs 存在）。
 * 这里只注册一页设置说明，告诉用户工具在哪里启用。
 */
function ToolSettings(): React.JSX.Element {
  return (
    <div className="flex max-w-[560px] flex-col gap-2">
      <div className="text-[13px] font-medium">${vars.title}</div>
      <div className="text-[12px] opacity-70">
        本插件给助手贡献了工具 <code>${vars.toolName}</code>：在「设置 → 智能体 → 工具」里勾选后，
        助手的下一轮对话就能调用它。停用本插件时该工具会立即从可用清单里消失。
      </div>
    </div>
  )
}

const plugin = {
  install(ctx: PluginRenderContext): void {
    ctx.use('settingsSection').register({
      tabKey: '${vars.id}',
      labelKey: '${vars.id}.settings.title',
      icon: <RiToolsLine size={16} />,
      group: 'assistant',
      order: 95,
      Component: ToolSettings
    })
    ctx.use('i18n').addResources('translation', {
      'zh-CN': { '${vars.id}': { settings: { title: ${vars.titleJson} } } },
      'en-US': { '${vars.id}': { settings: { title: ${vars.titleJson} } } }
    })
  }
}

export default plugin
