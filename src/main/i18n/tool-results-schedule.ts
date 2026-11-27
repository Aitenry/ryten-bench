import { getMainLanguage } from './index'

/**
 * 定时任务（schedule_*）工具与投递文案。
 *
 * 与其它 `tool-results-*` 模块同一约定：中文是源语言，英文树用 `typeof` 约束。
 * 时间统一以 ISO 8601 展示（机器可读、无歧义），规则描述保持数据原样。
 */
export const zhCNScheduleToolTexts = {
  notConfigured: '定时任务存储未初始化，暂时不可用。',
  notFound: '找不到定时任务 {{id}}。',
  created: '已创建定时任务 {{id}}「{{title}}」：{{when}}；下次执行 {{next}}。',
  updated: '已更新定时任务 {{id}}「{{title}}」：{{when}}；下次执行 {{next}}。',
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
  none: '—',
  /** 定时任务投递给模型的消息抬头（runner 使用） */
  question:
    '[定时任务：{{title}}]\n{{prompt}}\n\n（这条消息由用户创建的定时任务自动投递。请直接开始处理，不要向用户确认。）',
  /** 触发规则无效的原因 */
  reasons: {
    missing: '缺少触发规则',
    'unknown-kind': '未知类型（仅支持 once / every / daily）',
    'invalid-at': 'once.at 不是合法的 ISO 时间',
    'at-in-past': 'once.at 必须晚于当前时间（至少 30 秒后）',
    'invalid-minutes': 'every.minutes 必须是 5-10080 之间的整数',
    'invalid-time': 'daily.time 必须是 HH:MM（本地时间）'
  }
}

export const enUSScheduleToolTexts: typeof zhCNScheduleToolTexts = {
  notConfigured: 'The schedule store is not initialized, so scheduling is unavailable.',
  notFound: 'Scheduled task {{id}} was not found.',
  created: 'Created scheduled task {{id}} "{{title}}": {{when}}; next run {{next}}.',
  updated: 'Updated scheduled task {{id}} "{{title}}": {{when}}; next run {{next}}.',
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
  none: '—',
  question:
    '[Scheduled task: {{title}}]\n{{prompt}}\n\n(This message was delivered automatically by a schedule the user created. Work on it now; do not ask the user for confirmation.)',
  reasons: {
    missing: 'the schedule rule is missing',
    'unknown-kind': 'unknown kind (only once / every / daily are supported)',
    'invalid-at': 'once.at is not a valid ISO timestamp',
    'at-in-past': 'once.at must be at least 30 seconds in the future',
    'invalid-minutes': 'every.minutes must be an integer between 5 and 10080',
    'invalid-time': 'daily.time must be HH:MM (local time)'
  }
}

/** 按当前界面语言取定时任务文案 */
export function getScheduleToolTexts(): typeof zhCNScheduleToolTexts {
  return getMainLanguage() === 'en-US' ? enUSScheduleToolTexts : zhCNScheduleToolTexts
}
