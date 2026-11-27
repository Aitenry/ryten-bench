import type { StructuredToolInterface } from '../../ai/tools'
import type { SubAgentConfig } from '../../services/harness/types'
import {
  HARNESS_TOOL_CONTRIBUTION,
  type PluginToolContribution,
  type ToolInfo
} from '../../plugins/tool-contract'
import { listContributions } from '../../plugins/contributions'
import {
  MCP_TOOL_GROUP,
  SCHEDULE_TOOL_GROUP,
  SCHEDULE_TOOL_NAMES,
  canonicalToolName,
  expandMcpServerGroups,
  isMcpToolGroup,
  isScheduleToolGroup,
  isSelectableMainAgentTool,
  parseMcpServerGroup
} from '../../../shared/harness/mcp'
import { mergeToolSources, type ToolSource } from './registry'
import { buildGetWeatherTool } from './weather'
import { buildGetTimeTool } from './time'
import { buildWebFetchTool, buildWebSearchTool } from './web'
import { buildPresentTool } from './present'
import { buildScheduleTools } from './schedule'
import {
  buildMcpResourceTools,
  type McpResourceOps
} from './mcp-resources'
import { getMcpToolTexts } from '../../i18n/tool-results-mcp'
import { workshopToolBuilders, workshopToolInfos } from './workshop'
import { latticeToolBuilders, latticeToolInfos } from './lattice'

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
 *   不是别的插件贡献的工具，所以走这张本地表而不是 `harness.tool` 贡献点；
 * - `plugin_release`：**插件中心**发版（见 `main/lattice/**`）。与 `plugin_publish`
 *   （装进本机应用）相对，它是「把版本发出去给别的用户装」。
 *
 * 但这 5 个是**模式工具**：注册在这里（`buildTools` 要按名字建实例、同名插件贡献照旧被本地挡住），
 * 却**不出现在设置页的可选清单里**——它们由插件模式自动挂载，见 `shared/mcp.ts` 的
 * `PLUGIN_MODE_TOOL_NAMES` 与下面 `listAvailableTools` 的过滤。其中 `plugin_release`
 * 还要看插件中心登录态（`LATTICE_MODE_TOOL_NAMES`，未登录时连名字都不追加）。
 *
 * planner / notes / music 的工具**不在这里**：它们的实现已搬进各自插件
 * （插件源码的 `main/tools.ts`），由插件 `install(ctx)` 经
 * `ctx.contribute(HARNESS_TOOL_CONTRIBUTION, …)` 注册，这里在组装时拉取。
 * 其中 notes 的四个资料域已归一成 `manage_materials`（内置注册，见 system/notes.ts）。
 */
export const toolBuilders: Record<string, ToolFactory> = {
  get_weather: buildGetWeatherTool,
  get_time: buildGetTimeTool,
  // 联网：抓取 + 搜索（无密钥；见 tools/harness/web.ts）。默认不选中，由「智能体」页勾选启用。
  web_fetch: () => buildWebFetchTool(),
  web_search: () => buildWebSearchTool(),
  // 交付物声明（read 只读校验 + 卡片展示；不写文件）
  present: () => buildPresentTool(),
  // 定时任务（4 个）：到点由主进程无头起一轮（见 runtime/harness/schedule-runner.ts）
  ...Object.fromEntries(
    buildScheduleTools().map((instance) => [instance.name, () => instance])
  ),
  ...workshopToolBuilders,
  ...latticeToolBuilders
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
  {
    name: 'web_fetch',
    label: 'Web fetch',
    description: 'Fetch a URL and read its readable text',
    icon: 'RiGlobalLine',
    color: '#13c2c2'
  },
  {
    name: 'web_search',
    label: 'Web search',
    description: 'Search the web and get result links',
    icon: 'RiSearchLine',
    color: '#2f54eb'
  },
  {
    name: 'present',
    label: 'Present files',
    description: 'Declare finished files as deliverables for the user',
    icon: 'RiFileEditLine',
    color: '#c98a2b'
  },
  {
    name: 'schedule_create',
    label: 'Create schedule',
    description: 'Run a prompt on a recurring or one-off schedule',
    icon: 'RiCalendar2Line',
    color: '#722ed1'
  },
  {
    name: 'schedule_list',
    label: 'List schedules',
    description: 'List the scheduled tasks',
    icon: 'RiCalendar2Line',
    color: '#722ed1'
  },
  {
    name: 'schedule_view',
    label: 'View schedule',
    description: 'Show one scheduled task in full',
    icon: 'RiCalendar2Line',
    color: '#722ed1'
  },
  {
    name: 'schedule_edit',
    label: 'Edit schedule',
    description: 'Update, pause, resume or delete a scheduled task',
    icon: 'RiCalendar2Line',
    color: '#722ed1'
  },
  // 插件工坊（4 个）+ 插件中心发版（1 个）：label/description 只是兜底，下发前由 main/i18n 按界面语言覆盖
  ...workshopToolInfos,
  ...latticeToolInfos
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
    console.warn('[Harness] Failed to read MCP tools:', err)
    return { tools: [], infos: [] }
  }
}

