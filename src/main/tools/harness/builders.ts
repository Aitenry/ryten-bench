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
import { buildListCapabilitiesTool, LIST_CAPABILITIES_TOOL_NAME } from './capabilities'

// ============================================================================
// Tool Registry — local tools + plugin contributions (harness only provides the
// registry/consumption point)
// ============================================================================

type ToolFactory = () => StructuredToolInterface

/**
 * harness **local** tools: unrelated to any plugin's data, so they stay in harness.
 * - `get_weather`: its data source `src/main/weather.ts` belongs to core;
 * - `get_time`: pure local time;
 * - `plugin_draft` / `plugin_build` / `plugin_verify` / `plugin_publish`: the **plugin workshop**
 *   (see `main/workshop/**`) — the "build a plugin by chatting with the assistant" path is
 *   harness's own capability, not a tool contributed by another plugin, hence this local table
 *   instead of the `harness.tool` contribution point;
 * - `plugin_release`: **plugin center** release (see `main/lattice/**`). The counterpart of
 *   `plugin_publish` (install into the local app) — it sends a version out for other users to
 *   install.
 *
 * However these 5 are **mode tools**: registered here (`buildTools` must build instances by name,
 * and a same-named plugin contribution is still shadowed by the local one), yet they **do not
 * appear in the settings page's selectable list** — plugin mode attaches them automatically; see
 * `PLUGIN_MODE_TOOL_NAMES` in `shared/mcp.ts` and the filtering in `listAvailableTools` below.
 * `plugin_release` additionally depends on the plugin center sign-in state
 * (`LATTICE_MODE_TOOL_NAMES`; when signed out even the name is not appended).
 *
 * planner / notes / music tools are **not here**: their implementations have moved into their
 * respective plugins (in the plugin source `main/tools.ts`), registered by the plugin's
 * `install(ctx)` via `ctx.contribute(HARNESS_TOOL_CONTRIBUTION, …)`, and pulled in here during
 * assembly. The four data domains of notes have been consolidated into `manage_materials`
 * (built-in registration, see system/notes.ts).
 */
export const toolBuilders: Record<string, ToolFactory> = {
  get_weather: buildGetWeatherTool,
  get_time: buildGetTimeTool,
  // Web: fetch + search (no key; see tools/harness/web.ts). The two tools are merged into one
  // **selection list** entry `web-tools` (see WEB_TOOL_GROUP) and expanded by
  // expandSelectionToolNames at runtime; the registered names stay unchanged.
  web_fetch: () => buildWebFetchTool(),
  web_search: () => buildWebSearchTool(),
  // Deliverable declaration (read-only validation via read + card display; writes no files)
  present: () => buildPresentTool(),
  // Scheduled tasks (4): when due, the main process starts a headless round (see
  // runtime/harness/schedule-runner.ts)
  ...Object.fromEntries(
    buildScheduleTools().map((instance) => [instance.name, () => instance])
  ),
  // Capability catalog: the model copies `agentConfig` values from here. Registered but not
  // selectable; `expandSelectionToolNames` mounts it automatically next to the schedule tools.
  [LIST_CAPABILITIES_TOOL_NAME]: () => buildListCapabilitiesTool(listAvailableTools()),
  ...workshopToolBuilders,
  ...latticeToolBuilders
}

// ============================================================================
// Tool Info — front-end dropdown list
// Note: the label/description here are only a **fallback**; before being sent they are
// overridden by ipc/misc.ts using mainMessages().tools for the current UI language (only names
// not covered there use these values). They are separate from each tool's model-facing
// description; changing them does not affect model behavior.
// ============================================================================

/** Display metadata for local tools (plugin tool metadata comes along with the contribution; see tool-contract.ts) */
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
  // Mounted automatically next to the schedule tools; hidden from the selectable list (see the
  // `hidden` set in listAvailableTools) because it is a dependency, not a feature to schedule.
  {
    name: LIST_CAPABILITIES_TOOL_NAME,
    label: 'Capability list',
    description: 'List tools, skills and MCP servers a scheduled task can mount',
    icon: 'RiListCheck',
    color: '#722ed1'
  },
  // Plugin workshop (4) + plugin center release (1): label/description are fallbacks only;
  // main/i18n overrides them by UI language before they are sent
  ...workshopToolInfos,
  ...latticeToolInfos
]

// ============================================================================
// MCP tools (tools provided by external MCP servers)
// ============================================================================

/**
 * MCP tool provider: injected by `runtime/mcp.ts` when the plugin is installed
 * (`setMcpToolProvider`).
 *
 * Why injection instead of a direct import: the MCP manager reads electron-store and spawns
 * subprocesses; importing it directly would drag main-process-only dependencies into the tool
 * registry and break the offline regression run (node loading this module directly). When not
 * injected (plugin not loaded / disabled) it degrades to "no MCP tools", the same path as "no
 * server configured".
 */
let mcpToolProvider: (() => { tools: StructuredToolInterface[]; infos: ToolInfo[] }) | null = null

