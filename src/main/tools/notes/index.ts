import type { PluginToolContribution } from '../../plugins/tool-contract'
import { materialsToolContributions } from './materials'

/**
 * 资料库提供给 AI 助手的工具。
 *
 * 2026-11 起四个域（文档 / 待办 / 知识库 / 图谱）归一成一个 `manage_materials` 工具，
 * 对应界面语言里的「资料整理」；各域实现仍按文件拆分（docs/todos/wikis/graph），
 * 由 materials.ts 统一调度。旧工具名（manage_docs / manage_todos / manage_wikis /
 * search_graph）会在读取配置时迁移到新名字（见 shared/harness/mcp.ts）。
 *
 * 由 `src/main/system/notes.ts` 在启动时注册进 harness 的工具注册表
 * （`registerBuiltinHarnessTools`）；退出时注销。与第三方插件走同一个消费点，
 * 只是这里是随应用编译进来的内置来源。
 */
export const notesToolContributions: PluginToolContribution[] = [...materialsToolContributions]
