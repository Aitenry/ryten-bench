/**
 * AI 工具的**宿主契约**（core 所有，供 harness 与各插件共同引用）。
 *
 * 为什么单独一个文件：工具实现归各插件所有，harness 只提供注册/消费的贡献点
 * （设计见 test/plugin-coupling-notes.md §5）。契约若写在 harness 里，插件就得反向
 * import harness；放在 core（`src/main/plugins/**`）则两边都只依赖宿主。
 */
import type { StructuredToolInterface } from '@langchain/core/tools'

/**
 * 贡献点键：AI 工具（**第三方插件**用）。
 *
 * 插件在 `install(ctx)` 里 `ctx.contribute(HARNESS_TOOL_CONTRIBUTION, 工具项)`，
 * harness 组装工具集时 `listContributions<PluginToolContribution>(HARNESS_TOOL_CONTRIBUTION)`。
 *
 * 内置功能的工具（资料库的 4 个）不走这里：它们由 `src/main/system/notes.ts` 直接调
 * `registerBuiltinHarnessTools()` 注册，随应用编译、随应用退出。
 */
export const HARNESS_TOOL_CONTRIBUTION = 'harness.tool'

/**
 * 工具在设置页/提示词里的展示元数据（原 `harness/types.ts` 的 `ToolInfo`，定义搬到这里）。
 *
 * 注意：label/description 只是**兜底**界面文案，真正下发前会由 `ipc/misc.ts`
 * 按当前界面语言用 `mainMessages().tools` 覆盖；它们与工具给模型看的 description 是两回事。
 */
export interface ToolInfo {
  name: string
  label: string
  description: string
  icon: string
  color: string
}

/** 一个贡献给 harness 的 AI 工具（第三方插件贡献，或内置功能注册） */
export interface PluginToolContribution {
  /** 工具名（= 设置页与提示词索引所用的名字，例如 `manage_planner`） */
  name: string
  /** 设置页/提示词用的展示元数据 */
  info: ToolInfo
  /**
   * 真正构建 langchain 工具实例（**延迟到需要时**调用：插件未启用/未装载时
   * 根本不会调到，因此工具内部可以放心读自己插件的 mapper）。
   */
  build: () => StructuredToolInterface
}
