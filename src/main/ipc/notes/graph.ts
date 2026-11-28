import { BrowserWindow } from 'electron'
import logger from 'electron-log'
import type { BaseChatModel } from '../../ai/chat-model'
import { safeSend } from '../../safe-send'
import { mainMessages } from '../../i18n'
import { settingsStore } from '../../context'
import { getProviderService } from '../../provider/service'
import type { IpcHandlerMap } from '../register'
import { KnowledgeGraphService, BuildConfig } from '../../graph'
import { GraphSettings } from '../../types/settings'
import {
  getEntityById,
  searchEntities,
  updateEntity,
  deleteEntity,
  deleteRelation,
  getFullGraphData,
  getBuildJobByWikiId,
  getLatestBuildJob
} from '../../database/mapper/notes/graph'

/**
 * Knowledge graph IPC handler map (the library's fifth domain: data query/build/append).
 *
 * All channel names are `notes:<channel>`; the build entry point is a regular invoke channel
 * (handle is its only registration form), so the renderer uses invoke instead of
 * `ipcRenderer.send`. Progress / completion / error are broadcast by the main process, and the
 * renderer subscribes through the preload system bridge (`window.api.system.on`) — the `notes:`
 * channel prefix is allowed, so no extra whitelist entry is needed.
 *
 * Broadcast target: the original implementation used `event.sender` (the frame that started the
 * build); the handler has no event object, so it sends to all live windows — the app has a single
 * main window, so this is semantically equivalent.
 */
export const HOME_GRAPH_BUILD_START_CHANNEL = 'notes:graph-build-start'
export const HOME_GRAPH_BUILD_PROGRESS_CHANNEL = 'notes:graph-build-progress'
export const HOME_GRAPH_BUILD_COMPLETE_CHANNEL = 'notes:graph-build-complete'
export const HOME_GRAPH_BUILD_ERROR_CHANNEL = 'notes:graph-build-error'

/**
 * Graph build progress event broadcast (sent to all live windows, equivalent to the former
 * event.sender).
 */
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    safeSend(win.webContents, channel, payload)
  }
}

/**
 * Build the graph model from system settings; returns null when no default model is configured (the
 * caller emits an error event).
 */
async function createGraphModel(): Promise<BaseChatModel | null> {
  try {
    const defaultModelId = settingsStore.get('defaultModelId') as number | undefined
    return await getProviderService().createModel(defaultModelId)
  } catch (error) {
    logger.error('Error in notes:graph-build model:', error)
    return null
  }
}

/** Graph build start (formerly `ipcMain.on('graph-build-start')`, now a regular invoke channel) */
const graphBuildStartHandler: IpcHandlerMap = {
  'notes:graph-build-start': async (wikiId: number, config?: Record<string, unknown>) => {
    // The whole body is wrapped in try (any uncaught throw would keep the renderer from receiving
    // the error event)
    try {
      // When no graph build model is configured, skip the build and emit an error event so the
      // renderer can show a friendly notice
      const model = await createGraphModel()
      if (!model) {
        broadcast(HOME_GRAPH_BUILD_ERROR_CHANNEL, {
          wikiId,
          error: mainMessages().error.graphModelNotConfigured
        })
        return
      }
      const graphService = new KnowledgeGraphService(model)
      // Read graph build defaults from system settings; values passed by the caller override them
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
        logger.error('Error in notes:graph-build-start:', error)
        broadcast(HOME_GRAPH_BUILD_ERROR_CHANNEL, {
          wikiId,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    } catch (error) {
      logger.error('Error in notes:graph-build-start (unexpected):', error)
      broadcast(HOME_GRAPH_BUILD_ERROR_CHANNEL, {
        wikiId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
}

export const graphIpcHandlers: IpcHandlerMap = {
  ...graphBuildStartHandler,

  'notes:graph-data-get': async (wikiId: number, typeFilter?: string, docIds?: number[]) => {
    try {
      return await getFullGraphData(wikiId, typeFilter, docIds)
    } catch (error) {
      logger.error('Error in notes:graph-data-get:', error)
      throw error
    }
  },

  'notes:graph-entity-get': async (entityId: number) => {
    try {
      return await getEntityById(entityId)
    } catch (error) {
      logger.error('Error in notes:graph-entity-get:', error)
      throw error
    }
  },

  'notes:graph-entity-search': async (wikiId: number, query: string) => {
    try {
      return await searchEntities(wikiId, query)
    } catch (error) {
      logger.error('Error in notes:graph-entity-search:', error)
      throw error
    }
  },

  'notes:graph-entity-update': async (id: number, updates: Record<string, unknown>) => {
    try {
      return await updateEntity(id, updates as Record<string, unknown>)
    } catch (error) {
      logger.error('Error in notes:graph-entity-update:', error)
      throw error
    }
  },

  'notes:graph-entity-delete': async (id: number) => {
    try {
      return await deleteEntity(id)
    } catch (error) {
      logger.error('Error in notes:graph-entity-delete:', error)
      throw error
    }
  },

  'notes:graph-relation-delete': async (id: number) => {
    try {
      return await deleteRelation(id)
    } catch (error) {
      logger.error('Error in notes:graph-relation-delete:', error)
      throw error
    }
  },

  'notes:graph-build-status': async (wikiId: number) => {
    try {
      return await getLatestBuildJob(wikiId)
    } catch (error) {
      logger.error('Error in notes:graph-build-status:', error)
      throw error
    }
  },

  'notes:graph-processed-docs-get': async (wikiId: number) => {
    try {
      const job = await getBuildJobByWikiId(wikiId)
      if (job?.processed_note_ids) {
        return JSON.parse(job.processed_note_ids) as number[]
      }
      return []
    } catch (error) {
      logger.error('Error in notes:graph-processed-docs-get:', error)
      throw error
    }
  },

  'notes:graph-docs-append': async (wikiId: number, docIds: number[]) => {
    // When no graph build model is configured, skip the append flow and emit an error event so the
    // renderer can show a friendly notice
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
      logger.error('Error in notes:graph-docs-append:', error)
      broadcast(HOME_GRAPH_BUILD_ERROR_CHANNEL, {
        wikiId,
        error: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
  }
}

export default graphIpcHandlers
