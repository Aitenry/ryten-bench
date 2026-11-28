import { getMainLanguage } from './index'

/**
 * Texts for the `present` (deliverable files) tool.
 *
 * Same convention as the other `tool-results-*` modules: Chinese is the source language and the
 * English tree is checked with `typeof`.
 * List items and errors follow the UI language; paths themselves are data and are not translated.
 */
export const zhCNPresentToolTexts = {
  empty: '文件路径不能为空。',
  tooMany: '一次最多声明 {{max}} 个交付文件（收到 {{count}} 个）。',
  noWorkspace: '当前会话没有工作区，present 只能声明工作区内的文件。',
  escape: '路径必须位于工作区内: {{path}}',
  missing: '文件不存在: {{path}}',
  notFile: '路径不是文件: {{path}}',
  /** Declaration succeeded: {{list}} is a one-line summary per file */
  presented: '已声明 {{count}} 个交付文件（回合结束后用户会看到它们）：\n{{list}}',
  item: '- {{path}}{{description}}',
  /** Note shown when the path needs fixing (virtual paths start with /) */
  hint: '请使用工作区内的虚拟路径（如 /docs/report.pdf）。'
}

export const enUSPresentToolTexts: typeof zhCNPresentToolTexts = {
  empty: 'The file path must not be empty.',
  tooMany: 'At most {{max}} deliverables can be declared at once (got {{count}}).',
  noWorkspace: 'This session has no workspace, so present can only declare files inside one.',
  escape: 'The path must stay inside the workspace: {{path}}',
  missing: 'The file does not exist: {{path}}',
  notFile: 'The path is not a file: {{path}}',
  presented:
    'Declared {{count}} deliverable file(s); the user sees them after the turn ends:\n{{list}}',
  item: '- {{path}}{{description}}',
  hint: 'Use a workspace virtual path such as /docs/report.pdf.'
}

/** Return the present tool texts for the current UI language */
export function getPresentToolTexts(): typeof zhCNPresentToolTexts {
  return getMainLanguage() === 'en-US' ? enUSPresentToolTexts : zhCNPresentToolTexts
}
