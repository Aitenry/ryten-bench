/**
 * Capability catalog formatting (pure logic, no electron / no fs).
 *
 * Backs the `list_capabilities` tool: it turns the app's tools / skills / MCP servers into the
 * short "value — description" list a model copies into a scheduled task's `agentConfig`.
 *
 * Rules (user requirement):
 * - only the **name and description** are shown — no source, no enabled/connected state;
 * - the value is the exact identifier to fill in (`name` / skill `id` / `mcp@<namespace>`);
 * - list mode truncates descriptions to keep the output small; detail mode (exact `query`) keeps
 *   the full description;
 * - identifiers are never truncated.
 */

export type CapabilityKind = 'tools' | 'skills' | 'mcp'

/** One row of the catalog: the exact value plus its human readable description */
export interface CapabilityEntry {
  /** Exact identifier to copy (tool name / skill id / mcp@namespace) */
  value: string
  /** Human name when it differs from the value (skill name, MCP server name) */
  name?: string
  description: string
}

/** Localized copy for the catalog (labels, titles, empty/footer texts) */
export interface CapabilityTexts {
  labels: Record<CapabilityKind, string>
  titles: Record<CapabilityKind, string>
  none: string
  noDescription: string
  footer: string
}

/** Description cap in list mode (detail mode is never truncated) */
export const DESCRIPTION_LIMIT = 80

/** Collapse whitespace and trim (tool descriptions occasionally carry newlines) */
function normalize(text: string): string {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Truncate a description to the list-mode cap */
export function truncateDescription(text: string, limit = DESCRIPTION_LIMIT): string {
  const clean = normalize(text)
  if (!clean) return ''
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean
}

/** Render one row: `- <value>（<name>）— <description>` */
export function formatEntry(
  entry: CapabilityEntry,
  texts: Pick<CapabilityTexts, 'noDescription'>,
  full = false
): string {
  const label =
    entry.name && entry.name !== entry.value ? `${entry.value}（${entry.name}）` : entry.value
  const description = full ? normalize(entry.description) : truncateDescription(entry.description)
  return `- ${label} — ${description || texts.noDescription}`
}

/** Full list for one kind, followed by the one-line agentConfig note */
export function formatCapabilityList(
  kind: CapabilityKind,
  entries: CapabilityEntry[],
  texts: CapabilityTexts
): string {
  const lines = [`## ${texts.titles[kind]}`]
  if (entries.length === 0) {
    lines.push(texts.none)
  } else {
    for (const entry of entries) lines.push(formatEntry(entry, texts, false))
  }
  lines.push('', texts.footer)
  return lines.join('\n')
}

/** One entry with its full (untruncated) description */
export function formatCapabilityDetail(
  kind: CapabilityKind,
  entry: CapabilityEntry,
  texts: CapabilityTexts
): string {
  return [`## ${texts.titles[kind]}`, formatEntry(entry, texts, true)].join('\n')
}

/** Exact identifier lookup (case-sensitive: the form values are case-sensitive) */
export function findCapability(
  entries: CapabilityEntry[],
  query: string | undefined
): CapabilityEntry | undefined {
  const needle = String(query ?? '').trim()
  if (!needle) return undefined
  return entries.find((entry) => entry.value === needle)
}

/** All identifiers of a kind, for the "not found" hint */
export function listCapabilityIds(entries: CapabilityEntry[]): string {
  return entries.map((entry) => entry.value).join(', ')
}
