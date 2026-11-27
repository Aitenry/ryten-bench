import { getMainLanguage } from './index'

/**
 * `run_code`（PTC：模型写 JS 调只读工具）结果文案。
 *
 * 中文是源语言，英文树用 `typeof` 约束键一致。代码与工具输出属于模型数据、不翻译。
 */
export const zhCNRunCodeTexts = {
  denied:
    '当前权限档位是「{{mode}}」。run_code 在进程内执行模型写的 JavaScript（node:vm 不是安全边界），因此只在「完全权限」档可用——请让用户切换档位后重试。',
  modeReadOnly: '只读',
  modeWorkspace: '工作区可写',
  modeDanger: '完全权限',
  header: '## run_code 结果',
  headerWithDescription: '## run_code 结果：{{description}}',
  empty: '代码为空。',
  tooLong: '代码过长（上限 {{max}} 字符）。',
  logs: '日志：\n{{logs}}',
  result: '返回值：\n{{result}}',
  emptyResult: '（没有返回值）',
  error: '执行失败：{{message}}',
  timedOut: '执行超时：已停止等待（代码可能仍在后台继续，注意副作用）。',
  truncated: '（返回值已截断到 {{max}} 字符）',
  toolCalls: '工具调用 {{count}} 次 · 耗时 {{ms}}ms',
  noTools: '（当前会话没有可桥接的只读工具）',
  toolList: '可用工具：{{tools}}'
}

export const enUSRunCodeTexts: typeof zhCNRunCodeTexts = {
  denied:
    'The current permission mode is "{{mode}}". run_code executes model-written JavaScript inside the app process (node:vm is not a security boundary), so it is only available in "danger-full-access" — ask the user to switch modes and retry.',
  modeReadOnly: 'read-only',
  modeWorkspace: 'workspace-write',
  modeDanger: 'danger-full-access',
  header: '## run_code result',
  headerWithDescription: '## run_code result: {{description}}',
  empty: 'The code is empty.',
  tooLong: 'The code is too long (limit {{max}} characters).',
  logs: 'Logs:\n{{logs}}',
  result: 'Return value:\n{{result}}',
  emptyResult: '(no return value)',
  error: 'The code failed: {{message}}',
  timedOut: 'Execution timed out: stopped waiting (the code may still run in the background — beware of side effects).',
  truncated: '(return value truncated to {{max}} characters)',
  toolCalls: '{{count}} tool calls · {{ms}}ms',
  noTools: '(no read-only tools available to bridge)',
  toolList: 'Available tools: {{tools}}'
}

/** 按当前界面语言取 run_code 文案 */
export function getRunCodeTexts(): typeof zhCNRunCodeTexts {
  return getMainLanguage() === 'en-US' ? enUSRunCodeTexts : zhCNRunCodeTexts
}

export type RunCodeTexts = typeof zhCNRunCodeTexts
