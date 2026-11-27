import { getMainLanguage } from './index'

/**
 * 历史会话检索工具（session_search / conversation_read）文案。
 *
 * 与其它 `tool-results-*` 模块同一约定：中文是源语言，英文树用 `typeof` 约束。
 * 搜索到的历史正文属于用户数据，不翻译；这里只负责标题、角色标签与空结果的提示语。
 */
export const zhCNSessionToolTexts = {
  sessionSearch: {
    header: '## 历史会话搜索：{{query}}（{{count}} 条命中）',
    empty: '没有找到包含「{{query}}」的历史消息。换个关键词，或先确认这条会话是否在别的会话里。',
    item: '- [话题 {{topicId}}] {{title}}（{{role}} · {{time}}）\n  {{snippet}}',
    roleUser: '用户',
    roleAssistant: '助手',
    none: '—',
    failed: '搜索历史会话失败: {{message}}'
  },
  conversationRead: {
    header: '## 话题 {{topicId}}「{{title}}」最近 {{count}} 条消息',
    empty: '该话题还没有消息。',
    message: '[{{role}}] {{text}}',
    truncated: '…（单条过长，已截断）',
    notFound: '找不到话题 {{topicId}}（或它不属于当前工作区）。',
    failed: '读取历史会话失败: {{message}}'
  },
  conversationList: {
    header: '## 最近会话（{{count}}）',
    empty: '当前工作区还没有会话记录。',
    item: '- 话题 {{topicId}}「{{title}}」（更新于 {{updated}}）{{archivedTag}}',
    archivedTag: '[已归档]',
    hint: '用 conversation_read({ topicId }) 读取某个会话的最近消息。',
    none: '—',
    failed: '读取会话列表失败: {{message}}'
  }
}

export const enUSSessionToolTexts: typeof zhCNSessionToolTexts = {
  sessionSearch: {
    header: '## Conversation history search: {{query}} ({{count}} hits)',
    empty:
      'No historical message contains "{{query}}". Try another keyword, or check whether it happened in a different conversation.',
    item: '- [topic {{topicId}}] {{title}} ({{role}} · {{time}})\n  {{snippet}}',
    roleUser: 'user',
    roleAssistant: 'assistant',
    none: '—',
    failed: 'Failed to search conversation history: {{message}}'
  },
  conversationRead: {
    header: '## Topic {{topicId}} "{{title}}": last {{count}} messages',
    empty: 'This topic has no messages yet.',
    message: '[{{role}}] {{text}}',
    truncated: '… (truncated, message too long)',
    notFound: 'Topic {{topicId}} was not found (or belongs to another workspace).',
    failed: 'Failed to read the conversation: {{message}}'
  },
  conversationList: {
    header: '## Recent conversations ({{count}})',
    empty: 'This workspace has no conversations yet.',
    item: '- topic {{topicId}} "{{title}}" (updated {{updated}}){{archivedTag}}',
    archivedTag: '[archived]',
    hint: 'Use conversation_read({ topicId }) to read the most recent messages of a conversation.',
    none: '—',
    failed: 'Failed to read the conversation list: {{message}}'
  }
}

/** 按当前界面语言取会话检索工具文案 */
export function getSessionToolTexts(): typeof zhCNSessionToolTexts {
  return getMainLanguage() === 'en-US' ? enUSSessionToolTexts : zhCNSessionToolTexts
}
