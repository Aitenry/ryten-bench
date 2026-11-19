import { BrowserWindow } from 'electron'
import logger from 'electron-log'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { safeSend } from '../../../../main/safe-send'
import { mainMessages } from '../../../../main/i18n'
import { settingsStore } from '../../../../main/context'
import { getProviderService } from '../../../../main/provider/service'
import type { MainIpcHandlers } from '../../../../main/plugins/context'
import { KnowledgeGraphService, BuildConfig } from '../graph'
import { GraphSettings } from '../../../../main/types/settings'
import {
  getEntityById,
  searchEntities,
  updateEntity,
  deleteEntity,
  deleteRelation,
  getFullGraphData,
  getBuildJobByWikiId,
  getLatestBuildJob
} from '../db/mapper/graph'

/**
 * 知识图谱 IPC 处理器表（notes 插件的第 5 个域：数据查询/构建/追加）。
 *
 * 通道名一律 `plugin:notes:<channel>`；迁移说明：原 `src/main/ipc/graph.ts` 的 10 个
 * 扁平通道逐个改名。其中原 `ipcMain.on('graph-build-start')` 改成**普通 invoke 通道**
 * （ctx.registerIpc 只有 handle 一种注册方式），因此：
 * - 渲染层调用从 `ipcRenderer.send` 改为 `plugin.invoke`/`ipcRenderer.invoke`（preload 里同步改）；
 * - 进度/完成/错误三件事**必须声明为插件事件通道**才进 preload 白名单（见 main/index.ts 的
 *   `ctx.registerEvent`），否则渲染层 `window.api.plugin.on` 会被拒绝。
 *
 * 广播目标：原实现用 `event.sender`（发起构建的那个 frame）；registerIpc 不把 IpcMainInvokeEvent
 * 交给处理器，改为 `broadcast()` 发给所有存活窗口——本应用只有一个主窗口，语义等价。
 */
export const HOME_GRAPH_BUILD_START_CHANNEL = 'plugin:notes:graph-build-start'
export const HOME_GRAPH_BUILD_PROGRESS_CHANNEL = 'plugin:notes:graph-build-progress'
export const HOME_GRAPH_BUILD_COMPLETE_CHANNEL = 'plugin:notes:graph-build-complete'
export const HOME_GRAPH_BUILD_ERROR_CHANNEL = 'plugin:notes:graph-build-error'

/** 图谱构建进度事件广播（发给所有存活窗口，等价于原来的 event.sender） */
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    safeSend(win.webContents, channel, payload)
  }
}

/** 按系统设置构造图谱构建模型；未配置默认模型时返回 null（调用方下发错误事件） */
async function createGraphModel(): Promise<BaseChatModel | null> {
  try {
    const defaultModelId = settingsStore.get('defaultModelId') as number | undefined
    return await getProviderService().createModel(defaultModelId)
  } catch (error) {
    logger.error('Error in plugin:notes:graph-build model:', error)
    return null
  }
}

