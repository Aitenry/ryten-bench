import { registerIpcHandlers } from '../ipc/register'
import {
  registerBuiltinHarnessTools,
  unregisterBuiltinHarnessTools
} from '../tools/harness/builders'
import { todoIpcHandlers } from '../ipc/notes/todo'
import { documentIpcHandlers } from '../ipc/notes/document'
import { wikiIpcHandlers } from '../ipc/notes/wiki'
import { nodePositionIpcHandlers } from '../ipc/notes/node-position'
import { graphIpcHandlers } from '../ipc/notes/graph'
import { notesToolContributions } from '../tools/notes'

/**
 * 「资料库」主进程装配（系统级功能，不再是插件）。
 *
 * - **通道表**：5 个域（todo / document / wiki / node-position / graph），
 *   一个域一个文件，通道名一律 `notes:*`；
 * - **AI 工具**：`manage_materials`（资料整理）一个入口覆盖文档 / 待办 / 知识库 /
 *   图谱（实现见 `tools/notes/**`），注册进 harness 的工具注册表，模型因此能读写资料库；
 *   与第三方插件走同一个 `harness.tool` 消费点，只是这里是随应用编译进来的内置来源；
 * - **图谱事件**：`notes:graph-build-{progress,complete,error}` 由主进程广播、
 *   渲染层 `BuildProgressProvider` 订阅，通道名前缀由 preload 系统桥放行。
 */
let disposers: Array<() => void> = []
let started = false

export function startNotes(): void {
  if (started) return
  started = true

  disposers = [
    registerIpcHandlers(todoIpcHandlers),
    registerIpcHandlers(documentIpcHandlers),
    registerIpcHandlers(wikiIpcHandlers),
    registerIpcHandlers(nodePositionIpcHandlers),
    registerIpcHandlers(graphIpcHandlers)
  ]

  registerBuiltinHarnessTools(notesToolContributions)
}

export function stopNotes(): void {
  if (!started) return
  started = false
  unregisterBuiltinHarnessTools(notesToolContributions)
  for (const dispose of disposers.reverse()) {
    try {
      dispose()
    } catch {
      // 忽略：退出路径上不再抛错
    }
  }
  disposers = []
}
