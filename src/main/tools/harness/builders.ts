import logger from 'electron-log'
import type { StructuredToolInterface } from '../../ai/tools'
import type { SubAgentConfig } from '../../services/harness/types'
import {
  HARNESS_TOOL_CONTRIBUTION,
  type PluginToolContribution,
  type ToolInfo
} from '../../plugins/tool-contract'
import { listContributions } from '../../plugins/contributions'
import {
  SCHEDULE_TOOL_GROUP,
  SCHEDULE_TOOL_NAMES,
  WEB_TOOL_GROUP,
  WEB_TOOL_NAMES,
  canonicalToolName,
  expandMcpServerGroups,
  isMcpToolGroup,
  isScheduleToolGroup,
  isSelectableMainAgentTool,
  isWebToolGroup,
  mcpNamespace,
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
  // 联网：抓取 + 搜索（无密钥；见 tools/harness/web.ts）。两个工具在**选择列表**里合并成
  // 一项 `web-tools`（见 WEB_TOOL_GROUP），运行时由 expandSelectionToolNames 展开；注册名不变。
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
    logger.warn('[Harness] Failed to read MCP tools:', err)
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
  color: '#722ed1',
  source: 'system'
}

/** 「网页抓取与搜索」分组选择项：列表里只显示这一项，运行前展开成 web_fetch + web_search */
const WEB_GROUP_INFO: ToolInfo = {
  name: WEB_TOOL_GROUP,
  label: 'Web fetch & search',
  description: 'Fetch a page and search the web (one selection)',
  icon: 'RiGlobalLine',
  color: '#13c2c2',
  source: 'system'
}