/** 图谱构建启动（原 `ipcMain.on('graph-build-start')`，现为普通 invoke 通道） */
const graphBuildStartHandler: MainIpcHandlers = {
  'plugin:notes:graph-build-start': async (wikiId: number, config?: Record<string, unknown>) => {
    // 整段包 try（原实现说明保留：任何未捕获的抛错都会让渲染端收不到错误事件）
    try {
      // 未配置图谱构建模型时，不进入构建流程——通过错误事件通知渲染层弹出友好提醒
      const model = await createGraphModel()
      if (!model) {
        broadcast(HOME_GRAPH_BUILD_ERROR_CHANNEL, {
          wikiId,
          error: mainMessages().error.graphModelNotConfigured
        })
        return
      }
      const graphService = new KnowledgeGraphService(model)
      // 从系统设置读取图谱构建默认值，用户传入的config可覆盖
      const graphSettings = settingsStore.get('graph') as GraphSettings | undefined
      const mergedConfig: BuildConfig = {
        maxConcurrency: (config?.maxConcurrency as number) ?? graphSettings?.maxConcurrency ?? 8,
        enableGleaning:
          (config?.enableGleaning as boolean) ?? graphSettings?.enableGleaning ?? true,
        gleaningThreshold:
          (config?.gleaningThreshold as number) ?? graphSettings?.gleaningThreshold ?? 50,
        maxChunkSize: (config?.maxChunkSize as number) ?? graphSettings?.maxChunkSize ?? 2000,
        force: config?.force as boolean | undefined
      }
      try {
        const result = await graphService.buildGraph(
          wikiId,
          (progress) => {
            broadcast(HOME_GRAPH_BUILD_PROGRESS_CHANNEL, progress)
          },
          mergedConfig
        )
        broadcast(HOME_GRAPH_BUILD_COMPLETE_CHANNEL, {
          wikiId,
          entityCount: result.entities.length,
          relationCount: result.relations.length
        })
      } catch (error) {
        logger.error('Error in plugin:notes:graph-build-start:', error)
        broadcast(HOME_GRAPH_BUILD_ERROR_CHANNEL, {
          wikiId,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    } catch (error) {
      logger.error('Error in plugin:notes:graph-build-start (unexpected):', error)
      broadcast(HOME_GRAPH_BUILD_ERROR_CHANNEL, {
        wikiId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
}

export const graphIpcHandlers: MainIpcHandlers = {
  ...graphBuildStartHandler,

  'plugin:notes:graph-data-get': async (wikiId: number, typeFilter?: string, docIds?: number[]) => {
    try {
      return await getFullGraphData(wikiId, typeFilter, docIds)
    } catch (error) {
      logger.error('Error in plugin:notes:graph-data-get:', error)
      throw error
    }
  },

  'plugin:notes:graph-entity-get': async (entityId: number) => {
    try {
      return await getEntityById(entityId)
    } catch (error) {
      logger.error('Error in plugin:notes:graph-entity-get:', error)
      throw error
    }
  },

  'plugin:notes:graph-entity-search': async (wikiId: number, query: string) => {
    try {
      return await searchEntities(wikiId, query)
    } catch (error) {
      logger.error('Error in plugin:notes:graph-entity-search:', error)
      throw error
    }
  },

  'plugin:notes:graph-entity-update': async (id: number, updates: Record<string, unknown>) => {
    try {
      return await updateEntity(id, updates as Record<string, unknown>)
    } catch (error) {
      logger.error('Error in plugin:notes:graph-entity-update:', error)
      throw error
    }
  },

  'plugin:notes:graph-entity-delete': async (id: number) => {
    try {
      return await deleteEntity(id)
    } catch (error) {
      logger.error('Error in plugin:notes:graph-entity-delete:', error)
      throw error
    }
  },

  'plugin:notes:graph-relation-delete': async (id: number) => {
    try {
      return await deleteRelation(id)
    } catch (error) {
      logger.error('Error in plugin:notes:graph-relation-delete:', error)
      throw error
    }
  },

  'plugin:notes:graph-build-status': async (wikiId: number) => {
    try {
      return await getLatestBuildJob(wikiId)
    } catch (error) {
      logger.error('Error in plugin:notes:graph-build-status:', error)
      throw error
    }
  },

  'plugin:notes:graph-processed-docs-get': async (wikiId: number) => {
    try {
      const job = await getBuildJobByWikiId(wikiId)
      if (job?.processed_note_ids) {
        return JSON.parse(job.processed_note_ids) as number[]
      }
      return []
    } catch (error) {
      logger.error('Error in plugin:notes:graph-processed-docs-get:', error)
      throw error
    }
  },

  'plugin:notes:graph-docs-append': async (wikiId: number, docIds: number[]) => {
    // 未配置图谱构建模型时，不进入追加流程——通过错误事件通知渲染层弹出友好提醒
    const model = await createGraphModel()
    if (!model) {
      broadcast(HOME_GRAPH_BUILD_ERROR_CHANNEL, {
        wikiId,
        error: mainMessages().error.graphModelNotConfigured
      })
      return { entitiesAdded: 0, relationsAdded: 0 }
    }
    const graphService = new KnowledgeGraphService(model)
    try {
      const result = await graphService.appendDocs(wikiId, docIds, (progress) => {
        broadcast(HOME_GRAPH_BUILD_PROGRESS_CHANNEL, progress)
      })
      broadcast(HOME_GRAPH_BUILD_COMPLETE_CHANNEL, {
        wikiId,
        entityCount: result.entitiesAdded,
        relationCount: result.relationsAdded
      })
      return result
    } catch (error) {
      logger.error('Error in plugin:notes:graph-docs-append:', error)
      broadcast(HOME_GRAPH_BUILD_ERROR_CHANNEL, {
        wikiId,
        error: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
  }
}

export default graphIpcHandlers