/** Inject/revoke the MCP tool provider (called from the plugin install's reversible assembly) */
export function setMcpToolProvider(
  provider?: () => { tools: StructuredToolInterface[]; infos: ToolInfo[] }
): void {
  mcpToolProvider = provider ?? null
}

/** Currently ready MCP tools (empty when not injected or not connected) */
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
 * Data access dependencies for the MCP resource tools: injected by `system/harness.ts` during
 * assembly (same reasoning as the MCP tool provider — do not import the MCP manager directly in
 * the tool registry, or the offline regression run drags in the SDK/subprocesses).
 */
let mcpResourceOps: McpResourceOps | null = null

/** Inject/revoke the MCP resource data source (called on plugin assembly and shutdown; when not injected these three tools do not exist) */
export function setMcpResourceOps(ops?: McpResourceOps): void {
  mcpResourceOps = ops ?? null
}

/** Display metadata for the resource tools (fixed names, independent of the data source) */
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

/** "Scheduled tasks" group selection entry: only this entry shows in the list; it expands into 4 tools before running */
const SCHEDULE_GROUP_INFO: ToolInfo = {
  name: SCHEDULE_TOOL_GROUP,
  label: 'Schedules',
  description: 'Create, list, view and edit scheduled tasks',
  icon: 'RiCalendar2Line',
  color: '#722ed1',
  source: 'system'
}

/** "Web fetch & search" group selection entry: only this entry shows in the list; it expands into web_fetch + web_search before running */
const WEB_GROUP_INFO: ToolInfo = {
  name: WEB_TOOL_GROUP,
  label: 'Web fetch & search',
  description: 'Fetch a page and search the web (one selection)',
  icon: 'RiGlobalLine',
  color: '#13c2c2',
  source: 'system'
}

/** The three resource tools when an MCP data source is injected (built fresh each time to use the latest connection) */
/**
 * Tools of built-in features (1: material organization): compiled into the app, not going through
 * the plugin registry.
 *
 * Third-party plugins still go through the `harness.tool` contribution point
 * (`listContributions`); `toolSources()` merges both into one list — indistinguishable to the
 * model and the settings page, only the source differs.
 */
const builtinTools: PluginToolContribution[] = []

/** Register built-in tools (idempotent; called at startup by `src/main/system/notes.ts`) */
export function registerBuiltinHarnessTools(tools: PluginToolContribution[]): void {
  for (const tool of tools) {
    if (!builtinTools.includes(tool)) builtinTools.push(tool)
  }
}

/** Unregister built-in tools (shutdown/test cleanup; ignored when never registered) */
export function unregisterBuiltinHarnessTools(tools: PluginToolContribution[]): void {
  for (const tool of tools) {
    const index = builtinTools.indexOf(tool)
    if (index >= 0) builtinTools.splice(index, 1)
  }
}

