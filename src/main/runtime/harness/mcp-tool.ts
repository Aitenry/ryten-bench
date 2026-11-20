/**
 * MCP 工具 → LangChain 工具的**纯转换层**（零相对 import，可被 node 直接加载做离线回归）。
 *
 * 为什么从 `runtime/mcp.ts` 拆出来：连接管理要读 electron-store、要起子进程（无法离线跑），
 * 但「工具名怎么起、参数 schema 怎么处理、结果怎么变成模型能读的文本」这三件事是纯逻辑，
 * 也正是最容易出问题的地方（schema 翻错会丢参数、二进制内容塞进上下文会撑爆窗口）。
 * 放在这里就能用真实 MCP 服务器 + 真实 langchain 工具做端到端断言。
 */
import { tool as langchainTool } from '@langchain/core/tools'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { z } from 'zod/v4'

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
 * 把一条 MCP 工具包成 LangChain 工具。
 *
 * 参数 schema 用 `z.looseObject({})`（**宽松空对象**）而不是把服务器给的 JSON Schema 翻成 zod：
 * 参数最终由**服务器**校验，本地再翻一遍只会引入「翻错导致参数被剥掉」的风险；描述里已经写清
 * 工具名与来源，模型据此选工具、按服务器的 schema 传参，原样透传即可。
 * `name` 用全名（`mcp__<服务器>__<工具>`），调用时回传的是**原始工具名**（服务器只认它）。
 */
export function buildMcpTool(params: {
  fullName: string
  rawName: string
  serverName: string
  description: string
  caller: McpToolCaller
  timeoutMs?: number
}): StructuredToolInterface {
  const { fullName, rawName, serverName, description, caller, timeoutMs } = params
  return langchainTool(
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
      schema: z.looseObject({})
    }
  ) as unknown as StructuredToolInterface
}
