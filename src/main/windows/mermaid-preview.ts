import { BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'path'
import * as fs from 'fs'
import logger from 'electron-log'
import mermaidPreviewHtmlPath from '../resource/mermaid-preview.html?asset'
import { mainMessages } from '../i18n'
import { buildMermaidPreviewHtml } from './mermaid-preview-html'

let mermaidPreviewWin: BrowserWindow | null = null
let cachedHtml: string | null = null

/** 从 HTML 资源文件构建预览页（注入 SVG / nonce / 当前语言文案，逻辑见 mermaid-preview-html.ts） */
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
      // 快速连续预览时上一次导航会被下一次取代并以 ERR_ABORTED 拒绝——吞掉
      // 避免主进程 unhandled rejection（修复）
      mermaidPreviewWin.loadURL(dataUrl).catch((err) => {
        logger.warn('[Mermaid] Failed to load preview:', (err as Error)?.message)
      })
      mermaidPreviewWin.focus()
      return
    }
    // 独立预览窗口：与应用同款自定义无边框标题栏，可拉伸、可最大化，不占满全屏
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
