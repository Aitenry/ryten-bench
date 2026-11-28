import logger from 'electron-log'
import { settingsStore } from '../../context'
import type { IpcHandlerMap } from '../register'
import {
  getAllAgents,
  getAgentsPaginated,
  getAgentById,
  type AgentConfigInput
} from '../../database/mapper/harness/agent'
import type { MainAgentConfig } from '../../../shared/harness/mcp'
import { canonicalToolName, isSelectableMainAgentTool } from '../../../shared/harness/mcp'
import {
  createSubAgentDefinition,
  deleteSubAgentDefinition,
  normalizeSubAgentTools,
  updateSubAgentDefinition,
  type SubAgentDraftPatch
} from '../../services/harness/subagents'

/**
 * Material tools went through two renames (the four domain tools were merged into manage_materials
 * in 2026-11, then split back into `materials_*` tools under one `materials-tools` entry in
 * 2026-11-28, with documents and to-dos further split by intent). Sub-agent configs store tools as
 * a JSON string, so migrate them on read to keep previously checked tools from showing up
 * unchecked in the UI.
 */
function normalizeAgentRow<T extends { tools?: string | null }>(row: T): T {
  if (!row.tools) return row
  try {
    const parsed: unknown = JSON.parse(row.tools)
    if (Array.isArray(parsed)) {
      return {
        ...row,
        tools: JSON.stringify(normalizeSubAgentTools(parsed.map((name) => String(name))) ?? [])
      }
    }
  } catch {
    // Legacy dirty data is left as-is for upper layers to display
  }
  return row
}

/**
 * Agent (sub-agent) config plus main-agent default config IPC (the harness plugin's fifth domain).
 *
 * Write semantics (validation/normalization/cache invalidation/memory-directory cleanup) live in
 * `services/harness/subagents.ts`: the settings page and the main agent's `agent_create` tool
 * share one set of rules, so this file only parses arguments, maps read paths and logs errors.
 *
 * Channel names are always `harness:<original flat name>` (agent-* / main-agent-*, 8 in total);
 * disabling the AI assistant plugin removes the agent config page's channels too.
 */
export function agentIpcHandlers(): IpcHandlerMap {
  const handlers: IpcHandlerMap = {}
  /** Channel sink: the plugin namespace prefix appears only here */
  const handle = (channel: string, handler: (...args: never[]) => unknown): void => {
    handlers[`harness:${channel}`] = handler
  }

  handle('agent-get-all', async (workspaceId: number) => {
    try {
      return (await getAllAgents(workspaceId)).map(normalizeAgentRow)
    } catch (error) {
      logger.error('Error in agent-get-all:', error)
      throw error
    }
  })

  handle('agent-get-paginated', async (workspaceId: number, page: number, pageSize: number) => {
    try {
      const result = await getAgentsPaginated(workspaceId, page, pageSize)
      return { ...result, items: result.items.map(normalizeAgentRow) }
    } catch (error) {
      logger.error('Error in agent-get-paginated:', error)
      throw error
    }
  })

  handle('agent-get-by-id', async (workspaceId: number, id: number) => {
    try {
      const agent = await getAgentById(workspaceId, id)
      return agent ? normalizeAgentRow(agent) : agent
    } catch (error) {
      logger.error('Error in agent-get-by-id:', error)
      throw error
    }
  })

  handle('agent-create', async (input: AgentConfigInput) => {
    try {
      const { id } = await createSubAgentDefinition({
        workspaceId: input.workspace_id,
        name: input.name,
        displayName: input.rename ?? undefined,
        description: input.description ?? '',
        systemPrompt: input.prompt ?? '',
        tools: input.tools ?? undefined,
        model: input.model ?? undefined,
        skills: input.skills ?? undefined
      })
      return id
    } catch (error) {
      logger.error('Error in agent-create:', error)
      throw error
    }
  })

  handle(
    'agent-update',
    async (
      workspaceId: number,
      id: number,
      updates: Partial<AgentConfigInput>,
      expectedRevision?: number
    ) => {
      try {
        const patch: SubAgentDraftPatch = {}
        if (updates.name !== undefined) patch.name = updates.name
        if (updates.rename !== undefined) patch.displayName = updates.rename ?? undefined
        if (updates.description !== undefined) patch.description = updates.description ?? ''
        if (updates.prompt !== undefined) patch.systemPrompt = updates.prompt ?? ''
        if (updates.tools !== undefined) patch.tools = updates.tools ?? undefined
        if (updates.model !== undefined) patch.model = updates.model ?? undefined
        if (updates.skills !== undefined) patch.skills = updates.skills ?? undefined
        return await updateSubAgentDefinition(workspaceId, id, patch, expectedRevision)
      } catch (error) {
        logger.error('Error in agent-update:', error)
        throw error
      }
    }
  )

  handle('agent-delete', async (workspaceId: number, id: number) => {
    try {
      return await deleteSubAgentDefinition(workspaceId, id)
    } catch (error) {
      logger.error('Error in agent-delete:', error)
      throw error
    }
  })

  // Main agent config (electron-store). The shape holds tools / skills / mcpTools.
  handle('main-agent-get', () => {
    const config = (settingsStore.get('mainAgent') as MainAgentConfig | undefined) ?? {
      tools: [],
      skills: [],
      mcpTools: []
    }
    // Normalize in the main process before returning: keep only real, selectable tools (MCP,
    // grouped entries and mode tools are managed by their own channels), so the renderer can
    // display the result directly without filtering again.
    return {
      ...config,
      tools: Array.from(
        new Set((config.tools ?? []).map((name) => canonicalToolName(name)))
      ).filter(isSelectableMainAgentTool),
      skills: config.skills ?? [],
      mcpTools: config.mcpTools ?? []
    }
  })

  /**
   * Main agent page save: writes only `tools` / `skills`.
   *
   * **Deliberately not a whole-object overwrite**: `mcpTools` is maintained separately by the MCP
   * page (channel harness:mcp-tools-set); overwriting the object would wipe selections made there
   * when the agent page saves right after.
   */
  handle('main-agent-update', (config: { tools?: string[]; skills?: string[] }) => {
    const current = (settingsStore.get('mainAgent') as MainAgentConfig | undefined) ?? {}
    // Normalize in the main process before writing: MCP tools, grouped entries and plugin mode
    // tools do not belong in this list (MCP goes through mcp-tools-set; mode tools are mounted
    // automatically per plugin mode); legacy material tool names migrate to the `materials-tools`
    // group entry.
    const tools = Array.from(
      new Set((config?.tools ?? []).map((name) => canonicalToolName(name)))
    ).filter(isSelectableMainAgentTool)
    settingsStore.set('mainAgent', {
      ...current,
      tools,
      skills: config?.skills ?? []
    })
    return true
  })

  return handlers
}
