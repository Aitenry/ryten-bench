import type { StructuredToolInterface } from '@langchain/core/tools'
import type { SubAgentConfig } from '../types'
import {
  HARNESS_TOOL_CONTRIBUTION,
  type PluginToolContribution,
  type ToolInfo
} from '../../../../main/plugins/tool-contract'
import { listContributions } from '../../../../main/plugins/contributions'
import { settingsStore } from '../../../../main/context'
import { expandMcpServerGroups, isPluginModeTool, type MainAgentConfig } from '../../shared/mcp'
import { mergeToolSources, type ToolSource } from './registry'
import { buildGetWeatherTool } from './weather'
import { buildGetTimeTool } from './time'
import { workshopToolBuilders, workshopToolInfos } from './workshop'

// ============================================================================
// Tool Registry — 本地工具 + 插件贡献（harness 只提供注册表/消费点）
// ============================================================================

type ToolFactory = () => StructuredToolInterface

/**
 * harness **本地**工具：与某个插件的数据无关，因此留在 harness。
 * - `get_weather`：数据源 `src/main/weather.ts` 属 core；
 * - `get_time`：纯本地时间；
 * - `plugin_draft` / `plugin_build` / `plugin_verify` / `plugin_publish`：**插件工坊**
 *   （见 `main/workshop/**`）——「和助手对话把插件做出来」这条链路是 harness 自己的能力，
 *   不是别的插件贡献的工具，所以走这张本地表而不是 `harness.tool` 贡献点。
 *
 * 但这 4 个是**模式工具**：注册在这里（`buildTools` 要按名字建实例、同名插件贡献照旧被本地挡住），
 * 却**不出现在设置页的可选清单里**——它们由插件模式自动挂载，见 `shared/mcp.ts` 的
 * `PLUGIN_MODE_TOOL_NAMES` 与下面 `listAvailableTools` 的过滤。
 *
 * planner / notes / music 的工具**不在这里**：它们的实现已搬进各自插件
 * （`src/plugins/<id>/main/tools.ts`），由插件 `install(ctx)` 经
 * `ctx.contribute(HARNESS_TOOL_CONTRIBUTION, …)` 注册，这里在组装时拉取。
 */
export const toolBuilders: Record<string, ToolFactory> = {
  get_weather: buildGetWeatherTool,
  get_time: buildGetTimeTool,
  ...workshopToolBuilders
}

// ============================================================================
// Tool Info — 前端下拉列表
// 注意：这里的 label/description 只是**兜底**，真正下发前会由
// ipc/misc.ts 按当前界面语言用 mainMessages().tools 覆盖（未收录的名字才用这里的值）。
// 它们与各工具给模型看的 description 是两回事，改这里不影响模型行为。
// ============================================================================

/** 本地工具的展示元数据（插件工具的元数据随贡献一起带上，见 tool-contract.ts） */
const localToolInfos: ToolInfo[] = [
  {
    name: 'get_weather',
    label: 'Weather',
    description: 'Current conditions and forecast',
    icon: 'RiSunCloudyLine',
    color: '#1677ff'
  },
  {
    name: 'get_time',
    label: 'Time',
    description: 'Current date and time',
    icon: 'RiTimeLine',
    color: '#52c41a'
  },
  // 插件工坊（4 个）：label/description 只是兜底，下发前由 main/i18n 按界面语言覆盖
  ...workshopToolInfos
]

// ============================================================================
// MCP 工具（外部 MCP 服务器提供的工具）
// ============================================================================

/**
 * MCP 工具提供者：由 `runtime/mcp.ts` 在插件 install 时注入（`setMcpToolProvider`）。
 *
 * 为什么用注入而不是直接 import：MCP 管理器要读 electron-store、要起子进程，直接 import
 * 会让工具注册表带上仅主进程可用的依赖，离线回归（node 直接加载本模块）就跑不起来。
 * 未注入时（插件未装载/被停用）退化为「没有 MCP 工具」，与「一台服务器都没配」同一条路径。
 */
let mcpToolProvider: (() => { tools: StructuredToolInterface[]; infos: ToolInfo[] }) | null = null

/** 注入/撤销 MCP 工具提供者（插件 install 的可逆装配里调用） */
export function setMcpToolProvider(
  provider?: () => { tools: StructuredToolInterface[]; infos: ToolInfo[] }
): void {
  mcpToolProvider = provider ?? null
}

/** 当前就绪的 MCP 工具（未注入或未连上时为空） */
function currentMcpTools(): { tools: StructuredToolInterface[]; infos: ToolInfo[] } {
  if (!mcpToolProvider) return { tools: [], infos: [] }
  try {
    return mcpToolProvider()
  } catch (err) {
    console.warn('[Harness] 读取 MCP 工具失败:', err)
    return { tools: [], infos: [] }
  }
}

