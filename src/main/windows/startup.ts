import { app, dialog, ipcMain } from 'electron'
import { rename } from 'fs/promises'
import logger from 'electron-log'
import { createDatabase, getDatabaseDir, type Database } from '../database/loading'
import { runMigrations } from '../database/orm'
import { migrateWorkspaceData } from '../database/workspace-migration'
import { setDatabaseInstance, setInitializationPromise } from '../database/instance'
import { initKeystore } from '../crypto/provider-key'
import { settingsStore } from '../context'
import { safeSend } from '../safe-send'
import { mainMessages } from '../i18n'
import { GraphSettings, HarnessSettings, TraySettings } from '../types/settings'
import { getIp } from '../address'
import { startWeatherAutoRefresh } from '../weather'
import { listContributions } from '../plugins/contributions'
import { APP_PRELOAD, type AppHook } from '../plugins/app-hooks'
import { preloadHarness } from '../system/harness'
import { getMainWindow, markInitComplete } from './window-manager'

/** 初始化进度快照：后挂载的启动页（主窗口渲染层）通过 `init-state` 先取一次当前状态 */
export interface InitSnapshot {
  complete: boolean
  error: string | null
  currentTask: string
  progress: number
  taskIndex: number
  totalTasks: number
}

const initSnapshot: InitSnapshot = {
  complete: false,
  error: null,
  currentTask: '',
  progress: 0,
  taskIndex: 0,
  totalTasks: 5
}

function sendToMainWindow(channel: string, payload?: unknown): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  safeSend(win.webContents, channel, payload)
}

/** 初始化进度：更新快照并推给主窗口渲染层（启动页） */
function sendInitProgress(
  currentTask: string,
  progress: number,
  taskIndex: number,
  totalTasks: number
): void {
  initSnapshot.currentTask = currentTask
  initSnapshot.progress = Math.round(progress)
  initSnapshot.taskIndex = taskIndex
  initSnapshot.totalTasks = totalTasks
  sendToMainWindow('init-progress', {
    currentTask,
    progress: Math.round(progress),
    taskIndex,
    totalTasks
  })
}

export function getInitSnapshot(): InitSnapshot {
  return { ...initSnapshot }
}

/** 启动页拉取当前进度（处理「初始化在渲染层订阅前就已推进」的情况） */
export function registerStartupIpc(): void {
  ipcMain.handle('init-state', () => getInitSnapshot())
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
 * 执行「加载页预取」：系统功能（AI 助手）的预取 + 第三方插件贡献的钩子（`app.preload`）。
 *
 * 逐个 try/catch：预取失败只记日志——预取是加速用的旁路，
 * 不该把一个还能用的启动流程拦在加载页上。
 */
async function runPreloadHooks(): Promise<void> {
  try {
    await preloadHarness()
  } catch (err) {
    logger.warn('[Init] AI 助手预取失败:', err)
  }
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
        const result = await migrateWorkspaceData(
          database!.getDatabase(),
          () => {
            const harness = settingsStore.get('harness') as HarnessSettings | undefined
            return harness?.activeWorkspaceId
          },
          // 插件存放路径：分类历史上的插件工作区（kind='plugin'）用，没配就跳过那一步
          (settingsStore.get('harness') as HarnessSettings | undefined)?.pluginsPath
        )
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
      // 用户选择退出：通知启动页显示错误，然后直接退出
      if (outcome === 'declined') {
        initSnapshot.error = describeErrorChain(err)
        sendToMainWindow('init-error', initSnapshot.error)
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
 * 运行启动初始化（数据库 / 配置 / 密钥库 / 工作区迁移 / 插件预取）。
 *
 * 用户 2026-11-20 口径：**不再创建独立的加载窗口**——主窗口先创建并立即显示，
 * 启动页放在主窗口渲染层里（StartupSplash），所有数据加载完成后再进入主界面。
 * 因此这里只跑初始化任务，进度通过 `init-progress` 事件 + `init-state` 快照暴露给渲染层。
 */
export function runStartupInitialization(): Promise<void> {
  const initPromise = performInitializationTasks()
    .then(async () => {
      logger.info('All initialization tasks completed.')
      // 预取数据（启动页阶段完成）：AI 助手的预取直接调用，第三方插件的预取由它们
      // 贡献的 `app.preload` 钩子提供——停用插件即不再预取。
      await runPreloadHooks()
      initSnapshot.complete = true
      initSnapshot.progress = 100
      initSnapshot.error = null
      sendToMainWindow('init-complete')
      markInitComplete()
    })
    .catch((err) => {
      logger.error('Initialization failed:', err)
      initSnapshot.error = describeErrorChain(err)
      sendToMainWindow('init-error', initSnapshot.error)
    })
  setInitializationPromise(initPromise)
  return initPromise
}
