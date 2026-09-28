import { Database } from './loading'

// 数据库单例（保持模块级变量）
let database: Database | null = null
// 用于追踪初始化过程
let initializationPromise: Promise<void> | null = null

/**
 * 「初始化已经**开始**」的信号。
 *
 * 为什么需要它：初始化要到 `createLoadingWindow()` 才起步（那时才 `setInitializationPromise`），
 * 而 `initPluginHost()` 跑在它**之前**——外部插件的主模块就是在那时被 require 的，插件在装载期
 * 建表（工坊生成的 `main/db/ddl.ts` 就是这么干的）会撞上「既没有实例、也没有进行中的初始化」，
 * 于是拿到 `Database has not been initialized yet.`，之后每个通道都拿这条**缓存的**失败
 * （用户的 personal-ledger 实测：启动时一片红，直到重启才对）。
 *
 * 有了这个信号，`getDatabaseInstance()` 在「还没开始」时**等它开始**，而不是立刻抛错。
 */
let markInitStarted: () => void = () => {}
const initStarted = new Promise<void>((resolve) => {
  markInitStarted = resolve
})
let initStartedFlag = false
function noteInitStarted(): void {
  if (initStartedFlag) return
  initStartedFlag = true
  markInitStarted()
}

/**
 * 等待初始化「开始」的上限（毫秒）。
 *
 * 正常启动这段是几十毫秒；只有初始化根本没被触发（例如主流程在 whenReady 里就抛了）才会走满。
 * 有上限是为了**别把调用方永远挂住**：宁可给出「未初始化」的报错，也不要静默卡死。
 */
const INIT_START_WAIT_MS = 20_000

/** 注入数据库实例（由初始化流程调用） */
export function setDatabaseInstance(db: Database | null): void {
  database = db
  if (db) noteInitStarted()
}

/** 注入初始化 Promise（由加载窗口创建流程调用） */
export function setInitializationPromise(promise: Promise<void> | null): void {
  initializationPromise = promise
  if (promise) noteInitStarted()
}

/** 获取进行中的初始化 Promise（可能为 null） */
export function getInitializationPromise(): Promise<void> | null {
  return initializationPromise
}

/** 获取数据库实例引用（退出清理等场景直接访问，不等待初始化） */
export function getDatabaseRef(): Database | null {
  return database
}

/**
 * 等初始化**开始**（已经开始了就立即返回）。
 * 上限见 `INIT_START_WAIT_MS`：宁可报「未初始化」，也不把调用方永远挂住。
 */
async function waitForInitStart(): Promise<void> {
  if (initializationPromise) return
  await Promise.race([
    initStarted,
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, INIT_START_WAIT_MS)
      // 计时器不持有事件循环（调用方等的是上面那个信号，这只是兜底）
      timer.unref?.()
    })
  ])
}

/**
 * 获取已初始化的数据库实例。
 *
 * 三种情况都等，而不是「没实例就抛」：
 * - 实例已就位 → 直接返回；
 * - 初始化进行中 → 等它完成；
 * - **初始化还没开始**（插件装载期就是这种）→ 先等它开始，再等它完成。
 *
 * @returns Promise<Database> 已初始化的数据库实例
 */
export async function getDatabaseInstance(): Promise<Database> {
  if (database) {
    return database
  }

  await waitForInitStart()

  if (initializationPromise) {
    // 如果初始化正在进行中，则等待它完成
    await initializationPromise
    if (database) {
      return database
    }
  }

  // 等到了超时 / 初始化已经跑完却没有实例（初始化失败），如实报错
  throw new Error('Database has not been initialized yet.')
}

/**
 * 等待初始化完成。
 * 主窗口预热期间渲染进程可能早于初始化完成启动：
 * 设置/锁屏读取需等初始化（工作区迁移会写回 activeWorkspaceId）完成后才返回，避免拿到迁移前状态。
 *
 * 初始化**还没开始**时同样先等它开始（插件在装载期调用本函数就是这种情形，见 `waitForInitStart`）。
 */
export async function awaitInitialized(): Promise<void> {
  await waitForInitStart()
  if (initializationPromise) await initializationPromise
}
