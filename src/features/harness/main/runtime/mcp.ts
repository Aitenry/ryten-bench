/**
 * MCP（Model Context Protocol）客户端管理器 —— harness 主进程侧的全部连接逻辑。
 *
 * 职责：
 *  1. 把 electron-store 里的服务器配置翻成真实的 MCP 连接（stdio 子进程 / Streamable HTTP / SSE）；
 *  2. 连上后把服务器暴露的工具翻成 **LangChain 工具实例**，并入 harness 的工具注册表；
 *  3. 维护「设置页看得到的状态」：连没连上、报什么错、这台服务器有哪些工具。
 *
 * 为什么自己建连接而不直接用 `MultiServerMCPClient`：那个封装会把所有服务器塞进一个
 * 客户端，任一台连不上时**整份工具表**都可能拿不到；而默认托管进程（stdio）一旦起不来，
 * 用户在设置页只看到「没有工具」而看不到原因。这里逐台建连、逐台记账，一台坏不影响其余。
 *
 * 生命周期（谁调谁）：`configureMcp()`（插件 install，只注入存储读法）→ `refreshCatalog()`
 * （启动预热 / 保存配置后重连）→ `currentMcpTools()`（每轮组装工具集时同步取快照）。
 * 工具实例**不预先全部创建**：设计期发现 stdio 进程只能靠真正启动才知道好坏，所以
 * `currentMcpTools()` 永远是同步返回当前快照，慢的连接在后台 `refreshCatalog()` 里跑。
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import logger from 'electron-log'
import type { StructuredToolInterface } from '@langchain/core/tools'
import type { ToolInfo } from '../../../../main/plugins/tool-contract'
import {
  buildMcpTool,
  DEFAULT_MCP_TOOL_TIMEOUT_MS,
  formatMcpToolResult,
  withTimeout,
  type McpCallToolResult
} from './mcp-tool'
import {
  maskServerSecrets,
  mcpNamespace,
  mcpToolName,
  normalizeMcpServer,
  parseMcpToolName,
  restoreServerSecrets,
  type McpServerConfig,
  type McpServerInput,
  type McpServerStatus,
  type McpServerView,
  type McpToolInfo
} from '../../shared/mcp'

/** 工具详情卡片的图标与配色（MCP 工具统一用「插头」，与内置/插件工具区分开） */
const MCP_TOOL_ICON = 'RiPlug2Line'
const MCP_TOOL_COLOR = '#8c6b3f'

/**
 * 一次连接尝试的握手超时（毫秒）：服务起不来要尽快反馈到设置页，而不是干等。
 * 工具调用超时在 `mcp-tool.ts`（`DEFAULT_MCP_TOOL_TIMEOUT_MS`），可由服务器配置覆盖。
 */
const CONNECT_TIMEOUT_MS = 20_000

/** 快照被认为「还新鲜」的时长；过期后下一次取工具会顺手在后台重连 */
const SNAPSHOT_TTL_MS = 5 * 60_000

/* ── MCP SDK 的加载方式（有意为之，别改回静态 import） ─────────────────────
 *
 * `@modelcontextprotocol/sdk` 是 **ESM-only**（package.json "type": "module"），而插件
 * 主进程入口是 **CJS**（打包产物 `userData/plugins/<id>/main.cjs`，见 src/plugins/PACKAGING.md）。
 * 打包器把裸模块改写成**同步**的宿主解析调用（`globalThis.__RB_HOST_RESOLVE__(spec)`），
 * 于是 `require('@modelcontextprotocol/sdk/...')` 只会在插件装载期直接抛 ERR_REQUIRE_ESM；
 * 动态 `import()` 又会在**插件目录**下解析说明符——userData 不在应用树里，那里没有
 * node_modules，必然 ERR_MODULE_NOT_FOUND。
 *
 * 因此：用 `createRequire(应用根)` **惰性**加载。既能解析到 SDK（与宿主同一份实例），
 * 又不在模块顶层就加载（没配服务器时根本不碰 MCP 代码）。应用根由插件 install 经
 * `setMcpModuleBase(app.getAppPath())` 注入。
 * ────────────────────────────────────────────────────────────────────── */

/** 应用根（含 package.json 的目录）：插件 install 时注入 */
let moduleBase: string | null = null
/** 已加载的 SDK 类型（进程内缓存；失败不缓存，用户修好环境后重试应能成功） */
let sdkModule: Promise<McpSdkModule> | null = null

