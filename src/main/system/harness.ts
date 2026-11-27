import { app } from 'electron'
import { join } from 'path'
import logger from 'electron-log'
import { awaitInitialized } from '../database/instance'
import { APP_EVENT_WORKSPACE_CHANGED } from '../plugins/app-hooks'
import { onAppEvent } from '../plugins/app-events'
import { configureFileHistory } from '../workspace/file-history'
import { configureToolOutputStore } from '../runtime/harness/tool-output-store'
import { preloadHarnessData } from '../services/harness/preload-cache'
import { clearSubAgentCache } from '../services/harness/subagents'
import { clearProviderCache } from '../provider/cache'
import { todoStore } from '../runtime/harness/todo'
import { goalStore } from '../runtime/harness/goal'
import { harnessQueue } from '../services/harness/queue-store'
import { goalRoundDriver } from '../services/harness/goal-driver'
import { jobsRegistry } from '../runtime/harness/jobs'
import { subagentSessions } from '../runtime/harness/subagent-sessions'
import { buildResumedSubagentRuntime } from '../runtime/harness/subagent-resume'
import { teamModeStore } from '../runtime/harness/team-mode'
import { teamStore } from '../runtime/harness/team'
import {
  deleteTeamBoard,
  getTeamBoard,
  upsertTeamBoard
} from '../database/mapper/harness/team-board'
import {
  appendTeamTaskEvent,
  deleteTeamTaskEventsByTopic
} from '../database/mapper/harness/team-task-event'
import { dumpRendererMemory } from '../services/harness/renderer-memory'
import { closeAllMnemon } from '../services/harness/mnemon-singleton'
import { syncWorkspaceWatcher, stopWorkspaceWatcher, isWatchingPath } from '../workspace'
import { registerHarnessIpc } from '../ipc/harness/harness'
import { harnessTopicIpcHandlers } from '../ipc/harness/harness-topic'
import { openInAppIpcHandlers } from '../ipc/harness/open-in-app'
import { chatIpcHandlers } from '../ipc/harness/chat'
import { mnemonIpcHandlers } from '../ipc/harness/mnemon'
import { workspaceIpcHandlers } from '../ipc/harness/workspace'
import { agentIpcHandlers } from '../ipc/harness/agent'
import { workshopIpcHandlers } from '../ipc/harness/workshop'
import { installWorkshopHost, uninstallWorkshopHost } from '../workshop/wiring'
import { configureWorkshopDirReleaseHook } from '../workshop/dir-release'
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
 * - **通道表**：8 个域各一个文件（助手主体 / 话题对话 / 对话模式的目录与会话 / Mnemon 记忆 /
 *   工作区文件与改动审查 / 智能体配置 / 插件工坊 / 在应用中打开），全部是普通 `harness:*` 通道；
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

  // 冷恢复接线：恢复的 inactive 会话第一次 send 时按话题/配置重建 runtime
  subagentSessions.setRuntimeFactory(buildResumedSubagentRuntime)

  // 任务板持久化接线：运行时只依赖 TeamBoardPersistence 接口，DB 实现放在这里装配。
  // 整板 JSON 快照（含 deleted tombstone）+ revision/counter，重启后懒加载恢复。
  teamStore.setPersistence({
    load: async (topicId) => {
      const row = await getTeamBoard(topicId)
      if (!row) return null
      try {
        const tasks = JSON.parse(row.tasks) as unknown
        if (!Array.isArray(tasks)) return null
        return { revision: row.revision, counter: row.counter, tasks }
      } catch {
        return null
      }
    },
    save: (topicId, snapshot) =>
      upsertTeamBoard({
        topic_id: topicId,
        revision: snapshot.revision,
        counter: snapshot.counter,
        tasks: JSON.stringify(snapshot.tasks)
      }),
    remove: (topicId) => deleteTeamBoard(topicId),
    appendEvent: (event) =>
      appendTeamTaskEvent({
        topic_id: event.topicId,
        task_id: event.taskId,
        action: event.action,
        actor_id: event.actorId,
        actor_name: event.actorName,
        subject: event.subject,
        task_revision: event.taskRevision
      }),
    removeEvents: (topicId) => deleteTeamTaskEventsByTopic(topicId)
  })

  const effects = new EffectScope()
  scope = effects

  // ── 通道表（7 个域）─────────────────────────────────────────────────────
  disposers = [
    registerHarnessIpc(effects),
    registerIpcHandlers(harnessTopicIpcHandlers()),
    registerIpcHandlers(openInAppIpcHandlers()),
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
    /**
     * 工坊删除/重建草稿时，如果目录正被工作区监听（= 插件模式打开着它的源码），
     * Windows 上会 EPERM。把「先放掉监听、做完再挂回去」的实现注入给工坊服务：
     * 服务层保持 electron-free（离线工装仍可跑），主进程这里负责真实监听。
     */
    configureWorkshopDirReleaseHook(
      (dir) => {
        if (!isWatchingPath(dir)) return null
        stopWorkspaceWatcher()
        return () => {
          try {
            syncWorkspaceWatcher()
          } catch (err) {
            logger.warn(
              '[Harness] Failed to restore the workspace watcher after a workshop action:',
              err
            )
          }
        }
      },
      () => {
        try {
          syncWorkspaceWatcher()
        } catch (err) {
          logger.warn(
            '[Harness] Failed to resync the workspace watcher after a workshop action:',
            err
          )
        }
      }
    )

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
      configureWorkshopDirReleaseHook(null)
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

/** 加载页预取：初始化完成后、主窗口交接前，把常用数据读进缓存并恢复子代理会话历史 */
export function preloadHarness(): Promise<void> {
  return Promise.all([
    preloadHarnessData(),
    // 恢复历史会话（inactive）：先只读可看；第一次续聊时再按快照冷恢复 runtime
    subagentSessions.restorePersistedSessions()
  ]).then(() => undefined)
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
  clearSubAgentCache()
  clearProviderCache()
  todoStore.reset()
  goalStore.reset()
  teamModeStore.reset()
  harnessQueue.reset()
  goalRoundDriver.reset()
  // 后台命令按 topicId 归属，换账号后同一个 id 可能属于另一个会话：
  // 不清掉会出现「新账号的顶部栏里挂着上一个账号的 dev server」
  jobsRegistry.clearAll()
  // 后台子代理会话同样按 topicId 索引（含会话事件流）：换账号后必须清掉，否则串号
  subagentSessions.clearAll()
  // 换库后从新账号库恢复子代理会话历史（旧库数据保留，只清内存）
  void subagentSessions.restorePersistedSessions()
  // 共享任务板同样按 topicId 索引，换账号必须清空
  teamStore.clearAll()
  logger.info('[Harness] Account-scoped in-memory state cleared for profile switch')
}

/** 渲染进程异常退出时落诊断快照（未启动/无 dump 目录时静默） */
export function dumpHarnessMemory(reason: string, exitCode: number): void {
  dumpRendererMemory(reason, exitCode)
}

/** 退出前释放：Mnemon 会话与 MCP stdio 子进程都不能留在系统里 */
export function closeHarnessResources(): void {
  // 后台 execute 是真实系统进程（dev server / watcher）：退出时不取消会留下孤儿进程
  jobsRegistry.clearAll()
  // 后台子代理会话：退出时中止在途运行，避免闭包继续写已销毁的窗口/任务
  subagentSessions.clearAll()
  teamStore.clearAll()
  closeAllMnemon()
  void closeAllMcp()
}
