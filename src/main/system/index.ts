import logger from 'electron-log'
import { startHarness, stopHarness } from './harness'
import { startNotes, stopNotes } from './notes'

/**
 * 系统级功能的装配入口（AI 助手 / 资料库）。
 *
 * 这两块**不是插件**：随应用启动、随应用退出，没有安装/启用/停用这一层。
 * 它们的主进程代码就在 `src/main` 里（`system/` 只负责装配顺序），
 * 通道是普通的 `harness:*` / `notes:*`，不经过插件宿主。
 */
const SYSTEM_MODULE_IDS = ['harness', 'notes'] as const

/** 系统级功能占用的 id：第三方插件扫描与插件面板必须跳过，避免同名顶掉 */
export const SYSTEM_MODULE_IDS_SET: ReadonlySet<string> = new Set(SYSTEM_MODULE_IDS)

let started = false

/** 启动系统级功能（必须在 preload 通道查询与窗口创建之前执行） */
export function startSystemModules(): void {
  if (started) return
  started = true

  // harness 先装：notes 的 AI 工具注册进 harness 的工具注册表
  startHarness()
  startNotes()

  logger.info('[System] AI 助手 / 资料库已作为系统功能启动')
}

/** 退出装配（应用退出时调用；顺序与启动相反） */
export function stopSystemModules(): void {
  if (!started) return
  started = false
  stopNotes()
  stopHarness()
}
