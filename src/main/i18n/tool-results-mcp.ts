import { getMainLanguage } from './index'

/**
 * MCP 资源工具（list_mcp_resources / list_mcp_resource_templates / read_mcp_resource）文案。
 *
 * 与其它 `tool-results-*` 模块同一约定：中文是源语言，英文树用 `typeof` 约束。
 * 服务器返回的资源内容属于外部数据，不翻译、原样返回。
 */
export const zhCNMcpToolTexts = {
  common: {
    /** 没有连接任何服务器时给出的提示（列出可用的服务器名） */
    unknownServer: '没有已连接的 MCP 服务器名为 "{{server}}"。当前已连接：{{servers}}',
    noServers: '当前没有已连接的 MCP 服务器。请先在「设置 → MCP」里添加并连接一台服务器。',
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

/** 按当前界面语言取 MCP 资源工具文案 */
export function getMcpToolTexts(): typeof zhCNMcpToolTexts {
  return getMainLanguage() === 'en-US' ? enUSMcpToolTexts : zhCNMcpToolTexts
}
