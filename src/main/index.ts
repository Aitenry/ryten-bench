import { app, BrowserWindow, ipcMain, crashReporter } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import logger from 'electron-log'
import { initPluginHost, pushPluginChannels } from './plugins/host'
import { registerPluginScheme, registerPluginProtocolHandler } from './plugins/protocol'
import { registerLifecycleHooks } from './lifecycle'
import { registerStartupIpc, runStartupInitialization } from './windows/startup'
import { createMainWindow } from './windows/main-window'
import { registerMermaidPreviewIpc } from './windows/mermaid-preview'
import { createTray } from './tray'
import { setupWeather } from './weather'

// 单实例锁：防止多开，同时确保安装程序能正确检测和关闭进程
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // 再次启动时恢复主窗口（包括隐藏在系统托盘中的情况）
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    if (win) {
      if (win.isMinimized()) win.restore()
      if (!win.isVisible()) win.show()
      win.focus()
    }
  })
}

logger.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}'
logger.transports.file.fileName = 'main.log'

// 崩溃转储本地收集（修复：渲染进程崩溃后只有 exitCode、无 dump 可查根因）。
// 仅落盘不上传：dumps 保存于 userData/Crashpad/reports
try {
  crashReporter.start({ uploadToServer: false })
} catch (err) {
  logger.warn('[Main] crashReporter 启动失败:', err)
}

// 退出前保存流式数据 / 全窗口关闭退出
registerLifecycleHooks()

// plugin:// 自定义协议（外部插件文件服务）：scheme 特权声明必须在 app ready 之前
registerPluginScheme()

app
  .whenReady()
  .then(async () => {
    electronApp.setAppUserModelId('com.ryten.bench')

    // plugin:// 协议处理器（外部插件静态文件；需在 ready 后注册）
    registerPluginProtocolHandler()

    // 注意：文件改动快照目录（userData/file-history）、工具结果详情目录（userData/tool-output）
    // 与工作区文件监听原先都在这里启动，现随「AI 助手」插件搬进
    // `src/plugins/harness/main/index.ts` 的 install(ctx)：停用该插件就不再配置这些目录、
    // 也不再监听工作区（core 启动流程不再 import 任何插件模块）。

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
      // 插件通道白名单：启动期推送早于窗口创建（必然丢包），窗口加载完成后补推一次
      window.webContents.on('did-finish-load', () => pushPluginChannels())
    })

    // 注册 IPC：core（window/setting/dialog/provider/plugins）常驻 + 按启用态装载插件宿主
    // （插件全部来自 `userData/plugins/<id>/` 的磁盘包；启停由 plugins-set-enabled 驱动）
    initPluginHost()
    // 应用版本（加载页展示）
    ipcMain.handle('app-version', () => app.getVersion())
    // Mermaid 预览窗口（HTML 模板存于资源文件 ./resource/mermaid-preview.html）
    registerMermaidPreviewIpc()

    // 启动页（用户 2026-11-20 口径）：不再有独立加载窗口。
    // 先建主窗口并立刻显示（渲染层里盖着 StartupSplash 启动页），
    // 初始化任务同时在后台跑，进度通过 IPC 推给启动页；全部完成后再进入主界面。
    registerStartupIpc()
    createMainWindow()
    void runStartupInitialization()

    // 天气 IPC 与自动刷新只注册/启动一次（主窗口推送；修复：此前随 createMainWindow
    // 重复调用会二次注册 ipcMain.handle 抛错）
    setupWeather()

    // 系统托盘：关闭窗口可驻留后台（是否驻留由「通用设置 → 系统托盘」控制）
    createTray()

    // macOS activate：窗口全部关闭后只重建主窗口（初始化只需执行一次；此前重跑
    // createMainWindow 会二次建库、重复注册 IPC 导致崩溃）
    app.on('activate', function () {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow()
      }
    })
  })
  .catch((err) => {
    logger.error('[Main] 主流程初始化失败:', err)
  })
