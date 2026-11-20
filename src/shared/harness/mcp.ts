/**
 * MCP（Model Context Protocol）服务器配置的**跨进程 DTO**（主进程 ↔ 渲染层 ↔ electron-store）。
 *
 * 为什么单独一个文件、且运行期零依赖：这份形状同时被三处消费——
 *  - 主进程的连接管理器（`main/runtime/mcp.ts`，把配置翻成 @langchain/mcp-adapters 的连接）；
 *  - 设置 → MCP 页的表单（`renderer/components/settings/McpSettings.tsx`）；
 *  - 落盘（electron-store 的 `mcpServers` 键，见 `main/runtime/mcp-store.ts`）。
 *
 * 字段命名刻意对齐 mcp.json / Cursor / Claude Desktop 的通用写法（command/args/env、url/headers），
 * 这样用户可以直接粘贴现成的服务器条目，不用重写一遍。
 */

/** 传输方式：本地进程（stdio）或远程地址（Streamable HTTP，可回退 SSE） */
export type McpTransport = 'stdio' | 'http' | 'sse'

/** 一条 MCP 服务器配置（electron-store 里存的就是它的数组） */
export interface McpServerConfig {
  /** 稳定标识（nanoid/时间戳生成），工具命名空间与增删改都按它定位 */
  id: string
  /** 展示名（设置页与工具卡片上用），也是工具名前缀的来源（会被净化成 [A-Za-z0-9_-]） */
  name: string
  /** 补充说明（可为空）：这台服务器接的是什么，便于以后分辨 */
  description?: string
  /** 是否启用：停用即不连接、其工具也不出现在工具清单里 */
  enabled: boolean
  transport: McpTransport
  /** stdio：可执行文件（如 npx / uvx / node） */
  command?: string
  /** stdio：命令行参数 */
  args?: string[]
  /** stdio：附加环境变量（在宿主环境之上叠加） */
  env?: Record<string, string>
  /** stdio：工作目录（可选） */
  cwd?: string
  /** http/sse：服务地址 */
  url?: string
  /** http/sse：附加请求头（token 等） */
  headers?: Record<string, string>
  /** 单次工具调用超时（毫秒）；留空用工程默认值 */
  timeoutMs?: number
}

/** 服务器连上后拿到的一条工具（设置页展示 + 工具清单并入用） */
export interface McpToolInfo {
  /** 全名（`mcp__<serverId>__<toolName>`），即模型看到的名字 */
  name: string
  /** 服务器上报的原始工具名 */
  rawName: string
  /** 给模型看的描述（可能为空） */
  description: string
}

/**
 * 服务器的实时连接状态（设置页逐行展示；连不上的原因要能看见）。
 * `unknown` = 还没连过（加载列表不再顺手重连，见 runtime/mcp.ts 的 mcpServerViews）。
 */
export type McpServerStatus = 'ok' | 'error' | 'disabled' | 'unconfigured' | 'unknown'

/** 设置页一行的视图（配置 + 运行期状态 + 工具清单） */
export interface McpServerView {
  config: McpServerConfig
  status: McpServerStatus
  /** status === 'error' 时的失败原因（原始错误信息） */
  error?: string
  tools: McpToolInfo[]
  /** 本行凭据里的敏感值是否已配置（渲染层只显示「已设置」，不回传明文） */
  hasSecrets: { env: boolean; headers: boolean }
}

/** 设置页保存时的入参（id 缺省表示新增） */
export type McpServerInput = Omit<McpServerConfig, 'id'> & { id?: string }

/**
 * 把任意来源的条目规整成合法配置（新增/编辑/导入 mcp.json 共用）。
 *
 * 宽容之处（都是为了「粘贴现成 JSON 就能用」）：
 *  - `type` / `transport` 二选一，`sse` 归一成自己的传输；
 *  - 缺少 `args` 时补空数组（stdio 连接 schema 要求是数组）；
 *  - 名字非法（空）时用 id 兜底，id 也缺时由调用方生成。
 * 非法输入抛错，错误信息面向用户可直接显示在表单下方。
 */
