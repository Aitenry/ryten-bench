import { dialog } from 'electron'
import * as fs from 'fs'
import mammoth from 'mammoth'
import TurndownService from 'turndown'
import { JSDOM } from 'jsdom'
import { Readability } from '@mozilla/readability'
import { mainMessages } from '../../../../main/i18n'
import type { MainIpcHandlers } from '../../../../main/plugins/context'
import { deleteNodePosition } from '../db/mapper/node-position'
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
} from '../db/mapper/document'

/** HTML → Markdown 转换（doc-import 用） */
function htmlToMarkdown(html: string): string {
  const turndownService = new TurndownService()
  return turndownService.turndown(html)
}

/**
 * 文档库 IPC 处理器表（notes 插件的第 2 个域：导入/导出/CRUD/时间范围清理）。
 *
 * 通道名一律 `plugin:notes:<channel>`；迁移说明：原 `src/main/ipc/document.ts` 的 9 个
 * 扁平通道（`doc-*`）逐个改名，参数与返回类型不变，只去掉 ipcMain 的 `_event` 形参。
 */
export const documentIpcHandlers: MainIpcHandlers = {
  'plugin:notes:doc-get-by-id': async (id: number) => {
    try {
      return await getDocById(id)
    } catch (error) {
      console.error('Error in plugin:notes:doc-get-by-id:', error)
      throw error
    }
  },

  'plugin:notes:doc-get-all': async (
    page?: number,
    pageSize?: number,
    excludeWikiId?: number,
    search?: string
  ) => {
    try {
      return await getAllDocs(page, pageSize, excludeWikiId, search)
    } catch (error) {
      console.error('Error in plugin:notes:doc-get-all:', error)
      throw error
    }
  },

  'plugin:notes:doc-page-get': async (query: string, page?: number, pageSize?: number) => {
    try {
      return await getDocPage(query, page, pageSize)
    } catch (error) {
      console.error('Error in plugin:notes:doc-page-get:', error)
      throw error
    }
  },

  'plugin:notes:doc-add': async (
    doc: Omit<DocRow, 'id' | 'created_at' | 'updated_at'> & {
      image?: string | null
      content?: string | null
    }
  ) => {
    try {
      return await addDoc(doc)
    } catch (error) {
      console.error('Error in plugin:notes:doc-add:', error)
      throw error
    }
  },

  'plugin:notes:doc-update': async (
    id: number,
    updates: Partial<Omit<DocRow, 'id' | 'created_at'>> & {
      image?: string | null
      content?: string | null
    }
  ) => {
    try {
      return await updateDoc(id, updates)
    } catch (error) {
      console.error('Error in plugin:notes:doc-update:', error)
      throw error
    }
  },

  'plugin:notes:doc-delete': async (id: number) => {
    try {
      const result = await deleteDoc(id)
      deleteNodePosition(`doc-${id}`).catch((err) =>
        console.error('Failed to delete node position for doc:', err)
      )
      return result
    } catch (error) {
      console.error('Error in plugin:notes:doc-delete:', error)
      throw error
    }
  },

  'plugin:notes:doc-delete-by-time-range': async (startTime: string, endTime: string) => {
    try {
      // 先查询将要被删除的文档 ID，用于清理节点位置
      const deletedIds = await getDocIdsByTimeRange(startTime, endTime)

      const result = await deleteDocsByTimeRange(startTime, endTime)

      // 清理对应的节点位置
      for (const id of deletedIds) {
        deleteNodePosition(`doc-${id}`).catch((err) =>
          console.error('Failed to delete node position for doc:', err)
        )
      }

      return result
    } catch (error) {
      console.error('Error in plugin:notes:doc-delete-by-time-range:', error)
      throw error
    }
  },

  'plugin:notes:doc-import': async () => {
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
        // mammoth 输出的 HTML 不含 <head>/<body>，直接转换即可
        content = htmlToMarkdown(conversionResult.value)
      } else if (ext === 'txt' || ext === 'md') {
        content = fs.readFileSync(filePath, 'utf-8')
      } else if (ext === 'html' || ext === 'htm') {
        const rawHtml = fs.readFileSync(filePath, 'utf-8')
        // 使用 Readability 智能提取文章正文
        const dom = new JSDOM(rawHtml, { url: `file://${filePath}` })
        const reader = new Readability(dom.window.document)
        const article = reader.parse()
        if (article?.content) {
          content = htmlToMarkdown(article.content)
        } else {
          // 降级：提取 <body> 内容
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
      console.error('Error in plugin:notes:doc-import:', error)
      throw error
    }
  },

  'plugin:notes:doc-export': async (id: number) => {
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
      console.error('Error in plugin:notes:doc-export:', error)
      throw error
    }
  }
}

export default documentIpcHandlers
