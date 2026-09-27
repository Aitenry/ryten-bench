import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'path'
import { rename } from 'fs/promises'
import { is } from '@electron-toolkit/utils'
import icon from '../../../resources/logo.png?asset'
import logger from 'electron-log'
import { createDatabase, getDatabaseDir, type Database } from '../database/loading'
import { runMigrations } from '../database/orm'
import { migrateWorkspaceData } from '../database/workspace-migration'
import { setDatabaseInstance, setInitializationPromise } from '../database/instance'
import { initKeystore } from '../crypto/provider-key'
import { settingsStore } from '../context'
import { safeSend } from '../safe-send'
import { getMainLanguage, mainMessages } from '../i18n'
import { GraphSettings, HarnessSettings, TraySettings } from '../types/settings'
import { getIp } from '../address'
import { startWeatherAutoRefresh } from '../weather'
import { listContributions } from '../plugins/contributions'
import { APP_PRELOAD, type AppHook } from '../plugins/app-hooks'
import {
  getLoadingWindow,
  isInitComplete,
  markInitComplete,
  setLoadingWindow
} from './window-manager'

/** 加载窗口初始化进度（步骤名 + 细粒度百分比，逐步推进） */
function sendInitProgress(
  currentTask: string,
  progress: number,
  taskIndex: number,
  totalTasks: number
): void {
  const loadingWindow = getLoadingWindow()
  if (!loadingWindow) return
  safeSend(loadingWindow.webContents, 'init-progress', {
    currentTask,
    progress: Math.round(progress),
    taskIndex,
    totalTasks
  })
}

/**
 * 旧版本把 AI 助手这段配置存在 `chat` 键下，模块改名后统一用 `harness`。
 * 一次性搬迁：新键已存在就只删旧键，绝不会出现两份配置并存后互相覆盖。
 *
 * 注意：下面这个 'chat' 是**历史键名**，不能跟着模块一起改名——
 * 改了就再也读不到老用户已经存好的技能目录 / 工作区路径 / 记忆目录。
 */
function migrateHarnessSettingsKey(): void {
  const legacy = settingsStore.get('chat') as HarnessSettings | undefined
  if (legacy === undefined) return
  if (settingsStore.get('harness') === undefined) {
    settingsStore.set('harness', legacy)
  }
  settingsStore.delete('chat')
  logger.info('[Init] Migrated legacy "chat" settings key to "harness"')
}

async function loadConfig(): Promise<void> {
  migrateHarnessSettingsKey()
  const ipConfig = settingsStore.get('ip')
  const lockPermission = settingsStore.get('lock')
  const graphConfig = settingsStore.get('graph')
  const harnessConfig = settingsStore.get('harness')
  const configPromises: Promise<void>[] = []

  if (!ipConfig) {
    // IP 数据非关键依赖，后台静默获取，不阻塞初始化
    getIp()
      .then((ip) => {
        if (ip) {
          settingsStore.set('ip', ip)
          // IP 就绪后补建天气自动刷新定时器（修复：主窗口创建时 ip 未到位，
          // startWeatherAutoRefresh 提前 return，定时器本会话永不启动）
          startWeatherAutoRefresh()
        }
      })
      .catch(() => {})
  }
  if (!lockPermission) {
    configPromises.push(
      Promise.resolve().then(() => {
        settingsStore.set('lock', { code: 'e10adc3949ba59abbe56e057f20f883e', view: false })
      })
    )
  }
  if (!graphConfig) {
    configPromises.push(
      Promise.resolve().then(() => {
        settingsStore.set('graph', {
          maxConcurrency: 8,
          enableGleaning: true,
          gleaningThreshold: 50,
          maxChunkSize: 2000
        } as GraphSettings)
      })
    )
  }
  if (!harnessConfig) {
    configPromises.push(
      Promise.resolve().then(() => {
        settingsStore.set('harness', {} as HarnessSettings)
      })
    )
  }
  if (!settingsStore.get('tray')) {
    configPromises.push(
      Promise.resolve().then(() => {
        settingsStore.set('tray', { closeToTray: true } as TraySettings)
      })
    )
  }

  try {
    await Promise.all(configPromises)
  } catch (error) {
    logger.error('Error loading config:', error)
  }
}