interface McpSdkModule {
  Client: typeof import('@modelcontextprotocol/sdk/client/index.js').Client
  StdioClientTransport: typeof import('@modelcontextprotocol/sdk/client/stdio.js').StdioClientTransport
  StreamableHTTPClientTransport: typeof import('@modelcontextprotocol/sdk/client/streamableHttp.js').StreamableHTTPClientTransport
  SSEClientTransport: typeof import('@modelcontextprotocol/sdk/client/sse.js').SSEClientTransport
}

/** 注入宿主应用根（插件 install 的可逆装配里调用；停用时传 undefined 复位） */
export function setMcpModuleBase(base?: string): void {
  moduleBase = base ?? null
  sdkModule = null
}

/** 已连接客户端的类型（SDK 类型只在内部用，对外只见结构化工具） */
type McpClient = import('@modelcontextprotocol/sdk/client/index.js').Client

/**
 * 惰性加载 MCP SDK。
 *
 * 依赖 Node 的 `require(ESM)` 能力（Node 22.12+ 默认开启，Electron 44 自带满足）；
 * 老版本 Node 上这里会抛错并被上层记成「这台服务器连接失败」，其余功能不受影响。
 */
async function loadSdk(): Promise<McpSdkModule> {
  if (!sdkModule) {
    const base = moduleBase ?? process.cwd()
    const requireFromApp = createRequire(join(base, 'package.json'))
    sdkModule = Promise.resolve({
      Client: requireFromApp('@modelcontextprotocol/sdk/client/index.js').Client,
      StdioClientTransport: requireFromApp('@modelcontextprotocol/sdk/client/stdio.js')
        .StdioClientTransport,
      StreamableHTTPClientTransport: requireFromApp(
        '@modelcontextprotocol/sdk/client/streamableHttp.js'
      ).StreamableHTTPClientTransport,
      SSEClientTransport: requireFromApp('@modelcontextprotocol/sdk/client/sse.js')
        .SSEClientTransport
    } as McpSdkModule).catch((err) => {
      sdkModule = null
      throw err
    })
  }
  return sdkModule
}

/** 一条已就绪的 MCP 工具（渲染层的清单与模型侧的实例都来自它） */
interface McpToolDef {
  /** 全名：`mcp__<server>__<tool>`，即模型看到的名字 */
  name: string
  /** 服务器上报的原始工具名 */
  rawName: string
  /** 服务器名字（配置里的 name，用于展示与反查） */
  serverName: string
  serverId: string
  description: string
  info: ToolInfo
  instance: StructuredToolInterface
}

/** 一台服务器的运行期记录 */
interface McpServerEntry {
  config: McpServerConfig
  status: McpServerStatus
  error?: string
  tools: McpToolInfo[]
}

interface McpSnapshot {
  /** 取快照的时刻（判断新鲜度 / 触发后台重连） */
  at: number
  /** 配置指纹：配置变了立刻作废，不必等 TTL */
  signature: string
  byFullName: Map<string, McpToolDef>
  /** 服务器名字（净化后的命名空间）→ 连接的逆查表，工具调用时用 */
  clients: Map<string, McpClient>
  entries: McpServerEntry[]
}

/** 存储读取器由插件 install 注入（管理器本身不 import electron，便于离线回归） */
let readServersFromStore: () => McpServerInput[] = () => []

/** 当前快照（同步读，供每轮工具组装） */
let snapshot: McpSnapshot = emptySnapshot()
let loading: Promise<void> | null = null
/** 连接代次：配置变更/关闭时 +1，让在途的旧连接结果作废 */
let generation = 0
/** 上一次打印过错误的服务器（同一轮刷新里同样的错只记一次日志） */
const loggedErrors = new Set<string>()

function emptySnapshot(): McpSnapshot {
  return { at: 0, signature: '', byFullName: new Map(), clients: new Map(), entries: [] }
}

/** 插件 install 时注入「从 electron-store 读配置」的方法；停用时传 undefined 复位 */
export function configureMcp(reader?: () => McpServerInput[]): void {
  readServersFromStore = reader ?? (() => [])
}

/** 规范化后的服务器配置列表（非法条目跳过并记日志，不让一条坏配置毁掉整页） */
export function listMcpServers(): McpServerConfig[] {
  let raw: McpServerInput[]
  try {
    raw = readServersFromStore() ?? []
  } catch (err) {
    logger.warn('[MCP] 读取服务器配置失败:', err)
    return []
  }
  const out: McpServerConfig[] = []
  for (const item of raw) {
    try {
      out.push(normalizeMcpServer(item))
    } catch (err) {
      logger.warn(`[MCP] 忽略无法解析的服务器配置 "${item?.name ?? item?.id ?? '?'}":`, err)
    }
  }
  return out
}

