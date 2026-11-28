/**
 * MCP (Model Context Protocol) client manager — all connection logic on the harness main-process
 * side.
 *
 * Responsibilities:
 *  1. Turn server configurations in electron-store into real MCP connections (stdio child process /
 *     Streamable HTTP / SSE);
 *  2. After connecting, turn the tools exposed by the server into **AI tool instances** and merge
 *     them into the harness tool registry;
 *  3. Maintain "the state visible in the settings page": connected or not, what error, which tools
 *     this server has.
 *
 * Why build connections ourselves instead of using `MultiServerMCPClient`: that wrapper stuffs all
 * servers into one client, so when any single server fails to connect the **entire tool table** may
 * be unavailable; and when the default-managed process (stdio) fails to start, the user only sees
 * "no tools" in the settings page without the reason. Here each server connects and is accounted for
 * separately, so one broken server does not affect the rest.
 *
 * Lifecycle (who calls whom): `configureMcp()` (plugin install, only injects the store reader) →
 * `refreshCatalog()` (startup warm-up / reconnect after saving configuration) → `currentMcpTools()`
 * (takes a snapshot synchronously each round when assembling the tool set). Tool instances are **not
 * all created up front**: stdio processes can only be validated by actually starting them, so
 * `currentMcpTools()` always returns the current snapshot synchronously while slow connections run in
 * the background `refreshCatalog()`.
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import logger from 'electron-log'
import type { StructuredToolInterface } from '../../ai/tools'
import type { ToolInfo } from '../../plugins/tool-contract'
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
} from '../../../shared/harness/mcp'

/** Icon and color of the tool detail card (MCP tools all use a "plug", distinguishing them from built-in/plugin tools) */
const MCP_TOOL_ICON = 'RiPlug2Line'
const MCP_TOOL_COLOR = '#8c6b3f'

/**
 * Handshake timeout for one connection attempt (ms): a server that fails to start must be reported to
 * the settings page quickly rather than hanging. The tool call timeout lives in `mcp-tool.ts`
 * (`DEFAULT_MCP_TOOL_TIMEOUT_MS`) and can be overridden by the server configuration.
 */
const CONNECT_TIMEOUT_MS = 20_000

/** How long a snapshot is considered "fresh"; after it expires, the next tool fetch also reconnects in the background */
const SNAPSHOT_TTL_MS = 5 * 60_000

/* ── How the MCP SDK is loaded (intentional; do not change back to a static import) ─────────
 *
 * `@modelcontextprotocol/sdk` is **ESM-only** (package.json "type": "module"), while the plugin
 * main-process entry is **CJS** (build artifact `userData/plugins/<id>/main.cjs`).
 * The bundler rewrites bare modules into **synchronous** host resolution calls
 * (`globalThis.__RB_HOST_RESOLVE__(spec)`), so `require('@modelcontextprotocol/sdk/...')` throws
 * ERR_REQUIRE_ESM directly during plugin load; and a dynamic `import()` resolves the specifier under
 * the **plugin directory** — userData is not inside the app tree and has no node_modules there, so it
 * inevitably fails with ERR_MODULE_NOT_FOUND.
 *
 * Therefore: load **lazily** with `createRequire(app root)`. This both resolves the SDK (the same
 * instance as the host) and avoids loading it at module top level (no MCP code is touched when no
 * server is configured). The app root is injected by the plugin install via
 * `setMcpModuleBase(app.getAppPath())`.
 * ──────────────────────────────────────────────────────────────────────────────────────── */

/** App root (directory containing package.json): injected during plugin install */
let moduleBase: string | null = null
/** Loaded SDK types (cached in-process; failures are not cached, so a retry after the user fixes the environment can succeed) */
let sdkModule: Promise<McpSdkModule> | null = null

