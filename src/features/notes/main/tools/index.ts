import type { PluginToolContribution } from '../../../../main/plugins/tool-contract'
import { graphToolContributions } from './graph'
import { docToolContributions } from './docs'
import { wikiToolContributions } from './wikis'
import { todoToolContributions } from './todos'

/**
 * notes 插件贡献给 harness 的 AI 工具（一个域一个文件，这里只做汇总）。
 *
 * 由 `main/index.ts` 在 `install(ctx)` 里逐个 `ctx.contribute(HARNESS_TOOL_CONTRIBUTION, ...)`；
 * 插件停用/卸载时随 `ctx.dispose()` 一起摘除（harness 下一次组装工具集就看不到它们）。
 */
export const notesToolContributions: PluginToolContribution[] = [
  ...todoToolContributions,
  ...docToolContributions,
  ...wikiToolContributions,
  ...graphToolContributions
]
