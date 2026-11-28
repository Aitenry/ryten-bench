import { getMainLanguage } from './index'

/**
 * Texts for the scheduled-task (schedule_*) tools and deliveries.
 *
 * Same convention as the other `tool-results-*` modules: Chinese is the source language and the
 * English tree is checked with `typeof`.
 * Times are always shown in ISO 8601 (machine-readable and unambiguous), and rule descriptions
 * keep the data as-is.
 */
export const zhCNScheduleToolTexts = {
  notConfigured: '定时任务存储未初始化，暂时不可用。',
  notFound: '找不到定时任务 {{id}}。',
  created: '已创建定时任务 {{id}}「{{title}}」：{{when}}；下次执行 {{next}}。',
  updated: '已更新定时任务 {{id}}「{{title}}」：{{when}}；下次执行 {{next}}。',
  updatedFields: '已更新定时任务 {{id}}「{{title}}」：{{fields}}{{next}}。',
  fieldTitle: '标题',
  fieldPrompt: '提示词',
  fieldWhen: '触发规则',
  fieldTarget: '目标会话',
  fieldSelection: '运行选择',
  fieldEnabled: '启用状态',
  fieldSeparator: '、',
  nextSuffixInResult: '；下次执行 {{next}}',
  nothingChanged:
    '没有需要更新的内容：请至少给出标题、提示词、触发规则、目标会话、运行选择、启用状态中的一项。',
  noTargetResolved:
    '无法确定任务的目标会话/工作区（会话可能已被删除，或这个插件会话缺少插件标识），请先在一个具体会话里创建。',
  viewTarget: '目标: {{target}}',
  targetThis: '本会话 #{{topicId}}',
  targetNew: '每次触发新建会话（{{mode}}）',
  targetModeWork: '工作',
  viewSelection: '运行选择: 工具 {{tools}} · 技能 {{skills}} · MCP {{mcp}}',
  selectionNone: '跟随会话',
  paused: '已暂停定时任务 {{id}}「{{title}}」。',
  resumed: '已恢复定时任务 {{id}}「{{title}}」：下次执行 {{next}}。',
  deleted: '已删除定时任务 {{id}}。',
  invalidWhen: '触发规则无效（{{reason}}）。',
  tooMany: '定时任务数量已达上限（{{max}} 个），请先删除不再需要的任务。',
  noTopic: '无法确定任务归属的会话，请在某个会话里创建定时任务。',
  listEmpty: '当前没有定时任务。',
  listHeader: '定时任务（{{count}} 个）：',
  listItem: '- {{id}}「{{title}}」{{when}} · {{state}}{{next}}',
  stateEnabled: '启用中',
  statePaused: '已暂停',
  nextSuffix: ' · 下次 {{next}}',
  viewHeader: '定时任务 {{id}}「{{title}}」',
  viewWhen: '规则: {{when}}',
  viewState: '状态: {{state}}',
  viewNext: '下次执行: {{next}}',
  viewLast: '上次执行: {{last}}（{{status}}）',
  viewTopic: '会话: {{topicId}}',
  viewPrompt: '提示词:\n{{prompt}}',
  viewRecentRuns: '最近执行:',
  viewRunItem: '- {{time}} · {{status}}',
  runStatusCompleted: '成功',
  runStatusCancelled: '已取消',
  runStatusFailed: '失败',
  none: '—',
  /** Message header used when a scheduled task is delivered to the model (by the runner) */
  question:
    '[定时任务：{{title}}]\n{{prompt}}\n\n（这条消息由用户创建的定时任务自动投递。请直接开始处理，不要向用户确认。）',
  /** Reasons the trigger rule is invalid */
  reasons: {
    missing: '缺少触发规则',
    'unknown-kind': '未知类型（仅支持 once / every / daily）',
    'invalid-at': 'once.at 不是合法的 ISO 时间',
    'at-in-past': 'once.at 必须晚于当前时间（至少 30 秒后）',
    'invalid-minutes': 'every.minutes 必须是 5-10080 之间的整数',
    'invalid-time': 'daily.time 必须是 HH:MM（本地时间，24 小时制；午夜写 00:00，24:00 不合法）'
  }
}

