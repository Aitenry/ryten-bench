/**
 * MCP 资源工具：`list_mcp_resources` / `list_mcp_resource_templates` / `read_mcp_resource`。
 *
 * 对照 DSH 的 `@deepseek-ai/dsh-mcp-resources`：MCP 服务器除了工具，还可能暴露 **resources**
 * （可读取的文档/数据）与 **resource templates**（参数化 URI）。工具本身只做参数校验、
 * 服务器状态检查与本地化，数据访问通过注入的 {@link McpResourceOps}（运行期由 mcp.ts 提供），
 * 因此离线测试可以完全替换数据源。
 */
import { z } from 'zod'
import { tool, type StructuredToolInterface } from '../../ai/tools'
import { toolMedia, type ToolImage } from '../../runtime/harness/image-tool'
import {
  fill,
  formatReadResult,
  formatResourceList,
  formatTemplateList,
  serverErrorMessage,
  type McpResourceContent,
  type McpResourceRecord,
  type McpResourceTemplateRecord,
  type McpToolTexts
} from './mcp-resources-core'

/** 资源工具的数据访问依赖（运行期由 mcp.ts 实现；测试可注入假实现） */
export interface McpResourceOps {
  /** 当前已连接的服务器名（配置名） */
  servers: () => string[]
  listResources: (
    server: string,
    cursor?: string
  ) => Promise<{ resources: McpResourceRecord[]; nextCursor?: string }>
  listTemplates: (
    server: string,
    cursor?: string
  ) => Promise<{ templates: McpResourceTemplateRecord[]; nextCursor?: string }>
  read: (server: string, uri: string) => Promise<{ contents: McpResourceContent[] }>
}

/**
 * 构造三个 MCP 资源工具。
 *
 * 未连接任何服务器 / 服务器名写错时直接返回可操作提示，不进入网络调用；服务器返回的
 * 内容按「文本 + 可选图片」投影——图片走与 read_image 相同的工具图像通道。
 */
export function buildMcpResourceTools(
  ops: McpResourceOps,
  texts: McpToolTexts
): StructuredToolInterface[] {

  /** 服务器名校验：返回 null 表示可用，否则是给模型看的提示文案 */
  const serverError = (server: string): string | null => {
    let servers: string[] = []
    try {
      servers = ops.servers()
    } catch {
      servers = []
    }
    return serverErrorMessage(texts, server, servers)
  }

  const failureText = (server: string, err: unknown): string =>
    fill(texts.common.failed, {
      server,
      message: err instanceof Error ? err.message : String(err)
    })

  const listResources = tool(
    async ({ server, cursor }) => {
      const invalid = serverError(server)
      if (invalid) return invalid
      try {
        const result = await ops.listResources(server, cursor)
        return formatResourceList(fill, texts, server, result.resources, result.nextCursor)
      } catch (err) {
        return failureText(server, err)
      }
    },
    {
      name: 'list_mcp_resources',
      isConcurrencySafe: () => true,
      timeoutMs: 60_000,
      description:
        'List the resources an MCP server exposes (URIs that can be read as documents, data or images). Use the optional cursor from a previous result to continue when the server paginates.',
      schema: z.object({
        server: z.string().describe('Connected MCP server name, exactly as configured'),
        cursor: z.string().optional().describe('Pagination cursor returned by a previous call')
      })
    }
  )

  const listTemplates = tool(
    async ({ server, cursor }) => {
      const invalid = serverError(server)
      if (invalid) return invalid
      try {
        const result = await ops.listTemplates(server, cursor)
        return formatTemplateList(fill, texts, server, result.templates, result.nextCursor)
      } catch (err) {
        return failureText(server, err)
      }
    },
    {
      name: 'list_mcp_resource_templates',
      isConcurrencySafe: () => true,
      timeoutMs: 60_000,
      description:
        'List the parameterized resource URI templates an MCP server exposes, then expand a template and read the concrete URI with read_mcp_resource.',
      schema: z.object({
        server: z.string().describe('Connected MCP server name, exactly as configured'),
        cursor: z.string().optional().describe('Pagination cursor returned by a previous call')
      })
    }
  )

  const readResource = tool(
    async ({ server, uri }) => {
      const invalid = serverError(server)
      if (invalid) return invalid
      try {
        const result = await ops.read(server, uri)
        const formatted = formatReadResult(fill, texts, uri, result.contents)
        if (formatted.images.length === 0) return formatted.text
        const images: ToolImage[] = formatted.images.map((image) => ({
          dataUrl: image.dataUrl,
          path: image.uri,
          mimeType: image.mimeType as ToolImage['mimeType']
        }))
        return toolMedia(formatted.text, images)
      } catch (err) {
        return failureText(server, err)
      }
    },
    {
      name: 'read_mcp_resource',
      isConcurrencySafe: () => true,
      timeoutMs: 60_000,
      description:
        'Read one MCP resource by URI (taken from list_mcp_resources or from an expanded template). Text content is returned inline; images become viewable attachments; other binary content is reported by type and size.',
      schema: z.object({
        server: z.string().describe('Connected MCP server name, exactly as configured'),
        uri: z.string().describe('Resource URI, as returned by list_mcp_resources')
      })
    }
  )

  return [listResources, listTemplates, readResource]
}
