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
    tools: '工具（子智能体 tools / 定时任务 agentConfig.tools 填下面的 name）',
    skills: '技能（子智能体 skills / 定时任务 agentConfig.skills 填下面的 id）',
    mcp: 'MCP（定时任务 agentConfig.mcpTools 填下面的值）'
  },
  none: '（暂无）',
  noDescription: '（无描述）',
  footer:
    '只能填上面列出的值：task、read_file、execute、ask_user_question 等内置工具由运行环境自动提供，不要填进工具/技能选择（填了会被拒绝）。定时任务的 agentConfig：省略 = 跟随本会话，null = 清空，只填要覆盖的维度。',
  notFound: '未找到 ID "{{id}}"（{{kind}}）。可用 ID：{{ids}}'
}

export const enUSContextToolTexts: typeof zhCNContextToolTexts = {
  labels: {
    tools: 'tools',
    skills: 'skills',
    mcp: 'MCP'
  },
  titles: {
    tools: 'Tools (pass these names as a subagent\'s tools / a task\'s agentConfig.tools)',
    skills: 'Skills (pass these ids as a subagent\'s skills / a task\'s agentConfig.skills)',
    mcp: 'MCP servers (pass these values as a task\'s agentConfig.mcpTools)'
  },
  none: '(none)',
  noDescription: '(no description)',
  footer:
    'Only the values listed above are accepted: built-in tools such as task, read_file, execute and ask_user_question are provided automatically by the runtime and must not be passed as tools/skills (they would be rejected). For a task\'s agentConfig: omit it to follow this conversation, null clears it, and only pass the dimensions you override.',
  notFound: 'No capability with ID "{{id}}" ({{kind}}). Available IDs: {{ids}}'
}

/** Texts of the `list_capabilities` tool in the current UI language */
export function getContextToolTexts(): typeof zhCNContextToolTexts {
  return getMainLanguage() === 'en-US' ? enUSContextToolTexts : zhCNContextToolTexts
}
