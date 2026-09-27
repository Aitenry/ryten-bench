import { app } from 'electron'
import { join } from 'path'
import logger from 'electron-log'
import type { MainPluginContext } from '../../../main/plugins/context'
import { awaitInitialized } from '../../../main/database/instance'
import {
  APP_BEFORE_QUIT,
  APP_EVENT_WORKSPACE_CHANGED,
  APP_PRELOAD,
  APP_RENDERER_MEMORY_DUMP
} from '../../../main/plugins/app-hooks'
import { onAppEvent } from '../../../main/plugins/app-events'
import { PLUGIN_PURGE } from '../../../main/plugins/contributions'
import { configureFileHistory } from './workspace/file-history'
import { purgeHarnessData } from './purge'
import { configureToolOutputStore } from './runtime/tool-output-store'
import { preloadHarnessData } from './preload-cache'
import { dumpRendererMemory } from './renderer-memory'
import { closeAllMnemon } from './mnemon-singleton'
import { syncWorkspaceWatcher, stopWorkspaceWatcher } from './workspace'
import { HARNESS_EVENT_CHANNELS, installHarnessIpc } from './ipc/harness'
import { harnessTopicIpcHandlers } from './ipc/harness-topic'
import { mnemonIpcHandlers } from './ipc/mnemon'
import { workspaceIpcHandlers } from './ipc/workspace'
import { agentIpcHandlers } from './ipc/agent'
import { WORKSHOP_EVENT_CHANNELS, workshopIpcHandlers } from './ipc/workshop'
import { installWorkshopHost, uninstallWorkshopHost } from './workshop/wiring'
import { MCP_EVENT_CHANNELS, mcpIpcHandlers } from './ipc/mcp'
import {
  configureMcp,
  closeAllMcp,
  currentMcpTools,
  refreshCatalog,
  setMcpModuleBase
} from './runtime/mcp'
import { readMcpServers } from './runtime/mcp-store'
import { setMcpToolProvider } from './tools/builders'
import { WORKSPACE_FILE_HISTORY_EVENT_CHANNELS } from './workspace/file-history'
import { WORKSPACE_WATCHER_EVENT_CHANNELS } from './workspace/watcher'

/**
 * 文档被 AI 工具改写/删除的事件通道。
 *
 * 发送方是 notes 插件的 `manage_docs` 工具（`src/plugins/notes/main/tools/docs.ts`，它按
 * 「插件不得 import harness」的铁律用字面量发这个通道名）；订阅方是 harness 的渲染层入口
 * （`renderer/plugin.tsx`），它再把它桥接成**宿主事件总线**的语义事件 `doc:changed`，
 * 由 notes 的文档编辑器消费——notes 因此不认识这个通道名。在 harness 这里声明通道名，
 * 是为了让它进 preload 的插件通道白名单。
 */
const HARNESS_DOC_CHANGED_CHANNEL = 'plugin:harness:harness-doc-changed'

/**
 * harness 插件主进程入口（契约见 src/plugins/README.md）。
 *
 * 装的是「AI 助手」这一整块内容：
 * - 通道表：6 个域一个文件（harness 主体 / 话题对话 / Mnemon 记忆 / 工作区文件与改动审查 /
 *   智能体配置 / **插件工坊**），全部经 `ctx.registerIpc`；
 * - 事件通道：主进程 → 渲染层的推送（流式 chunk、队列、目标、后台任务、子代理、
 *   提问、计划清单、工作区磁盘变化、改动记录、文档改写、工坊状态变化与装载探针）
 *   逐个 `ctx.registerEvent` 声明，否则 preload 白名单会拒绝渲染层订阅（notes 那轮踩过）；
 * - 启动接线：文件改动快照目录 + 工作区文件监听 + **插件工坊宿主**（`workshop/wiring.ts`），
 *   原先写在 `src/main/index.ts`，现挪进 `ctx.effect`（可逆）。停用「AI 助手」就不再配置
 *   快照目录、不再监听工作区、工坊也随之不可用（工具与设置页给出可读错误）；
 * - 工具注册表：本地工具 time/weather + 各插件的 `harness.tool` 贡献（拉取语义，
 *   见 `src/main/plugins/tool-contract.ts`）。
 *
 * 归属依据（本轮实测）：
 * - `src/main/workspace/**` 是 AI 改动复核（快照/回溯/文件监听）+ 文件浏览器；
 * - `src/main/ipc/workspace.ts` 的 9 个 `workspace-*` 通道只被 harness 渲染层组件使用
 *   （WorkspacePanel / FileExplorer / FileDiffView），故从 core 组移除；
 * - `provider.ts` 里的 agent-* / main-agent-* 是智能体配置（agent_config 挂在 harness 的
 *   workspace 表下），随本轮搬进 `ipc/agent.ts`，provider.ts 只留模型 Provider。
 */
