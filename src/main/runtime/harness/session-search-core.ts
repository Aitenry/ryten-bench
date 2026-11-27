/**
 * 历史会话检索的纯格式化逻辑（无 electron / DB 依赖，可离线测试）。
 *
 * 对照 DSH 的 `dsh-tool-session-query`（session_search / session_event_read 一族）：
 * 本项目先落地两个最常用的只读工具——跨话题搜索历史消息、按话题读取最近消息。
 * 数据访问由工具层（DB mapper）完成，这里只负责「结果怎么排、片段怎么截」。
 */

/** 一条搜索命中（工具层把 DB 行投影成这个形状） */
export interface SessionSearchHit {
  topicId: number
  topicTitle: string
  /** 'user' | 'assistant' | 其它（历史数据可能有别的角色） */
  role: string
  content: string
  createdAt?: string | null
}

/** 会话工具文案（由 i18n 按界面语言提供） */
export interface SessionToolTexts {
  sessionSearch: {
    header: string
    empty: string
    item: string
    roleUser: string
    roleAssistant: string
    none: string
    failed: string
  }
  conversationRead: {
    header: string
    empty: string
    message: string
    truncated: string
    notFound: string
    failed: string
  }
}

/** 一条待展示的消息（conversation_read 用） */
export interface ConversationMessage {
  role: string
  content: string
}

type Format = (template: string, values: Record<string, string | number>) => string

/** 单条消息在 conversation_read 里的展示上限（字符） */
export const MAX_MESSAGE_CHARS = 600
/** 搜索片段两侧各保留的字符数 */
export const SNIPPET_RADIUS = 90

/** 角色 → 本地化标签 */
function roleLabel(texts: SessionToolTexts, role: string): string {
  if (role === 'user') return texts.sessionSearch.roleUser
  if (role === 'assistant') return texts.sessionSearch.roleAssistant
  return role || texts.sessionSearch.none
}

/**
 * 从正文里截出包含关键词的片段（两侧各 {@link SNIPPET_RADIUS} 字符）。
 *
 * 先折叠空白（历史消息里可能有代码块/多行），再按小写匹配定位；找不到关键词时退回开头。
 */
export function buildSnippet(content: string, query: string, radius = SNIPPET_RADIUS): string {
  const collapsed = (content ?? '').replace(/\s+/g, ' ').trim()
  if (!collapsed) return ''
  const needle = query.trim().toLowerCase()
  if (!needle) return collapsed.slice(0, radius * 2)
  const at = collapsed.toLowerCase().indexOf(needle)
  if (at < 0) {
    return collapsed.length > radius * 2 ? `${collapsed.slice(0, radius * 2)}…` : collapsed
  }
  const start = Math.max(0, at - radius)
  const end = Math.min(collapsed.length, at + needle.length + radius)
  return `${start > 0 ? '…' : ''}${collapsed.slice(start, end)}${end < collapsed.length ? '…' : ''}`
}

/** 搜索结果列表 */
export function formatSessionSearch(
  format: Format,
  texts: SessionToolTexts,
  query: string,
  hits: SessionSearchHit[]
): string {
  const header = format(texts.sessionSearch.header, { query, count: String(hits.length) })
  if (hits.length === 0) {
    return `${header}\n\n${format(texts.sessionSearch.empty, { query })}`
  }
  const items = hits.map((hit) =>
    format(texts.sessionSearch.item, {
      topicId: String(hit.topicId),
      title: hit.topicTitle || texts.sessionSearch.none,
      role: roleLabel(texts, hit.role),
      time: hit.createdAt ?? texts.sessionSearch.none,
      snippet: buildSnippet(hit.content, query)
    })
  )
  return [header, ...items].join('\n')
}

/** 单个话题最近消息 */
export function formatConversation(
  format: Format,
  texts: SessionToolTexts,
  args: {
    topicId: number
    title: string
    messages: ConversationMessage[]
  }
): string {
  const header = format(texts.conversationRead.header, {
    topicId: String(args.topicId),
    title: args.title || texts.sessionSearch.none,
    count: String(args.messages.length)
  })
  if (args.messages.length === 0) {
    return `${header}\n\n${texts.conversationRead.empty}`
  }
  const lines = args.messages.map((message) => {
    const text = (message.content ?? '').trim()
    const clipped =
      text.length > MAX_MESSAGE_CHARS
        ? `${text.slice(0, MAX_MESSAGE_CHARS)}${texts.conversationRead.truncated}`
        : text
    return format(texts.conversationRead.message, {
      role: roleLabel(texts, message.role),
      text: clipped
    })
  })
  return [header, ...lines].join('\n\n')
}