/** 配置指纹：连接相关的字段全进签名（改超时也算配置变更，应重连） */
function signatureOf(servers: McpServerConfig[]): string {
  return JSON.stringify(
    servers.map((s) => [
      s.id,
      s.name,
      s.enabled,
      s.transport,
      s.command ?? '',
      s.args ?? [],
      s.env ?? {},
      s.cwd ?? '',
      s.url ?? '',
      s.headers ?? {},
      s.timeoutMs ?? 0
    ])
  )
}

/** 敏感值不落日志：只看键名，值一律打码 */
function maskMap(map?: Record<string, string>): Record<string, string> {
  if (!map) return {}
  return Object.fromEntries(Object.keys(map).map((k) => [k, '***']))
}

/** 建一台服务器的连接（不含工具加载）；返回已 connect 的 Client */
async function connectServer(config: McpServerConfig): Promise<McpClient> {
  const { Client, StdioClientTransport, StreamableHTTPClientTransport, SSEClientTransport } =
    await loadSdk()
  const client = new Client({ name: 'rytenbench-harness', version: '0.1.0' }, { capabilities: {} })
  const transport =
    config.transport === 'stdio'
      ? new StdioClientTransport({
          command: config.command as string,
          args: config.args ?? [],
          // 只在用户显式配了 env 时覆盖：默认继承宿主环境（npx 找不到 PATH 就起不来）
          ...(config.env
            ? { env: { ...process.env, ...config.env } as Record<string, string> }
            : {}),
          cwd: config.cwd,
          // stderr 进管道而不是 inherit：MCP 服务器爱往 stderr 打日志，直接继承会污染应用日志
          stderr: 'pipe'
        })
      : config.transport === 'sse'
        ? new SSEClientTransport(new URL(config.url as string), {
            requestInit: config.headers ? { headers: config.headers } : undefined
          })
        : new StreamableHTTPClientTransport(new URL(config.url as string), {
            requestInit: config.headers ? { headers: config.headers } : undefined
          })

  if (config.transport === 'stdio') {
    // stderr 是 stdio 传输独有的：服务器日志进管道（见上方 spawn 参数），这里转进应用日志
    const stdio = transport as InstanceType<McpSdkModule['StdioClientTransport']>
    stdio.stderr?.on('data', (chunk: Buffer) => {
      const text = String(chunk).trim().split('\n').slice(0, 3).join(' | ')
      if (text) logger.info(`[MCP:${config.name}] ${text.slice(0, 500)}`)
    })
  }

  await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `连接超时（${config.name}）`)
  return client
}

/**
 * 读一台服务器暴露的工具（不含内置限制：MCP 服务器还支持 resources/prompts，这里只接工具）。
 *
 * 自己做而不是 `loadMcpTools`：需要**按台**控制命名与超时，并在单台失败时只标记这一台。
 * tools/list 支持分页游标，照游标翻到底。
 */
async function listServerTools(
  client: McpClient,
  config: McpServerConfig
): Promise<{ rawName: string; description: string; inputSchema: Record<string, unknown> }[]> {
  const collected: {
    rawName: string
    description: string
    inputSchema: Record<string, unknown>
  }[] = []
  let cursor: string | undefined
  for (let page = 0; page < 50; page += 1) {
    const result = await withTimeout(
      client.listTools(cursor ? { cursor } : {}),
      CONNECT_TIMEOUT_MS,
      `读取工具清单超时（${config.name}）`
    )
    for (const item of result.tools ?? []) {
      if (!item?.name) continue
      collected.push({
        rawName: item.name,
        description: item.description ?? '',
        inputSchema: (item.inputSchema ?? { type: 'object' }) as Record<string, unknown>
      })
    }
    cursor = result.nextCursor
    if (!cursor) break
  }
  return collected
}

/** `client.callTool` 的返回形状见 mcp-tool.ts（`McpCallToolResult`），这里只做连接与记账 */

/**
 * 重连全部服务器并重建快照。
 *
 * - 逐台串行：并发起十几个子进程会让「哪台拖慢了启动」无从判断，而这段本该是后台任务；
 * - 单台失败只记在这一台上（status='error' + 原因），其余照常可用；
 * - 代次守卫：刷新期间配置又变了（或插件被停用）时，旧结果直接丢弃、连接就地关掉。
 */