export function normalizeMcpServer(input: McpServerInput): McpServerConfig {
  const id = (input.id ?? '').trim()
  const name = (input.name ?? '').trim() || id
  if (!name) throw new Error('MCP server name is required')

  const rawType = (input.transport ?? (input as { type?: string }).type ?? 'stdio') as string
  const transport: McpTransport =
    rawType === 'http' || rawType === 'sse' ? rawType : ('stdio' as McpTransport)

  if (transport === 'stdio') {
    const command = (input.command ?? '').trim()
    if (!command) throw new Error('MCP stdio server requires a command')
    return {
      id: id || name,
      name,
      description: input.description?.trim() || undefined,
      enabled: input.enabled ?? true,
      transport,
      command,
      args: Array.isArray(input.args) ? input.args.map((a) => String(a)) : [],
      env: cleanMap(input.env),
      cwd: input.cwd?.trim() || undefined,
      timeoutMs: cleanTimeout(input.timeoutMs)
    }
  }

  const url = (input.url ?? '').trim()
  if (!url) throw new Error('MCP HTTP server requires a url')
  return {
    id: id || name,
    name,
    description: input.description?.trim() || undefined,
    enabled: input.enabled ?? true,
    transport,
    url,
    headers: cleanMap(input.headers),
    timeoutMs: cleanTimeout(input.timeoutMs)
  }
}

/** 去掉空键/空值；全空时返回 undefined（避免落盘一堆空对象） */
function cleanMap(map?: Record<string, string>): Record<string, string> | undefined {
  if (!map) return undefined
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(map)) {
    const k = key.trim()
    if (k && value !== undefined && value !== null) out[k] = String(value)
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function cleanTimeout(value?: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return Math.round(value)
}

/**
 * 工具名命名空间：`mcp__<server>__<tool>`。
 *
 * 前缀为什么必要：不同服务器的工具可能重名（`search` / `read`），而工具清单是**扁平**的
 * 一张表（本地工具 + 插件贡献 + MCP），重名会被注册表当冲突丢掉。这里统一成
 * `mcp__` 两段式，既避免冲突，又让工具卡片一眼看出「这是外部 MCP 工具」。
 * 名字里的非法字符（空格、点、中文）一律净化成 `_`：部分模型对工具名字符集敏感。
 */
export const MCP_TOOL_PREFIX = 'mcp__'

/** 服务器名 → 工具命名空间片段（净化到 [A-Za-z0-9_-]） */
export function mcpNamespace(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return cleaned || 'server'
}

/** 组装工具全名 */
export function mcpToolName(serverNamespace: string, rawToolName: string): string {
  return `${MCP_TOOL_PREFIX}${serverNamespace}__${rawToolName}`
}

/**
 * 反解工具全名。返回 null 表示这不是一条 MCP 工具。
 *
 * 只认 `mcp__` 前缀 + 第一个 `__` 分隔：工具名本身可能含 `__`（如 `list__x`），
 * 按第一个分隔切才不会把服务器名切错。
 */
export function parseMcpToolName(fullName: string): { server: string; tool: string } | null {
  if (!fullName.startsWith(MCP_TOOL_PREFIX)) return null
  const rest = fullName.slice(MCP_TOOL_PREFIX.length)
  const sep = rest.indexOf('__')
  if (sep <= 0) return null
  return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) }
}

/** 是不是一条 MCP 工具的全名（`mcp__…`） */
export function isMcpToolName(name?: string): boolean {
  return typeof name === 'string' && name.startsWith(MCP_TOOL_PREFIX)
}

/**
 * 智能体工具选择里的「MCP 服务器」分组项：`mcp@<命名空间>`。
 *
 * 为什么要有它（2026-09-26 用户要求「MCP 注册到智能体的设置页面，不能直接选择全部的工具」
 * → 紧接着又要求「要用 mcp 的名称」）：MCP 服务器一多，工具就是几十项
 * （`mcp__<服务器>__<工具>`），智能体页的工具下拉会被它们淹没；而在那儿挑某个具体工具，
 * 与 MCP 页的逐项开关本来就是**同一个决定**——两个入口必然漂移。
 * 现在的分工：智能体页**按服务器**给一项，名字就用服务器自己的名字（如 `github`）；
 * **具体哪几个工具只由 MCP 设置页的逐项开关决定**。
 *
 * 分隔符为什么用 `@`：`mcpNamespace()` 只保留 `[A-Za-z0-9_-]`，`@` 不可能出现在命名空间里，
 * 因此这一项与真实工具全名（`mcp__…`）绝不会互相误认。
 */