/**
 * 数据库启动失败的识别：PGlite 起不来时 drizzle 只会抛「Failed query: CREATE SCHEMA …」，
 * 真正的原因藏在 cause 链里（如 RuntimeError: Aborted()，Postgres 侧的
 * "could not locate a valid checkpoint record" 只写进 stdout）。这里把整条 cause 链打出来，
 * 否则日志里只剩一句无从下手的 SQL。
 */
function describeErrorChain(err: unknown): string {
  const parts: string[] = []
  let current: unknown = err
  for (let depth = 0; current instanceof Error && depth < 5; depth += 1) {
    parts.push(`${current.name}: ${current.message}`)
    current = (current as { cause?: unknown }).cause
  }
  return parts.length > 0 ? parts.join(' ← ') : String(err)
}

/** 数据库无法启动的典型特征（本地集群损坏 / 需要崩溃恢复但恢复不了） */
function looksLikeDatabaseStartupFailure(err: unknown): boolean {
  const text = describeErrorChain(err)
  return (
    /Failed query/i.test(text) ||
    /Aborted\(\)/i.test(text) ||
    /PGlite failed to initialize/i.test(text) ||
    /could not locate a valid checkpoint record/i.test(text) ||
    /incorrect checksum in control file/i.test(text)
  )
}

/**
 * 数据库损坏时的兜底：把损坏目录改名留档（不删），让应用用空库继续可用。
 *
 * 为什么需要它：PGlite 是嵌入式 Postgres，**没有 pg_resetwal 这类修复工具**，一旦
 * pg_control/WAL 里的检查点记录被写坏（非正常退出、或两个进程同时打开同一目录），
 * 集群就再也起不来，而在此之前应用只是一直卡在「初始化失败」的启动页上（主窗口不展示），
 * 用户既看不到原因也无法自救。
 *
 * 留档而不是删除：坏目录里的数据页通常完好，可用 `node scripts/recover-pglite.mjs`
 * 抢救出会话/文档等数据（该脚本正是 2026-09-18 那次事故里实际用过的恢复流程）。
 */
async function offerDatabaseReset(
  err: unknown
): Promise<'recovered' | 'declined' | 'not-applicable'> {
  const text = describeErrorChain(err)
  if (!looksLikeDatabaseStartupFailure(err)) return 'not-applicable'

  const m = mainMessages().dialog
  logger.error(`[Init] 数据库无法启动，可能是数据目录损坏：${text}`)
  const { response } = await dialog.showMessageBox({
    type: 'error',
    noLink: true,
    title: m.dbStartupFailedTitle,
    message: m.dbStartupFailedMessage,
    detail: m.dbStartupFailedDetail,
    buttons: [m.dbStartupFailedReset, m.dbStartupFailedQuit],
    defaultId: 0,
    cancelId: 1
  })
  if (response !== 0) return 'declined'

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = `${getDatabaseDir()}.corrupt-${stamp}`
  try {
    await rename(getDatabaseDir(), backupDir)
    logger.warn(`[Init] 损坏的数据库目录已留档：${backupDir}`)
  } catch (renameErr) {
    logger.error('[Init] 留档损坏目录失败（可能被其他进程占用）:', renameErr)
    return 'declined'
  }
  return 'recovered'
}

/**
 * 执行各插件贡献的「加载页预取」钩子（贡献点 `app.preload`）。
 *
 * 逐个 try/catch：某个插件预取失败只记日志——预取是加速用的旁路，
 * 不该把一个还能用的启动流程拦在加载页上。钩子随插件停用摘除，停用的插件不执行。
 */
async function runPreloadHooks(): Promise<void> {
  for (const hook of listContributions<AppHook>(APP_PRELOAD)) {
    try {
      await hook.run()
    } catch (err) {
      logger.warn(`[Init] 预取钩子执行失败（${hook.label}）:`, err)
    }
  }
}

