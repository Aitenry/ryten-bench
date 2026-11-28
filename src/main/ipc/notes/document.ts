import logger from 'electron-log'
import { dialog } from 'electron'
import * as fs from 'fs'
import mammoth from 'mammoth'
import TurndownService from 'turndown'
import { JSDOM } from 'jsdom'
import { Readability } from '@mozilla/readability'
import { mainMessages } from '../../i18n'
import type { IpcHandlerMap } from '../register'
import { deleteNodePosition } from '../../database/mapper/notes/node-position'
import {
  getDocById,
  getAllDocs,
  getDocPage,
  addDoc,
  updateDoc,
  deleteDoc,
  getDocIdsByTimeRange,
  deleteDocsByTimeRange,
  DocRow
} from '../../database/mapper/notes/document'

/** HTML -> Markdown conversion (used by doc-import) */
function htmlToMarkdown(html: string): string {
  const turndownService = new TurndownService()
  return turndownService.turndown(html)
}

/**
 * Document library IPC handler map (the notes plugin's second domain: import/export/CRUD/time-range
 * cleanup).
 *
 * All channel names are `notes:<channel>`; migration note: the 9 flat channels (`doc-*`) of the old
 * `src/main/ipc/document.ts` were renamed one by one, with parameters and return types unchanged
 * and only ipcMain's `_event` parameter dropped.
 */
export const documentIpcHandlers: IpcHandlerMap = {
  'notes:doc-get-by-id': async (id: number) => {
    try {
      return await getDocById(id)
    } catch (error) {
      logger.error('Error in notes:doc-get-by-id:', error)
      throw error
    }
  },

  'notes:doc-get-all': async (
    page?: number,
    pageSize?: number,
    excludeWikiId?: number,
    search?: string
  ) => {
    try {
      return await getAllDocs(page, pageSize, excludeWikiId, search)
    } catch (error) {
      logger.error('Error in notes:doc-get-all:', error)
      throw error
    }
  },

  'notes:doc-page-get': async (query: string, page?: number, pageSize?: number) => {
    try {
      return await getDocPage(query, page, pageSize)
    } catch (error) {
      logger.error('Error in notes:doc-page-get:', error)
      throw error
    }
  },

  'notes:doc-add': async (
    doc: Omit<DocRow, 'id' | 'created_at' | 'updated_at'> & {
      image?: string | null
      content?: string | null
    }
  ) => {
    try {
      return await addDoc(doc)
    } catch (error) {
      logger.error('Error in notes:doc-add:', error)
      throw error
    }
  },

  'notes:doc-update': async (
    id: number,
    updates: Partial<Omit<DocRow, 'id' | 'created_at'>> & {
      image?: string | null
      content?: string | null
    }
  ) => {
    try {
      return await updateDoc(id, updates)
    } catch (error) {
      logger.error('Error in notes:doc-update:', error)
      throw error
    }
  },

  'notes:doc-delete': async (id: number) => {
    try {
      const result = await deleteDoc(id)
      deleteNodePosition(`doc-${id}`).catch((err) =>
        logger.error('Failed to delete node position for doc:', err)
      )
      return result
    } catch (error) {
      logger.error('Error in notes:doc-delete:', error)
      throw error
    }
  },

  'notes:doc-delete-by-time-range': async (startTime: string, endTime: string) => {
    try {
      // Query the ids that will be deleted first, so their node positions can be cleaned up
      const deletedIds = await getDocIdsByTimeRange(startTime, endTime)

      const result = await deleteDocsByTimeRange(startTime, endTime)

      // Clean up the corresponding node positions
      for (const id of deletedIds) {
        deleteNodePosition(`doc-${id}`).catch((err) =>
          logger.error('Failed to delete node position for doc:', err)
        )
      }

      return result
    } catch (error) {
      logger.error('Error in notes:doc-delete-by-time-range:', error)
      throw error
    }
  },

  'notes:doc-import': async () => {
    try {
      const m = mainMessages().dialog
      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [
          {
            name: m.filterDocumentFiles,
            extensions: ['txt', 'md', 'docx', 'html', 'htm']
          },
          { name: m.filterAllFiles, extensions: ['*'] }
        ]
      })

      if (result.canceled || result.filePaths.length === 0) {
        return null
      }

      const filePath = result.filePaths[0]
      const fileName = filePath.split(/[\\/]/).pop() || 'file'
      const ext = filePath.split('.').pop()?.toLowerCase() || ''
      const title = fileName.replace(/\.[^/.]+$/, '')

      let content: string

      if (ext === 'docx') {
        const buffer = fs.readFileSync(filePath)
        const conversionResult = await mammoth.convertToHtml({ buffer })
        // mammoth's HTML output has no <head>/<body>, so it can be converted directly
        content = htmlToMarkdown(conversionResult.value)
      } else if (ext === 'txt' || ext === 'md') {
        content = fs.readFileSync(filePath, 'utf-8')
      } else if (ext === 'html' || ext === 'htm') {
        const rawHtml = fs.readFileSync(filePath, 'utf-8')
        // Use Readability to extract the article body
        const dom = new JSDOM(rawHtml, { url: `file://${filePath}` })
        const reader = new Readability(dom.window.document)
        const article = reader.parse()
        if (article?.content) {
          content = htmlToMarkdown(article.content)
        } else {
          // Fallback: extract the <body> content
          const bodyMatch = rawHtml.match(/<body[^>]*>([\s\S]*)<\/body>/i)
          const bodyContent = bodyMatch ? bodyMatch[1] : rawHtml
          const cleaned = bodyContent
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
            .replace(/<!--[\s\S]*?-->/g, '')
          content = htmlToMarkdown(cleaned)
        }
      } else {
        content = fs.readFileSync(filePath, 'utf-8')
      }

      return { title, content }
    } catch (error) {
      logger.error('Error in notes:doc-import:', error)
      throw error
    }
  },

  'notes:doc-export': async (id: number) => {
    try {
      const doc = await getDocById(id)
      if (!doc) {
        return false
      }

      const result = await dialog.showSaveDialog({
        defaultPath: `${doc.title || 'document'}.md`,
        filters: [{ name: 'Markdown', extensions: ['md'] }]
      })

      if (result.canceled || !result.filePath) {
        return false
      }

      fs.writeFileSync(result.filePath, doc.content || '', 'utf-8')
      return true
    } catch (error) {
      logger.error('Error in notes:doc-export:', error)
      throw error
    }
  }
}

export default documentIpcHandlers