export const MCP_SERVER_GROUP_PREFIX = 'mcp@'

/** 服务器命名空间 → 选择项的值 */
export function mcpServerGroupValue(namespace: string): string {
  return `${MCP_SERVER_GROUP_PREFIX}${namespace}`
}

/** 反解选择项：是某台 MCP 服务器的分组项就给命名空间，否则 null */
export function parseMcpServerGroup(value?: string): string | null {
  if (typeof value !== 'string' || !value.startsWith(MCP_SERVER_GROUP_PREFIX)) return null
  const namespace = value.slice(MCP_SERVER_GROUP_PREFIX.length)
  return namespace || null
}

/** 该选择项是不是某台 MCP 服务器的分组项 */
export function isMcpServerGroup(value?: string): boolean {
  return parseMcpServerGroup(value) !== null
}

/**
 * 历史标记：最早那版只给一项笼统的「MCP」（所有服务器一起开关）。
 * 现在按服务器分开，但旧配置里可能还留着它——读到时按「全部已启用的 MCP 工具」处理。
 */
export const MCP_TOOL_GROUP = 'mcp'

/** 该名字是不是那个笼统的旧「MCP」分组项 */
export function isMcpToolGroup(name?: string): boolean {
  return name === MCP_TOOL_GROUP
}

/**
 * 把选择列表里的 MCP 相关项展开成**具体工具名**（其余原样保留）。
 *
 * 三种形态都认：
 *  - `mcp@<命名空间>`：那台服务器在 MCP 页被勾选的工具；
 *  - `mcp`（旧标记）：全部被勾选的 MCP 工具；
 *  - `mcp__<命名空间>__<工具>`（旧数据里逐个存的真实全名）：**也按所属服务器的勾选展开**——
 *    MCP 页是工具级的唯一管控点，不能因为别处存了个名字就绕过它。
 */
export function expandMcpServerGroups(
  names: string[] | undefined,
  enabledMcpToolNames: string[]
): string[] {
  const out: string[] = []
  for (const name of names ?? []) {
    const groupNamespace = parseMcpServerGroup(name)
    if (groupNamespace) {
      out.push(
        ...enabledMcpToolNames.filter((tool) => parseMcpToolName(tool)?.server === groupNamespace)
      )
      continue
    }
    if (isMcpToolGroup(name)) {
      out.push(...enabledMcpToolNames)
      continue
    }
    const parsed = parseMcpToolName(name)
    if (parsed) {
      out.push(
        ...enabledMcpToolNames.filter((tool) => parseMcpToolName(tool)?.server === parsed.server)
      )
      continue
    }
    out.push(name)
  }
  return out
}

/**
 * **模式工具**：插件工坊的 4 个工具（草稿 / 构建 / 验收 / 发布）。
 *
 * 它们**不进**「设置 → 智能体 → 默认工具」的可选清单：那张清单是给「哪一轮都可能用得上」的
 * 工具准备的，而这 4 个只在写插件时成立。用户口径（2026-09-29）：不要在这里勾了才注册；
 * 切到**插件模式**就自动挂载，同时把它们从主智能体的可选清单里拿掉。
 *
 * 于是模式工具走一条独立的路：
 *  - 主进程注册表照常登记实例（`main/tools/builders.ts` 的 `toolBuilders`），
 *    `buildTools` 才拿得到它们、同名插件贡献也照旧被本地工具挡住；
 *  - `listAvailableTools()` 把它们滤掉 —— 设置页下拉里看不到、也没法勾；
 *  - `effectiveMainAgentTools(..., { pluginMode: true })` 把它们**追加**进本轮工具名。
 *    插件模式的判定 = 会话（话题）的记忆作用域是 `plugin:<id>`，见 `main/memory-scope.ts`，
 *    因此「切到插件模式 → 下一轮就能用」，不需要任何勾选动作，重启应用后重开这条会话也仍然成立。
 *
 * 名单放在这个 shared 模块里、而不是新开一个文件：主进程（工具注册/组装）与渲染层
 * （设置页清理历史残留）都要用它，而本模块是**零相对 import 的纯模块**——
 * `test/verify-mcp-tools.mjs` 直接 `node --experimental-strip-types` 加载它做离线断言，
 * 多一条相对 import 那条路就走不通了。
 */
