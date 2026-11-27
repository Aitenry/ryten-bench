/**
 * 历史会话检索的纯逻辑回归（`runtime/harness/session-search-core.ts`）。
 *
 * 跑法：`node --no-warnings tests/session-search.test.mts`
 *
 * 覆盖：
 * - 命中片段的截取（中间命中带省略号、未命中退回开头、空白折叠、空正文）；
 * - 搜索结果排版（计数/话题/角色/时间/片段，空结果的提示）；
 * - 会话读取排版（角色标签、单条截断、空话题）。
 */
import assert from 'node:assert/strict'
import {
  MAX_MESSAGE_CHARS,
  SNIPPET_RADIUS,
  buildSnippet,
  formatConversation,
  formatConversationList,
  formatSessionSearch,
  type SessionSearchHit,
  type SessionToolTexts
} from '../src/main/runtime/harness/session-search-core.ts'

const TEXTS: SessionToolTexts = {
  sessionSearch: {
    header: '## search {{query}} ({{count}})',
    empty: 'nothing for {{query}}',
    item: '- [topic {{topicId}}] {{title}} ({{role}} · {{time}})\n  {{snippet}}',
    roleUser: 'USER',
    roleAssistant: 'ASSISTANT',
    none: '—',
    failed: 'failed {{message}}'
  },
  conversationRead: {
    header: '## topic {{topicId}} "{{title}}" ({{count}})',
    empty: 'no messages',
    message: '[{{role}}] {{text}}',
    truncated: '…TRUNC',
    notFound: 'missing {{topicId}}',
    failed: 'failed {{message}}'
  },
  conversationList: {
    header: '## conversations {{count}}',
    empty: 'no conversations',
    item: '- topic {{topicId}} "{{title}}" ({{updated}}){{archivedTag}}',
    archivedTag: '[ARCH]',
    hint: 'use conversation_read with topicId',
    none: '—',
    failed: 'failed {{message}}'
  }
}

/** 与主进程 i18n 同义的极简插值 */
const fill = (template: string, values: Record<string, string | number>): string =>
  template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    values[key] === undefined ? match : String(values[key])
  )

// ── 1. buildSnippet ──────────────────────────────────────────────────
const long = `${'a'.repeat(SNIPPET_RADIUS * 2)} NEEDLE ${'b'.repeat(SNIPPET_RADIUS * 2)}`
const snippet = buildSnippet(long, 'needle')
assert.ok(snippet.startsWith('…'))
assert.ok(snippet.endsWith('…'))
assert.ok(snippet.includes('NEEDLE'))

// 未命中：退回开头（并截断）
const miss = buildSnippet('x'.repeat(SNIPPET_RADIUS * 3), 'zzz')
assert.ok(miss.endsWith('…'))
assert.ok(miss.length <= SNIPPET_RADIUS * 2 + 1)

// 空白折叠
assert.equal(buildSnippet('a\n\n  b   c', 'b'), 'a b c')
// 空正文 / 空关键词
assert.equal(buildSnippet('   ', 'x'), '')
assert.equal(buildSnippet('short text', '   '), 'short text')

// ── 2. formatSessionSearch ───────────────────────────────────────────
const hits: SessionSearchHit[] = [
  {
    topicId: 7,
    topicTitle: 'Deploy notes',
    role: 'user',
    content: 'we discussed the deploy pipeline yesterday',
    createdAt: '2026-11-27T02:00:00.000Z'
  },
  {
    topicId: 9,
    topicTitle: '',
    role: 'assistant',
    content: 'the pipeline runs on push',
    createdAt: null
  }
]
const rendered = formatSessionSearch(fill, TEXTS, 'pipeline', hits)
assert.ok(rendered.startsWith('## search pipeline (2)'))
assert.ok(rendered.includes('[topic 7] Deploy notes (USER · 2026-11-27T02:00:00.000Z)'))
assert.ok(rendered.includes('[topic 9] — (ASSISTANT · —)'))
assert.ok(rendered.includes('pipeline'))

const emptyRender = formatSessionSearch(fill, TEXTS, 'nope', [])
assert.ok(emptyRender.includes('nothing for nope'))

// ── 3. formatConversation ────────────────────────────────────────────
const conversation = formatConversation(fill, TEXTS, {
  topicId: 3,
  title: 'Planning',
  messages: [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'x'.repeat(MAX_MESSAGE_CHARS + 10) }
  ]
})
assert.ok(conversation.startsWith('## topic 3 "Planning" (2)'))
assert.ok(conversation.includes('[USER] hello'))
assert.ok(conversation.includes('[ASSISTANT] ' + 'x'.repeat(MAX_MESSAGE_CHARS) + '…TRUNC'))

const emptyConversation = formatConversation(fill, TEXTS, { topicId: 4, title: 'Empty', messages: [] })
assert.ok(emptyConversation.includes('(0)'))
assert.ok(emptyConversation.includes('no messages'))

// ── 4. formatConversationList ────────────────────────────────────────
const conversations = formatConversationList(fill, TEXTS, [
  { topicId: 11, title: 'Deploy notes', updatedAt: '2026-11-27T02:30:00.000Z', archived: false },
  { topicId: 12, title: '', updatedAt: null, archived: true },
  { topicId: 13, title: 'Old chat', updatedAt: '2026-10-01T08:05:00.000Z', archived: true }
])
assert.ok(conversations.startsWith('## conversations 3'))
assert.ok(conversations.includes('- topic 11 "Deploy notes" (2026-11-27 02:30)'))
// 空标题/无更新时间/归档标记都要正确渲染
assert.ok(conversations.includes('- topic 12 "—" (—) [ARCH]'))
assert.ok(conversations.includes('- topic 13 "Old chat" (2026-10-01 08:05) [ARCH]'))
assert.ok(conversations.includes('use conversation_read with topicId'))
assert.equal(conversations.split('[ARCH]').length, 3)

const emptyConversations = formatConversationList(fill, TEXTS, [])
assert.ok(emptyConversations.startsWith('## conversations 0'))
assert.ok(emptyConversations.includes('no conversations'))

console.log('session-search: all assertions passed')
