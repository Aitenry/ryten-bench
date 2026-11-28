/**
 * Pure renderer-side logic for `propose_action` (no React / electron dependencies, so it is easy
 * to unit test).
 *
 * User decision 2026-11-27: confirmation is no longer a card in the message stream; instead a
 * single-line input bar with **pre-filled AI-recommended content** appears in the input area,
 * leaving no trace in the message stream. All this module does is decide "which proposal is
 * still pending" and "what the recommended content is".
 */

export interface ProposalActionItem {
  label: string
  description?: string
  reply?: string
}

export interface PendingProposalView {
  /** Stable key: message id + block index (used to tell "is this the same proposal" when there is no tool id) */
  key: string
  question: string
  actions: ProposalActionItem[]
  /** Content pre-filled into the input bar by default: reply of the first action (or its label) */
  recommendedText: string
}

/** Minimal renderer message shape (only the fields the decision needs, so tests don't depend on the full Message type) */
export interface ProposalMessageLike {
  role: string
  id?: string
  blocks?: Array<{
    type?: string
    tool?: {
      name?: string
      status?: string
      id?: string
      input?: unknown
    }
  }>
}

function normalizeActions(raw: unknown): ProposalActionItem[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter(
      (action): action is ProposalActionItem =>
        typeof action === 'object' &&
        action !== null &&
        typeof (action as { label?: unknown }).label === 'string' &&
        ((action as { label: string }).label ?? '').trim().length > 0
    )
    .map((action) => ({
      label: action.label.trim(),
      description:
        typeof action.description === 'string' && action.description.trim()
          ? action.description.trim()
          : undefined,
      reply:
        typeof action.reply === 'string' && action.reply.trim() ? action.reply.trim() : undefined
    }))
    .slice(0, 4)
}

/** Default pre-filled content: reply of the first action → label (keeping a full sentence the user can edit) */
export function recommendedProposalText(actions: readonly ProposalActionItem[]): string {
  const first = actions[0]
  if (!first) return ''
  return (first.reply ?? first.label).trim()
}

/**
 * Find the currently pending propose_action:
 * - only look at the **latest assistant message after the last user message** (older proposals
 *   are always expired);
 * - take the last completed `propose_action` tool block in that message with at least 1 action;
 * - return null if there is none (the input bar does not appear).
 */
export function findPendingProposal(
  messages: readonly ProposalMessageLike[]
): PendingProposalView | null {
  let lastUserIndex = -1
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') {
      lastUserIndex = i
      break
    }
  }
  // Only the latest assistant message can carry "the proposal that just finished this turn"
  for (let i = messages.length - 1; i > lastUserIndex; i -= 1) {
    const message = messages[i]
    if (message.role !== 'assistant') continue
    const blocks = message.blocks ?? []
    for (let b = blocks.length - 1; b >= 0; b -= 1) {
      const block = blocks[b]
      if (block.type !== 'tool') continue
      const tool = block.tool
      if (!tool || tool.name !== 'propose_action') continue
      if ((tool.status ?? 'completed') !== 'completed') continue
      const input = (tool.input ?? {}) as { question?: unknown; actions?: unknown }
      const actions = normalizeActions(input.actions)
      if (actions.length === 0) return null
      return {
        // tool ids are theoretically unique; still append message id + block index so that
        // reusing the same call id within one session (scripts / replay) is not mistaken for the
        // dismissed key of a previous ✕
        key: `${tool.id ?? 'no-id'}:${message.id ?? i}:${b}`,
        question: typeof input.question === 'string' ? input.question.trim() : '',
        actions,
        recommendedText: recommendedProposalText(actions)
      }
    }
    // No pending proposal in the latest assistant message → stop searching further back
    return null
  }
  return null
}
