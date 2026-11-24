/**
 * MCP 工具 → AI 工具实例的**纯转换层**（只依赖自研 AI 层，可被 node 直接加载做离线回归）。
 *
 * 为什么从 `runtime/mcp.ts` 拆出来：连接管理要读 electron-store、要起子进程（无法离线跑），
 * 但「工具名怎么起、参数 schema 怎么处理、结果怎么变成模型能读的文本」这三件事是纯逻辑，
 * 也正是最容易出问题的地方（schema 翻错会丢参数、二进制内容塞进上下文会撑爆窗口）。
 * 放在这里就能用真实 MCP 服务器 + 真实工具实例做端到端断言。
 */
import { tool as aiTool } from '../../ai/tools'
import type { StructuredToolInterface } from '../../ai/tools'

/**
 * 单次工具调用默认超时（毫秒）。外部服务器卡住时不能把整个回合拖死；
 * 一台服务器可用 `timeoutMs` 单独覆盖。
 */
export const DEFAULT_MCP_TOOL_TIMEOUT_MS = 60_000

/** `client.callTool` 的返回形状（只取用到的字段，避免依赖 SDK 的类型导出路径） */
export interface McpCallToolResult {
  content?: {
    type?: string
    text?: string
    mimeType?: string
    resource?: { uri?: string }
    [key: string]: unknown
  }[]
  isError?: boolean
}

/** 传给模型看的工具说明：注明来源服务器，便于模型在多台服务器之间选对工具 */
export function describeMcpTool(serverName: string, rawName: string, description: string): string {
  const head = `[MCP · ${serverName}] ${rawName}`
  return description.trim() ? `${head} — ${description.trim()}` : head
}

/**
 * 工具结果 → 文本。
 *
 * - 文本块原样拼接；
 * - 图片/音频/嵌入资源这类内容**不内联**（会撑爆上下文），只留一行类型说明；
 * - 工具侧报错（isError）加前缀，让模型知道这是失败而不是空结果；
 * - 全空也返回一句占位，**永远不返回 undefined/空串**（下游按字符串处理结果）。
 */
export function formatMcpToolResult(
  rawName: string,
  serverName: string,
  result: McpCallToolResult
): string {
  const parts: string[] = []
  for (const block of result.content ?? []) {
    if (block?.type === 'text') {
      if (block.text) parts.push(block.text)
    } else if (block?.type === 'resource') {
      parts.push(`[resource] ${block.resource?.uri ?? 'embedded resource'}`)
    } else if (block?.type) {
      parts.push(`[${block.type}${block.mimeType ? ` ${block.mimeType}` : ''} 内容未内联]`)
    }
  }
  const text = parts.join('\n').trim()
  const body = text || `（${rawName} 未返回内容）`
  return result.isError ? `[MCP 工具报错 · ${serverName}/${rawName}]\n${body}` : body
}

/** 调用 MCP 服务器上一个工具的最小接口（真实 Client 与测试替身都满足） */
export interface McpToolCaller {
  callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<unknown>
}

/** 给调用加超时（外部进程/网络都不能无限等） */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

/**
 * 把服务器上报的 `inputSchema` 规整成**给模型看的** JSON Schema。
 *
 * 为什么必须带上它（2026-11-24 实测）：「宽松空对象」意味着工具声明里
 * `properties` 永远是空的 —— 模型只看得到工具名和描述，不知道有 `query` 这类参数，
 * 于是发一个 `{}` 过来，参数是必填的服务器（PubMed 的 `search_articles` 就是）
 * 直接拒掉：「No search term: no `query` was given」。参数契约只有服务器自己知道，
 * 不传下去等于让模型闭着眼调用。
 *
 * 仍然**不翻成 zod、不在本地校验**：MCP 给的本来就是 JSON Schema，原样交给供应商即可；
 * 本地再翻一遍只会引入「翻错导致参数被剥掉」的风险（这正是自研 AI 层 `schemaToJsonSchema`
 * 对纯 JSON Schema 走原样透传、`parseArgs` 对非 zod schema 不做校验的原因）。
 * 这里只做几处不改变语义的清理：
 *  - 缺省 / 不是对象 → 宽松空对象（允许任意参数，与旧行为一致）；
 *  - 去掉 `$schema`（对模型无意义，个别网关因未知字段 400）；
 *  - 有 `properties` 却缺 `type` 时补 `type: 'object'`（少数服务器省略，部分供应商会拒收）；
 *    有 `$ref` / `anyOf` 这类组合器时不补，避免与之冲突；
 *  - 没有具名参数时显式 `additionalProperties: true`（无参工具在严格模式下也不挡住参数）。
 */
export function normalizeMcpInputSchema(inputSchema?: unknown): Record<string, unknown> {
  if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
    return { type: 'object', additionalProperties: true }
  }
  const out = { ...(inputSchema as Record<string, unknown>) }
  delete out.$schema
  const composed = out.$ref ?? out.anyOf ?? out.oneOf ?? out.allOf
  if (!out.type && !composed) out.type = 'object'
  // 没有任何具名参数：显式放行任意参数，别让严格模式的供应商把模型的参数挡在本地
  const named =
    out.properties && typeof out.properties === 'object'
      ? Object.keys(out.properties as Record<string, unknown>).length > 0
      : false
  if (!named && !composed) out.additionalProperties ??= true
  return out
}

/**
 * 把一条 MCP 工具包成 AI 工具实例。
 *
 * `name` 用全名（`mcp__<服务器>__<工具>`），调用时回传的是**原始工具名**（服务器只认它）。
 * 参数 schema 用服务器 `tools/list` 上报的 `inputSchema`（见 `normalizeMcpInputSchema`）：
 * 模型据此知道有哪些参数、哪些必填；本地不校验、不转换，模型传什么就原样转给服务器。
 */
export function buildMcpTool(params: {
  fullName: string
  rawName: string
  serverName: string
  description: string
  /** 服务器上报的参数 schema（JSON Schema）；缺省时退化为宽松空对象 */
  inputSchema?: unknown
  caller: McpToolCaller
  timeoutMs?: number
}): StructuredToolInterface {
  const { fullName, rawName, serverName, description, inputSchema, caller, timeoutMs } = params
  return aiTool(
    async (args: Record<string, unknown>) => {
      const result = await withTimeout(
        caller.callTool({ name: rawName, arguments: args ?? {} }),
        timeoutMs ?? DEFAULT_MCP_TOOL_TIMEOUT_MS,
        `工具调用超时：${rawName}（${serverName}）`
      )
      return formatMcpToolResult(rawName, serverName, result as McpCallToolResult)
    },
    {
      name: fullName,
      description: describeMcpTool(serverName, rawName, description),
      schema: normalizeMcpInputSchema(inputSchema)
    }
  ) as unknown as StructuredToolInterface
}