async function performInitializationTasks(): Promise<void> {
  // 扁平化初始化步骤：配置 / 密钥库 / 连接数据库 / 执行数据库迁移 / 工作区迁移。
  // 进度条按步骤均匀推进，逐步增长，避免整任务一步跳到 25%。
  // 步骤名是启动页上可见的文案，随界面语言（这里取一次即可，启动期间语言不会变）。
  const m = mainMessages()
  let database: Database | null = null
  const steps: { name: string; execute: () => Promise<void> | void }[] = [
    { name: m.splash.stepLoadConfig, execute: async () => await loadConfig() },
    {
      name: m.splash.stepInitKeystore,
      execute: async () => {
        initKeystore()
      }
    },
    {
      name: m.splash.stepConnectDatabase,
      execute: async () => {
        database = await createDatabase()
      }
    },
    {
      name: m.splash.stepRunMigrations,
      execute: async () => {
        await runMigrations(database!.getDatabase())
      }
    },
    {
      name: m.splash.stepInitWorkspace,
      execute: async () => {
        const result = await migrateWorkspaceData(database!.getDatabase(), () => {
          const harness = settingsStore.get('harness') as HarnessSettings | undefined
          return harness?.activeWorkspaceId
        })
        // 把迁移确定的活动工作区写回设置（id 与路径一起同步）
        const harness = settingsStore.get('harness') as HarnessSettings | undefined
        const next: HarnessSettings = { ...(harness ?? ({} as HarnessSettings)) }
        if (result.activeWorkspaceId == null) {
          // 没有任何工作区：清掉残留配置，回到「未配置」，由对话页引导用户选择目录
          if (next.activeWorkspaceId != null || next.workspacePath) {
            delete next.activeWorkspaceId
            next.workspacePath = ''
            settingsStore.set('harness', next)
          }
        } else if (
          next.activeWorkspaceId !== result.activeWorkspaceId ||
          next.workspacePath !== result.activeWorkspacePath
        ) {
          next.activeWorkspaceId = result.activeWorkspaceId
          next.workspacePath = result.activeWorkspacePath ?? ''
          settingsStore.set('harness', next)
        }
        logger.info(
          `[Init] Workspace migration done, active workspace=${result.activeWorkspaceId ?? 'none'}`
        )
      }
    }
  ]

  const runSteps = async (): Promise<void> => {
    for (let i = 0; i < steps.length; i++) {
      // 步骤起始进度：已完成 i 步 / 总步数，每步只推进一小格
      sendInitProgress(steps[i].name, (i / steps.length) * 100, i + 1, steps.length)
      await steps[i].execute()
    }
  }

  try {
    await runSteps()
  } catch (err) {
    // 数据库起不来：先关掉失败的实例（Windows 上句柄未释放会导致目录改名失败），
    // 再给用户一条可执行的出路；其余错误照原样抛出（加载页会显示失败提示）
    logger.error(`[Init] 初始化失败（cause 链）：${describeErrorChain(err)}`)
    try {
      // 显式断言一次：database 只在 steps 回调里赋值，TS 的控制流分析会把它窄化成 null
      const failedDb = database as Database | null
      await Promise.race([
        failedDb ? failedDb.close() : Promise.resolve(),
        new Promise((resolve) => setTimeout(resolve, 2000))
      ])
    } catch (closeErr) {
      logger.warn('[Init] 关闭失败的数据库实例时出错:', closeErr)
    }
    const outcome = await offerDatabaseReset(err)
    if (outcome !== 'recovered') {
      // 用户选择退出：不留一个只能看不能用的启动页，通知加载页后直接退出
      if (outcome === 'declined') {
        const win = getLoadingWindow()
        if (win) safeSend(win.webContents, 'init-error', describeErrorChain(err))
        setTimeout(() => app.quit(), 300)
      }
      throw err
    }
    database = null
    await runSteps()
  }
  // 建表与工作区迁移全部完成后再开放数据库访问：
  // 主窗口预热期间渲染进程可能已发起查询，提前暴露会导致「relation ... does not exist」。
  setDatabaseInstance(database)

  // 全部步骤完成
  sendInitProgress(m.splash.stepCompleted, 100, steps.length, steps.length)
}

