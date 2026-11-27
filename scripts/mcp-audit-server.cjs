#!/usr/bin/env node
/**
 * 0.2.6 链路审计用的最小 MCP stdio server（本地工装，不入库）。
 *
 * 只提供：
 * - 一个工具 `echo`（回显输入，验证「保存配置 → 真实连接 → 工具清单 → 会话级选择」链路）；
 * - 一个资源 `audit://note`（验证 resources 读取链路）。
 *
 * 注意：stdout 是 MCP 协议通道，任何调试输出必须走 stderr。
 */
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const { z } = require('zod')

const server = new McpServer({ name: 'audit-echo', version: '1.0.0' })

server.registerTool(
  'echo',
  {
    description: 'Echo the given text back with a prefix',
    inputSchema: { text: z.string().describe('text to echo') }
  },
  async ({ text }) => ({
    content: [{ type: 'text', text: `echo:${text}` }]
  })
)

server.registerResource(
  'audit-note',
  'audit://note',
  {
    title: 'Audit note',
    description: 'A static note resource for the 0.2.6 audit',
    mimeType: 'text/plain'
  },
  async (uri) => ({
    contents: [{ uri: uri.href, text: 'audit-resource-body-026' }]
  })
)

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  process.stderr.write('[mcp-audit-server] ready\n')
}

main().catch((err) => {
  process.stderr.write(`[mcp-audit-server] fatal: ${err?.stack || err}\n`)
  process.exit(1)
})
