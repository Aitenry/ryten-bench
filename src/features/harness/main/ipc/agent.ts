import * as fs from 'fs'
import { join } from 'path'
import logger from 'electron-log'
import { mainMessages } from '../../../../main/i18n'
import { settingsStore } from '../../../../main/context'
import type { HarnessSettings } from '../../../../main/types/settings'
import type { MainIpcHandlers } from '../../../../main/plugins/context'
import { clearAgentCache } from '../preload-cache'
import {
  getAllAgents,
  getAgentsPaginated,
  getAgentById,
  createAgent,
  updateAgent,
  deleteAgent,
  type AgentConfigInput
} from '../db/mapper/agent'
import { getAllWorkspaces } from '../db/mapper/harness'
import type { MainAgentConfig } from '../../shared/mcp'

/**
 * 智能体（子代理）配置 + 主智能体默认配置 IPC（harness 插件的第 5 个域）。
 *
 * 归属说明：这 8 个通道原本混在 `src/main/ipc/provider.ts` 里（该文件同时注册模型
 * Provider 通道），但 agent_config.workspace_id 挂的是 harness 的 workspace 表、
 * 配置的也是 AI 子代理，属于 harness —— 因此随本轮迁移搬进本插件，provider.ts 只留
 * 模型 Provider（provider-*）。
 *
 * 通道名一律 `plugin:harness:<原扁平名>`（agent-* / main-agent-* 共 8 个），
 * 停用「AI 助手」后智能体配置页的通道一并消失。
 */
export function agentIpcHandlers(): MainIpcHandlers {
  const handlers: MainIpcHandlers = {}
  /** 收通道：本插件的命名空间前缀只在这里出现 */
  const handle = (channel: string, handler: (...args: never[]) => unknown): void => {
    handlers[`plugin:harness:${channel}`] = handler
  }

  handle('agent-get-all', async (workspaceId: number) => {
    try {
      return await getAllAgents(workspaceId)
    } catch (error) {
      logger.error('Error in agent-get-all:', error)
      throw error
    }
  })

  handle('agent-get-paginated', async (workspaceId: number, page: number, pageSize: number) => {
    try {
      return await getAgentsPaginated(workspaceId, page, pageSize)
    } catch (error) {
      logger.error('Error in agent-get-paginated:', error)
      throw error
    }
  })

  handle('agent-get-by-id', async (workspaceId: number, id: number) => {
    try {
      return await getAgentById(workspaceId, id)
    } catch (error) {
      logger.error('Error in agent-get-by-id:', error)
      throw error
    }
  })

  handle('agent-create', async (input: AgentConfigInput) => {
    try {
      // agent_config.workspace_id 有外键约束：未配置工作区时给出可读提示，
      // 而不是抛原始的 FK 违例（应用不再自动创建默认工作区）
      const workspaces = await getAllWorkspaces()
      if (!input.workspace_id || !workspaces.some((w) => w.id === input.workspace_id)) {
        throw new Error(mainMessages().error.workspaceNotConfigured)
      }
      const id = await createAgent(input)
      clearAgentCache()
      return id
    } catch (error) {
      logger.error('Error in agent-create:', error)
      throw error
    }
  })

  handle(
    'agent-update',
    async (workspaceId: number, id: number, updates: Partial<AgentConfigInput>) => {
      try {
        const result = await updateAgent(workspaceId, id, updates)
        clearAgentCache()
        return result
      } catch (error) {
        logger.error('Error in agent-update:', error)
        throw error
      }
    }
  )

  handle('agent-delete', async (workspaceId: number, id: number) => {
    try {
      // 先获取 agent 信息（需要 name 来删除记忆目录）
      const agent = await getAgentById(workspaceId, id)
      await deleteAgent(workspaceId, id)
      clearAgentCache()
      // 自动删除子Agent记忆目录
      if (agent) {
        const settings = settingsStore.store
        const memoryPath = (settings.harness as HarnessSettings)?.memoryPath
        if (memoryPath) {
          try {
            const agentDir = join(memoryPath, `workspace-${workspaceId}`, 'sub-agents', agent.name)
            if (fs.existsSync(agentDir)) {
              fs.rmSync(agentDir, { recursive: true, force: true })
              logger.info(`Auto-removed memory directories for sub-agent: ${agent.name}`)
            }
          } catch (memErr) {
            logger.warn('Failed to auto-remove sub-agent memory directories:', memErr)
          }
        }
      }
      return true
    } catch (error) {
      logger.error('Error in agent-delete:', error)
      throw error
    }
  })

  // 主智能体配置（electron-store）。形状含 tools / skills / mcpTools，见 shared/mcp.ts
  handle('main-agent-get', () => {
    return (
      (settingsStore.get('mainAgent') as MainAgentConfig | undefined) ?? {
        tools: [],
        skills: [],
        mcpTools: []
      }
    )
  })

  /**
   * 主智能体页保存：只写 `tools` / `skills`。
   *
   * **刻意不整对象覆盖**：`mcpTools` 由 MCP 页单独维护（通道 plugin:harness:mcp-tools-set），
   * 整覆盖会在「MCP 页刚勾好、智能体页随后保存」时把勾选抹掉。
   */
  handle('main-agent-update', (config: { tools?: string[]; skills?: string[] }) => {
    const current = (settingsStore.get('mainAgent') as MainAgentConfig | undefined) ?? {}
    settingsStore.set('mainAgent', {
      ...current,
      tools: config?.tools ?? [],
      skills: config?.skills ?? []
    })
    return true
  })

  return handlers
}