/**
 * MCP 资源工具的数据访问依赖：由 `system/harness.ts` 在装配时注入（与 MCP 工具提供者
 * 同一套理由——不在工具注册表里直接 import MCP 管理器，否则离线回归会拖进 SDK/子进程）。
 */
let mcpResourceOps: McpResourceOps | null = null

/** 注入/撤销 MCP 资源数据源（插件装配与退出时调用；未注入时这三个工具不存在） */
export function setMcpResourceOps(ops?: McpResourceOps): void {
  mcpResourceOps = ops ?? null
}

/** 资源工具的展示元数据（名称固定，与数据源无关） */
const MCP_RESOURCE_TOOL_INFOS: ToolInfo[] = [
  {
    name: 'list_mcp_resources',
    label: 'MCP resources',
    description: 'List resources exposed by an MCP server',
    icon: 'RiPlug2Line',
    color: '#8c6b3f'
  },
  {
    name: 'list_mcp_resource_templates',
    label: 'MCP resource templates',
    description: 'List parameterized resource URI templates',
    icon: 'RiPlug2Line',
    color: '#8c6b3f'
  },
  {
    name: 'read_mcp_resource',
    label: 'Read MCP resource',
    description: 'Read one MCP resource by URI',
    icon: 'RiPlug2Line',
    color: '#8c6b3f'
  }
]

/** 「定时任务」分组选择项：列表里只显示这一项，运行前展开成 4 个工具 */
const SCHEDULE_GROUP_INFO: ToolInfo = {
  name: SCHEDULE_TOOL_GROUP,
  label: 'Schedules',
  description: 'Create, list, view and edit scheduled tasks',
  icon: 'RiCalendar2Line',
  color: '#722ed1'
}

/** 「MCP」分组选择项：一次勾选 = 已连接服务器的工具 + 3 个资源工具 */
const MCP_GROUP_INFO: ToolInfo = {
  name: MCP_TOOL_GROUP,
  label: 'MCP',
  description: 'Use every connected MCP server (tools and resources)',
  icon: 'RiPlug2Line',
  color: '#8c6b3f'
}

/** 已注入 MCP 数据源时的三个资源工具（每次现建，保证用最新连接） */
function mcpResourceToolSources(): ToolSource<StructuredToolInterface>[] {
  if (!mcpResourceOps) return []
  try {
    return buildMcpResourceTools(mcpResourceOps, getMcpToolTexts())
      .map((instance) => {
        const info = MCP_RESOURCE_TOOL_INFOS.find((item) => item.name === instance.name)
        return info ? { info, build: () => instance } : null
      })
      .filter((source): source is ToolSource<StructuredToolInterface> => source !== null)
  } catch (err) {
    console.warn('[Harness] Failed to build MCP resource tools:', err)
    return []
  }
}

/**
 * 内置功能的工具（资料整理 1 个）：随应用编译进来，不经插件注册表。
 *
 * 第三方插件仍走 `harness.tool` 贡献点（`listContributions`），两者在 `toolSources()`
 * 合并成同一份清单——对模型与设置页来说没有区别，只是来源不同。
 */
const builtinTools: PluginToolContribution[] = []

/** 注册内置工具（幂等；由 `src/main/system/notes.ts` 在启动时调用） */
export function registerBuiltinHarnessTools(tools: PluginToolContribution[]): void {
  for (const tool of tools) {
    if (!builtinTools.includes(tool)) builtinTools.push(tool)
  }
}

/** 注销内置工具（退出/测试收尾；未注册过则忽略） */
export function unregisterBuiltinHarnessTools(tools: PluginToolContribution[]): void {
  for (const tool of tools) {
    const index = builtinTools.indexOf(tool)
    if (index >= 0) builtinTools.splice(index, 1)
  }
}

