import { app, BrowserWindow, ipcMain, nativeTheme, screen, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import icon from '../../../resources/logo.png?asset'
import logger from 'electron-log'
import { safeSend } from '../safe-send'
import { getMainWindow, markMainWindowReady, setMainWindow } from './window-manager'
import { isCloseToTrayEnabled, isTrayAvailable, syncTrayState } from '../tray'
import { isQuittingNow, markQuitting } from '../lifecycle'
import { listContributions } from '../plugins/contributions'
import { APP_RENDERER_MEMORY_DUMP, type AppHook } from '../plugins/app-hooks'
import { dumpHarnessMemory } from '../system/harness'
import { syncWindowBorderColor } from './dwm-border'

/** 各窗口的最大化状态（主窗口与 mermaid 预览窗口共用；随窗口销毁清理） */
const windowMaxStates = new Map<
  number,
  { isMaximized: boolean; normalBounds: Electron.Rectangle | null }
>()

/**
 * 窗口控制 IPC 绑定窗口的**唯一性守卫**。
 *
 * 为什么需要（2026-09-26 用户实测 `MaxListenersExceededWarning: 11 closed listeners
 * added to [BrowserWindow]`）：此前 `winFromEvent` **每处理一次窗口控制 IPC** 就往
 * 该窗口挂一个 `once('closed', …)` 清理器（最小化/最大化/关闭/查询是否最大化各挂一次，
 * 且渲染层窗口按钮会频繁调用）——同一个窗口上堆到 11 个就触发 Node 的监听器上限告警。
 * 现在按「一个窗口只注册一次清理」记账：WeakSet 不阻止窗口回收，窗口关闭后由
 * `closed` 事件自己把状态与守卫一起清掉。
 */
const windowCleanupWatched = new WeakSet<Electron.BrowserWindow>()

/** 登记某窗口的关闭清理（幂等：同一个窗口无论被调用多少次都只挂一个监听） */
function watchWindowCleanup(win: Electron.BrowserWindow): void {
  if (windowCleanupWatched.has(win)) return
  windowCleanupWatched.add(win)
  const id = win.id
  win.once('closed', () => {
    windowCleanupWatched.delete(win)
    windowMaxStates.delete(id)
  })
}

let windowControlIpcRegistered = false

/** 渲染进程异常退出时的内存快照：系统功能（AI 助手）直接调用 + 第三方插件贡献的钩子 */
function runRendererMemoryDumpHooks(reason: string, exitCode: number): void {
  try {
    // 快照是诊断旁路：不阻塞崩溃恢复流程
    dumpHarnessMemory(reason, exitCode)
  } catch (err) {
    logger.warn('[Memory] AI 助手内存快照失败:', err)
  }
  for (const hook of listContributions<AppHook>(APP_RENDERER_MEMORY_DUMP)) {
    try {
      // 快照是诊断旁路：不阻塞崩溃恢复流程，异步失败也只记日志
      void Promise.resolve(hook.run(reason, exitCode)).catch((err) => {
        logger.warn(`[Memory] 内存快照钩子执行失败（${hook.label}）:`, err)
      })
    } catch (err) {
      logger.warn(`[Memory] 内存快照钩子执行失败（${hook.label}）:`, err)
    }
  }
}

/** 渲染端警告去重窗口（KaTeX 等库会为同一条消息连发数百次） */
const CONSOLE_WARN_DEDUPE_WINDOW_MS = 10_000
const CONSOLE_WARN_REPEAT_SUMMARY_AT = 100
const consoleWarnSeen = new Map<string, { count: number; lastAt: number }>()

/**
 * 窗口控制 IPC（作用于发送方窗口）：全局只注册一次。
 * 修复：此前注册在 createMainWindow 内——macOS 关闭全部窗口后 activate 重开主窗口会
 * 触发 ipcMain.handle 重复注册抛错（Attempted to register a second handler），
 * ipcMain.on 也会双绑（一次点击触发两次处理）。
 */
function registerWindowControlIpcOnce(): void {
  if (windowControlIpcRegistered) return
  windowControlIpcRegistered = true

  const winFromEvent = (
    event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent
  ): BrowserWindow | null => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && !win.isDestroyed()) watchWindowCleanup(win)
    return win
  }

  ipcMain.on('window-minimize', (event) => {
    winFromEvent(event)?.minimize()
  })
  ipcMain.on('window-maximize', (event) => {
    const win = winFromEvent(event)
    if (!win || win.isDestroyed()) return
    let st = windowMaxStates.get(win.id)
    if (!st) {
      st = { isMaximized: false, normalBounds: null }
      windowMaxStates.set(win.id, st)
    }
    if (st.isMaximized) {
      // 还原到之前的尺寸和位置
      if (st.normalBounds) win.setBounds(st.normalBounds)
      st.isMaximized = false
    } else {
      // 保存当前尺寸，然后最大化到可用工作区
      st.normalBounds = win.getBounds()
      const { workArea } = screen.getPrimaryDisplay()
      win.setBounds({
        x: workArea.x,
        y: workArea.y,
        width: workArea.width,
        height: workArea.height
      })
      st.isMaximized = true
    }
    safeSend(win.webContents, 'window-maximized', st.isMaximized)
  })
  ipcMain.on('window-close', (event) => {
    winFromEvent(event)?.close()
  })
  ipcMain.handle('window-is-maximized', (event) => {
    const win = winFromEvent(event)
    return win ? (windowMaxStates.get(win.id)?.isMaximized ?? false) : false
  })

  /**
   * 窗口标题（原生标题栏）：渲染层按当前内容更新成 `xxx - RytenBench`。
   * 只接受纯文本并截断，避免把超长/带换行的内容塞进标题栏。
   */
  ipcMain.on('window-set-title', (event, title: unknown) => {
    const win = winFromEvent(event)
    if (!win || win.isDestroyed() || typeof title !== 'string') return
    const clean = title
      .replace(/[\r\n\t]+/g, ' ')
      .trim()
      .slice(0, 160)
    win.setTitle(clean || 'RytenBench')
  })

  /**
   * 自绘标题栏（Window Controls Overlay，Windows / Linux）的主题同步：
   * 渲染层把测得的侧栏底色与前景色送上来，主进程更新系统绘制的窗口按钮配色。
   * 窗口按钮本身仍是**系统绘制**的（不是渲染层画出来的假按钮），只是配色/底条跟着主题走。
   */
  ipcMain.on('window-titlebar-overlay', (event, payload: unknown) => {
    const win = winFromEvent(event)
    if (!win || win.isDestroyed()) return
    const data = (payload ?? {}) as { color?: unknown; symbolColor?: unknown; height?: unknown }
    const color = typeof data.color === 'string' ? data.color : undefined
    const symbolColor = typeof data.symbolColor === 'string' ? data.symbolColor : undefined
    const height = typeof data.height === 'number' ? data.height : undefined
    const overlay = {
      ...(color ? { color } : {}),
      ...(symbolColor ? { symbolColor } : {}),
      ...(height ? { height } : {})
    }
    const apply = (): void => {
      if (win.isDestroyed()) return
      try {
        win.setTitleBarOverlay(overlay)
      } catch (err) {
        // 平台不支持 WCO（macOS / 老 Electron）时静默降级；标题栏仍能正常显示
        logger.debug('[Window] setTitleBarOverlay 不可用:', err)
      }
      // 系统窗口边框（DWM 画的那 1~2px）颜色跟随标题栏底色，避免亮色主题下顶部残留深色边
      if (color) syncWindowBorderColor(win, color)
    }
    apply()
    // Windows 的 WCO 覆盖层在切主题时偶尔不会立刻重绘（最大化窗口里尤其明显）；
    // 下一帧与稍后再补两次，确保系统按钮条和渲染层自绘标题条的底色同步。
    setTimeout(apply, 80)
    setTimeout(apply, 260)
  })

  /**
   * 让**系统绘制的窗口边框/标题栏明暗**跟随应用主题。
   *
   * 用户 2026-11-19 反馈「顶部会出现这种情况」：应用切到亮色后，窗口最上沿仍有一条深灰边
   * ——那是 Windows 按「系统深色模式」画的 DWM 窗口边框，不跟随应用内主题。
   * 通过 nativeTheme.themeSource 把系统侧明暗声明成与应用一致，DWM 边框/阴影就会跟着变。
   */
  ipcMain.on('window-native-theme', (_event, mode: unknown) => {
    if (mode === 'light' || mode === 'dark' || mode === 'system') {
      nativeTheme.themeSource = mode
    }
  })

  // 应用菜单命令（自绘标题栏的「应用 / 编辑」下拉）：只做窗口内动作，不暴露任意 IPC
  ipcMain.on('window-reload', (event) => {
    winFromEvent(event)?.webContents.reload()
  })
  ipcMain.on('app-quit', () => {
    markQuitting()
    app.quit()
  })
  ipcMain.on('window-edit-command', (event, command: unknown) => {
    const wc = event.sender
    if (!wc || wc.isDestroyed()) return
    switch (command) {
      case 'undo':
        wc.undo()
        break
      case 'redo':
        wc.redo()
        break
      case 'cut':
        wc.cut()
        break
      case 'copy':
        wc.copy()
        break
      case 'paste':
        wc.paste()
        break
      case 'selectAll':
        wc.selectAll()
        break
      default:
        break
    }
  })
}

