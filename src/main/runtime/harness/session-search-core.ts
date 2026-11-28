/**
 * Pure formatting logic for session-history search (no electron / DB dependency,
 * offline-testable).
 *
 * This lands the two most useful read-only tools first — searching past messages across topics and
 * reading recent messages of one topic. Data access is done by the tool layer (DB mapper); this
 * module only decides how results are ordered and how snippets are clipped.
 */

/** One search hit (the tool layer projects a DB row into this shape) */
export interface SessionSearchHit {
  topicId: number
  topicTitle: string
  /** 'user' | 'assistant' | others (historical data may contain other roles) */
  role: string
  content: string
  createdAt?: string | null
}

/** Session tool texts (provided by i18n per UI language) */
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
  conversationList: {
    header: string
    empty: string
    item: string
    archivedTag: string
    hint: string
    none: string
    failed: string
  }
}

/** One conversation list item (the tool layer projects it from a topic row) */
export interface ConversationListEntry {
  topicId: number
  title: string
  /** Update time (ISO; shows none when missing) */
  updatedAt: string | null
  archived: boolean
}

/** One message to display (used by conversation_read) */
export interface ConversationMessage {
  role: string
  content: string
}

type Format = (template: string, values: Record<string, string | number>) => string

/** Display cap per message in conversation_read (characters) */
export const MAX_MESSAGE_CHARS = 600
/** Characters kept on each side of a search snippet */
export const SNIPPET_RADIUS = 90

/** Role -> localized label */
function roleLabel(texts: SessionToolTexts, role: string): string {
  if (role === 'user') return texts.sessionSearch.roleUser
  if (role === 'assistant') return texts.sessionSearch.roleAssistant
  return role || texts.sessionSearch.none
}

/**
 * Clip a snippet containing the keyword out of the body ({@link SNIPPET_RADIUS} characters on each
 * side).
 *
 * Whitespace is collapsed first (historical messages may contain code blocks / multiple lines),
 * then the match is located case-insensitively; when the keyword is absent it falls back to the
 * start.
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

/** Search result list */
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

/** Recent messages of one topic */
export function formatConversation(  format: Format,
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

/**
 * Conversation list (`conversation_list`): shows recent topics in reverse update order.
 *
 * Complements search: browse first, then read by id; archived topics are kept but tagged (they can
 * still be read by conversation_read).
 */
export function formatConversationList(
  format: Format,
  texts: SessionToolTexts,
  entries: ConversationListEntry[]
): string {
  const header = format(texts.conversationList.header, { count: String(entries.length) })
  if (entries.length === 0) {
    return `${header}\n\n${texts.conversationList.empty}`
  }
  const items = entries.map((entry) => {
    const updated = entry.updatedAt ? entry.updatedAt.replace('T', ' ').slice(0, 16) : texts.conversationList.none
    return format(texts.conversationList.item, {
      topicId: String(entry.topicId),
      title: entry.title || texts.sessionSearch.none,
      updated,
      archivedTag: entry.archived ? ` ${texts.conversationList.archivedTag}` : ''
    })
  })
  return [header, ...items, '', texts.conversationList.hint].join('\n')
}
