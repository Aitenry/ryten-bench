import { getMainLanguage } from './index'

/**
 * Texts for the MCP resource tools (list_mcp_resources / list_mcp_resource_templates /
 * read_mcp_resource).
 *
 * Same convention as the other `tool-results-*` modules: Chinese is the source language and the
 * English tree is checked with `typeof`.
 * Resource content returned by the server is external data; it is returned verbatim, untranslated.
 */
export const zhCNMcpToolTexts = {
  common: {
    /** Hint shown when no server is connected (lists the available server names) */
    unknownServer: '没有已连接的 MCP 服务器名为 "{{server}}"。当前已连接：{{servers}}',
    noServers: '当前没有已连接的 MCP 服务器。请先在「设置 → MCP」里添加并连接一台服务器。',
    /** The server is connected but not selected for this turn (resource tools may only read servers enabled this turn) */
    notSelected: '服务器 "{{server}}" 不在本轮启用的 MCP 服务器里。本轮启用：{{servers}}',
    failed: '读取 MCP 服务器 "{{server}}" 失败: {{message}}'
  },
  listResources: {
    header: '## MCP 资源（{{server}}）',
    empty: '服务器 "{{server}}" 没有暴露任何资源。',
    item: '- {{uri}}{{name}}{{mime}}',
    nextCursor: '\n（还有更多：用 cursor="{{cursor}}" 继续）'
  },
  listTemplates: {
    header: '## MCP 资源模板（{{server}}）',
    empty: '服务器 "{{server}}" 没有暴露任何资源模板。',
    item: '- {{uriTemplate}}{{name}}{{mime}}',
    nextCursor: '\n（还有更多：用 cursor="{{cursor}}" 继续）'
  },
  read: {
    header: '## 资源内容：{{uri}}',
    textPart: '{{text}}',
    binaryPart: '[二进制内容：{{mimeType}}，{{bytes}} 字节 base64；该工具只返回文本，无法直接查看]',
    empty: '资源 "{{uri}}" 返回了空内容。',
    imageNote: '资源中的图片：{{uri}}'
  }
}

export const enUSMcpToolTexts: typeof zhCNMcpToolTexts = {
  common: {
    unknownServer:
      'No connected MCP server named "{{server}}". Currently connected: {{servers}}',
    noServers:
      'No MCP server is connected. Add and connect one under Settings → MCP first.',
    notSelected:
      'Server "{{server}}" is not one of the MCP servers enabled for this turn. Enabled: {{servers}}',
    failed: 'Failed to read MCP server "{{server}}": {{message}}'
  },
  listResources: {
    header: '## MCP resources ({{server}})',
    empty: 'Server "{{server}}" exposes no resources.',
    item: '- {{uri}}{{name}}{{mime}}',
    nextCursor: '\n(more available: continue with cursor="{{cursor}}")'
  },
  listTemplates: {
    header: '## MCP resource templates ({{server}})',
    empty: 'Server "{{server}}" exposes no resource templates.',
    item: '- {{uriTemplate}}{{name}}{{mime}}',
    nextCursor: '\n(more available: continue with cursor="{{cursor}}")'
  },
  read: {
    header: '## Resource content: {{uri}}',
    textPart: '{{text}}',
    binaryPart: '[binary content: {{mimeType}}, {{bytes}} base64 bytes; this tool returns text only]',
    empty: 'Resource "{{uri}}" returned no content.',
    imageNote: 'Image from resource: {{uri}}'
  }
}

/** Return the MCP resource tool texts for the current UI language */
export function getMcpToolTexts(): typeof zhCNMcpToolTexts {
  return getMainLanguage() === 'en-US' ? enUSMcpToolTexts : zhCNMcpToolTexts
}
