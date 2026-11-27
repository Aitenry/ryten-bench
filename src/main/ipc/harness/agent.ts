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
 * 旧资料工具名（manage_docs/manage_todos/manage_wikis/search_graph）在 2026-11 合并成
 * manage_materials。子智能体配置把 tools 存成 JSON 字符串，这里读时顺手迁移，
 * 免得界面上「上次勾过的工具」显示为未选中。
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
    // 历史脏数据保持原样，交给上层展示
  }
  return row
}

/**
 * 智能体（子代理）配置 + 主智能体默认配置 IPC（harness 插件的第 5 个域）。
 *
 * 写入语义（校验/归一/缓存失效/记忆目录清理）已收敛到
 * `services/harness/subagents.ts`：设置页与主智能体的 `agent_create` 工具共用同一套规则，
 * 这里只做参数解析、读路径映射与错误日志。
 *
 * 通道名一律 `harness:<原扁平名>`（agent-* / main-agent-* 共 8 个），
 * 停用「AI 助手」后智能体配置页的通道一并消失。
 */
export function agentIpcHandlers(): IpcHandlerMap {
  const handlers: IpcHandlerMap = {}
  /** 收通道：本插件的命名空间前缀只在这里出现 */
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

  // 主智能体配置（electron-store）。形状含 tools / skills / mcpTools，见 shared/mcp.ts
  handle('main-agent-get', () => {
    const config = (settingsStore.get('mainAgent') as MainAgentConfig | undefined) ?? {
      tools: [],
      skills: [],
      mcpTools: []
    }
    // 返回前在主进程收敛：工具清单只留可勾选的真实工具（MCP / 分组项 / 模式工具由各自的
    // 通道管理），渲染层直接展示，不做二次过滤。
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
   * 主智能体页保存：只写 `tools` / `skills`。
   *
   * **刻意不整对象覆盖**：`mcpTools` 由 MCP 页单独维护（通道 harness:mcp-tools-set），
   * 整覆盖会在「MCP 页刚勾好、智能体页随后保存」时把勾选抹掉。
   */
  handle('main-agent-update', (config: { tools?: string[]; skills?: string[] }) => {
    const current = (settingsStore.get('mainAgent') as MainAgentConfig | undefined) ?? {}
    // 写入前在主进程收敛：MCP 工具/分组项、插件模式工具都不属于这份清单
    // （MCP 走 mcp-tools-set，模式工具按插件模式自动挂载）；旧资料工具名迁移到统一入口。
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
