import logger from 'electron-log'
import type { IpcHandlerMap } from '../register'
import { deleteNodePosition } from '../../database/mapper/notes/node-position'
import {
  getWikiById,
  getAllWikis,
  addWiki,
  updateWiki,
  deleteWiki,
  getDirectoriesByWikiId,
  addDirectory,
  updateDirectory,
  deleteDirectory,
  getDocsByDirectoryId,
  addDocToDirectory,
  removeDocFromDirectory,
  getDirectoriesByDocId,
  WikiRow,
  WikiDirectoryRow
} from '../../database/mapper/notes/wiki'

/**
 * Wiki (knowledge base) IPC handler map (the third domain of the notes plugin).
 *
 * Channel names are always `notes:<channel>`. Migration note: the 13 flat channels (`wiki-*`) from
 * the former `src/main/ipc/wiki.ts` were renamed one by one; parameters and return types are
 * unchanged, apart from dropping ipcMain's `_event` parameter.
 */
export const wikiIpcHandlers: IpcHandlerMap = {
  'notes:wiki-get-by-id': async (id: number) => {
    try {
      return await getWikiById(id)
    } catch (error) {
      logger.error('Error in notes:wiki-get-by-id:', error)
      throw error
    }
  },

  'notes:wiki-get-all': async (page?: number, pageSize?: number) => {
    try {
      return await getAllWikis(page, pageSize)
    } catch (error) {
      logger.error('Error in notes:wiki-get-all:', error)
      throw error
    }
  },

  'notes:wiki-add': async (
    wiki: Omit<WikiRow, 'id' | 'doc_count' | 'created_at' | 'updated_at'>
  ) => {
    try {
      return await addWiki(wiki)
    } catch (error) {
      logger.error('Error in notes:wiki-add:', error)
      throw error
    }
  },

  'notes:wiki-update': async (
    id: number,
    updates: Partial<Omit<WikiRow, 'id' | 'doc_count' | 'created_at'>>
  ) => {
    try {
      return await updateWiki(id, updates)
    } catch (error) {
      logger.error('Error in notes:wiki-update:', error)
      throw error
    }
  },

  'notes:wiki-delete': async (id: number) => {
    try {
      const result = await deleteWiki(id)
      deleteNodePosition(`wiki-${id}`).catch((err) =>
        logger.error('Failed to delete node position for wiki:', err)
      )
      return result
    } catch (error) {
      logger.error('Error in notes:wiki-delete:', error)
      throw error
    }
  },

  'notes:wiki-directories-get': async (wikiId: number) => {
    try {
      return await getDirectoriesByWikiId(wikiId)
    } catch (error) {
      logger.error('Error in notes:wiki-directories-get:', error)
      throw error
    }
  },

  'notes:wiki-directory-add': async (
    directory: Omit<WikiDirectoryRow, 'id' | 'created_at' | 'updated_at'>
  ) => {
    try {
      return await addDirectory(directory)
    } catch (error) {
      logger.error('Error in notes:wiki-directory-add:', error)
      throw error
    }
  },

  'notes:wiki-directory-update': async (
    id: number,
    updates: Partial<Omit<WikiDirectoryRow, 'id' | 'created_at'>>
  ) => {
    try {
      return await updateDirectory(id, updates)
    } catch (error) {
      logger.error('Error in notes:wiki-directory-update:', error)
      throw error
    }
  },

  'notes:wiki-directory-delete': async (id: number) => {
    try {
      return await deleteDirectory(id)
    } catch (error) {
      logger.error('Error in notes:wiki-directory-delete:', error)
      throw error
    }
  },

  'notes:wiki-directory-docs-get': async (directoryId: number) => {
    try {
      return await getDocsByDirectoryId(directoryId)
    } catch (error) {
      logger.error('Error in notes:wiki-directory-docs-get:', error)
      throw error
    }
  },

  'notes:wiki-directory-note-add': async (
    directoryId: number,
    noteId: number,
    sortOrder?: number
  ) => {
    try {
      return await addDocToDirectory(directoryId, noteId, sortOrder)
    } catch (error) {
      logger.error('Error in notes:wiki-directory-note-add:', error)
      throw error
    }
  },

  'notes:wiki-directory-doc-remove': async (directoryId: number, docId: number) => {
    try {
      return await removeDocFromDirectory(directoryId, docId)
    } catch (error) {
      logger.error('Error in notes:wiki-directory-doc-remove:', error)
      throw error
    }
  },

  'notes:wiki-doc-directories-get': async (docId: number) => {
    try {
      return await getDirectoriesByDocId(docId)
    } catch (error) {
      logger.error('Error in notes:wiki-doc-directories-get:', error)
      throw error
    }
  }
}

export default wikiIpcHandlers
