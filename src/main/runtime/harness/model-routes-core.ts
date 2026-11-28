/**
 * Pure formatting logic for `list_subagent_models` (no DB / electron, can be tested offline).
 *
 * Purpose: the `model` field of `agent_create` / subagent configuration requires an **enabled
 * route** in `provider:model` form. Models cannot see the provider configuration, so this
 * renders the enabled routes plus a capability summary as text for them to choose from.
 */

/** One available model route (projected by the tool layer from provider config / model profiles) */
export interface ModelRouteEntry {
  /** `provider:model` (the format accepted by resolveSubAgentModelSpec) */
  spec: string
  /** Display name of the provider configuration */
  name: string
  /** Provider type (e.g. openai / anthropic) */
  providerType: string
  model: string
  isDefault: boolean
  /** Capability summary (from the model profile; undefined when not listed) */
  capabilities?: {
    image?: boolean
    tools?: boolean
    reasoning?: boolean
  }
}

/** Texts (provided by i18n according to the UI language) */
export interface ModelRoutesTexts {
  header: string
  empty: string
  item: string
  capabilities: string
  defaultTag: string
  hint: string
  none: string
  image: string
  tools: string
  reasoning: string
}

type Format = (template: string, values: Record<string, string | number>) => string

/** Joins capability labels; returns the none text when no capability is known */
export function capabilityLabels(texts: ModelRoutesTexts, entry: ModelRouteEntry): string {
  const labels: string[] = []
  if (entry.capabilities?.image) labels.push(texts.image)
  if (entry.capabilities?.tools) labels.push(texts.tools)
  if (entry.capabilities?.reasoning) labels.push(texts.reasoning)
  return labels.length > 0 ? labels.join(' · ') : texts.none
}

/** Renders the list shown to the model (the default route comes first) */
export function formatModelRoutes(
  format: Format,
  texts: ModelRoutesTexts,
  entries: ModelRouteEntry[]
): string {
  const header = format(texts.header, { count: String(entries.length) })
  if (entries.length === 0) {
    return `${header}\n\n${texts.empty}\n\n${texts.hint}`
  }
  const sorted = [...entries].sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1
    return a.spec.localeCompare(b.spec)
  })
  const items = sorted.map((entry) =>
    format(texts.item, {
      spec: entry.spec,
      name: entry.name,
      model: entry.model,
      capabilities: capabilityLabels(texts, entry),
      defaultTag: entry.isDefault ? ` ${texts.defaultTag}` : ''
    })
  )
  return [header, ...items, '', texts.hint].join('\n')
}