/** The three sources pulled fresh on each tool-set build (local tool constants + built-in/plugin contributions + MCP snapshot) */
function toolSources(): {
  local: ToolSource<StructuredToolInterface>[]
  contributed: ToolSource<StructuredToolInterface>[]
  mcp: ToolSource<StructuredToolInterface>[]
} {
  /**
   * Source tagging (the small "system / plugin" label right of each name in the tool list of the
   * settings page / input box):
   * - the local tool table and built-in features registered by `registerBuiltinHarnessTools` →
   *   `system` (compiled with the app);
   * - tools registered by third-party plugins via the `harness.tool` contribution point →
   *   `plugin` (gone as soon as the plugin is disabled);
   * - tools exposed by MCP servers → `mcp` (external process, neither system nor plugin).
   *
   * The info of a plugin contribution is metadata supplied by the plugin itself; here it is
   * **copied and extended**, never mutated.
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
      // The three MCP resource tools are **not here**: they are built per round from "what is
      // selected this round ∩ what declares the resources capability", see buildTools /
      // buildSubAgentTools (a static registry cannot know which servers are selected this round).
    ],
    contributed,
    mcp: mcpSources
  }
}

/**
 * Merged tool table: local tools + plugin contributions + connected MCP tools (rules in
 * tools/registry.ts).
 *
 * **Contributions are pulled again on every call** — this is what makes "plugin enable/disable
 * takes effect immediately": once a plugin is disabled its contribution is removed by the host,
 * and the next assembly (next conversation turn/subagent) does not see its tools. With no plugin
 * loaded the contributions are an empty array and the tool set degrades to the two local tools
 * **without throwing**. Same for MCP: when a server disconnects or is disabled its tools vanish
 * immediately.
 */
function resolveToolBuilders(): Record<string, ToolFactory> {
  return mergeToolSources({ ...toolSources(), onWarn: (message) => logger.warn(message) }).builders
}

/**
 * Tool list (used by the tool dropdown in Settings → Agents): local tools + plugin contributions
 * + MCP tools, with the local one winning on name collisions. Pulled fresh on every call, so
 * plugin enable/disable and MCP connection state are reflected immediately.
 * Ordering and dedup rules share one source with `resolveToolBuilders` (the same
 * `mergeToolSources`), so they cannot drift apart.
 *
 * **Only real, user-selectable tools are returned**: mode tools (4 workshop tools + 1 release
 * tool) are attached by plugin mode automatically; MCP tools (`mcp__…`) / group entries
 * (`mcp@…`) / the legacy marker (`mcp`) are managed by the MCP selector below the input box and
 * merged in at runtime. Filtering happens in the main process; the renderer displays exactly what
 * it receives and does not filter again.
 *
 * **MCP is no longer a separate entry** (user's wording, 2026-11-27: "isn't this MCP server just
 * one unified thing?"): that "select all" entry and the MCP selector cover the same set of tools,
 * and two entry points only make it unclear which side to check. The MCP selector below the input
 * box is now the single entry point; the group marker `mcp` keeps its expansion logic only for
 * **legacy config compatibility**.
 */
export function listAvailableTools(): ToolInfo[] {
  const infos = mergeToolSources({ ...toolSources(), onWarn: (message) => logger.warn(message) }).infos
  const hidden = new Set<string>([
    ...SCHEDULE_TOOL_NAMES,
    ...MCP_RESOURCE_TOOL_INFOS.map((i) => i.name),
    // Mounted automatically with the schedule tools; not a selectable item of its own
    LIST_CAPABILITIES_TOOL_NAME
  ])
  const out: ToolInfo[] = []
  let webGroupPlaced = false
  for (const info of infos) {
    if (!isSelectableMainAgentTool(info.name) || hidden.has(info.name)) continue
    /**
     * Web fetch / web search are merged into one entry (user's wording, 2026-11-27: "merge these
     * two into one registration, like the scheduled tasks"): the group entry is placed at the
     * position of the first and dropped at the second, so the list order still falls in the local
     * tool tier (weather, time, web, deliverables…) instead of being pushed behind plugin tools.
     */
    if ((WEB_TOOL_NAMES as readonly string[]).includes(info.name)) {
      if (!webGroupPlaced) {
        out.push(WEB_GROUP_INFO)
        webGroupPlaced = true
      }
      continue
    }
    // Group entries are added here; a same-named entry mixed into legacy config/plugins never
    // appears twice
    if (isScheduleToolGroup(info.name) || isMcpToolGroup(info.name) || isWebToolGroup(info.name)) {
      continue
    }
    out.push(info)
  }
  // Group entries are added here: scheduled tasks always exist; the web group normally lands in
  // the loop (both tools are always in the local tool table), so this is only a fallback in case
  // the table is changed.
  if (!webGroupPlaced) out.push(WEB_GROUP_INFO)
  out.push(SCHEDULE_GROUP_INFO)
  return out
}

// ============================================================================
// Build Tools
// ============================================================================

/** Connected servers that declare the resources capability (degrades to "all supported" when the legacy injection provides no capability list) */
function resourceCapableServers(): string[] {
  if (!mcpResourceOps) return []
  try {
    return mcpResourceOps.resourceCapableServers?.() ?? mcpResourceOps.servers()
  } catch {
    return []
  }
}

/** MCP server names (config names) selected this round: translates `mcp@<namespace>` and the legacy `mcp` marker into server names */
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
 * Servers usable by this round's resource tools = **selected ∩ declaring the resources
 * capability**.
 *
 * Both conditions are required (user's wording, 2026-11-27):
 *  - servers that do not declare resources are not attached (calling them would only return an
 *    empty list, wasting context);
 *  - servers that are not selected are not readable (selecting A must not also read B's
 *    resources).
 */
function resourceScopedServers(toolNames: string[]): string[] {
  const capable = resourceCapableServers()
  return selectedMcpServerNames(toolNames).filter((server) => capable.includes(server))
}

/** Resource tool instances to attach this round; none are built when no server is usable */
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
 * Expand group entries in the selection list → real tool names (deduplicated):
 * - `schedule-tasks` → the 4 `schedule_*` tools;
 * - `web-tools` → `web_fetch` + `web_search`;
 * - `mcp@<server>` → that server's tools; plus 3 resource tools when the server declares
 *   resources;
 * - `mcp` → all tools of currently connected MCP servers (**legacy config compatibility only**;
 *   the list no longer offers this entry);
 * - everything else is kept as is.
 *
 * The user checks one entry in the list; at runtime all tools it represents are attached (the
 * same idea as the material organization merge).
 */
export function expandSelectionToolNames(
  toolNames: string[],
  mcpToolNames?: string[]
): string[] {
  const allMcp = mcpToolNames ?? currentMcpTools().infos.map((info) => info.name)
  // Whether the three resource tools are included depends on "selected this round ∩ declares
  // resources" (see resourceScopedServers)
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
  // The schedule tools depend on the capability catalog to fill `agentConfig` with valid values
  // (tool names / skill ids / mcp@namespace). Mount it automatically next to them, so the user
  // only has to check the scheduled-task group.
  if (out.some((name) => (SCHEDULE_TOOL_NAMES as readonly string[]).includes(name))) {
    out.push(LIST_CAPABILITIES_TOOL_NAME)
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

/** Build the actual tool instances for an agent (group entries are expanded first too) */
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
