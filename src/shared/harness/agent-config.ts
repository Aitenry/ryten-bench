/**
 * Shared definition of the session-level "selection enabled for this turn" (used by the
 * renderer, the main process and scheduled tasks alike).
 *
 * Semantics (user requirement 2026-11-27: newly added MCP servers and skills must not be enabled
 * by default; they are selected below the input box):
 * - `tools === null`: no override, follow the main agent's default tools;
 * - `skills === null`: **no skills enabled**;
 * - `mcpTools === null`: **no MCP tools enabled**.
 *
 * All three values are "a string array or null"; illegal input always collapses to null (dirty
 * data never goes into session config).
 */

/** Session-level runtime selection (null = not overridden / not enabled for that dimension) */
export interface AgentSelection {
  tools: string[] | null
  skills: string[] | null
  mcpTools: string[] | null
}

/** Clean a string array (trim, dedupe, drop non-strings; an empty array is kept as []) */
function cleanNames(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const value = item.trim()
    if (!value || out.includes(value)) continue
    out.push(value)
  }
  return out
}

/** Parse a selection from outside (IPC / database JSON); any illegal field collapses to null */
export function normalizeAgentSelection(raw: unknown): AgentSelection | null {
  if (!raw || typeof raw !== 'object') return null
  const input = raw as Record<string, unknown>
  return {
    tools: cleanNames(input.tools),
    skills: cleanNames(input.skills),
    mcpTools: cleanNames(input.mcpTools)
  }
}

/**
 * Merge two layers of selection: **non-null** dimensions in `override` win over `base`.
 *
 * Used to layer "the selection stored on the task" over "the selection stored on the session":
 * dimensions explicitly chosen in the task win, unselected ones keep following the
 * session/default.
 */
export function mergeAgentSelection(
  base: AgentSelection | null | undefined,
  override: AgentSelection | null | undefined
): AgentSelection {
  return {
    tools: override?.tools !== null && override?.tools !== undefined ? override.tools : (base?.tools ?? null),
    skills:
      override?.skills !== null && override?.skills !== undefined
        ? override.skills
        : (base?.skills ?? null),
    mcpTools:
      override?.mcpTools !== null && override?.mcpTools !== undefined
        ? override.mcpTools
        : (base?.mcpTools ?? null)
  }
}

/** Whether this is a selection where nothing is selected (all null) */
export function isEmptyAgentSelection(selection: AgentSelection | null | undefined): boolean {
  if (!selection) return true
  return selection.tools === null && selection.skills === null && selection.mcpTools === null
}
