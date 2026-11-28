/**
 * MCP resource tools: `list_mcp_resources` / `list_mcp_resource_templates` / `read_mcp_resource`.
 *
 * Besides tools, an MCP server may expose **resources** (readable documents/data) and
 * **resource templates** (parameterized URIs). The tools themselves only handle argument
 * validation, server state checks and localization; data access goes through the injected
 * {@link McpResourceOps} (supplied at runtime by mcp.ts), so offline tests can replace the data
 * source entirely.
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

/** Data-access dependencies of the resource tools (implemented at runtime by mcp.ts; tests can inject fakes) */
export interface McpResourceOps {
  /** Currently connected server names (config names) */
  servers: () => string[]
  /**
   * Names of connected servers that **declare the resources capability**.
   * Absent is treated as "all supported" (compatible with older injections/offline tests); at
   * runtime mcp.ts supplies the real list.
   */
  resourceCapableServers?: () => string[]
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
 * Build the three MCP resource tools.
 *
 * When no server is connected or the server name is wrong, an actionable hint is returned without
 * a network call; content returned by the server is projected as "text + optional images" — images
 * use the same tool image channel as read_image.
 *
 * `allowedServers` is the **set of servers enabled this turn**: the resource tools may only read
 * those (selecting A must not allow reading B). Absent means unrestricted (offline tests/legacy
 * calls); at runtime `builders.ts` passes the intersection of "selected" and "declares resources",
 * and when none remain the three tools are simply not built.
 */
export function buildMcpResourceTools(
  ops: McpResourceOps,
  texts: McpToolTexts,
  allowedServers?: string[]
): StructuredToolInterface[] {
  const allowed = allowedServers ? new Set(allowedServers) : null

  /** Server name validation: returns null when usable, otherwise a hint text shown to the model */
  const serverError = (server: string): string | null => {
    let connected: string[] = []
    try {
      connected = ops.servers()
    } catch {
      connected = []
    }
    const visible = allowed ? connected.filter((name) => allowed.has(name)) : connected
    return serverErrorMessage(texts, server, connected, allowed ? visible : undefined)
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
        server: z.string().describe('MCP server name enabled for this turn, exactly as configured'),
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
        server: z.string().describe('MCP server name enabled for this turn, exactly as configured'),
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
        server: z.string().describe('MCP server name enabled for this turn, exactly as configured'),
        uri: z.string().describe('Resource URI, as returned by list_mcp_resources')
      })
    }
  )

  return [listResources, listTemplates, readResource]
}
