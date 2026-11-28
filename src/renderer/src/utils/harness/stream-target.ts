import type { Message } from '../../types/harness/types'

/**
 * Stream-target helpers shared by the live stream listener (useHarnessHandlers).
 *
 * Background (2026-11-28, production topic 6): a whole turn streamed in the main process
 * (155 blocks / 1107 characters persisted as dialogue 98) while the renderer kept showing
 * "generating…" — not one chunk reached the bubble. The listener silently discarded every batch
 * because the session cache / the target message had disappeared in the meantime, and there was no
 * way back: `applyChunkToMessages` only maps over existing messages, so an unknown id is a no-op.
 *
 * The three rules below make that path fail loud and self-healing instead of silently empty:
 *  - the target bubble is created when missing, so a batch always has somewhere to land;
 *  - "nothing on this card yet" is a single predicate shared by the stream path and the done path;
 *  - the done path can fill an empty card from the persisted dialogue row (the content is never
 *    lost — it is in the database, the renderer just failed to render it live).
 */

/**
 * Merge the persisted dialogue row into an empty live message (self-heal after a lost stream).
 *
 * Only an empty card is replaced: if any chunk did arrive, the live (already streamed) content is
 * authoritative and the row must not overwrite it.
 */
export function applySettledDialogue(
  messages: Message[],
  targetId: string,
  row: { id: number; content: string; blocks: string | null }
): Message[] {
  let blocks: Message['blocks'] = []
  if (row.blocks) {
    try {
      const parsed: unknown = JSON.parse(row.blocks)
      if (Array.isArray(parsed)) blocks = parsed as Message['blocks']
    } catch {
      blocks = []
    }
  }
  return messages.map((message) =>
    message.id === targetId && isEmptyAssistantCard(message)
      ? { ...message, content: row.content, blocks, dialogueId: row.id, loading: false }
      : message
  )
}

/**
 * Append the streaming target bubble when it is not in the list.
 *
 * Used before applying a chunk batch: without it, a missing target makes `applyChunkToMessages`
 * a silent no-op and the whole turn stays invisible.
 */
export function ensureStreamTarget(
  messages: Message[],
  targetId: string,
  timestamp = Date.now()
): Message[] {
  if (messages.some((message) => message.id === targetId)) return messages
  const placeholder: Message = {
    id: targetId,
    role: 'assistant',
    content: '',
    blocks: [],
    timestamp,
    toolCalls: [],
    loading: true
  }
  return [...messages, placeholder]
}

/**
 * Whether an assistant card has nothing to show yet (still empty while the turn settles).
 *
 * Text / reasoning / tool calls / blocks are all checked: a card holding only tool or sub-agent
 * blocks is *not* empty and must never be replaced by the "generating…" placeholder.
 */
export function isEmptyAssistantCard(message: Message | undefined): boolean {
  if (!message) return false
  if (message.role !== 'assistant') return false
  return (
    !message.content &&
    !message.reasoning_content &&
    (message.blocks?.length ?? 0) === 0 &&
    (message.toolCalls?.length ?? 0) === 0
  )
}
