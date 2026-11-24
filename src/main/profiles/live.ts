import { app } from 'electron'
import logger from 'electron-log'
import {
  applyProfile,
  deriveProfileKey,
  readSessionIdentity,
  type ApplyProfileResult
} from './manager'
import {
  getActiveProfileKey,
  isAccountProfileReady,
  logApplyResult,
  requestProfileRestart,
  setActiveProfileKey
} from './runtime'
import { createDatabase } from '../database/loading'
import { getDatabaseRef, setDatabaseInstance } from '../database/instance'
import { runMigrations } from '../database/orm'
import { applyWorkspaceSettings } from '../database/workspace-settings'
import { activeHarnessStreams, streamAbortControllers } from '../context'
import { reloadAllExternalMains, unloadAllExternalMains } from '../plugins/host'
import { closeAllMcp } from '../runtime/harness/mcp'
import { closeAllMnemon } from '../services/harness/mnemon-singleton'
import { startSystemModules, stopSystemModules } from '../system'
import { resetHarnessAccountState } from '../system/harness'
import * as sync from '../lattice/sync'
import { resumeLatticeAfterProfileSwitch } from '../lattice/index'
import { getMainWindow, isInitComplete } from '../windows/window-manager'

/**
 * 账号数据空间的**运行中原地切换**（不再 `app.relaunch()`）。
 *
 * 背景：`manager.ts` 的模型是「正在用的账号数据摆在 userData 根下，其它账号在
 * `profiles/<key>/` 里休眠，换号 = 两组目录对调」。最初的版本只在启动早期做对调，
 * 因此登录 / 登出 / 改基址都会重启整个应用（用户 2026-11-24 反馈：每次登出都重启太打断）。
 *
 * 现在把同一套对调搬到运行中，顺序刻意与「一次冷启动」对齐：
 *
 *   ① 悬停 —— 中止对话流、挂起云同步、停掉系统功能（AI 助手 / 资料库）、
 *             卸载第三方插件主模块、关闭 PGlite；
 *   ② 对调 —— `applyProfile()`（与启动期完全同一份逻辑，带 journal 保护）；
 *   ③ 重连 —— 新空间的 DB 连接 + 迁移 + 工作区设置对齐；
 *   ④ 复原 —— 清账号级内存缓存 → 装回系统功能 → 装回插件 → 恢复同步并 pull；
 *   ⑤ 刷新 —— 主窗口 `webContents.reload()`（渲染层重新挂载，启动页盖住这段切换）。
 *
 * 失败语义：**任何一步失败都回退成 `app.relaunch()`**（即旧行为）。目录对调本身有
 * journal + marker 兜底，重启后 `initAccountProfile()` 会续做/回滚，数据不会丢也不会串。
 * 只有「原地切换的所有前置条件都成立」时才走这条快路径，因此启动早期（初始化未完成、
 * 数据库还没就绪）的调用点仍然走重启，逻辑不分叉成两份。
 */

let switching = false

/** 是否正在原地切换（同步守卫 / 同步层用） */
export function isProfileSwitchRunning(): boolean {
  return switching
}

export interface ProfileSwitchOptions {
  /** 日志与用户可读的原因（如 `logout -> anonymous`） */
  reason: string
  /**
   * 目标数据空间 key。省略时按**磁盘上的会话**推导（与启动期同一口径）。
   * 登录场景由调用方直接给新账号的 key，避免「会话已写盘但推导口径不一致」的窗口。
   */
  targetKey?: string
}