interface McpSdkModule {
  Client: typeof import('@modelcontextprotocol/sdk/client/index.js').Client
  StdioClientTransport: typeof import('@modelcontextprotocol/sdk/client/stdio.js').StdioClientTransport
  StreamableHTTPClientTransport: typeof import('@modelcontextprotocol/sdk/client/streamableHttp.js').StreamableHTTPClientTransport
  SSEClientTransport: typeof import('@modelcontextprotocol/sdk/client/sse.js').SSEClientTransport
}

/** Inject the host app root (called from the plugin install's reversible wiring; pass undefined to reset on disable) */
export function setMcpModuleBase(base?: string): void {
  moduleBase = base ?? null
  sdkModule = null
}

/** Type of a connected client (SDK types are used internally only; externally only structured tools are exposed) */
type McpClient = import('@modelcontextprotocol/sdk/client/index.js').Client

/**
 * Lazily load the MCP SDK.
 *
 * Relies on Node's `require(ESM)` support (enabled by default in Node 22.12+, which Electron 44
 * ships); on older Node versions this throws and the caller records it as "this server failed to
 * connect", leaving the rest of the functionality unaffected.
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

/** One ready MCP tool (both the renderer-side list and the model-side instance come from it) */
interface McpToolDef {
  /** Full name: `mcp__<server>__<tool>`, i.e. the name the model sees */
  name: string
  /** Raw tool name reported by the server */
  rawName: string
  /** Server name (the name in the configuration, used for display and reverse lookup) */
  serverName: string
  serverId: string
  description: string
  info: ToolInfo
  instance: StructuredToolInterface
}

/** Runtime record of one server */
interface McpServerEntry {
  config: McpServerConfig
  status: McpServerStatus
  error?: string
  tools: McpToolInfo[]
  /**
   * Whether the server declares the resources capability (MCP initialize's `capabilities.resources`).
   * The three resource tools are attached only to servers that declare it: calling them on a server
   * that does not only yields an empty list and wastes context.
   */
  supportsResources: boolean
}

interface McpSnapshot {
  /** Time the snapshot was taken (for freshness checks / triggering background reconnects) */
  at: number
  /** Configuration fingerprint: a configuration change invalidates it immediately, without waiting for the TTL */
  signature: string
  byFullName: Map<string, McpToolDef>
  /** Server name (sanitized namespace) → connection reverse lookup, used for tool calls */
  clients: Map<string, McpClient>
  entries: McpServerEntry[]
}

/** Store reader injected by the plugin install (the manager itself does not import electron, for offline regression) */
let readServersFromStore: () => McpServerInput[] = () => []

/** Current snapshot (read synchronously, for each round's tool assembly) */
let snapshot: McpSnapshot = emptySnapshot()
let loading: Promise<void> | null = null
/** Connection generation: incremented on configuration change/close, invalidating in-flight results of old connections */
let generation = 0
/** Servers whose error was printed last time (the same error is logged only once per refresh round) */
const loggedErrors = new Set<string>()

function emptySnapshot(): McpSnapshot {
  return { at: 0, signature: '', byFullName: new Map(), clients: new Map(), entries: [] }
}

/** Inject the "read configuration from electron-store" method during plugin install; pass undefined to reset on disable */
export function configureMcp(reader?: () => McpServerInput[]): void {
  readServersFromStore = reader ?? (() => [])
}

/** Normalized server configuration list (invalid entries are skipped and logged, so one bad configuration does not ruin the whole page) */
export function listMcpServers(): McpServerConfig[] {
  let raw: McpServerInput[]
  try {
    raw = readServersFromStore() ?? []
  } catch (err) {
    logger.warn('[MCP] Failed to read server configuration:', err)
    return []
  }
  const out: McpServerConfig[] = []
  for (const item of raw) {
    try {
      out.push(normalizeMcpServer(item))
    } catch (err) {
      logger.warn(`[MCP] Ignoring unparsable server configuration "${item?.name ?? item?.id ?? '?'}":`, err)
    }
  }
  return out
}

/** Configuration fingerprint: all connection-related fields go into the signature (changing a timeout counts as a configuration change and should reconnect) */
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