export const PLUGIN_MODE_TOOL_NAMES = [
  'plugin_draft',
  'plugin_build',
  'plugin_verify',
  'plugin_publish'
] as const

/** 这个名字是不是插件模式的模式工具（设置页过滤历史残留时用） */
export function isPluginModeTool(name: string): boolean {
  return (PLUGIN_MODE_TOOL_NAMES as readonly string[]).includes(name)
}

/**
 * 主智能体配置（electron-store 的 `mainAgent` 键）。
 *
 * `tools` 是**用户从「智能体」页工具下拉里勾的**（本地工具 + 插件工具，**不含** MCP 工具；
 * MCP 在那一页按服务器显示成 `mcp@<命名空间>`，见 MCP_SERVER_GROUP_PREFIX），
 * `mcpTools` 是**在 MCP 页按工具勾的**（MCP 是全项目唯一的工具级管控点）。
 * 两者分开存的原因：进 MCP 页反勾某个工具时，只该停用它自己，不能把用户在智能体页挑的
 * 其他工具一起抹掉——合并成一张表存就必然出这个问题。
 * 模式工具（插件工坊 4 个）两份都不进：它们由 `pluginMode` 自动带进来。
 */
export interface MainAgentConfig {
  tools?: string[]
  skills?: string[]
  mcpTools?: string[]
}

/**
 * 一轮对话实际启用的工具名 = 主智能体勾选的工具 + MCP 页勾选的 MCP 工具（去重）
 *   + 插件模式的模式工具（`options.pluginMode`，名单见 PLUGIN_MODE_TOOL_NAMES）。
 *
 * 单一真源：主进程组装工具集（harness-start-stream / harness-send-message）与话题上的工具快照
 * 都走这里，避免「页面显示已启用、实际没挂上」这类漂移。`tools` 里若混进了 MCP 分组项
 * （历史数据/子智能体配置被复制过来）或模式工具（改版前在这一页勾过的历史配置），这里直接跳过
 * ——它们都不是用户可勾的真实工具名，模式工具再由 `pluginMode` 统一追加。
 */
export function effectiveMainAgentTools(
  config?: MainAgentConfig | null,
  options?: { pluginMode?: boolean }
): string[] {
  const out: string[] = []
  const push = (names?: string[]): void => {
    for (const name of names ?? []) {
      if (typeof name !== 'string' || !name) continue
      if (isMcpToolGroup(name) || isMcpServerGroup(name)) continue
      if (isPluginModeTool(name)) continue
      if (!out.includes(name)) out.push(name)
    }
  }
  push(config?.tools)
  push(config?.mcpTools)
  if (options?.pluginMode) {
    for (const name of PLUGIN_MODE_TOOL_NAMES) if (!out.includes(name)) out.push(name)
  }
  return out
}

/**
 * 渲染层的**掩码占位**：env / headers 的值不下发到界面（凭据不出主进程），
 * 表单里显示的就是这个串；保存时把磁盘上的原值填回去（用户没动这一项）。
 */
export const SECRET_MASK = '••••••'

/** 下发配置前把凭据值掩码（只掩值，键名保留——用户需要看到自己配了哪些变量） */
export function maskServerSecrets<
  T extends { env?: Record<string, string>; headers?: Record<string, string> }
>(config: T): T {
  const mask = (map?: Record<string, string>): Record<string, string> | undefined =>
    map ? Object.fromEntries(Object.keys(map).map((k) => [k, SECRET_MASK])) : undefined
  return { ...config, env: mask(config.env), headers: mask(config.headers) }
}

/**
 * 保存时把掩码还原成磁盘上的原值。
 *
 * 规则：**值等于掩码的键**取原值，其余键用新值（新增/删除照旧生效）。这样用户不改凭据时
 * 不必重新输入 token，也不会因为「表单不回显」而把已保存的值清空。
 */
export function restoreServerSecrets(
  input: McpServerInput,
  previous?: McpServerInput
): McpServerInput {
  const restore = (
    incoming?: Record<string, string>,
    stored?: Record<string, string>
  ): Record<string, string> | undefined => {
    if (!incoming) return undefined
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(incoming)) {
      out[key] = value === SECRET_MASK && stored?.[key] !== undefined ? stored[key] : value
    }
    return out
  }
  return {
    ...input,
    env: restore(input.env, previous?.env),
    headers: restore(input.headers, previous?.headers)
  }
}