/** 每次取工具集时现拉的三路来源（本地工具常量 + 插件贡献 + MCP 快照） */
function toolSources(): {
  local: ToolSource<StructuredToolInterface>[]
  contributed: ToolSource<StructuredToolInterface>[]
  mcp: ToolSource<StructuredToolInterface>[]
} {
  const contributed = listContributions<PluginToolContribution>(HARNESS_TOOL_CONTRIBUTION).map(
    (item) => ({ info: item.info, build: item.build })
  )
  const mcp = currentMcpTools()
  const byName = new Map(mcp.tools.map((tool) => [tool.name, tool]))
  const mcpSources: ToolSource<StructuredToolInterface>[] = []
  for (const info of mcp.infos) {
    const ready = byName.get(info.name)
    if (ready) mcpSources.push({ info, build: () => ready })
  }
  return {
    local: Object.entries(toolBuilders).map(([name, build]) => ({
      info: localToolInfos.find((i) => i.name === name)!,
      build
    })),
    contributed,
    mcp: mcpSources
  }
}

/**
 * 合并后的工具表：本地工具 + 各插件贡献 + 已连接的 MCP 工具（规则见 tools/registry.ts）。
 *
 * **每次调用都重新拉取贡献**——这正是「插件启停即时生效」的落点：插件停用后贡献被宿主摘除，
 * 下一次组装（下一轮对话/子代理）就看不到它的工具。未装载任何插件时贡献为空数组，
 * 工具集退化为本地两个工具，**不抛错**。MCP 同理：服务器断开或停用时其工具即刻消失。
 */
function resolveToolBuilders(): Record<string, ToolFactory> {
  return mergeToolSources(toolSources()).builders
}

/**
 * 工具清单（设置 → 智能体页的工具下拉用）：本地工具 + 各插件贡献 + MCP 工具，同名的本地优先。
 * 每次调用即时拉取，因此插件启停与 MCP 连接状态都会立刻反映在这份清单里。
 * 排序与去重规则与 `resolveToolBuilders` 同源（同一个 `mergeToolSources`），不会漂移。
 *
 * **模式工具（插件工坊 4 个）不在这份清单里**：它们由插件模式自动挂载（用户口径 2026-09-29
 * 「不要在这里面选择工具才注册这些工具」），下发给设置页的下拉里既不该有选项、用户也勾不到。
 * 注册表（`resolveToolBuilders`）里照旧保留它们——本轮工具名由 `effectiveMainAgentTools` 按模式追加。
 */
export function listAvailableTools(): ToolInfo[] {
  return mergeToolSources(toolSources()).infos.filter(
    (info) => !isPluginModeTool(info.name)
  ) as ToolInfo[]
}

// ============================================================================
// Build Tools
// ============================================================================

/** Build LangChain tool instances from selected tool names */
export function buildTools(toolNames: string[]): StructuredToolInterface[] {
  const registry = resolveToolBuilders()
  return toolNames.filter((name) => name in registry).map((name) => registry[name]())
}

/** 为智能体构建实际的工具实例 */
export function buildSubAgentTools(subAgent: SubAgentConfig): StructuredToolInterface[] {
  const registry = resolveToolBuilders()
  /**
   * 子智能体的选择里存的可能是 MCP 分组项（智能体页按服务器给一项，见 shared/mcp.ts）：
   * 建实例前展开成 MCP 页当前启用的那批真实工具名。**只有 MCP 页能决定具体哪几个工具**，
   * 子智能体只是引用那份清单，因此这里每次都现读，MCP 页改了立即生效。
   */
  const selected = expandMcpServerGroups(subAgent.tools, enabledMcpToolNames())
  return selected.filter((name) => name in registry).map((name) => registry[name]())
}

/** MCP 页当前勾选给模型的工具名（`mainAgent.mcpTools`，读不到就当没有） */
function enabledMcpToolNames(): string[] {
  try {
    const config = settingsStore.get('mainAgent') as MainAgentConfig | undefined
    return Array.isArray(config?.mcpTools) ? config.mcpTools : []
  } catch (err) {
    console.warn('[Harness] 读取已启用的 MCP 工具失败:', err)
    return []
  }
}

// ============================================================================
// SubAgent Registry
// ============================================================================

/** 从数据库加载指定工作区下已启用的智能体定义 */
export async function loadSubAgentDefinitions(workspaceId: number): Promise<SubAgentConfig[]> {
  const { getEnabledSubAgentConfigs } = await import('../db/mapper/agent')
  return getEnabledSubAgentConfigs(workspaceId)
}
