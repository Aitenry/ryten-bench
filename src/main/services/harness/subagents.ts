import * as fs from 'fs'
import { join } from 'path'
import logger from 'electron-log'
import { mainMessages } from '../../i18n'
import { settingsStore } from '../../context'
import type { HarnessSettings } from '../../types/settings'
import { listAvailableTools } from '../../tools/harness/builders'
import { mcpServerViews } from '../../runtime/harness/mcp'
import {
  canonicalToolName,
  isMcpServerGroup,
  mcpNamespace,
  mcpServerGroupValue,
  toSelectionToolNames
} from '../../../shared/harness/mcp'
import { validateSubAgentDraft, type SubAgentDraft } from '../../../shared/harness/subagent'
import type { SubAgentConfig } from './types'
import {
  createAgent,
  deleteAgent,
  getAgentById,
  getAgentByName,
  getEnabledSubAgentConfigs,
  updateAgent,
  type AgentConfigInput
} from '../../database/mapper/harness/agent'
import { getAllWorkspaces } from '../../database/mapper/harness/harness'

/**
 * Tool name normalization: mounted names → selection values (`schedule_create` → `schedule-tasks`,
 * `mcp__<server>__<tool>` → `mcp@<server>`; auto-mounted dependencies dropped), plus legacy name
 * migration (canonicalToolName) + trim + dedupe.
 *
 * Why the mounted→selection mapping matters: `agent_create` inherits the main agent's toolset from
 * the **built** tool instances, where groups are already expanded. Without mapping them back, a
 * perfectly valid inheritance would fail validation (the expanded names are not selectable values).
 * Shared by settings-page writes, IPC read display and agent_create, so there aren't two
 * "seemingly identical" normalization implementations.
 */
export function normalizeSubAgentTools(tools: string[] | null | undefined): string[] | null {
  if (!tools) return null
  const out: string[] = []
  for (const value of toSelectionToolNames(tools)) {
    const canonical = canonicalToolName(value)
    if (canonical && !out.includes(canonical)) out.push(canonical)
  }
  return out
}

/**
 * Sub-agent (agent) config service — shared by IPC (settings page) and runtime tools (`agent_create`).
 *
 * Previously this write logic all lived in `ipc/harness/agent.ts`: workspace validation, tool name
 * normalization, cache invalidation, and memory directory cleanup on delete. Now the main agent can
 * also "delegate sub-agent creation"; copying the tool logic again would mean two sets of rules, so
 * the **write semantics** are consolidated here and IPC / tools only do argument parsing and error
 * display.
 *
 * Responsibility boundaries:
 * - validation (pure format rules come from `shared/harness/subagent.ts`; the tool registry is
 *   validated here);
 * - persistence + cache invalidation (call `clearSubAgentCache()` after writing, so the runtime's
 *   next `task` sees the new config);
 * - deleting a config also cleans up that sub-agent's dedicated memory directory (same as the old
 *   IPC behavior).
 *
 * Read paths (list/detail) still query the mapper directly from IPC — the service layer provides no
 * pointless pass-through.
 */

/** Edit patch: `null` means explicitly clear an optional field (undefined = unchanged), consistent with the settings-page form semantics */
export interface SubAgentDraftPatch {
  name?: string
  displayName?: string | null
  description?: string
  systemPrompt?: string
  tools?: string[] | null
  model?: string | null
  skills?: string[] | null
}

/** Draft + owning workspace: common input for the settings page and the `agent_create` tool */
export interface SubAgentDefinitionInput extends SubAgentDraft {
  workspaceId: number
}

/** Persisted sub-agent config (returned to the tool for the model / to the settings page for refresh) */
export interface SubAgentDefinitionResult {
  id: number
  config: SubAgentConfig
}