export const enUSScheduleToolTexts: typeof zhCNScheduleToolTexts = {
  notConfigured: 'The schedule store is not initialized, so scheduling is unavailable.',
  notFound: 'Scheduled task {{id}} was not found.',
  created: 'Created scheduled task {{id}} "{{title}}": {{when}}; next run {{next}}.',
  updated: 'Updated scheduled task {{id}} "{{title}}": {{when}}; next run {{next}}.',
  updatedFields: 'Updated scheduled task {{id}} "{{title}}": {{fields}}{{next}}.',
  fieldTitle: 'title',
  fieldPrompt: 'prompt',
  fieldWhen: 'rule',
  fieldTarget: 'target conversation',
  fieldSelection: 'run selection',
  fieldEnabled: 'enabled state',
  fieldSeparator: ', ',
  nextSuffixInResult: '; next run {{next}}',
  nothingChanged:
    'Nothing to update: pass at least one of title, prompt, rule, target conversation, run selection or enabled state.',
  noTargetResolved:
    'Could not resolve a target conversation/workspace for this task (the conversation may have been deleted, or this plugin session has no plugin id). Create it from a concrete conversation first.',
  viewTarget: 'Target: {{target}}',
  targetThis: 'this conversation #{{topicId}}',
  targetNew: 'a new conversation on every run ({{mode}})',
  targetModeWork: 'work',
  viewSelection: 'Run selection: tools {{tools}} · skills {{skills}} · MCP {{mcp}}',
  selectionNone: 'follows the conversation',
  paused: 'Paused scheduled task {{id}} "{{title}}".',
  resumed: 'Resumed scheduled task {{id}} "{{title}}": next run {{next}}.',
  deleted: 'Deleted scheduled task {{id}}.',
  invalidWhen: 'Invalid schedule rule ({{reason}}).',
  tooMany: 'The schedule limit is reached ({{max}} tasks); delete unused ones first.',
  noTopic: 'Cannot tell which conversation this task belongs to; create it from inside a conversation.',
  listEmpty: 'There are no scheduled tasks.',
  listHeader: 'Scheduled tasks ({{count}}):',
  listItem: '- {{id}} "{{title}}" {{when}} · {{state}}{{next}}',
  stateEnabled: 'enabled',
  statePaused: 'paused',
  nextSuffix: ' · next {{next}}',
  viewHeader: 'Scheduled task {{id}} "{{title}}"',
  viewWhen: 'Rule: {{when}}',
  viewState: 'State: {{state}}',
  viewNext: 'Next run: {{next}}',
  viewLast: 'Last run: {{last}} ({{status}})',
  viewTopic: 'Conversation: {{topicId}}',
  viewPrompt: 'Prompt:\n{{prompt}}',
  viewRecentRuns: 'Recent runs:',
  viewRunItem: '- {{time}} · {{status}}',
  runStatusCompleted: 'succeeded',
  runStatusCancelled: 'cancelled',
  runStatusFailed: 'failed',
  none: '—',
  question:
    '[Scheduled task: {{title}}]\n{{prompt}}\n\n(This message was delivered automatically by a schedule the user created. Work on it now; do not ask the user for confirmation.)',
  reasons: {
    missing: 'the schedule rule is missing',
    'unknown-kind': 'unknown kind (only once / every / daily are supported)',
    'invalid-at': 'once.at is not a valid ISO timestamp',
    'at-in-past': 'once.at must be at least 30 seconds in the future',
    'invalid-minutes': 'every.minutes must be an integer between 5 and 10080',
    'invalid-time':
      'daily.time must be HH:MM on a 24-hour clock (midnight is 00:00; 24:00 is not valid)'
  }
}

/** Return the scheduled-task texts for the current UI language */
export function getScheduleToolTexts(): typeof zhCNScheduleToolTexts {
  return getMainLanguage() === 'en-US' ? enUSScheduleToolTexts : zhCNScheduleToolTexts
}
