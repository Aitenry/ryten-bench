import * as z from 'zod/v4'
import { tool, type StructuredToolInterface } from '../../ai/tools'
import { settingsStore } from '../../context'
import { mainFormat } from '../../i18n'
import { getContextToolTexts } from '../../i18n/tool-results-context'
import { loadSkills } from '../../runtime/harness/skills-core'
import { mcpServerViews } from '../../runtime/harness/mcp'
import { getEnabledProviders } from '../../database/mapper/provider'
import {
  LIST_CAPABILITIES_TOOL_NAME,
  canonicalToolName,
  mcpNamespace,
  MCP_TOOL_GROUP
} from '../../../shared/harness/mcp'
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
 * `list_capabilities` — the capability catalog for **filling built-in forms with exact values**.
 *
 * Why it exists: `agent_create` (creating a subagent) and `schedule_create` / `schedule_edit`
 * (scheduling a task) take exact identifiers (`tools` names, `skills` ids, `mcp@<namespace>`,
 * `provider:model`), but a model that only sees its own tool schemas cannot know what else the app
 * offers, nor what an item does. This tool lists the complete catalog per kind, so those forms can
 * be filled from real values instead of guesses.
 *
 * Design (user requirement):
 * - listing only ever shows **name + description** — no source, no enabled or connection state;
 * - `kind` is required (`tools` / `skills` / `mcp` / `models`); there is no `all` option — call once per kind;
 * - `query` is an **exact identifier** (`name` / skill `id` / `mcp@<namespace>`) and returns that
 *   one row with its full description; it is not a fuzzy search;
 * - the output is text, one `value — description` row per line, so the model can copy it verbatim.
 *
 * It is **not** a selectable tool: the runtime mounts it unconditionally in every main-agent
 * conversation (see `buildAllTools` in `runtime/harness/runtime.ts`), instead of only next to the
 * schedule tools, because subagent creation needs the same catalog. It is also classified as a
 * read-only tool in the permission policy.
 */

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

/**
 * Models: every enabled provider route as `provider:model`, the value subagent configs and
 * scheduled-task `model` fields accept.
 *
 * Providers are read fresh on every call (like tools/skills) so enabling/disabling a model in
 * settings shows up without a restart. The row key is the route spec; the provider's display name
 * is the human label, and the model name is the description.
 */
async function modelEntries(): Promise<CapabilityEntry[]> {
  try {
    const providers = await getEnabledProviders()
    const out: CapabilityEntry[] = []
    for (const provider of providers) {
      const modelName = provider.model?.trim()
      const providerType = provider.provider?.trim()
      if (!modelName || !providerType) continue
      const value = `${providerType}:${modelName}`
      if (out.some((entry) => entry.value === value)) continue
      out.push({ value, name: provider.name, description: provider.model })
    }
    return out
  } catch {
    return []
  }
}

async function entriesOf(
  kind: CapabilityKind,
  availableTools: ToolInfo[]
): Promise<CapabilityEntry[]> {
  if (kind === 'tools') return toolEntries(availableTools)
  if (kind === 'skills') return skillEntries()
  if (kind === 'models') return modelEntries()
  return mcpEntries()
}

/** Accepted `provider:model` values for a scheduled task's (or subagent's) model field */
export async function modelSelectionValues(): Promise<ReadonlySet<string>> {
  return new Set((await modelEntries()).map((entry) => entry.value))
}

/**
 * Accepted values for a scheduled task's `agentConfig`, derived from the same catalog the tool
 * lists.
 *
 * `tools` also contains the MCP group values: the Schedules page's legacy migration keeps
 * `mcp@<namespace>` in `tools`, and the old all-servers marker `mcp` is still expanded at run
 * time. Everything else that is mounted unconditionally (built-in runtime tools such as `task`,
 * `read_file`, `execute`, …) is deliberately absent, so validation can reject it.
 */
export function scheduleSelectionValues(availableTools: ToolInfo[]): {
  tools: ReadonlySet<string>
  skills: ReadonlySet<string>
  mcp: ReadonlySet<string>
  canonicalTool: (name: string) => string
} {
  const tools = new Set(toolEntries(availableTools).map((entry) => entry.value))
  const skills = new Set(skillEntries().map((entry) => entry.value))
  const mcp = new Set([...mcpEntries().map((entry) => entry.value), MCP_TOOL_GROUP])
  for (const value of mcp) tools.add(value)
  // Old tasks/forms still carry pre-split names (`manage_materials`, `web_fetch`, …); the run-time
  // sanitizer uses this to migrate them to the group entries above instead of dropping them.
  return { tools, skills, mcp, canonicalTool: canonicalToolName }
}

export function buildListCapabilitiesTool(availableTools: ToolInfo[]): StructuredToolInterface {
  return tool(
    async ({ kind, query }) => {
      const texts = getContextToolTexts()
      const entries = await entriesOf(kind as CapabilityKind, availableTools)
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
        "Look up this app's selectable capabilities (tools / skills / MCP servers / models) so built-in forms can be filled with exact identifiers: creating a subagent (agent_create → tools / skills / model) and creating or editing a scheduled task (schedule_create / schedule_edit → agentConfig / model). " +
        "Call once per kind; pass query with an exact value (tool name, skill id, mcp@<namespace> or provider:model) to read one item's full description. " +
        'Read-only. Copy the returned values verbatim — those forms reject values outside this catalog.',
      schema: z.object({
        kind: z
          .enum(['tools', 'skills', 'mcp', 'models'])
          .describe('Which catalog to list: tools, skills, MCP servers or models'),
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