/** Tool selection validation: accept only selectable tools that really exist in the current registry (same source as the settings page) */
function assertKnownTools(tools: string[] | null): void {
  if (!tools || tools.length === 0) return
  const available = new Set(listAvailableTools().map((tool) => tool.name))
  // MCP server group entries (mcp@<server>) are expanded into concrete tools from the MCP page at
  // run time, so a name that does not match a configured server would silently mount nothing.
  let configuredMcp = new Set<string>()
  try {
    configuredMcp = new Set(
      mcpServerViews().map((view) => mcpServerGroupValue(mcpNamespace(view.config.name)))
    )
  } catch (err) {
    logger.warn('[SubAgentConfig] Failed to read MCP servers for tool validation:', err)
  }
  const unknown = tools.filter(
    (name) => !available.has(name) && !(isMcpServerGroup(name) && configuredMcp.has(name))
  )
  if (unknown.length > 0) {
    throw new Error(
      `unknown tool(s): ${unknown.join(', ')}. Use tools that exist in the tool registry, or omit tools to inherit the main agent toolset.`
    )
  }
}

/** The workspace must exist: `agent_config.workspace_id` has a foreign key constraint; give a readable error instead of an FK violation */
async function assertWorkspaceExists(workspaceId: number): Promise<void> {
  const workspaces = await getAllWorkspaces()
  if (!workspaceId || !workspaces.some((workspace) => workspace.id === workspaceId)) {
    throw new Error(mainMessages().error.workspaceNotConfigured)
  }
}

/** Draft → database write params (tool name normalization and empty-string→null rules are maintained only here) */
function toAgentConfigInput(
  workspaceId: number,
  draft: SubAgentDraft,
  tools: string[] | null
): AgentConfigInput {
  return {
    workspace_id: workspaceId,
    name: draft.name.trim(),
    rename: draft.displayName?.trim() || null,
    prompt: draft.systemPrompt.trim(),
    description: draft.description.trim(),
    tools,
    model: draft.model?.trim() || null,
    skills: draft.skills ?? null,
    enable: true
  }
}

/** Draft → runtime shape (returned after a successful create/update to avoid another DB query) */
function toSubAgentConfig(draft: SubAgentDraft, tools: string[] | null): SubAgentConfig {
  const rename = draft.displayName?.trim()
  return {
    name: draft.name.trim(),
    ...(rename && rename !== draft.name.trim() ? { rename } : {}),
    description: draft.description.trim(),
    systemPrompt: draft.systemPrompt.trim(),
    tools: tools ?? [],
    ...(draft.model?.trim() ? { model: draft.model.trim() } : {}),
    ...(draft.skills && draft.skills.length > 0 ? { skills: draft.skills } : {})
  }
}

/** When deleting a config, also delete the sub-agent's dedicated memory directory (`<memoryPath>/workspace-<id>/sub-agents/<name>`) */
function removeSubAgentMemory(workspaceId: number, name: string): void {
  const memoryPath = (settingsStore.get('harness') as HarnessSettings | undefined)?.memoryPath
  if (!memoryPath) return
  try {
    const agentDir = join(memoryPath, `workspace-${workspaceId}`, 'sub-agents', name)
    if (fs.existsSync(agentDir)) {
      fs.rmSync(agentDir, { recursive: true, force: true })
      logger.info(`Auto-removed memory directories for sub-agent: ${name}`)
    }
  } catch (err) {
    logger.warn('Failed to auto-remove sub-agent memory directories:', err)
  }
}

/** Create a sub-agent config (shared by the settings page's "New" and the `agent_create` tool) */
export async function createSubAgentDefinition(
  input: SubAgentDefinitionInput
): Promise<SubAgentDefinitionResult> {
  const errors = validateSubAgentDraft(input)
  if (errors.length > 0) {
    throw new Error(`invalid subagent definition: ${errors.join('; ')}`)
  }
  await assertWorkspaceExists(input.workspaceId)

  const existing = await getAgentByName(input.workspaceId, input.name.trim())
  if (existing) {
    throw new Error(
      `subagent "${input.name.trim()}" already exists in this workspace. Pick another name.`
    )
  }

  const tools = normalizeSubAgentTools(input.tools)
  assertKnownTools(tools)

  const id = await createAgent(toAgentConfigInput(input.workspaceId, input, tools))
  // Runtime caches enabled configs per workspace: invalidate after writing so the next
  // task/agent_create sees it
  clearSubAgentCache()
  logger.info(`[SubAgentConfig] Created subagent "${input.name}" (workspace=${input.workspaceId})`)
  return { id, config: toSubAgentConfig(input, tools) }
}