export interface ProfileSwitchResult {
  ok: boolean
  key: string
  from: string | null
  reason: string
  /** 无法原地切换，已改为重启应用（调用方不需要再刷新界面） */
  restarted?: boolean
  error?: string
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 有上限的等待：数据库 close / 同步收尾这类「可能被正在跑的任务拖住」的步骤不能无限期阻塞切号 */
async function withTimeout(task: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | null = null
  try {
    await Promise.race([
      task,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms)
      })
    ])
    return true
  } catch (err) {
    logger.warn('[Profiles] A switch step failed while waiting for it to finish:', err)
    return true
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 能否原地切换：初始化已完成（启动页已进入主界面）且数据库确实连着。
 *
 * 不满足时不要硬来——启动早期（`initLattice()` 在 `initPluginHost()` 里就跑起来）
 * 数据库可能还没建好，此时切目录等于把启动流程的中间状态打断，直接走重启最稳。
 */
function canSwitchInPlace(): boolean {
  if (!isAccountProfileReady()) return false
  if (!isInitComplete()) return false
  const db = getDatabaseRef()
  return db !== null && db.isInitialized()
}

/** ① 悬停：让所有可能读写账号数据的东西停手（顺序 = 依赖的卸载顺序） */
async function quiesceForSwitch(): Promise<void> {
  // 正在跑的对话流会写库：先中止并等它落库（最多 5s，和退出流程同一条口径）
  if (activeHarnessStreams.size > 0) {
    logger.info(
      `[Profiles] Aborting ${activeHarnessStreams.size} active assistant stream(s) before switch`
    )
    for (const controller of streamAbortControllers.values()) {
      controller.abort()
    }
    await withTimeout(Promise.allSettled([...activeHarnessStreams]), 5000)
  }

  // 同步层：挂起防抖 push，并等正在跑的那一次同步收尾（它会写 plugin-state / lattice-sync.json）
  await sync.pauseLatticeSync()

  // 系统功能（AI 助手 / 资料库）：摘 IPC、停工作区监听与工坊、关 MCP 客户端
  try {
    stopSystemModules()
  } catch (err) {
    logger.warn('[Profiles] Failed to stop system modules before switch:', err)
  }

  // 第三方插件主模块：它们可能在装载期就打开了 plugin-state / 数据库句柄
  try {
    unloadAllExternalMains()
  } catch (err) {
    logger.warn('[Profiles] Failed to unload plugin main modules before switch:', err)
  }

  // 记忆组件是独立的 PGlite 实例（存储根在机器级目录里，不在对调清单中），
  // 但它们的缓存按账号数据组织：换号后必须重新按新库加载
  await Promise.allSettled([closeAllMnemon(), closeAllMcp()])

  // 数据库最后关：前面所有持有者都停手之后，目录才能被 rename（Windows 句柄）
  const database = getDatabaseRef()
  if (database) {
    const closed = await withTimeout(database.close(), 5000)
    if (!closed) logger.warn('[Profiles] Database close timed out; trying to swap anyway')
    setDatabaseInstance(null)
  }
}

/** ③ 重连：把根目录（现在是目标账号的数据）重新打开成数据库 */
async function reconnectDatabase(): Promise<void> {
  const database = await createDatabase()
  try {
    await runMigrations(database.getDatabase())
    // 活动工作区存在机器级设置里、工作区行在账号库里：换号后必须重新对齐，否则会指向不存在的行
    await applyWorkspaceSettings(database.getDatabase())
  } catch (err) {
    await database.close().catch((closeErr) => {
      logger.warn('[Profiles] Failed to close half-opened database after switch:', closeErr)
    })
    throw err
  }
  setDatabaseInstance(database)
}

/** ④ 复原：装回系统功能与插件，让同步层从「新空间 + 新会话」重新起步 */
function restoreRuntimeAfterSwitch(): void {
  // 先清掉按账号数据索引的内存缓存（topicId 是各账号库的自增 id，不清会串号）
  resetHarnessAccountState()
  // 与启动期同序：系统功能（AI 助手的工具表）→ 第三方插件
  startSystemModules()
  reloadAllExternalMains()

  // 新空间的 lattice-sync.json 才是当前账号的缓存（revs / 冲突 / 上次结果）
  sync.reloadLatticeSyncCache()
  sync.resumeLatticeSync()
  // 广播新登录态并在后台 pull 一次（登出时内部直接返回）
  void resumeLatticeAfterProfileSwitch()
}

/** ⑤ 刷新渲染层：给 IPC 响应留一帧，然后整页重载（启动页会盖住这段） */
function scheduleRendererReload(reason: string): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  setTimeout(() => {
    if (win.isDestroyed()) return
    logger.info(`[Profiles] 账号数据空间已切换，刷新界面（不重启应用）：${reason}`)
    win.webContents.reload()
  }, 60)
}

/**
 * 原地切换账号数据空间（登录 / 登出 / 改基址都走这里）。
 *
 * 调用方 `await` 它即可：成功时返回 `{ok:true}`（随后主窗口会自动刷新）；
 * 需要重启（初始化未完成 / 切换失败）时返回 `{restarted:true}`，应用会在几百毫秒后重启。
 */
export async function switchAccountProfile(
  options: ProfileSwitchOptions
): Promise<ProfileSwitchResult> {
  const { reason } = options
  const userDataDir = app.getPath('userData')
  const identity = readSessionIdentity(userDataDir)
  const desired = options.targetKey ?? deriveProfileKey(identity)
  const current = getActiveProfileKey()

  if (switching) {
    return {
      ok: false,
      key: desired,
      from: current,
      reason,
      error: '账号数据空间正在切换，请稍候'
    }
  }
  if (current === desired) {
    return { ok: true, key: desired, from: current, reason }
  }
  if (!canSwitchInPlace()) {
    logger.info(`[Profiles] 初始化未完成，改为重启切换账号数据空间：${reason}`)
    requestProfileRestart(reason)
    return { ok: false, key: desired, from: current, reason, restarted: true }
  }

  switching = true
  logger.info(
    `[Profiles] 原地切换账号数据空间：${current ?? 'null'} -> ${desired}（${reason}），不重启应用`
  )
  try {
    await quiesceForSwitch()

    // ② 对调：与启动期同一份逻辑（marker / journal 保护都在 manager 里）
    const result: ApplyProfileResult = applyProfile(userDataDir, desired, identity)
    logApplyResult(result, desired)
    setActiveProfileKey(desired)

    await reconnectDatabase()
    restoreRuntimeAfterSwitch()
    scheduleRendererReload(reason)

    logger.info(
      `[Profiles] 账号数据空间已在运行中切换完成：${current ?? 'null'} -> ${desired}（${reason}）`
    )
    return { ok: true, key: desired, from: result.from ?? current, reason }
  } catch (err) {
    logger.error(
      '[Profiles] 原地切换失败，回退为重启应用（数据没有删除；启动时会按 journal 续做/回滚）:',
      err
    )
    requestProfileRestart(`switch failed: ${reason}`)
    return {
      ok: false,
      key: desired,
      from: current,
      reason,
      restarted: true,
      error: errorText(err)
    }
  } finally {
    switching = false
  }
}
