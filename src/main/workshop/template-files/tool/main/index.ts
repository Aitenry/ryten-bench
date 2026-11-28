import { tool } from '@host/main/ai/tools'
import * as z from 'zod/v4'
import { HARNESS_TOOL_CONTRIBUTION } from '@host/main/plugins/tool-contract'
import type { MainPluginContext } from './context'

/**
 * Contributes a tool to the AI assistant (the harness.tool contribution point).
 *
 * Key points:
 * - The contribution is removed together with the plugin: the assistant no longer sees it
 *   the **next turn**, when it assembles its tool set;
 * - The user must also tick this tool under Settings → Agent → Tools before it is actually
 *   attached to the model;
 * - build() is called lazily (it is never invoked while the plugin is unloaded), so it is
 *   safe to read the plugin's own data.
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
