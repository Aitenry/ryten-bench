import type { MainIpcHandlers } from '../../../../main/plugins/context'
import { deleteNodePosition } from '../db/mapper/node-position'
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
} from '../db/mapper/wiki'

/**
 * 知识库（Wiki）IPC 处理器表（notes 插件的第 3 个域）。
 *
 * 通道名一律 `plugin:notes:<channel>`；迁移说明：原 `src/main/ipc/wiki.ts` 的 13 个
 * 扁平通道（`wiki-*`）逐个改名，参数与返回类型不变，只去掉 ipcMain 的 `_event` 形参。
 */
export const wikiIpcHandlers: MainIpcHandlers = {
  'plugin:notes:wiki-get-by-id': async (id: number) => {
    try {
      return await getWikiById(id)
    } catch (error) {
      console.error('Error in plugin:notes:wiki-get-by-id:', error)
      throw error
    }
  },

  'plugin:notes:wiki-get-all': async (page?: number, pageSize?: number) => {
    try {
      return await getAllWikis(page, pageSize)
    } catch (error) {
      console.error('Error in plugin:notes:wiki-get-all:', error)
      throw error
    }
  },

  'plugin:notes:wiki-add': async (
    wiki: Omit<WikiRow, 'id' | 'doc_count' | 'created_at' | 'updated_at'>
  ) => {
    try {
      return await addWiki(wiki)
    } catch (error) {
      console.error('Error in plugin:notes:wiki-add:', error)
      throw error
    }
  },

  'plugin:notes:wiki-update': async (
    id: number,
    updates: Partial<Omit<WikiRow, 'id' | 'doc_count' | 'created_at'>>
  ) => {
    try {
      return await updateWiki(id, updates)
    } catch (error) {
      console.error('Error in plugin:notes:wiki-update:', error)
      throw error
    }
  },

  'plugin:notes:wiki-delete': async (id: number) => {
    try {
      const result = await deleteWiki(id)
      deleteNodePosition(`wiki-${id}`).catch((err) =>
        console.error('Failed to delete node position for wiki:', err)
      )
      return result
    } catch (error) {
      console.error('Error in plugin:notes:wiki-delete:', error)
      throw error
    }
  },

  'plugin:notes:wiki-directories-get': async (wikiId: number) => {
    try {
      return await getDirectoriesByWikiId(wikiId)
    } catch (error) {
      console.error('Error in plugin:notes:wiki-directories-get:', error)
      throw error
    }
  },

  'plugin:notes:wiki-directory-add': async (
    directory: Omit<WikiDirectoryRow, 'id' | 'created_at' | 'updated_at'>
  ) => {
    try {
      return await addDirectory(directory)
    } catch (error) {
      console.error('Error in plugin:notes:wiki-directory-add:', error)
      throw error
    }
  },

  'plugin:notes:wiki-directory-update': async (
    id: number,
    updates: Partial<Omit<WikiDirectoryRow, 'id' | 'created_at'>>
  ) => {
    try {
      return await updateDirectory(id, updates)
    } catch (error) {
      console.error('Error in plugin:notes:wiki-directory-update:', error)
      throw error
    }
  },

  'plugin:notes:wiki-directory-delete': async (id: number) => {
    try {
      return await deleteDirectory(id)
    } catch (error) {
      console.error('Error in plugin:notes:wiki-directory-delete:', error)
      throw error
    }
  },

  'plugin:notes:wiki-directory-docs-get': async (directoryId: number) => {
    try {
      return await getDocsByDirectoryId(directoryId)
    } catch (error) {
      console.error('Error in plugin:notes:wiki-directory-docs-get:', error)
      throw error
    }
  },

  'plugin:notes:wiki-directory-note-add': async (
    directoryId: number,
    noteId: number,
    sortOrder?: number
  ) => {
    try {
      return await addDocToDirectory(directoryId, noteId, sortOrder)
    } catch (error) {
      console.error('Error in plugin:notes:wiki-directory-note-add:', error)
      throw error
    }
  },

  'plugin:notes:wiki-directory-doc-remove': async (directoryId: number, docId: number) => {
    try {
      return await removeDocFromDirectory(directoryId, docId)
    } catch (error) {
      console.error('Error in plugin:notes:wiki-directory-doc-remove:', error)
      throw error
    }
  },

  'plugin:notes:wiki-doc-directories-get': async (docId: number) => {
    try {
      return await getDirectoriesByDocId(docId)
    } catch (error) {
      console.error('Error in plugin:notes:wiki-doc-directories-get:', error)
      throw error
    }
  }
}

export default wikiIpcHandlers
