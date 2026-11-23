import { tool } from '@host/main/ai/tools'
import * as z from 'zod/v4'
import { HARNESS_TOOL_CONTRIBUTION } from '@host/main/plugins/tool-contract'
import type { MainPluginContext } from './context'

/**
 * 给 AI 助手贡献一个工具（harness.tool 贡献点）。
 *
 * 要点：
 * - 贡献随插件停用一并摘除：助手**下一轮**组装工具集时就看不到它了；
 * - 用户还要在 设置 → 智能体 → 工具 里勾选本工具才会真正挂给模型；
 * - build() 是延迟调用的（插件没装载就不会被调到），可以放心读插件自己的数据。
 */
export function install(ctx: MainPluginContext): void {
  ctx.contribute(HARNESS_TOOL_CONTRIBUTION, {
    name: '${vars.toolName}',
    info: {
      name: '${vars.toolName}',
      label: ${vars.titleJson},
      description: ${vars.descriptionJson},
      icon: 'RiToolsLine',
      color: '#8b5cf6'
    },
    build: () =>
      tool(
        async (input: { text: string; upper?: boolean }) => {
          const text = String(input?.text ?? '')
          const out = input?.upper ? text.toUpperCase() : text
          return ${vars.titleJson} + ' → ' + out
        },
        {
          name: '${vars.toolName}',
          description: ${vars.descriptionJson},
          schema: z.object({
            text: z.string().describe('要处理的文本'),
            upper: z.boolean().optional().describe('是否转成大写')
          })
        }
      )
  })
}
