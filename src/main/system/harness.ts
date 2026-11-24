import { app } from 'electron'
import { join } from 'path'
import logger from 'electron-log'
import { awaitInitialized } from '../database/instance'
import { APP_EVENT_WORKSPACE_CHANGED } from '../plugins/app-hooks'
import { onAppEvent } from '../plugins/app-events'
import { configureFileHistory } from '../workspace/file-history'
import { configureToolOutputStore } from '../runtime/harness/tool-output-store'
import { preloadHarnessData, clearAgentCache } from '../services/harness/preload-cache'
import { clearProviderCache } from '../provider/cache'
import { todoStore } from '../runtime/harness/todo'
import { goalStore } from '../runtime/harness/goal'
import { harnessQueue } from '../services/harness/queue-store'
import { goalRoundDriver } from '../services/harness/goal-driver'
import { dumpRendererMemory } from '../services/harness/renderer-memory'
import { closeAllMnemon } from '../services/harness/mnemon-singleton'
import { syncWorkspaceWatcher, stopWorkspaceWatcher } from '../workspace'
import { registerHarnessIpc } from '../ipc/harness/harness'
import { harnessTopicIpcHandlers } from '../ipc/harness/harness-topic'
import { chatIpcHandlers } from '../ipc/harness/chat'
import { mnemonIpcHandlers } from '../ipc/harness/mnemon'
import { workspaceIpcHandlers } from '../ipc/harness/workspace'
import { agentIpcHandlers } from '../ipc/harness/agent'
import { workshopIpcHandlers } from '../ipc/harness/workshop'
import { installWorkshopHost, uninstallWorkshopHost } from '../workshop/wiring'
import { mcpIpcHandlers } from '../ipc/harness/mcp'
import {
  configureMcp,
  closeAllMcp,
  currentMcpTools,
  refreshCatalog,
  setMcpModuleBase
} from '../runtime/harness/mcp'
import { readMcpServers } from '../runtime/harness/mcp-store'
import { setMcpToolProvider } from '../tools/harness/builders'
import { EffectScope, registerIpcHandlers } from '../ipc/register'

/**
 * 「AI 助手」主进程装配（系统级功能，不再是插件）。
 *
 * 六件事：
 * - **通道表**：7 个域一个文件（助手主体 / 话题对话 / 对话模式的目录与会话 / Mnemon 记忆 /
 *   工作区文件与改动审查 / 智能体配置 / 插件工坊），全部是普通 `harness:*` 通道；
 * - **事件通道**：主进程 → 渲染层的推送（流式 chunk、队列、目标、后台任务、子代理、
 *   提问、计划清单、工作区磁盘变化、改动记录、文档改写、工坊状态变化与装载探针）；
 *   通道名以 `harness:` 开头，preload 的系统桥按前缀放行，不需要再声明清单；
 * - **启动接线**：文件改动快照目录、工具结果目录、插件工坊宿主、MCP 客户端、工作区监听；
 * - **生命周期钩子**：加载页预取、渲染进程内存快照、退出前释放（导出的三个函数，
 *   由 core 在固定时机直接调用——不再经贡献点绕一圈）；
 * - **工具注册表**：本地工具 time/weather/工坊 + 第三方插件的 `harness.tool` 贡献；
 * - **第三方插件协作**：`harness.tool` 仍由第三方插件经插件注册表贡献，这里只做消费。
 *
 * 装配是幂等的：core 启动时调用一次 `startHarness()`，退出时调用 `stopHarness()`。
 */
let started = false
let disposers: Array<() => void> = []
let scope: EffectScope | null = null

