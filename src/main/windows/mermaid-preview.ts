import { BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'path'
import * as fs from 'fs'
import logger from 'electron-log'
import mermaidPreviewHtmlPath from '../resource/mermaid-preview.html?asset'
import { mainMessages } from '../i18n'
import { buildMermaidPreviewHtml } from './mermaid-preview-html'

let mermaidPreviewWin: BrowserWindow | null = null
let cachedHtml: string | null = null

/** Build the preview page from the HTML asset (injects SVG / nonce / current locale text; see mermaid-preview-html.ts) */
function buildPreviewPage(svg: string): string {
  if (cachedHtml === null) {
    cachedHtml = fs.readFileSync(mermaidPreviewHtmlPath, 'utf-8')
  }
  return buildMermaidPreviewHtml(cachedHtml, svg, mainMessages().window.mermaidPreview)
}

export function registerMermaidPreviewIpc(): void {
  ipcMain.handle('mermaid-preview', (_event, svg: string) => {
    const dataUrl =
      'data:text/html;charset=utf-8,' + encodeURIComponent(buildPreviewPage(svg))
    if (mermaidPreviewWin && !mermaidPreviewWin.isDestroyed()) {
      // On rapid consecutive previews the previous navigation is superseded by the next one and
      // rejects with ERR_ABORTED — swallow it to avoid an unhandled rejection in the main process
      mermaidPreviewWin.loadURL(dataUrl).catch((err) => {
        logger.warn('[Mermaid] Failed to load preview:', (err as Error)?.message)
      })
      mermaidPreviewWin.focus()
      return
    }
    // Standalone preview window: custom frameless title bar matching the app, resizable and
    // maximizable, without covering the full screen
    const { workAreaSize } = screen.getPrimaryDisplay()
    mermaidPreviewWin = new BrowserWindow({
      width: Math.round(Math.min(1200, workAreaSize.width * 0.7)),
      height: Math.round(Math.min(800, workAreaSize.height * 0.75)),
      minWidth: 480,
      minHeight: 360,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      title: mainMessages().window.mermaidPreview.title,
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: false
      }
    })
    mermaidPreviewWin.on('closed', () => {
      mermaidPreviewWin = null
    })
    mermaidPreviewWin.on('ready-to-show', () => {
      mermaidPreviewWin?.show()
    })
    mermaidPreviewWin.loadURL(dataUrl).catch((err) => {
      logger.warn('[Mermaid] Failed to load preview:', (err as Error)?.message)
    })
  })
}
