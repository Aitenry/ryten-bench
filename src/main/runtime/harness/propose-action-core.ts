/**
 * Pure logic for `propose_action`: validate the action list, build the confirmation text shown to
 * the model, and build the action card title.
 *
 * The action card itself is rendered by the renderer from the tool input; the tool result only
 * tells the model "already displayed". Validation and text assembly are split into pure functions
 * for offline testing (length caps, dedupe, item cap, reply text fallback).
 */

/** A single selectable action (shared by the renderer and the tool) */
export interface ProposedAction {
  /** Button text (this is what the user clicks) */
  label: string
  /** Optional one-line description */
  description?: string
  /** Optional: text actually sent back after clicking (defaults to label) */
  reply?: string
}

/** Maximum number of actions (only the first N are kept so the card stays short) */
export const MAX_PROPOSED_ACTIONS = 4
/** Maximum length of a single label */
export const MAX_ACTION_LABEL_CHARS = 60
/** Maximum length of a single description */
export const MAX_ACTION_DESCRIPTION_CHARS = 160
/** Maximum length of a reply */
export const MAX_ACTION_REPLY_CHARS = 200

/** Texts (provided by i18n according to the UI language) */
export interface ProposeActionTexts {
  shown: string
  item: string
  hint: string
}

type Format = (template: string, values: Record<string, string | number>) => string

/**
 * Normalize the action list: drop empty labels, dedupe by label, truncate oversized fields, and
 * cap the count.
 *
 * Returns `null` when no usable action remains (the caller should ask the model to retry).
 */
export function normalizeProposedActions(raw: unknown): ProposedAction[] | null {
  if (!Array.isArray(raw)) return null
  const actions: ProposedAction[] = []
  const seen = new Set<string>()
  for (const candidate of raw) {
    if (typeof candidate !== 'object' || candidate === null) continue
    const item = candidate as Record<string, unknown>
    const label = typeof item.label === 'string' ? item.label.trim() : ''
    if (!label) continue
    const clipped = label.slice(0, MAX_ACTION_LABEL_CHARS)
    if (seen.has(clipped)) continue
    seen.add(clipped)
    const action: ProposedAction = { label: clipped }
    if (typeof item.description === 'string' && item.description.trim()) {
      action.description = item.description.trim().slice(0, MAX_ACTION_DESCRIPTION_CHARS)
    }
    if (typeof item.reply === 'string' && item.reply.trim()) {
      action.reply = item.reply.trim().slice(0, MAX_ACTION_REPLY_CHARS)
    }
    actions.push(action)
    if (actions.length >= MAX_PROPOSED_ACTIONS) break
  }
  return actions.length > 0 ? actions : null
}

/** Result text for the model: the list of displayed actions plus a "waiting for the user" hint */
export function formatProposedActions(
  format: Format,
  texts: ProposeActionTexts,
  actions: ProposedAction[]
): string {
  const header = format(texts.shown, { count: String(actions.length) })
  const items = actions.map((action) =>
    format(texts.item, {
      label: action.label,
      description: action.description ? `— ${action.description}` : ''
    })
  )
  return [header, ...items, '', texts.hint].join('\n')
}