export function startHarness(): void {
  if (started) return
  started = true

  const effects = new EffectScope()
  scope = effects

  // ── 通道表（7 个域）─────────────────────────────────────────────────────
  disposers = [
    registerHarnessIpc(effects),
    registerIpcHandlers(harnessTopicIpcHandlers()),
    registerIpcHandlers(chatIpcHandlers()),
    registerIpcHandlers(mnemonIpcHandlers()),
    registerIpcHandlers(workspaceIpcHandlers()),
    registerIpcHandlers(agentIpcHandlers()),
    registerIpcHandlers(workshopIpcHandlers()),
    registerIpcHandlers(mcpIpcHandlers())
  ]

  // ── 启动接线：目录、工坊、MCP、文件监听 ─────────────────────────────────
  effects.effect(() => {
    // 文件改动快照目录：放 userData 而不是工作区——工作区挂载为虚拟 '/'，
    // 写进去会污染用户项目，也会出现在模型自己的 ls/glob 结果里
    configureFileHistory(join(app.getPath('userData'), 'file-history'))

    // 工具结果详情存储目录（内置工具的结果不再随流下发/落库，点开卡片时按需读取）
    configureToolOutputStore(join(app.getPath('userData'), 'tool-output'))

    // ── 插件工坊接线 ─────────────────────────────────────────────────────
    // 工坊自己不做 IO 约定：宿主运行时表、插件装载/卸载、模块加载器、渲染层探针
    // 都在 wiring.ts 里一次性注入（那边刻意是唯一 import electron/core 的地方）。
    installWorkshopHost()

    // ── MCP 客户端接线 ───────────────────────────────────────────────────
    // 配置读取器由这里注入（管理器本身不 import electron，可离线回归）；
    // 应用根一并注入：MCP SDK 是 ESM-only，而主进程产物是 CJS，
    // 只能用 createRequire(应用根) 惰性加载（理由见 runtime/harness/mcp.ts 顶部注释）。
    configureMcp(readMcpServers)
    setMcpModuleBase(app.getAppPath())
    setMcpToolProvider(currentMcpTools)

    // 工作区文件监听：数据库初始化完成（设置已加载）后跟随当前工作区启动。
    let stopped = false
    void awaitInitialized().then(() => {
      if (stopped) return
      try {
        syncWorkspaceWatcher()
      } catch (err) {
        logger.warn('[Harness] Failed to start workspace file watcher:', err)
      }
      // MCP 服务器预热：连接与工具发现都在后台跑（起子进程/联网可能要几秒），
      // 不阻塞启动；连不上的那台只在设置页与日志里体现，不影响其余工具。
      void refreshCatalog().catch((err) => logger.warn('[Harness] MCP warm-up failed:', err))
    })

    // 系统设置里切换/重建工作区（core 发 `app.workspace-changed`）→ 监听换根目录
    const offWorkspaceChanged = onAppEvent(APP_EVENT_WORKSPACE_CHANGED, () => {
      try {
        syncWorkspaceWatcher()
      } catch (err) {
        logger.warn('[Harness] Failed to restart watcher after workspace switch:', err)
      }
    })

    return () => {
      stopped = true
      offWorkspaceChanged()
      stopWorkspaceWatcher()
      configureFileHistory('')
      configureToolOutputStore('')
      uninstallWorkshopHost()
      setMcpToolProvider(undefined)
      configureMcp(undefined)
      setMcpModuleBase(undefined)
      void closeAllMcp()
    }
  })
}

/** 退出装配（应用退出或测试收尾）：摘掉通道与全部订效，按 LIFO 回滚 */
export function stopHarness(): void {
  if (!started) return
  started = false
  for (const dispose of disposers.reverse()) {
    try {
      dispose()
    } catch (err) {
      logger.warn('[Harness] Failed to unregister channel:', err)
    }
  }
  disposers = []
  scope?.dispose()
  scope = null
}

// ── 应用生命周期钩子（core 在固定时机直接调用）──────────────────────────────

/** 加载页预取：初始化完成后、主窗口交接前，把常用数据读进缓存 */
export function preloadHarness(): Promise<void> {
  return preloadHarnessData()
}

/**
 * 丢掉全部**按账号数据**缓存的内存状态（运行中切换账号数据空间时调用）。
 *
 * 为什么必须清：这些单例按 `topicId` / `workspaceId` 这类**数据库自增 id** 索引，
 * 而每个账号的库是独立的——换库后同一个 id 可能指向另一个账号的数据。不清掉会出现
 * 「新账号的话题显示上一个账号的待办 / 目标 / 排队消息」，属于串号（只是发生在内存里）。
 *
 * 只清缓存、不落盘：真实数据都在各自账号的数据库里，清掉后按需重新读即可。
 * 记忆组件（Mnemon）与 MCP 子进程不在这些缓存里，由切换流程（`profiles/live.ts`）
 * 单独关闭后重新按新库装载。
 */
export function resetHarnessAccountState(): void {
  clearAgentCache()
  clearProviderCache()
  todoStore.reset()
  goalStore.reset()
  harnessQueue.reset()
  goalRoundDriver.reset()
  logger.info('[Harness] Account-scoped in-memory state cleared for profile switch')
}

/** 渲染进程异常退出时落诊断快照（未启动/无 dump 目录时静默） */
export function dumpHarnessMemory(reason: string, exitCode: number): void {
  dumpRendererMemory(reason, exitCode)
}

/** 退出前释放：Mnemon 会话与 MCP stdio 子进程都不能留在系统里 */
export function closeHarnessResources(): void {
  closeAllMnemon()
  void closeAllMcp()
}
