/**
 * **Pure conversion layer** from MCP tools to AI tool instances (depends only on the in-house AI
 * layer; loadable directly by node for offline regression).
 *
 * Why split out of `runtime/mcp.ts`: connection management needs electron-store and spawns child
 * processes (cannot run offline), but "how to name the tool, how to handle the parameter schema, and
 * how to turn the result into text the model can read" are pure logic and also the most error-prone
 * parts (a mistranslated schema drops parameters, binary content stuffed into the context blows up
 * the window). Keeping them here allows end-to-end assertions with real MCP servers and real tool
 * instances.
 */
import { tool as aiTool } from '../../ai/tools'
import type { StructuredToolInterface } from '../../ai/tools'

/**
 * Default timeout for a single tool call (ms). A stuck external server must not drag down the whole
 * turn; a single server can override it with `timeoutMs`.
 */
export const DEFAULT_MCP_TOOL_TIMEOUT_MS = 60_000

/** Return shape of `client.callTool` (only the fields used, to avoid depending on the SDK's type export paths) */
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

/** Tool description shown to the model: note the source server so the model picks the right tool among several servers */
export function describeMcpTool(serverName: string, rawName: string, description: string): string {
  const head = `[MCP · ${serverName}] ${rawName}`
  return description.trim() ? `${head} — ${description.trim()}` : head
}

/**
 * Tool result → text.
 *
 * - Text blocks are concatenated as-is;
 * - Image/audio/embedded-resource content is **not inlined** (it would blow up the context); only a
 *   one-line type note is kept;
 * - Tool-side errors (isError) get a prefix so the model knows this is a failure rather than an
 *   empty result;
 * - Even a fully empty result gets a placeholder — **never return undefined/an empty string**
 *   (downstream treats the result as a string).
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

/** Minimal interface for calling a tool on an MCP server (both the real Client and test doubles satisfy it) */
export interface McpToolCaller {
  callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<unknown>
}

/** Add a timeout to the call (external processes/networks must not wait forever) */
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
 * Normalize the `inputSchema` reported by the server into a JSON Schema **for the model**.
 *
 * Why it must be passed through (measured on 2026-11-24): a "loose empty object" means `properties`
 * in the tool declaration is always empty — the model only sees the tool name and description, does
 * not know there is a `query` parameter, sends `{}`, and servers with required parameters (PubMed's
 * `search_articles`, for example) reject it outright: "No search term: no `query` was given". Only
 * the server knows the parameter contract; not passing it down means the model calls blind.
 *
 * It still does **not** translate to zod and does **not** validate locally: MCP already provides JSON
 * Schema, so hand it to the provider as-is; translating again locally only risks "a bad translation
 * strips parameters" (which is exactly why the in-house AI layer's `schemaToJsonSchema` passes pure
 * JSON Schema through unchanged and `parseArgs` does no validation for non-zod schemas). Only a few
 * semantics-preserving cleanups are done here:
 *  - missing / not an object → loose empty object (any parameters allowed, consistent with the old
 *    behavior);
 *  - drop `$schema` (meaningless to the model; a few gateways return 400 on unknown fields);
 *  - add `type: 'object'` when `properties` exists but `type` is missing (a few servers omit it and
 *    some providers reject it); when a combinator such as `$ref` / `anyOf` is present, do not add it
 *    to avoid conflicts;
 *  - explicitly set `additionalProperties: true` when there are no named parameters (so a no-arg tool
 *    does not block parameters under strict-mode providers).
 */
export function normalizeMcpInputSchema(inputSchema?: unknown): Record<string, unknown> {
  if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
    return { type: 'object', additionalProperties: true }
  }
  const out = { ...(inputSchema as Record<string, unknown>) }
  delete out.$schema
  const composed = out.$ref ?? out.anyOf ?? out.oneOf ?? out.allOf
  if (!out.type && !composed) out.type = 'object'
  // No named parameters at all: explicitly allow any parameter so strict-mode providers do not block
  // the model's parameters locally
  const named =
    out.properties && typeof out.properties === 'object'
      ? Object.keys(out.properties as Record<string, unknown>).length > 0
      : false
  if (!named && !composed) out.additionalProperties ??= true
  return out
}

/**
 * Wrap an MCP tool as an AI tool instance.
 *
 * `name` uses the full name (`mcp__<server>__<tool>`), while the call passes back the **raw tool
 * name** (that is all the server recognizes). The parameter schema comes from the `inputSchema`
 * reported by the server's `tools/list` (see `normalizeMcpInputSchema`): the model learns from it
 * which parameters exist and which are required; nothing is validated or converted locally — whatever
 * the model passes is forwarded to the server as-is.
 */
export function buildMcpTool(params: {
  fullName: string
  rawName: string
  serverName: string
  description: string
  /** Parameter schema reported by the server (JSON Schema); falls back to a loose empty object when absent */
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
