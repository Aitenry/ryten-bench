import logger from 'electron-log'
import { install as installHarness } from '../features/harness/main'
import { install as installNotes } from '../features/notes/main'
import { MainPluginContextImpl } from './plugins/context'

/**
 * 系统级功能（harness / notes）的主进程装配。
 *
 * 两者已经从 `src/plugins/**` 移出，不再经过插件安装器、磁盘包或启用态开关；
 * 但仍然复用 `MainPluginContext` 的 IPC 通道命名空间与可逆装配能力：
 * - 通道名保持 `plugin:harness:*` / `plugin:notes:*`，preload 白名单与渲染层
 *   `harnessApi` / `notesApi` 不需要迁移；
 * - `ctx.contribute(...)` 仍可注册 AI 工具、生命周期钩子等系统级贡献；
 * - 这些上下文常驻进程生命周期，不参与插件的启用/停用。
 */
const SYSTEM_SERVICE_IDS = ['harness', 'notes'] as const

const systemContexts: MainPluginContextImpl[] = []
let initialized = false

/** 系统级功能占用的 id（插件扫描与插件面板必须跳过） */
export const SYSTEM_MODULE_IDS: ReadonlySet<string> = new Set(SYSTEM_SERVICE_IDS)

/** 启动系统级功能（必须在 preload 通道同步与窗口创建之前执行） */
export function initSystemServices(): void {
  if (initialized) return
  initialized = true

  // harness 先装：notes 的工具贡献会注册到 harness 的工具契约里
  const harnessCtx = new MainPluginContextImpl('harness')
  installHarness(harnessCtx)
  systemContexts.push(harnessCtx)

  const notesCtx = new MainPluginContextImpl('notes')
  installNotes(notesCtx)
  systemContexts.push(notesCtx)

  logger.info(
    `[System] harness / notes 已作为系统功能启动（通道 ${systemContexts.reduce(
      (sum, ctx) => sum + ctx.channels.length,
      0
    )} 个）`
  )
}

/** 系统级功能占用的 IPC / 事件通道（并入 preload 白名单） */
export function activeSystemChannels(): string[] {
  return systemContexts.flatMap((ctx) => ctx.channels)
}
