import logger from 'electron-log'
import type { IpcHandlerMap } from '../register'
import {
  getAllNodePositions,
  saveNodePosition,
  saveNodePositions,
  deleteNodePosition
} from '../../database/mapper/notes/node-position'

/**
 * Graph/board node position IPC handler map (the notes plugin's fourth domain).
 *
 * All channel names are `notes:<channel>`; migration note: the 4 flat channels (`node-position-*` /
 * `node-positions-*`) of the old `src/main/ipc/node-position.ts` were renamed one by one, with
 * unchanged parameters and return types.
 */
export const nodePositionIpcHandlers: IpcHandlerMap = {
  'notes:node-positions-get-all': async () => {
    try {
      return await getAllNodePositions()
    } catch (error) {
      logger.error('Error in notes:node-positions-get-all:', error)
      throw error
    }
  },

  'notes:node-position-save': async (nodeId: string, x: number, y: number) => {
    try {
      await saveNodePosition(nodeId, x, y)
    } catch (error) {
      logger.error('Error in notes:node-position-save:', error)
      throw error
    }
  },

  'notes:node-positions-save-batch': async (
    positions: { node_id: string; x: number; y: number }[]
  ) => {
    try {
      await saveNodePositions(positions)
    } catch (error) {
      logger.error('Error in notes:node-positions-save-batch:', error)
      throw error
    }
  },

  'notes:node-position-delete': async (nodeId: string) => {
    try {
      return await deleteNodePosition(nodeId)
    } catch (error) {
      logger.error('Error in notes:node-position-delete:', error)
      throw error
    }
  }
}

export default nodePositionIpcHandlers