export async function refreshCatalog(): Promise<McpServerView[]> {
  // 同一时刻只允许一次刷新：并发的保存/预热共用同一趟连接，避免反复起子进程
  if (loading) {
    await loading
    return snapshot.entries.map(toView)
  }
  const runGeneration = ++generation
  loading = (async () => {
    const servers = listMcpServers()
    const byFullName = new Map<string, McpToolDef>()
    const clients = new Map<string, McpClient>()
    const entries: McpServerEntry[] = []
    const previous = snapshot

    for (const config of servers) {
      if (runGeneration !== generation) break
      const namespace = mcpNamespace(config.name)

      if (!config.enabled) {
        entries.push({ config, status: 'disabled', tools: [] })
        continue
      }
      if (config.transport === 'stdio' ? !config.command : !config.url) {
        entries.push({ config, status: 'unconfigured', error: 'missing command/url', tools: [] })
        continue
      }

      let client: McpClient | undefined
      try {
        client = await connectServer(config)
        const listed = await listServerTools(client, config)
        if (runGeneration !== generation) {
          await client.close().catch(() => undefined)
          break
        }
        clients.set(namespace, client)

        const tools: McpToolInfo[] = []
        for (const item of listed) {
          const fullName = mcpToolName(namespace, item.rawName)
          if (byFullName.has(fullName)) {
            logger.warn(`[MCP] 工具名冲突：${fullName}（同机重名，已忽略后一个）`)
            continue
          }
          const info: ToolInfo = {
            name: fullName,
            label: `${namespace} · ${item.rawName}`,
            description: item.description,
            icon: MCP_TOOL_ICON,
            color: MCP_TOOL_COLOR
          }
          byFullName.set(fullName, {
            name: fullName,
            rawName: item.rawName,
            serverName: config.name,
            serverId: config.id,
            description: item.description,
            info,
            instance: buildMcpTool({
              fullName,
              rawName: item.rawName,
              serverName: config.name,
              description: item.description,
              caller: client,
              timeoutMs: config.timeoutMs
            })
          })
          tools.push({ name: fullName, rawName: item.rawName, description: item.description })
        }
        tools.sort((a, b) => a.rawName.localeCompare(b.rawName, 'en'))
        entries.push({ config, status: 'ok', tools })
        loggedErrors.delete(config.id)
        logger.info(
          `[MCP] 已连接 ${config.name}（${config.transport}）：${tools.length} 个工具` +
            ` env=${JSON.stringify(maskMap(config.env))} headers=${JSON.stringify(maskMap(config.headers))}`
        )
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (client) await client.close().catch(() => undefined)
        entries.push({ config, status: 'error', error: message, tools: [] })
        if (!loggedErrors.has(config.id)) {
          loggedErrors.add(config.id)
          logger.warn(`[MCP] 连接失败 ${config.name}（${config.transport}）：${message}`)
        }
      }
    }

    if (runGeneration !== generation) return

    // 关掉旧快照里不再出现的连接（配置删除/改名/停用后不留孤儿子进程）
    for (const [namespace, client] of previous.clients) {
      if (!clients.has(namespace)) await client.close().catch(() => undefined)
    }
    snapshot = {
      at: Date.now(),
      signature: signatureOf(servers),
      byFullName,
      clients,
      entries
    }
  })()
    .catch((err) => logger.error('[MCP] 刷新服务器目录失败:', err))
    .finally(() => {
      loading = null
    })
  await loading
  return snapshot.entries.map(toView)
}

/**
 * 设置页视图：**凭据值在这里掩码**。
 *
 * 下发到渲染层的配置里，env/headers 的值一律替换成掩码串（键名保留，用户得看见自己配了
 * 哪些变量）；保存时 mcp-store 会把掩码还原成磁盘上的原值。这样 token 不会经过渲染进程，
 * 表单也不会因为「不回显」而把已存的凭据写坏。`entry.config` 本身保持原值供连接使用。
 */
function toView(entry: McpServerEntry): McpServerView {
  return {
    config: maskServerSecrets(entry.config),
    status: entry.status,
    error: entry.error,
    tools: entry.tools,
    hasSecrets: {
      env: Object.keys(entry.config.env ?? {}).length > 0,
      headers: Object.keys(entry.config.headers ?? {}).length > 0
    }
  }
}

/** 凭据「配没配」的只读信息（列表在没有运行期记录时也要给得出） */
function hasSecretsOf(config: McpServerConfig): McpServerView['hasSecrets'] {
  return {
    env: Object.keys(config.env ?? {}).length > 0,
    headers: Object.keys(config.headers ?? {}).length > 0
  }
}