/**
 * 加载页「值不值得露脸」的等待窗口（毫秒）。
 *
 * 热启动时初始化通常几百毫秒就结束，主窗口紧接着就位——这段时间显示加载页只会得到
 * 「一个窗口闪一下」的观感（2026-09-27 用户报「每一次启动应用都会打开一个窗口，然后快速就关闭了，
 * 影响光感」）。等这么久还没结束才说明真的需要它（冷启动、首次建库、迁移）。
 */
const SPLASH_DELAY_MS = 600

export async function createLoadingWindow(): Promise<void> {
  const loadingWindow = new BrowserWindow({
    width: 360,
    height: 230,
    frame: false,
    transparent: true,
    resizable: false,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    /**
     * 先不显示，等页面**真的能画出来**（ready-to-show）再显示。
     *
     * 为什么（2026-09-27 用户报「每一次启动应用都会打开一个窗口，然后快速就关闭了，影响光感」）：
     * 这个窗口是 `transparent + frame:false`，创建即显示时屏幕上先出现的是一块**还没绘制的**
     * 空白/黑窗口，等 HTML 画好才变成正常加载页——热启动（初始化几百毫秒就结束）时，
     * 用户看到的就是「一块黑窗口闪一下」。默认 `show: true` 正是这个闪现的来源。
     */
    show: false,
    ...{ icon },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // 防止 occluded/后台时渲染进程定时器被节流（loading 页的 notifyInitComplete 回发会因此延迟数秒，
      // 导致「初始化完成 → 主窗口交接」被拖慢）
      backgroundThrottling: false
    }
  })
  setLoadingWindow(loadingWindow)

  loadingWindow.setMenu(null)

  // 能画出来了才显示；如果这时初始化已经结束（热启动），就干脆不显示——
  // 否则会「刚露脸就被 close 掉」，还是一次闪烁。
  loadingWindow.once('ready-to-show', () => {
    setTimeout(() => {
      if (loadingWindow.isDestroyed() || isInitComplete()) return
      loadingWindow.show()
    }, SPLASH_DELAY_MS)
  })

  // 启动页自身的静态文案在渲染侧按 ?lang= 选择，避免首帧显示错语言
  const lang = getMainLanguage()
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    await loadingWindow.loadURL(
      `${process.env['ELECTRON_RENDERER_URL']}/resource/loading.html?lang=${lang}`
    )
  } else {
    await loadingWindow.loadFile(join(__dirname, '../renderer/resource/loading.html'), {
      query: { lang }
    })
  }
  logger.info('[Window] Loading window ready')

  // 加载页回发的交接信号（兜底）：正常路径由下方 performInitializationTasks 的 .then 直接驱动
  ipcMain.once('init-complete', () => {
    logger.info('[Window] Init complete signal received (fallback)')
    markInitComplete()
  })

  const initPromise = performInitializationTasks()
    .then(async () => {
      logger.info('All initialization tasks completed.')
      // 预取插件数据（加载页阶段完成，不阻塞交接）：core 只负责时机，
      // 具体预取什么由插件的 `app.preload` 贡献决定——停用插件即不再预取，
      // core 不认识任何插件模块（见 src/main/plugins/app-hooks.ts）
      await runPreloadHooks()
      // 通知加载页显示完成状态（纯 UI 提示；不依赖其回发驱动交接——
      // 加载页定时器可能被后台节流延迟数秒，交接由主进程直接控制）
      const win = getLoadingWindow()
      if (win) {
        safeSend(win.webContents, 'init-complete')
      }
      markInitComplete()
    })
    .catch((err) => {
      logger.error('Initialization failed:', err)
      const win = getLoadingWindow()
      if (win) {
        safeSend(win.webContents, 'init-error', err.message)
      }
    })
  setInitializationPromise(initPromise)

  // 注意：此处不再等待初始化完成——调用方紧接着会预热主窗口（隐藏），
  // 让渲染进程加载与数据库初始化并行，消除「加载窗口结束后再等主窗口」的空白期
}
