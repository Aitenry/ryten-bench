import { getMainLanguage } from './index'

/**
 * Copy for the `list_capabilities` tool (tool results, not the model-facing tool description).
 *
 * The output language follows the UI language, like the other tool-result texts. Identifiers
 * (tool names, skill ids, `mcp@…` values) are never localized.
 */
export const zhCNContextToolTexts = {
  labels: {
    tools: '工具',
    skills: '技能',
    mcp: 'MCP'
  },
  titles: {
    tools: '工具（agentConfig.tools 填下面的 name）',
    skills: '技能（agentConfig.skills 填下面的 id）',
    mcp: 'MCP（agentConfig.mcpTools 填下面的值）'
  },
  none: '（暂无）',
  noDescription: '（无描述）',
  footer: 'agentConfig 省略 = 跟随本会话；null = 清空；只填要覆盖的维度。',
  notFound: '未找到 ID "{{id}}"（{{kind}}）。可用 ID：{{ids}}'
}

export const enUSContextToolTexts: typeof zhCNContextToolTexts = {
  labels: {
    tools: 'tools',
    skills: 'skills',
    mcp: 'MCP'
  },
  titles: {
    tools: 'Tools (put these names in agentConfig.tools)',
    skills: 'Skills (put these ids in agentConfig.skills)',
    mcp: 'MCP servers (put these values in agentConfig.mcpTools)'
  },
  none: '(none)',
  noDescription: '(no description)',
  footer:
    'Omit agentConfig to follow this conversation; null clears it; only pass the dimensions you override.',
  notFound: 'No capability with ID "{{id}}" ({{kind}}). Available IDs: {{ids}}'
}

/** Texts of the `list_capabilities` tool in the current UI language */
export function getContextToolTexts(): typeof zhCNContextToolTexts {
  return getMainLanguage() === 'en-US' ? enUSContextToolTexts : zhCNContextToolTexts
}
