import type { Message } from '../../types/harness/types'

/**
 * Merge a freshly loaded history page with the live messages a topic already has on screen.
 *
 * Background (production 2026-11-28): `handleSelectTopic` loads the first page asynchronously, then
 * `setMessages(loadedMessages)`. If the user sends a message while that load is still in flight,
 * `startTurn` has already appended the optimistic pair (user message + streaming bubble) — and the
 * load's replace erases it. The cache still holds the pair, so the next chunk brings the pair back
 * but the history that was just loaded is dropped again by that write: the screen ends up showing
 * one user message and an empty assistant card, exactly the "page has no content" report.
 *
 * The rule is deliberately dumb and order-stable:
 *  - everything loaded comes first (it is older than anything appended after the load started);
 *  - live messages whose id is not in the loaded page are appended in their existing order;
 *  - when there is nothing live (the normal path) the loaded array is returned as-is.
 */
export function mergeLoadedHistory(loaded: Message[], live: Message[]): Message[] {
  if (live.length === 0) return loaded
  const known = new Set(loaded.map((message) => message.id))
  const tail = live.filter((message) => !known.has(message.id))
  return tail.length === 0 ? loaded : [...loaded, ...tail]
}