export function createMainWindow(): void {
  const isWindows = process.platform === 'win32'
  const isMac = process.platform === 'darwin'
  /** 标题栏底色（窗口首帧兜底色；macOS 的 hiddenInset 也用它） */
  const TITLEBAR_BG = '#1b1b1d'
  /** 窗口标题（原生标题栏左侧显示的名称；渲染层会按当前内容更新成 `xxx - RytenBench`） */
  const APP_TITLE = 'RytenBench'

  const win = new BrowserWindow({
    width: 1200,
    height: 800, // 打开应用时即为最小尺寸（与 min 一致），可后续手动拉大
    minWidth: 1200,
    minHeight: 800,
    show: false,
    /**
     * 标题栏形态（用户 2026-11-20 口径）：
     *
     * 「把顶部的那个区域的内容移除掉换成原生的内容」——放弃自绘标题栏 + WCO
     * （应用/编辑 菜单那套颜色同步问题反复调不好），Windows 改用**系统原生标题栏**：
     * 拖动、最小化/最大化/关闭全部由系统绘制；左侧保留项目自己的图标 + 名称
     * （用户 2026-11-20 追加「增加名称」）。
     * 明暗仍跟随应用主题（nativeTheme.themeSource 由渲染层同步）。
     * macOS 保持 hiddenInset + 交通灯位置；Linux 本来就是原生边框。
     */
    ...(isWindows
      ? {
          frame: true,
          title: APP_TITLE,
          backgroundColor: TITLEBAR_BG
        }
      : isMac
        ? {
            titleBarStyle: 'hiddenInset' as const,
            trafficLightPosition: { x: 16, y: 17 },
            backgroundColor: TITLEBAR_BG
          }
        : {
            frame: true,
            backgroundColor: TITLEBAR_BG
          }),
    autoHideMenuBar: true,
    ...{ icon },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })
  setMainWindow(win)

  if (isWindows) {
    // 原生标题栏：去掉菜单栏；标题固定为应用名（页面 document.title 的回写不覆盖它）。
    // 图标保留：Windows 原生标题栏的图标位去不掉（置空会回退成 Electron 默认图标），
    // 所以用项目自己的 logo（吉祥物，见 resources/logo.png，由 BrowserWindow 的 icon 指定）。
    win.setMenu(null)
    win.on('page-title-updated', (event) => {
      event.preventDefault()
      win.setTitle(APP_TITLE)
    })
  }

  // 渲染就绪后**立即**显示主窗口：启动页（StartupSplash）盖在渲染层最上面，
  // 等初始化任务与首屏数据完成后再淡出进入主界面（不再由主进程控制「交接」时机）
  win.on('ready-to-show', () => {
    logger.info('[Window] Main window ready-to-show')
    markMainWindowReady()
  })

  win.on('closed', () => {
    if (getMainWindow() === win) setMainWindow(null)
  })

  // 关闭拦截：开启「关闭到系统托盘」时，关闭窗口改为隐藏到托盘（真正退出时放行）
  win.on('close', (event) => {
    if (isCloseToTrayEnabled() && isTrayAvailable() && !isQuittingNow()) {
      event.preventDefault()
      win.hide()
    }
  })

  // 窗口显隐时同步托盘状态（右键菜单文案实时反映）
  win.on('show', () => syncTrayState())
  win.on('hide', () => syncTrayState())

  // 系统关机/注销（Windows）：窗口事件（Electron 43 中 session-end 为窗口事件而非 app 事件）。
  // 托盘驻留时窗口不会关闭，若不放行，Windows 只能强杀进程，可能丢失未落盘数据。
  win.on('session-end', () => {
    markQuitting()
    app.quit()
  })

  // 渲染进程退出诊断：记录原因（崩溃/OOM/被杀/正常退出），便于排查「运行运行突然白屏」
  // 等异常；主进程本身不会因渲染进程退出而崩溃。
  // 修复：崩溃/OOM 后主窗口只剩死帧（应用「跑着跑着用不了/卡住」）——IPC 已全局注册一次，
  // 直接销毁并重建主窗口恢复可用（新 webContents 不在 safeSend 死名单中）。
  win.webContents.on('render-process-gone', (_event, details) => {
    const abnormal = details.reason !== 'clean-exit' && details.reason !== 'killed'
    const msg = `[Window] 渲染进程退出 reason=${details.reason} exitCode=${details.exitCode}`
    if (abnormal) logger.error(msg)
    else logger.info(msg)
    // 崩溃/OOM 时补一份内存快照（渲染进程已消失，只能靠流式期间的采样缓存）：
    // 没有这个数字时，日志里只剩 reason=oom，无法判断水位是哪一段流量推上去的。
    if (abnormal) runRendererMemoryDumpHooks(details.reason, details.exitCode)
    if (
      details.reason === 'crashed' ||
      details.reason === 'oom' ||
      details.reason === 'launch-failed' ||
      details.reason === 'integrity-failure'
    ) {
      logger.warn('[Window] 渲染进程异常退出，300ms 后重建主窗口恢复可用...')
      setTimeout(() => {
        // 应用正在退出时不再自愈（退出清理会关闭数据库，重建的窗口加载必失败）
        if (isQuittingNow()) return
        if (getMainWindow() === win && !win.isDestroyed()) {
          // 先建新窗口、再销毁已崩溃的旧窗口。
          // 修复：此前先 win.destroy() 再 createMainWindow()——销毁最后一个窗口会触发
          // window-all-closed → app.quit()（Windows），随后才创建的新窗口其 loadURL
          // 会被退出清理掐断报 ERR_FAILED(-2)，一次渲染进程 OOM/崩溃就会带崩整个应用；
          // 先建后毁使窗口数 1→2→1 永不归零，退出流程不会在自愈期间触发。
          try {
            createMainWindow()
          } catch (err) {
            logger.error('[Window] 自愈重建主窗口失败:', err)
          }
          if (getMainWindow() === win && !win.isDestroyed()) {
            // 重建失败（构造抛错）时销毁旧窗口走正常退出收尾，避免留下不可用的死窗口
            win.destroy()
          }
        } else if (!getMainWindow()) {
          createMainWindow()
        }
      }, 300)
    }
  })

  // 渲染进程 console 错误/警告转发到主进程日志（修复：渲染端异常此前无任何落盘线索,
  // 崩溃后只剩 exitCode 无法定位根因）。
  // 修复：KaTeX 等库会为同一条警告连发数百次（如中文入数学模式），警告按 10 秒窗口
  // 去重（第 100 次重复时留一条计数摘要），错误始终逐条转发。
  win.webContents.on('console-message', (event, details) => {
    /**
     * 取字段要兼容两种形态：老版把 level/message/lineNumber/sourceId 直接挂在 event 上，
     * 新版给第二个参数 MessageDetails（level 是数字、URL 叫 sourceUrl）。
     * 位置信息是关键：渲染进程的未捕获异常此前只落一句 "Uncaught TypeError: ..."，
     * 定位不到来源（2026-09-19 那条 startTime 报错就吃了这个亏）。
     */
    const info = (details ?? event) as {
      level?: string | number
      message?: string
      lineNumber?: number
      sourceId?: string
      sourceUrl?: string
    }
    const msg = info.message ?? ''
    const level = info.level
    const isError = level === 'error' || level === 3
    const isWarning = level === 'warning' || level === 2
    if (!isError && !isWarning) return
    const url = info.sourceUrl ?? info.sourceId
    const at = url ? ` @ ${url}:${info.lineNumber ?? 0}` : ''
    if (isError) {
      logger.error(`[Renderer:error] ${msg}${at}`)
      return
    }
    const key = msg
    const now = Date.now()
    const seen = consoleWarnSeen.get(key)
    if (seen && now - seen.lastAt < CONSOLE_WARN_DEDUPE_WINDOW_MS) {
      seen.count += 1
      if (seen.count === CONSOLE_WARN_REPEAT_SUMMARY_AT) {
        logger.warn(
          `[Renderer:warning] ${msg}（同条消息已重复 ${seen.count}+ 次，10 秒内不再转发）`
        )
      }
      return
    }
    consoleWarnSeen.set(key, { count: 1, lastAt: now })
    logger.warn(`[Renderer:warning] ${msg}${at}`)
  })

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url).then()
    return { action: 'deny' }
  })

  // 拦截主窗口导航：仅允许应用自身页面（开发 URL / 生产 file://）。
  // 聊天正文里的站外链接若不带 target="_blank"，点击会把窗口原地导航到远程页面；
  // 该窗口的 preload（sandbox:false）暴露了完整 window.api，远程页面可借此调用
  // 主进程 IPC——必须拦截并转交系统浏览器（hash 路由的页内导航不会触发本事件）。
  win.webContents.on('will-navigate', (event, url) => {
    const devOrigin = is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined
    const allowed = devOrigin ? url.startsWith(devOrigin) : url.startsWith('file://')
    if (!allowed) {
      event.preventDefault()
      shell.openExternal(url).catch((err) => logger.warn('[Window] 外部链接打开失败:', err))
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/resource/index.html`).catch((err) => {
      logger.error('[Window] 主窗口加载失败:', err)
    })
  } else {
    win.loadFile(join(__dirname, '../renderer/resource/index.html')).catch((err) => {
      logger.error('[Window] 主窗口加载失败:', err)
    })
  }
  logger.info('[Window] Main window created, renderer loading started')

  win.webContents.once('dom-ready', () => {
    logger.info('[Window] Main window dom-ready')
    safeSend(win.webContents, 'main-window-ready')
  })

  // 窗口控制 IPC 全局只注册一次（macOS activate 重开窗口时不得重复注册）
  registerWindowControlIpcOnce()
}
