import logger from 'electron-log'
import type { MainIpcHandlers } from '../../../../main/plugins/context'
import {
  getAllNodePositions,
  saveNodePosition,
  saveNodePositions,
  deleteNodePosition
} from '../db/mapper/node-position'

/**
 * 图谱/看板节点坐标 IPC 处理器表（notes 插件的第 4 个域）。
 *
 * 通道名一律 `plugin:notes:<channel>`；迁移说明：原 `src/main/ipc/node-position.ts` 的 4 个
 * 扁平通道（`node-position-*` / `node-positions-*`）逐个改名，参数与返回类型不变。
 */
export const nodePositionIpcHandlers: MainIpcHandlers = {
  'plugin:notes:node-positions-get-all': async () => {
    try {
      return await getAllNodePositions()
    } catch (error) {
      logger.error('Error in plugin:notes:node-positions-get-all:', error)
      throw error
    }
  },

  'plugin:notes:node-position-save': async (nodeId: string, x: number, y: number) => {
    try {
      await saveNodePosition(nodeId, x, y)
    } catch (error) {
      logger.error('Error in plugin:notes:node-position-save:', error)
      throw error
    }
  },

  'plugin:notes:node-positions-save-batch': async (
    positions: { node_id: string; x: number; y: number }[]
  ) => {
    try {
      await saveNodePositions(positions)
    } catch (error) {
      logger.error('Error in plugin:notes:node-positions-save-batch:', error)
      throw error
    }
  },

  'plugin:notes:node-position-delete': async (nodeId: string) => {
    try {
      return await deleteNodePosition(nodeId)
    } catch (error) {
      logger.error('Error in plugin:notes:node-position-delete:', error)
      throw error
    }
  }
}

export default nodePositionIpcHandlers