export function install(ctx: MainPluginContext): void {
  // ── 通道表（6 个域）─────────────────────────────────────────────────────
  installHarnessIpc(ctx)
  ctx.registerIpc(harnessTopicIpcHandlers())
  ctx.registerIpc(mnemonIpcHandlers())
  ctx.registerIpc(workspaceIpcHandlers())
  ctx.registerIpc(agentIpcHandlers())
  ctx.registerIpc(workshopIpcHandlers())
  ctx.registerIpc(mcpIpcHandlers())

  // ── 主进程 → 渲染层的事件通道（只有发送方）─────────────────────────────
  ctx.registerEvent(
    ...HARNESS_EVENT_CHANNELS,
    ...WORKSPACE_FILE_HISTORY_EVENT_CHANNELS,
    ...WORKSPACE_WATCHER_EVENT_CHANNELS,
    ...Object.values(MCP_EVENT_CHANNELS),
    ...WORKSHOP_EVENT_CHANNELS,
    HARNESS_DOC_CHANGED_CHANNEL
  )

  // ── 宿主生命周期钩子（贡献点：随 ctx.dispose() 摘除，停用即不再执行）────
  // core 只负责「时机」，具体动作由本插件提供——core 因此不认识 harness 的任何模块。
  ctx.contribute(APP_PRELOAD, {
    label: 'harness.preload',
    run: () => preloadHarnessData()
  })
  ctx.contribute(APP_RENDERER_MEMORY_DUMP, {
    label: 'harness.renderer-memory',
    run: (reason, exitCode) => dumpRendererMemory(reason ?? 'unknown', exitCode ?? 0)
  })
  ctx.contribute(APP_BEFORE_QUIT, {
    label: 'harness.mnemon',
    run: () => closeAllMnemon()
  })
  ctx.contribute(APP_BEFORE_QUIT, {
    label: 'harness.mcp',
    // 退出前关掉 MCP 连接：stdio 服务器是应用起的子进程，不关会留下孤儿进程
    run: () => closeAllMcp()
  })
  // 卸载时「同时删除该插件的全部数据」勾上后由宿主回调：删本插件的 7 张表行 + 三处托管目录
  // （实现见 `./purge.ts`；工作区表与 harness 设置键刻意不动）
  ctx.contribute(PLUGIN_PURGE, {
    run: purgeHarnessData,
    label: '会话、对话、目标、子代理配置、文件改动记录与记忆目录'
  })

  // ── 启动接线（原 src/main/index.ts）─────────────────────────────────────
  ctx.effect(() => {
    // 文件改动快照目录：放 userData 而不是工作区——工作区挂载为虚拟 '/'，
    // 写进去会污染用户项目，也会出现在模型自己的 ls/glob 结果里
    configureFileHistory(join(app.getPath('userData'), 'file-history'))

    // 工具结果详情存储目录（内置工具的结果不再随流下发/落库，点开卡片时按需读取）：
    // 同样放 userData。停用时经 configureToolOutputStore('') 降级——见下方回滚。
    configureToolOutputStore(join(app.getPath('userData'), 'tool-output'))

    // ── 插件工坊接线（可逆）──────────────────────────────────────────────
    // 工坊自己不做 IO 约定：宿主运行时表、插件装载/卸载、模块加载器、渲染层探针
    // 都在 wiring.ts 里一次性注入（那边刻意是唯一 import electron/core 的地方）。
    installWorkshopHost()

    // ── MCP 客户端接线（可逆）────────────────────────────────────────────
    // 配置读取器由这里注入（管理器本身不 import electron，可离线回归）；
    // 应用根一并注入：MCP SDK 是 ESM-only，而插件主进程是 CJS，
    // 只能用 createRequire(应用根) 惰性加载（理由见 runtime/mcp.ts 顶部注释）。
    configureMcp(readMcpServers)
    setMcpModuleBase(app.getAppPath())
    setMcpToolProvider(currentMcpTools)

    // 工作区文件监听：数据库初始化完成（设置已加载）后跟随当前工作区启动。
    // 初始化未完成时插件就被停用的话（stopped）不能再起监听。
    let stopped = false
    void awaitInitialized().then(() => {
      if (stopped) return
      try {
        syncWorkspaceWatcher()
      } catch (err) {
        logger.warn('[Harness] 工作区文件监听启动失败:', err)
      }
      // MCP 服务器预热：连接与工具发现都在后台跑（起子进程/联网可能要几秒），
      // 不阻塞启动；连不上的那台只在设置页与日志里体现，不影响其余工具。
      void refreshCatalog().catch((err) => logger.warn('[Harness] MCP 预热失败:', err))
    })

    // 系统设置里切换/重建工作区（core 发 `app.workspace-changed`）→ 监听换根目录。
    // 事件订阅是可逆效果：停用即解绑，不再响应工作区变化。
    const offWorkspaceChanged = onAppEvent(APP_EVENT_WORKSPACE_CHANGED, () => {
      try {
        syncWorkspaceWatcher()
      } catch (err) {
        logger.warn('[Harness] 工作区切换后重启监听失败:', err)
      }
    })

    return () => {
      stopped = true
      offWorkspaceChanged()
      stopWorkspaceWatcher()
      // 停用即「不再配置快照/详情目录」：写入处按空目录降级为「无快照 / 无详情」（不抛错）
      configureFileHistory('')
      configureToolOutputStore('')
      // 工坊随之摘掉接线：工具与设置页给出「工坊尚未接线」的可读错误，
      // 已装好的插件**不受影响**（它们是独立的插件包，跟 AI 助手是否启用无关）
      uninstallWorkshopHost()
      // MCP 同样是可逆装配：摘掉提供者并关掉所有连接（stdio 子进程不能留在系统里）
      setMcpToolProvider(undefined)
      configureMcp(undefined)
      setMcpModuleBase(undefined)
      void closeAllMcp()
    }
  })
}

export default { install }