/** Sensitive values never reach the log: only key names are shown, values are always masked */
function maskMap(map?: Record<string, string>): Record<string, string> {
  if (!map) return {}
  return Object.fromEntries(Object.keys(map).map((k) => [k, '***']))
}

/** Create a connection to one server (without loading tools); returns a connected Client */
async function connectServer(config: McpServerConfig): Promise<McpClient> {
  const { Client, StdioClientTransport, StreamableHTTPClientTransport, SSEClientTransport } =
    await loadSdk()
  const client = new Client({ name: 'rytenbench-harness', version: '0.1.0' }, { capabilities: {} })
  const transport =
    config.transport === 'stdio'
      ? new StdioClientTransport({
          command: config.command as string,
          args: config.args ?? [],
          // Only override env when the user configured it explicitly: by default the host environment
          // is inherited (npx cannot start without PATH)
          ...(config.env
            ? { env: { ...process.env, ...config.env } as Record<string, string> }
            : {}),
          cwd: config.cwd,
          // stderr goes into a pipe rather than inherit: MCP servers love logging to stderr, and
          // inheriting would pollute the app log
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
    // stderr is unique to the stdio transport: server logs go into a pipe (see the spawn arguments
    // above) and are forwarded to the app log here
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
 * Whether the server declares the resources capability (`capabilities.resources` in the MCP
 * initialize result).
 *
 * This is the sole basis for "should the three resource tools be attached to this server": on a server
 * that does not declare it, `resources/list` only returns an empty list, and attaching them just
 * wastes context (changed to capability-based attachment after the user asked on 2026-11-27 what the
 * 3 resource tools are for). When capabilities cannot be read, treat it as "not supported" — never
 * attach wrongly, at most one potentially usable capability is missed.
 */
function readResourceCapability(client: McpClient): boolean {
  try {
    return Boolean(client.getServerCapabilities()?.resources)
  } catch {
    return false
  }
}

/**
 * Read the tools exposed by one server (excluding built-in limits: MCP servers also support
 * resources/prompts, but only tools are handled here).
 *
 * Done manually instead of `loadMcpTools`: naming and timeouts must be controlled **per server**, and
 * a single failure should mark only that server. tools/list supports a pagination cursor, so keep
 * paging until the end.
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

/** The return shape of `client.callTool` is described in mcp-tool.ts (`McpCallToolResult`); this file only handles connections and bookkeeping */

/**
 * Reconnect all servers and rebuild the snapshot.
 *
 * - Serially, one server at a time: spawning a dozen child processes concurrently makes it impossible
 *   to tell which one slowed down startup, and this is supposed to be a background task;
 * - A single failure is recorded on that server only (status='error' + reason); the rest stay usable;
 * - Generation guard: if the configuration changes again during the refresh (or the plugin is
 *   disabled), the old results are discarded and the connections closed on the spot.
 */
export async function refreshCatalog(): Promise<McpServerView[]> {
  // Only one refresh at a time: concurrent saves/warm-ups share the same connection pass, avoiding
  // repeated child processes
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
        entries.push({ config, status: 'disabled', tools: [], supportsResources: false })
        continue
      }
      if (config.transport === 'stdio' ? !config.command : !config.url) {
        entries.push({
          config,
          status: 'unconfigured',
          error: 'missing command/url',
          tools: [],
          supportsResources: false
        })
        continue
      }

      let client: McpClient | undefined
      try {
        client = await connectServer(config)
        const supportsResources = readResourceCapability(client)
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
            logger.warn(`[MCP] Tool name conflict: ${fullName} (duplicate name on the same server, ignoring the latter)`)
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
              // The parameter contract declared by the server must be passed down to the model:
              // without it the model only sees "a tool with no parameters", and required parameters
              // (such as PubMed's query) are called with an empty object and rejected by the server
              inputSchema: item.inputSchema,
              caller: client,
              timeoutMs: config.timeoutMs
            })
          })
          tools.push({ name: fullName, rawName: item.rawName, description: item.description })
        }
        tools.sort((a, b) => a.rawName.localeCompare(b.rawName, 'en'))
        entries.push({ config, status: 'ok', tools, supportsResources })
        loggedErrors.delete(config.id)
        logger.info(
          `[MCP] Connected ${config.name} (${config.transport}): ${tools.length} tools` +
            ` env=${JSON.stringify(maskMap(config.env))} headers=${JSON.stringify(maskMap(config.headers))}`
        )
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (client) await client.close().catch(() => undefined)
        entries.push({ config, status: 'error', error: message, tools: [], supportsResources: false })
        if (!loggedErrors.has(config.id)) {
          loggedErrors.add(config.id)
          logger.warn(`[MCP] Failed to connect to ${config.name} (${config.transport}): ${message}`)
        }
      }
    }

    if (runGeneration !== generation) return

    // Close connections that no longer appear in the new snapshot (leaving no orphan child processes
    // after a configuration is deleted/renamed/disabled)
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
    .catch((err) => logger.error('[MCP] Failed to refresh server catalog:', err))
    .finally(() => {
      loading = null
    })
  await loading
  return snapshot.entries.map(toView)
}

