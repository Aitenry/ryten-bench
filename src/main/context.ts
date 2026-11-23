import _Store from 'electron-store'
import { HarnessSettings } from './types/settings'
import { setActiveWorkspaceIdProvider } from './database/workspace-context'

// electron-store 实例：全局设置（IPC 层与 AI 工具层共用）
export const Store = _Store['default'] || _Store
export const settingsStore = new Store({ name: 'settings' })

// 全局活动工作区读取器（IPC 层与 AI 工具层共用）
setActiveWorkspaceIdProvider(() => {
  const harness = settingsStore.get('harness') as HarnessSettings | undefined
  return harness?.activeWorkspaceId ?? 0
})

// 流式输出取消控制器（按渲染进程 sender.id 区分）
export const streamAbortControllers = new Map<number, AbortController>()
// 进行中的对话流（退出前需等待其保存数据；含目标自动续跑轮）
export const activeHarnessStreams = new Set<Promise<unknown>>()
// 生成中的插话队列（harnessQueue）属 harness 插件：实现与消费者都在
// src/main/services/harness/queue-store.ts（ipc/harness、ipc/harness-topic），
// core 不参与，因此这里不做任何再导出。
