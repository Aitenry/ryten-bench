import logger from 'electron-log'
import type { MainIpcHandlers } from '../../../../main/plugins/context'
import { todoStore } from '../runtime/todo'
import { goalStore } from '../runtime/goal'
import { jobsRegistry } from '../runtime/jobs'
import { subagentSessions } from '../runtime/subagent-sessions'
import { SpillStore } from '../runtime/spill'
import { questionService } from '../runtime/ask'
import { permissionGate } from '../runtime/permission-gate'
import { getToolOutputStore } from '../runtime/tool-output-store'
import { deleteCompactionByTopic } from '../db/mapper/compaction'
import { settingsStore } from '../../../../main/context'
import { harnessQueue } from '../queue-store'
import { clearTopicCache } from '../preload-cache'
import type { HarnessSettings } from '../../../../main/types/settings'
import { memoryScopeRoot, parseMemoryScope } from '../memory-scope'
import {
  getAllWorkspaces,
  createWorkspace,
  updateWorkspace,
  deleteWorkspace,
  getAllTopics,
  getAllTopicsPaginated,
  getTopicById,
  createTopic,
  updateTopic,
  deleteTopic,
  getDialoguesByTopicId,
  getDialoguesByTopicIdPaginated,
  addDialogue,
  deleteDialoguesByTopicId,
  deleteDialogueById,
  getUsageByTopic
} from '../db/mapper/harness'
import type { HarnessTopicRow, HarnessDialogueRow } from '../db/mapper/harness'

/**
 * Harness 工作区 / 话题 / 对话记录 CRUD IPC（harness 插件的第 2 个域）。
 *
 * 通道名一律 `plugin:harness:<原扁平名>`（原 `src/main/ipc/harness-topic.ts` 的 16 个扁平
 * 通道逐个改名：4 个工作区 + 6 个话题 + 6 个对话/用量，参数与返回类型不变），
 * 由 `main/index.ts` 交给 `ctx.registerIpc`，停用时随 `ctx.dispose()` 一次性摘除。
 */