/**
 * Settings-page view: **credential values are masked here**.
 *
 * In the configuration sent to the renderer, the values of env/headers are always replaced with a mask
 * string (key names are kept so users can see which variables they configured); on save, mcp-store
 * restores the mask to the original values on disk. This way tokens never pass through the renderer
 * process, and the form does not corrupt stored credentials by "not echoing" them. `entry.config`
 * itself keeps the original values for connection use.
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

/** Read-only info about whether credentials are configured (the list must provide it even without a runtime record) */
function hasSecretsOf(config: McpServerConfig): McpServerView['hasSecrets'] {
  return {
    env: Object.keys(config.env ?? {}).length > 0,
    headers: Object.keys(config.headers ?? {}).length > 0
  }
}

/**
 * **Synchronous** entry point for each round's tool assembly: returns the current snapshot and, in the
 * background, does two things — reconnect if the configuration changed, or refresh once if the
 * snapshot expired. Returning synchronously keeps the tool assembly path from being held up by the
 * network.
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

/* ────────────────────────── MCP resources ────────────────────────── */

/** Names of currently connected servers (listed when a resource tool errors) */
export function connectedMcpServerNames(): string[] {
  return snapshot.entries
    .filter((entry) => entry.status === 'ok' && snapshot.clients.has(mcpNamespace(entry.config.name)))
    .map((entry) => entry.config.name)
}

/**
 * Names of connected servers that **declare the resources capability**.
 *
 * The three resource tools are attached only according to this list: when 3 servers are selected but
 * only 1 supports resources, they are attached only for that one (the tool's `server` parameter also
 * allows only that one). When there are none, they are not attached at all, saving 3 tool
 * definitions.
 */
export function resourceCapableMcpServers(): string[] {
  return snapshot.entries
    .filter(
      (entry) =>
        entry.status === 'ok' &&
        entry.supportsResources &&
        snapshot.clients.has(mcpNamespace(entry.config.name))
    )
    .map((entry) => entry.config.name)
}

/** Get a connected client by configuration name; returns null when not connected/disabled */
function connectedClient(server: string): McpClient | null {
  const entry = snapshot.entries.find(
    (item) => item.status === 'ok' && item.config.name === server
  )
  if (!entry) return null
  return snapshot.clients.get(mcpNamespace(entry.config.name)) ?? null
}

/** List the resources of one server (supports a pagination cursor) */
export async function listMcpResources(
  server: string,
  cursor?: string
): Promise<{
  resources: Array<{ uri: string; name?: string; description?: string; mimeType?: string }>
  nextCursor?: string
}> {
  const client = connectedClient(server)
  if (!client) throw new Error(`MCP server "${server}" is not connected`)
  const result = await withTimeout(
    client.listResources(cursor ? { cursor } : {}),
    CONNECT_TIMEOUT_MS,
    `读取资源清单超时（${server}）`
  )
  return {
    resources: (result.resources ?? []).map((resource) => ({
      uri: resource.uri,
      name: resource.name,
      description: resource.description,
      mimeType: resource.mimeType
    })),
    nextCursor: result.nextCursor
  }
}