/**
 * 每轮组装工具集时的**同步**入口：给当前快照；顺带在后台做两件事——
 * 配置变了就重连，或快照过期了刷新一次。同步返回保证工具装配路径不被网络拖住。
 */
export function currentMcpTools(): { tools: StructuredToolInterface[]; infos: ToolInfo[] } {
  const servers = listMcpServers()
  const signature = signatureOf(servers)
  const stale = Date.now() - snapshot.at > SNAPSHOT_TTL_MS
  if (signature !== snapshot.signature || (stale && servers.some((s) => s.enabled))) {
    void refreshCatalog()
  }
  const defs = [...snapshot.byFullName.values()]
  return { tools: defs.map((d) => d.instance), infos: defs.map((d) => d.info) }
}

/**
 * 设置页当前视图：**只读最近一次真实结果，绝不发起连接**。
 *
 * 为什么不顺手重连一次（2026-09-26 用户要求「加载列表的时候，不需要测试连接，不然会很卡」）：
 * 每次打开设置页（以及每次目录广播后刷新）都去起一轮子进程 / 做一遍 HTTP 握手，
 * 服务器一多就整页卡住；而这些连接一旦有变化会由保存/切换/手动重连主动刷新。
 *
 * 视图因此**从配置出发**再叠加运行期记录：配置里有、但还没连过的服务器也要出现在列表里
 * （否则冷启动后的第一次打开会是「一台服务器都没有」）。它的状态是 `unknown`（未连接），
 * 用户点「重新连接」或试连时才真正去连。
 */
export function mcpServerViews(): McpServerView[] {
  const runtimeById = new Map(snapshot.entries.map((entry) => [entry.config.id, entry]))
  return listMcpServers().map((config) => {
    const entry = runtimeById.get(config.id)
    if (entry) return toView(entry)
    return {
      config: maskServerSecrets(config),
      status: config.enabled ? ('unknown' as McpServerStatus) : ('disabled' as McpServerStatus),
      tools: [],
      hasSecrets: hasSecretsOf(config)
    }
  })
}

/**
 * 单独试连一台服务器（新增/编辑弹窗的「测试连接」用）。
 *
 * 刻意**不写 store**：测试的是表单里还没保存的这份配置；连上就报工具数，连不上报原始错误，
 * 让用户在看得到原因的情况下决定要不要保存。
 */
export async function testMcpServer(input: McpServerInput): Promise<{
  ok: boolean
  tools?: McpToolInfo[]
  error?: string
}> {
  let config: McpServerConfig
  try {
    // 编辑既有服务器时表单里是掩码串：先按磁盘上的原值还原，否则「测试连接」会拿 •••••• 去连
    const previous = input.id ? listMcpServers().find((s) => s.id === input.id) : undefined
    config = normalizeMcpServer(restoreServerSecrets(input, previous))
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  let client: McpClient | undefined
  try {
    client = await connectServer(config)
    const listed = await listServerTools(client, config)
    const namespace = mcpNamespace(config.name)
    return {
      ok: true,
      tools: listed.map((item) => ({
        name: mcpToolName(namespace, item.rawName),
        rawName: item.rawName,
        description: item.description
      }))
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    if (client) await client.close().catch(() => undefined)
  }
}

/** 直接调用一条 MCP 工具（离线回归/调试用；主链路是 LangChain 工具实例内部自调用） */
export async function callMcpTool(
  fullName: string,
  args: Record<string, unknown>,
  timeoutMs = DEFAULT_MCP_TOOL_TIMEOUT_MS
): Promise<string> {
  const parsed = parseMcpToolName(fullName)
  if (!parsed) throw new Error(`不是 MCP 工具名：${fullName}`)
  const client = snapshot.clients.get(parsed.server)
  if (!client) throw new Error(`MCP 服务器未连接：${parsed.server}`)
  const result = await withTimeout(
    client.callTool({ name: parsed.tool, arguments: args ?? {} }),
    timeoutMs,
    `工具调用超时：${parsed.tool}（${parsed.server}）`
  )
  return formatMcpToolResult(parsed.tool, parsed.server, result as McpCallToolResult)
}

/** 关闭全部连接并清空快照（插件停用 / 应用退出前调用，避免留下孤儿子进程） */
export async function closeAllMcp(): Promise<void> {
  generation += 1
  const clients = [...snapshot.clients.values()]
  snapshot = emptySnapshot()
  loggedErrors.clear()
  await Promise.all(clients.map((client) => client.close().catch(() => undefined)))
  if (clients.length > 0) logger.info(`[MCP] 已关闭 ${clients.length} 个服务器连接`)
}