/** 已注入 MCP 数据源时的三个资源工具（每次现建，保证用最新连接） */
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
  /**
   * 来源标注（设置页/输入框的工具清单里名称右边的「系统 / 插件」小标签）：
   * - 本地工具表与 `registerBuiltinHarnessTools` 注册的内置功能 → `system`（随应用编译）；
   * - 第三方插件经 `harness.tool` 贡献点注册的工具 → `plugin`（停用插件即消失）；
   * - MCP 服务器暴露的工具 → `mcp`（外部进程，既不是系统也不是插件）。
   *
   * 插件贡献的 info 是插件自己给的元数据，这里**复制一份再补字段**，不改插件对象。
   */
  const contributed: ToolSource<StructuredToolInterface>[] = [
    ...builtinTools.map((item) => ({
      info: { ...item.info, source: 'system' as const },
      build: item.build
    })),
    ...listContributions<PluginToolContribution>(HARNESS_TOOL_CONTRIBUTION).map((item) => ({
      info: { ...item.info, source: 'plugin' as const },
      build: item.build
    }))
  ]
  const mcp = currentMcpTools()
  const byName = new Map(mcp.tools.map((tool) => [tool.name, tool]))
  const mcpSources: ToolSource<StructuredToolInterface>[] = []
  for (const info of mcp.infos) {
    const ready = byName.get(info.name)
    if (ready) mcpSources.push({ info: { ...info, source: 'mcp' as const }, build: () => ready })
  }
  return {
    local: [
      ...Object.entries(toolBuilders).map(([name, build]) => ({
        info: { ...localToolInfos.find((i) => i.name === name)!, source: 'system' as const },
        build
      }))
      // MCP 资源三件套**不在这里**：它们按「本轮勾选 ∩ 声明了 resources 能力」现建，
      // 见 buildTools / buildSubAgentTools（静态注册表没法知道这一轮勾了哪几台）。
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
  return mergeToolSources({ ...toolSources(), onWarn: (message) => logger.warn(message) }).builders
}

/**
 * 工具清单（设置 → 智能体页的工具下拉用）：本地工具 + 各插件贡献 + MCP 工具，同名的本地优先。
 * 每次调用即时拉取，因此插件启停与 MCP 连接状态都会立刻反映在这份清单里。
 * 排序与去重规则与 `resolveToolBuilders` 同源（同一个 `mergeToolSources`），不会漂移。
 *
 * **只返回用户可勾选的真实工具**：模式工具（工坊 4 个 + 发布版本 1 个）由插件模式自动挂载；MCP 工具
 * （`mcp__…`）/ 分组项（`mcp@…`）/ 旧标记（`mcp`）由输入框下方的 MCP 选择器管理、运行时自动并入。
 * 过滤在主进程完成，渲染层拿到什么就展示什么，不再二次过滤。
 *
 * **MCP 不再单独列一项**（用户口径 2026-11-27：「这个 MCP 服务器不就是一个统一的内容吗」）：
 * 那个「全选」项和 MCP 选择器覆盖的是同一批工具，两套入口只会让人不知道勾哪边。现在 MCP 的
 * 唯一入口是输入框下方的 MCP 选择器；分组标记 `mcp` 只作为**历史配置兼容**保留展开逻辑。
 */
export function listAvailableTools(): ToolInfo[] {
  const infos = mergeToolSources({ ...toolSources(), onWarn: (message) => logger.warn(message) }).infos
  const hidden = new Set<string>([
    ...SCHEDULE_TOOL_NAMES,
    ...MCP_RESOURCE_TOOL_INFOS.map((i) => i.name)
  ])
  const out: ToolInfo[] = []
  let webGroupPlaced = false
  for (const info of infos) {
    if (!isSelectableMainAgentTool(info.name) || hidden.has(info.name)) continue
    /**
     * 网页抓取 / 网页搜索合并成一项（用户口径 2026-11-27「这两个合成一个注册，像定时任务一样」）：
     * 在第一处的位置放分组项、第二处直接丢掉，清单顺序因此仍落在本地工具那一档
     * （天气、时间、网页、交付文件…），而不是被推到插件工具后面。
     */
    if ((WEB_TOOL_NAMES as readonly string[]).includes(info.name)) {
      if (!webGroupPlaced) {
        out.push(WEB_GROUP_INFO)
        webGroupPlaced = true
      }
      continue
    }
    // 分组项由这里补，历史配置/插件里若混进同名项也不重复出现
    if (isScheduleToolGroup(info.name) || isMcpToolGroup(info.name) || isWebToolGroup(info.name)) {
      continue
    }
    out.push(info)
  }
  // 分组项由这里补：定时任务恒有；网页分组正常一定在循环里落位（两个工具恒在本地工具表），
  // 这里只是「表被改动」时的兜底。
  if (!webGroupPlaced) out.push(WEB_GROUP_INFO)
  out.push(SCHEDULE_GROUP_INFO)
  return out
}

// ============================================================================
// Build Tools
// ============================================================================

/** 已连接、且声明了 resources 能力的服务器（旧注入没提供能力清单时退化为「全都支持」） */
function resourceCapableServers(): string[] {
  if (!mcpResourceOps) return []
  try {
    return mcpResourceOps.resourceCapableServers?.() ?? mcpResourceOps.servers()
  } catch {
    return []
  }
}

/** 本轮勾选的 MCP 服务器名（配置名）：把 `mcp@<命名空间>` 与历史 `mcp` 标记翻成服务器名 */
function selectedMcpServerNames(toolNames: string[]): string[] {
  if (!mcpResourceOps) return []
  let connected: string[] = []
  try {
    connected = mcpResourceOps.servers()
  } catch {
    return []
  }
  const out: string[] = []
  for (const raw of toolNames) {
    const name = canonicalToolName(raw)
    if (isMcpToolGroup(name)) {
      out.push(...connected)
      continue
    }
    const namespace = parseMcpServerGroup(name)
    if (namespace) {
      out.push(...connected.filter((server) => mcpNamespace(server) === namespace))
    }
  }
  return Array.from(new Set(out))
}

/**
 * 本轮资源工具可用的服务器 = **勾选的 ∩ 声明了 resources 能力的**。
 *
 * 两条要求缺一不可（用户口径 2026-11-27）：
 *  - 没声明 resources 的服务器不挂（调用只会得到空清单，白占上下文）；
 *  - 没勾的服务器不给读（勾了 A 不能顺手把 B 的资源也读了）。
 */
function resourceScopedServers(toolNames: string[]): string[] {
  const capable = resourceCapableServers()
  return selectedMcpServerNames(toolNames).filter((server) => capable.includes(server))
}

/** 本轮要挂的资源工具实例；没有可用的服务器时一个都不建 */
function buildScopedResourceTools(toolNames: string[]): StructuredToolInterface[] {
  if (!mcpResourceOps) return []
  const allowed = resourceScopedServers(toolNames)
  if (allowed.length === 0) return []
  try {
    return buildMcpResourceTools(mcpResourceOps, getMcpToolTexts(), allowed)
  } catch (err) {
    logger.warn('[Harness] Failed to build MCP resource tools:', err)
    return []
  }
}

/**
 * 展开选择列表里的分组项 → 真实工具名（去重）：
 * - `schedule-tasks` → 4 个 `schedule_*` 工具；
 * - `web-tools` → `web_fetch` + `web_search`；
 * - `mcp@<服务器>` → 那台服务器的工具；该服务器声明了 resources 时再加 3 个资源工具；
 * - `mcp` → 当前已连接 MCP 服务器的全部工具（**仅历史配置兼容**，清单里已不再提供这一项）；
 * - 其余原样保留。
 *
 * 列表里用户勾的是「一项」，运行时挂的是它代表的全部工具（与资料整理合并同一个思路）。
 */
export function expandSelectionToolNames(
  toolNames: string[],
  mcpToolNames?: string[]
): string[] {
  const allMcp = mcpToolNames ?? currentMcpTools().infos.map((info) => info.name)
  // 资源三件套按「本轮勾选 ∩ 声明了 resources」决定带不带（见 resourceScopedServers）
  const resourceNames =
    resourceScopedServers(toolNames).length > 0
      ? MCP_RESOURCE_TOOL_INFOS.map((info) => info.name)
      : []
  const out: string[] = []
  for (const raw of toolNames) {
    const name = canonicalToolName(raw)
    if (isScheduleToolGroup(name)) {
      out.push(...SCHEDULE_TOOL_NAMES)
      continue
    }
    if (isWebToolGroup(name)) {
      out.push(...WEB_TOOL_NAMES)
      continue
    }
    if (isMcpToolGroup(name)) {
      out.push(...allMcp, ...resourceNames)
      continue
    }
    if (parseMcpServerGroup(name)) {
      out.push(...expandMcpServerGroups([name], allMcp), ...resourceNames)
      continue
    }
    out.push(name)
  }
  return Array.from(new Set(out))
}

/** Build AI tool instances from selected tool names */
export function buildTools(toolNames: string[]): StructuredToolInterface[] {
  const registry = resolveToolBuilders()
  const resources = new Map(
    buildScopedResourceTools(toolNames).map((instance) => [instance.name, instance])
  )
  return expandSelectionToolNames(toolNames)
    .filter((name) => name in registry || resources.has(name))
    .map((name) => (name in registry ? registry[name]() : resources.get(name)!))
}

/** 为智能体构建实际的工具实例（分组项同样先展开） */
export function buildSubAgentTools(subAgent: SubAgentConfig): StructuredToolInterface[] {
  const registry = resolveToolBuilders()
  const toolNames = subAgent.tools ?? []
  const resources = new Map(
    buildScopedResourceTools(toolNames).map((instance) => [instance.name, instance])
  )
  return expandSelectionToolNames(toolNames)
    .filter((name) => name in registry || resources.has(name))
    .map((name) => (name in registry ? registry[name]() : resources.get(name)!))
}