/** List the resource templates of one server (parameterized URIs) */
export async function listMcpResourceTemplates(
  server: string,
  cursor?: string
): Promise<{
  templates: Array<{
    uriTemplate: string
    name?: string
    description?: string
    mimeType?: string
  }>
  nextCursor?: string
}> {
  const client = connectedClient(server)
  if (!client) throw new Error(`MCP server "${server}" is not connected`)
  const result = await withTimeout(
    client.listResourceTemplates(cursor ? { cursor } : {}),
    CONNECT_TIMEOUT_MS,
    `读取资源模板超时（${server}）`
  )
  return {
    templates: (result.resourceTemplates ?? []).map((template) => ({
      uriTemplate: template.uriTemplate,
      name: template.name,
      description: template.description,
      mimeType: template.mimeType
    })),
    nextCursor: result.nextCursor
  }
}

/** Read one resource (text / base64 blob; how to display it is decided by the tool layer) */
export async function readMcpResource(
  server: string,
  uri: string
): Promise<{
  contents: Array<{ uri?: string; mimeType?: string; text?: string; blob?: string }>
}> {
  const client = connectedClient(server)
  if (!client) throw new Error(`MCP server "${server}" is not connected`)
  const result = await withTimeout(
    client.readResource({ uri }),
    CONNECT_TIMEOUT_MS,
    `读取资源超时（${server}）`
  )
  return {
    contents: (result.contents ?? []).map((content) => ({
      uri: content.uri,
      mimeType: content.mimeType,
      text: 'text' in content ? content.text : undefined,
      blob: 'blob' in content ? content.blob : undefined
    }))
  }
}

/**
 * Current settings-page view: **read-only of the latest real result, never initiates a connection**.
 *
 * Why not reconnect on the fly (after the user asked on 2026-09-26: "when loading the list, don't test
 * connections, it gets very laggy"): opening the settings page every time (and refreshing after every
 * directory broadcast) would spawn a round of child processes / do an HTTP handshake, freezing the
 * whole page once there are several servers; and these connections are actively refreshed by save /
 * toggle / manual reconnect whenever they change.
 *
 * The view therefore starts **from the configuration** and overlays runtime records: servers that are
 * configured but never connected still appear in the list (otherwise the first open after a cold start
 * would show "no servers at all"). Their status is `unknown` (not connected), and the actual
 * connection happens when the user clicks "reconnect" or tests the connection.
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
 * Test a single server connection (used by the "test connection" action in the add/edit dialog).
 *
 * Deliberately **does not write the store**: what is tested is the unsaved configuration in the form;
 * on success it reports the tool count, on failure the raw error, so the user can decide whether to
 * save while seeing the reason.
 */
export async function testMcpServer(input: McpServerInput): Promise<{
  ok: boolean
  tools?: McpToolInfo[]
  error?: string
}> {
  let config: McpServerConfig
  try {
    // When editing an existing server the form holds the mask string: restore the real values from
    // disk first, otherwise "test connection" would connect with ••••••
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

/** Call an MCP tool directly (for offline regression/debugging; the main path is the AI tool instance self-calling) */
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

/** Close all connections and clear the snapshot (called when the plugin is disabled / before app exit, to avoid orphan child processes) */
export async function closeAllMcp(): Promise<void> {
  generation += 1
  const clients = [...snapshot.clients.values()]
  snapshot = emptySnapshot()
  loggedErrors.clear()
  await Promise.all(clients.map((client) => client.close().catch(() => undefined)))
  if (clients.length > 0) logger.info(`[MCP] Closed ${clients.length} server connections`)
}