export function harnessTopicIpcHandlers(): MainIpcHandlers {
  const handlers: MainIpcHandlers = {}
  /** 收通道：本插件的命名空间前缀只在这里出现 */
  const handle = (channel: string, handler: (...args: never[]) => unknown): void => {
    handlers[`plugin:harness:${channel}`] = handler
  }

  // --- Harness Workspace IPC handlers ---

  handle('workspace-get-all', async () => {
    try {
      return await getAllWorkspaces()
    } catch (error) {
      logger.error('Error in workspace-get-all:', error)
      throw error
    }
  })

  handle('workspace-create', async (name: string, path: string) => {
    try {
      return await createWorkspace(name, path)
    } catch (error) {
      logger.error('Error in workspace-create:', error)
      throw error
    }
  })

  handle('workspace-update', async (id: number, updates: { name: string }) => {
    try {
      return await updateWorkspace(id, updates)
    } catch (error) {
      logger.error('Error in workspace-update:', error)
      throw error
    }
  })

  handle('workspace-delete', async (id: number) => {
    try {
      clearTopicCache()
      return await deleteWorkspace(id)
    } catch (error) {
      logger.error('Error in workspace-delete:', error)
      throw error
    }
  })

  // --- Harness Topic IPC handlers ---

  handle('harness-topic-get-all', async (workspaceId: number) => {
    try {
      return await getAllTopics(workspaceId)
    } catch (error) {
      logger.error('Error in harness-topic-get-all:', error)
      throw error
    }
  })

  handle(
    'harness-topic-get-paginated',
    async (workspaceId: number, page: number, pageSize: number) => {
      try {
        return await getAllTopicsPaginated(workspaceId, page, pageSize)
      } catch (error) {
        logger.error('Error in harness-topic-get-paginated:', error)
        throw error
      }
    }
  )

  handle('harness-topic-get-by-id', async (id: number) => {
    try {
      return await getTopicById(id)
    } catch (error) {
      logger.error('Error in harness-topic-get-by-id:', error)
      throw error
    }
  })

  handle(
    'harness-topic-create',
    async (
      workspaceId: number,
      title: string,
      model?: string,
      selectedTools?: string,
      /** 记忆作用域（`plugin:<插件 id>`；空 = 工作区记忆，见 main/memory-scope.ts） */
      memoryScope?: string | null
    ) => {
      try {
        clearTopicCache()
        return await createTopic(workspaceId, title, model, selectedTools, memoryScope)
      } catch (error) {
        logger.error('Error in harness-topic-create:', error)
        throw error
      }
    }
  )

  handle(
    'harness-topic-update',
    async (
      id: number,
      updates: Partial<Pick<HarnessTopicRow, 'title' | 'model' | 'selected_tools'>>
    ) => {
      try {
        clearTopicCache()
        return await updateTopic(id, updates)
      } catch (error) {
        logger.error('Error in harness-topic-update:', error)
        throw error
      }
    }
  )

  handle('harness-topic-delete', async (id: number) => {
    try {
      clearTopicCache()
      // 清理该话题的对话计划清单（进程级 todoStore）
      todoStore.clear(id)
      // 清理该话题的对话目标（goalStore：缓存 + 数据库行）
      await goalStore.delete(id)
      // 清理该话题的后台任务（全部 kill）
      jobsRegistry.clearTopic(id)
      // 清理该话题的子代理续接会话（全部中断）
      subagentSessions.clearTopic(id)
      // 清理该话题的摘要压缩 checkpoint（topic_compactions 表）
      await deleteCompactionByTopic(id)
      // 清理该话题的工具结果溢出文件（spill 目录）
      // 落点按**这条会话的作用域**算：工作会话在 <memoryPath>/workspace-<id>/spill/，
      // 插件会话在 <memoryPath>/plugin-<id>/spill/（与 Runtime 的 memoryPath 同一口径，
      // 否则删了话题、溢出文件还留在那个作用域目录里）
      const harnessSettings = settingsStore.get('harness') as HarnessSettings | undefined
      const topicRows = await getTopicById(id).catch(() => [])
      const topicRow = topicRows[0]
      SpillStore.pruneTopic(
        harnessSettings?.workspacePath || undefined,
        memoryScopeRoot(
          harnessSettings?.memoryPath || undefined,
          parseMemoryScope(topicRow?.memory_scope, topicRow?.workspace_id ?? 0)
        ),
        id
      )
      // 清理该话题的工具结果详情（聊天卡片点开的 ls/glob/grep/execute 结果）
      getToolOutputStore()?.removeTopic(id)
      // 清理该话题的插话队列（含待注入缓冲：那条插话已随话题一起消失）
      harnessQueue.clear(id)
      // 该话题挂起的提问 / 审批：按「已取消 / 拒绝」结算。
      // 不结算的话，删掉这条会话后那次调用永远等不到回答（工具卡片一直「执行中…」、
      // 主进程还挂着一个 promise）——提问/审批按会话隔离，这一条会话没了就该一起收尾
      questionService.abortTopic(id)
      permissionGate.abortTopic(id)
      return await deleteTopic(id)
    } catch (error) {
      logger.error('Error in harness-topic-delete:', error)
      throw error
    }
  })

  // --- Harness Dialogue IPC handlers ---

  handle('harness-dialogue-get-by-topic', async (topicId: number) => {
    try {
      return await getDialoguesByTopicId(topicId)
    } catch (error) {
      logger.error('Error in harness-dialogue-get-by-topic:', error)
      throw error
    }
  })

  handle(
    'harness-dialogue-get-by-topic-paginated',
    async (topicId: number, page: number, pageSize: number) => {
      try {
        return await getDialoguesByTopicIdPaginated(topicId, page, pageSize)
      } catch (error) {
        logger.error('Error in harness-dialogue-get-by-topic-paginated:', error)
        throw error
      }
    }
  )

  // 对话真实用量（harness_dialogue_usage）：渲染层按 dialogue_id 回填到各条助手消息
  handle('harness-usage-get-by-topic', async (topicId: number) => {
    try {
      return await getUsageByTopic(topicId)
    } catch (error) {
      logger.error('Error in harness-usage-get-by-topic:', error)
      throw error
    }
  })

  handle(
    'harness-dialogue-add',
    async (dialogue: Omit<HarnessDialogueRow, 'id' | 'created_at'>) => {
      try {
        return await addDialogue(dialogue)
      } catch (error) {
        logger.error('Error in harness-dialogue-add:', error)
        throw error
      }
    }
  )

  handle('harness-dialogue-delete-by-topic', async (topicId: number) => {
    try {
      return await deleteDialoguesByTopicId(topicId)
    } catch (error) {
      logger.error('Error in harness-dialogue-delete-by-topic:', error)
      throw error
    }
  })

  handle('harness-dialogue-delete', async (id: number) => {
    try {
      return await deleteDialogueById(id)
    } catch (error) {
      logger.error('Error in harness-dialogue-delete:', error)
      throw error
    }
  })

  return handlers
}
