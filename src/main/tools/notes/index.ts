import type { PluginToolContribution } from '../../plugins/tool-contract'
import { graphToolContributions } from './graph'
import { docToolContributions } from './docs'
import { wikiToolContributions } from './wikis'
import { todoToolContributions } from './todos'

/**
 * 资料库提供给 AI 助手的工具（一个域一个文件，这里只做汇总）。
 *
 * 由 `src/main/system/notes.ts` 在启动时注册进 harness 的工具注册表
 * （`registerBuiltinHarnessTools`）；退出时注销。与第三方插件走同一个消费点，
 * 只是这里是随应用编译进来的内置来源。
 */
export const notesToolContributions: PluginToolContribution[] = [
  ...todoToolContributions,
  ...docToolContributions,
  ...wikiToolContributions,
  ...graphToolContributions
]