/** 每次取工具集时现拉的三路来源（本地工具常量 + 内置/插件贡献 + MCP 快照） */
function toolSources(): {
  local: ToolSource<StructuredToolInterface>[]
  contributed: ToolSource<StructuredToolInterface>[]
  mcp: ToolSource<StructuredToolInterface>[]
} {
  const contributed = [
    ...builtinTools,
    ...listContributions<PluginToolContribution>(HARNESS_TOOL_CONTRIBUTION)
  ].map((item) => ({ info: item.info, build: item.build }))
  const mcp = currentMcpTools()
  const byName = new Map(mcp.tools.map((tool) => [tool.name, tool]))
  const mcpSources: ToolSource<StructuredToolInterface>[] = []
  for (const info of mcp.infos) {
    const ready = byName.get(info.name)
    if (ready) mcpSources.push({ info, build: () => ready })
  }
  return {
    local: [
      ...Object.entries(toolBuilders).map(([name, build]) => ({
        info: localToolInfos.find((i) => i.name === name)!,
        build
      })),
      // MCP 资源三件套：数据源由 system/harness 注入，未注入时为空（工具不存在）
      ...mcpResourceToolSources()
    ],
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
 * **只返回用户可勾选的真实工具**：模式工具（工坊 4 个 + 发布版本 1 个）由插件模式自动挂载；MCP 工具
 * （`mcp__…`）/ 分组项（`mcp@…`）/ 旧标记（`mcp`）由 MCP 页管理、运行时自动并入。
 * 过滤在主进程完成，渲染层拿到什么就展示什么，不再二次过滤。
 */
export function listAvailableTools(): ToolInfo[] {
  const infos = mergeToolSources(toolSources()).infos
  const hidden = new Set<string>([...SCHEDULE_TOOL_NAMES, ...MCP_RESOURCE_TOOL_INFOS.map((i) => i.name)])
  const visible = infos.filter(
    (info) => isSelectableMainAgentTool(info.name) && !hidden.has(info.name)
  )
  // 分组项由这里补：定时任务恒有；MCP 只在真的有数据源/服务器时出现
  const out = visible.filter(
    (info) => !isScheduleToolGroup(info.name) && !isMcpToolGroup(info.name)
  )
  out.push(SCHEDULE_GROUP_INFO)
  if (mcpResourceOps || currentMcpTools().infos.length > 0) out.push(MCP_GROUP_INFO)
  return out
}

// ============================================================================
// Build Tools
// ============================================================================

/**
 * 展开选择列表里的分组项 → 真实工具名（去重）：
 * - `schedule-tasks` → 4 个 `schedule_*` 工具；
 * - `mcp` → 当前已连接 MCP 服务器的全部工具 + 3 个资源工具；
 * - `mcp@<服务器>` → 那台服务器的工具；
 * - 其余原样保留。
 *
 * 列表里用户勾的是「一项」，运行时挂的是它代表的全部工具（与资料整理合并同一个思路）。
 */
export function expandSelectionToolNames(
  toolNames: string[],
  mcpToolNames?: string[]
): string[] {
  const allMcp = mcpToolNames ?? currentMcpTools().infos.map((info) => info.name)
  const resourceNames = mcpResourceOps ? MCP_RESOURCE_TOOL_INFOS.map((info) => info.name) : []
  const out: string[] = []
  for (const raw of toolNames) {
    const name = canonicalToolName(raw)
    if (isScheduleToolGroup(name)) {
      out.push(...SCHEDULE_TOOL_NAMES)
      continue
    }
    if (isMcpToolGroup(name)) {
      out.push(...allMcp, ...resourceNames)
      continue
    }
    if (parseMcpServerGroup(name)) {
      out.push(...expandMcpServerGroups([name], allMcp))
      continue
    }
    out.push(name)
  }
  return Array.from(new Set(out))
}

/** Build AI tool instances from selected tool names */
export function buildTools(toolNames: string[]): StructuredToolInterface[] {
  const registry = resolveToolBuilders()
  return expandSelectionToolNames(toolNames)
    .filter((name) => name in registry)
    .map((name) => registry[name]())
}

/** 为智能体构建实际的工具实例（分组项同样先展开） */
export function buildSubAgentTools(subAgent: SubAgentConfig): StructuredToolInterface[] {
  const registry = resolveToolBuilders()
  return expandSelectionToolNames(subAgent.tools ?? [])
    .filter((name) => name in registry)
    .map((name) => registry[name]())
}
