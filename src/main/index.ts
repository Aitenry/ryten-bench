// ⚠️ 必须是第一条 import：environment 在**模块求值阶段**就把「开发 / 打包」两套 userData
// 定下来（开发 = <appData>/ryten-bench-dev，打包 = <appData>/ryten-bench）。
// 下面的 ./plugins/host 会经由 ./context（electron-store）和数据库模块在求值时读
// app.getPath('userData')；晚一步，设置/数据库/插件/账号/日志就会写进另一套环境。
import { currentEnvironment, currentUserDataDir } from './environment'
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
import { bootstrapStorageLayout } from './storage'
import { initAccountProfile } from './profiles/runtime'

// 单实例锁：防止多开，同时确保安装程序能正确检测和关闭进程。
// 锁的键就是 userData：开发态（ryten-bench-dev）与打包态（ryten-bench）互不影响，
// 各自都能开一个实例；同一套数据目录里的两个进程必须只有一个。
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  // 必须 app.exit 立即结束：app.quit() 只是排队退出，本模块后面的 whenReady 链仍会跑一遍
  // ——PGlite 没有跨进程锁，两个进程同时打开同一个数据目录会写出坏库。
  // （2026-11-24 实测：旧版安装包还开着时启动新包，第二实例会短暂初始化并打开同一个库。）
  app.exit(0)
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
  logger.warn('[Main] Failed to start crashReporter:', err)
}

// 退出前保存流式数据 / 全窗口关闭退出
registerLifecycleHooks()

// plugin:// 自定义协议（外部插件文件服务）：scheme 特权声明必须在 app ready 之前
registerPluginScheme()

/**
 * 开发态的 DevTools 快捷键：Ctrl+Shift+I / ⌘+⌥+I 开关。
 *
 * 为什么需要单独接一条：`@electron-toolkit/utils` 的 `watchWindowShortcuts` 在未打包时
 * **只处理 F12**（而且开发态下它不会拦截 Ctrl+Shift+I）；而 Windows 上主窗口用原生标题栏，
 * `win.setMenu(null)` 把默认菜单一起删了——菜单里的 “Toggle Developer Tools” 也就没了。
 * 结果就是：F12 之外没有任何入口，习惯 Ctrl+Shift+I 的人会觉得“打不开开发者工具”。
 *
 * 这里只补 Ctrl+Shift+I（F12 仍由上面的 helper 处理，避免同一事件被切换两次）。
 * 打包产物不接这条快捷键：DevTools 在发布版里按设计不可用。
 */
function installDevToolsAccelerator(win: BrowserWindow): void {
  if (app.isPackaged) return
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const key = input.key.toLowerCase()
    const toggle =
      (input.control && input.shift && key === 'i') || (input.meta && input.alt && key === 'i')
    if (!toggle) return
    event.preventDefault()
    const contents = win.webContents
    if (contents.isDevToolsOpened()) contents.closeDevTools()
    else contents.openDevTools({ mode: 'undocked' })
  })
}

app
  .whenReady()
  .then(async () => {
    // 环境名与 userData 落点先打一条日志：出问题时「哪套数据被读写」一眼可查。
    const environment = currentEnvironment()
    logger.info(
      `[Environment] ${environment.name} | appName=${environment.appName} | ` +
        `userData=${currentUserDataDir()}`
    )

    electronApp.setAppUserModelId('com.ryten.bench')

    // 账号级本地数据空间：必须在**任何**数据库/插件/同步数据被读写之前完成对调。
    // （未登录 = anonymous 容器；换账号后重启，由这里把上一账号的数据换进 profiles/）
    if (!initAccountProfile()) return

    // plugin:// 协议处理器（外部插件静态文件；需在 ready 后注册）
    registerPluginProtocolHandler()

    // 默认存储布局：<安装目录>/data/{memory,plugins,skills}（不可写时退回 userData/data）。
    // 必须早于 initPluginHost()：插件工坊在装载期就会读 harness.pluginsPath 注入运行时。
    bootstrapStorageLayout()

    // 文件改动快照目录（userData/file-history）、工具结果详情目录（userData/tool-output）
    // 与工作区文件监听随「AI 助手」一起装配（`src/main/system/harness.ts`），
    // 由 `initPluginHost()` 里的 `startSystemModules()` 在窗口创建前启动。

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
      // 开发态补 Ctrl+Shift+I（F12 由上面的 helper 处理；Windows 删了菜单后没有别的入口）
      installDevToolsAccelerator(window)
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
    logger.error('[Main] Failed to initialize main flow:', err)
  })