/** Update a sub-agent config (for settings-page editing; tools don't expose update to keep the model from messing up user config) */
export async function updateSubAgentDefinition(
  workspaceId: number,
  id: number,
  patch: SubAgentDraftPatch,
  expectedRevision?: number
): Promise<boolean> {
  const current = await getAgentById(workspaceId, id)
  if (!current) throw new Error(`subagent config ${id} does not exist in this workspace`)

  // Optimistic concurrency: the settings page saves with the revision it opened with; reject if it
  // was changed by another window/process meanwhile
  if (expectedRevision !== undefined && current.revision !== expectedRevision) {
    throw new Error(
      `subagent "${current.name}" was modified by someone else (current revision ${current.revision}, expected ${expectedRevision}); reload and try again`
    )
  }

  const merged: SubAgentDraft = {
    name: patch.name ?? current.name,
    displayName:
      patch.displayName === undefined
        ? (current.rename ?? undefined)
        : (patch.displayName ?? undefined),
    description: patch.description ?? current.description ?? '',
    systemPrompt: patch.systemPrompt ?? current.prompt ?? '',
    tools:
      patch.tools === undefined
        ? current.tools
          ? (JSON.parse(current.tools) as string[])
          : undefined
        : (patch.tools ?? undefined),
    model: patch.model === undefined ? (current.model ?? undefined) : (patch.model ?? undefined),
    skills:
      patch.skills === undefined
        ? current.skills
          ? (JSON.parse(current.skills) as string[])
          : undefined
        : (patch.skills ?? undefined)
  }
  const errors = validateSubAgentDraft(merged)
  if (errors.length > 0) throw new Error(`invalid subagent definition: ${errors.join('; ')}`)

  // Renaming requires re-validating uniqueness (excluding itself)
  if (merged.name.trim() !== current.name) {
    const existing = await getAgentByName(workspaceId, merged.name.trim())
    if (existing && existing.id !== id) {
      throw new Error(`subagent "${merged.name.trim()}" already exists in this workspace`)
    }
  }

  const tools = normalizeSubAgentTools(merged.tools)
  // Validate only when the caller actually changes the tool list: an unrelated edit (rename /
  // enable toggle) of an old config must not fail because a plugin or MCP server disappeared since
  // it was created — the stale entry is inert at run time and can be removed explicitly.
  if (patch.tools !== undefined) assertKnownTools(tools)

  // Pass expectedRevision once more when writing: if a concurrent update happens between read and
  // write, CAS fails instead of overwriting
  const result = await updateAgent(
    workspaceId,
    id,
    toAgentConfigInput(workspaceId, merged, tools),
    expectedRevision ?? current.revision
  )
  if (!result) {
    throw new Error(`subagent "${current.name}" was modified concurrently; reload and try again`)
  }
  clearSubAgentCache()
  return result
}

/** Delete a sub-agent config (for settings-page deletion; also cleans up the dedicated memory directory) */
export async function deleteSubAgentDefinition(workspaceId: number, id: number): Promise<boolean> {
  const agent = await getAgentById(workspaceId, id)
  const deleted = await deleteAgent(workspaceId, id)
  if (deleted) {
    clearSubAgentCache()
    if (agent) removeSubAgentMemory(workspaceId, agent.name)
  }
  return deleted
}

/** "Enabled sub-agent definitions" cached per workspace: read when task is called, invalidated by this module after config writes */
const enabledDefinitionsCache = new Map<number, SubAgentConfig[]>()

/** Invalidate the cache (called after create/update/delete config; preload and runtime share the same cache) */
export function clearSubAgentCache(): void {
  enabledDefinitionsCache.clear()
}

/**
 * Read the enabled sub-agent definitions of the current workspace (with an in-process cache).
 *
 * The `task` tool re-reads this list **on every call**: a sub-agent that the main agent just created
 * with `agent_create` can be dispatched by `task` within the same turn (the cache was invalidated on
 * creation). Preload also reuses the same entry point, avoiding "two caches on the read path".
 */
export async function listEnabledSubAgents(workspaceId: number): Promise<SubAgentConfig[]> {
  const cached = enabledDefinitionsCache.get(workspaceId)
  if (cached) return cached
  const defs = await getEnabledSubAgentConfigs(workspaceId)
  enabledDefinitionsCache.set(workspaceId, defs)
  return defs
}
