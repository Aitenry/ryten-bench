/**
 * 设计稿渲染工装：用 Electron 离屏窗口把本地 HTML 截成 PNG（本地工装，不入库）。
 * 用法：electron scripts/design-shot.cjs <htmlPath> <outPng> [width] [height]
 */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const args = process.argv.slice(2)
const htmlPath = args[0] ? path.resolve(args[0]) : ''
const outPath = args[1] ? path.resolve(args[1]) : ''
const width = Number(args[2] || 1184)
const height = Number(args[3] || 761)

if (!htmlPath || !outPath) {
  console.error('usage: electron scripts/design-shot.cjs <html> <out.png> [width] [height]')
  app.exit(2)
}

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    frame: false,
    backgroundColor: '#ffffff',
    webPreferences: { offscreen: false }
  })
  try {
    await win.loadFile(htmlPath)
    // 等字体/布局稳定
    await new Promise((resolve) => setTimeout(resolve, 700))
    const image = await win.webContents.capturePage()
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, image.toPNG())
    console.log('saved', outPath, width, height)
  } catch (err) {
    console.error('design shot failed:', err)
    app.exitCode = 1
  } finally {
    app.quit()
  }
})
