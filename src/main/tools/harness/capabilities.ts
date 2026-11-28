import * as z from 'zod/v4'
import { tool, type StructuredToolInterface } from '../../ai/tools'
import { settingsStore } from '../../context'
import { mainFormat } from '../../i18n'
import { getContextToolTexts } from '../../i18n/tool-results-context'
import { loadSkills } from '../../runtime/harness/skills-core'
import { mcpServerViews } from '../../runtime/harness/mcp'
import { mcpNamespace } from '../../../shared/harness/mcp'
import type { ToolInfo } from '../../plugins/tool-contract'
import {
  findCapability,
  formatCapabilityDetail,
  formatCapabilityList,
  listCapabilityIds,
  type CapabilityEntry,
  type CapabilityKind
} from '../../runtime/harness/capability-catalog-core'

/**
 * `list_capabilities` — the capability catalog the model copies values from when it fills a
 * scheduled task's `agentConfig`.
 *
 * Why it exists: `schedule_create` / `schedule_edit` take exact identifiers (`tools` names,
 * `skills` ids, `mcp@<namespace>` values), but a model that only sees its own tool schemas cannot
 * know what else the app offers, nor what an item does. This tool lists the complete catalog per
 * kind, so the form can be filled from real values instead of guesses.
 *
 * Design (user requirement):
 * - listing only ever shows **name + description** — no source, no enabled or connection state;
 * - `kind` is required (`tools` / `skills` / `mcp`); there is no `all` option — call once per kind;
 * - `query` is an **exact identifier** (`name` / skill `id` / `mcp@<namespace>`) and returns that
 *   one row with its full description; it is not a fuzzy search;
 * - the output is text, one `value — description` row per line, so the model can copy it verbatim.
 *
 * It is registered automatically whenever the scheduled-task tool group is selected (see
 * `expandSelectionToolNames`); it is not a user-selectable entry of its own.
 */

export const LIST_CAPABILITIES_TOOL_NAME = 'list_capabilities'

/** Tools: the selectable catalog (system + plugin + group entries) */
function toolEntries(infos: ToolInfo[]): CapabilityEntry[] {
  return infos.map((info) => ({
    value: info.name,
    // The localized UI description is exactly what the form shows; fall back to the label
    description: info.description || info.label
  }))
}

/** Skills: every skill under the configured root (not filtered by the conversation's selection) */
function skillEntries(): CapabilityEntry[] {
  const harness = settingsStore.get('harness') as { skillsPath?: string } | undefined
  const skillsPath = typeof harness?.skillsPath === 'string' ? harness.skillsPath : ''
  if (!skillsPath) return []
  return loadSkills({ skillsPath }).map((skill) => ({
    value: skill.id,
    name: skill.name,
    description: skill.description
  }))
}

/** MCP servers: every configured server, mapped to the value the form expects (`mcp@<ns>`) */
function mcpEntries(): CapabilityEntry[] {
  try {
    return mcpServerViews().map((view) => ({
      value: `mcp@${mcpNamespace(view.config.name)}`,
      name: view.config.name,
      description: view.config.description ?? ''
    }))
  } catch {
    return []
  }
}

function entriesOf(kind: CapabilityKind, availableTools: ToolInfo[]): CapabilityEntry[] {
  if (kind === 'tools') return toolEntries(availableTools)
  if (kind === 'skills') return skillEntries()
  return mcpEntries()
}

export function buildListCapabilitiesTool(availableTools: ToolInfo[]): StructuredToolInterface {
  return tool(
    async ({ kind, query }) => {
      const texts = getContextToolTexts()
      const entries = entriesOf(kind as CapabilityKind, availableTools)
      const trimmed = typeof query === 'string' ? query.trim() : ''
      if (!trimmed) return formatCapabilityList(kind as CapabilityKind, entries, texts)

      const entry = findCapability(entries, trimmed)
      if (!entry) {
        return mainFormat(texts.notFound, {
          id: trimmed,
          kind: texts.labels[kind as CapabilityKind],
          ids: listCapabilityIds(entries) || texts.none
        })
      }
      return formatCapabilityDetail(kind as CapabilityKind, entry, texts)
    },
    {
      name: LIST_CAPABILITIES_TOOL_NAME,
      isConcurrencySafe: () => true,
      description:
        "List this app's tools, skills or MCP servers for a scheduled task's agentConfig. " +
        'Call once per kind (tools, skills, mcp) to see everything; pass query with an exact id ' +
        "(tool name, skill id or mcp@<namespace>) to read one item's full description. " +
        'Read-only. Use the returned values verbatim in schedule_create / schedule_edit agentConfig.',
      schema: z.object({
        kind: z
          .enum(['tools', 'skills', 'mcp'])
          .describe('Which catalog to list: tools, skills or MCP servers'),
        query: z
          .string()
          .optional()
          .describe(
            'Exact identifier to read in full (tool name / skill id / mcp@<namespace>); omit to list the whole kind'
          )
      })
    }
  )
}
