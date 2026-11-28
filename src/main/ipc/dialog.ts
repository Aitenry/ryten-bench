import logger from 'electron-log'
import { dialog, ipcMain } from 'electron'
import * as fs from 'fs'
import { mainMessages } from '../i18n'

/** Shared file-picker IPC (chat attachments: images/documents and text files) */
export function registerDialogIpc(): void {
  ipcMain.handle('select-image-file', async (_event, allowImages?: boolean) => {
    try {
      const m = mainMessages().dialog
      const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp']
      const docExts = ['pdf', 'txt', 'md', 'csv', 'json', 'xml', 'doc', 'docx', 'xls', 'xlsx']

      const extensions = allowImages !== false ? [...imageExts, ...docExts] : docExts

      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [
          { name: m.filterSupportedFiles, extensions },
          { name: m.filterAllFiles, extensions: ['*'] }
        ]
      })

      if (result.canceled || result.filePaths.length === 0) {
        return null
      }

      const filePath = result.filePaths[0]
      const fileName = filePath.split(/[\\/]/).pop() || 'file'
      const ext = filePath.split('.').pop()?.toLowerCase() || 'bin'
      const isImage = imageExts.includes(ext)

      // Disallow picking images for non-vision models
      if (allowImages === false && isImage) {
        await dialog.showErrorBox(m.unsupportedFileTypeTitle, m.unsupportedFileTypeMessage)
        return null
      }

      if (isImage) {
        const fileBuffer = fs.readFileSync(filePath)
        const base64 = fileBuffer.toString('base64')
        const mimeType = `image/${ext === 'jpg' ? 'jpeg' : ext}`
        return { dataUrl: `data:${mimeType};base64,${base64}`, fileName, isImage: true }
      }

      return { dataUrl: filePath, fileName, isImage: false }
    } catch (error) {
      logger.error('Error selecting file:', error)
      throw error
    }
  })

  ipcMain.handle('select-text-file', async () => {
    try {
      const m = mainMessages().dialog
      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [
          { name: m.filterTextFiles, extensions: ['txt'] },
          { name: m.filterAllFiles, extensions: ['*'] }
        ]
      })

      if (result.canceled || result.filePaths.length === 0) {
        return null
      }

      const filePath = result.filePaths[0]
      const fileName = filePath.split(/[\\/]/).pop() || 'file'
      return { fileName, filePath }
    } catch (error) {
      logger.error('Error selecting text file:', error)
      throw error
    }
  })
}