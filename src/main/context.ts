import _Store from 'electron-store'
import { HarnessSettings } from './types/settings'
import { setActiveWorkspaceIdProvider } from './database/workspace-context'
import { recoverSettingsAtStartup, startSettingsBackupWatcher } from './settings-backup'

// electron-store 实例：全局设置（IPC 层与 AI 工具层共用）
// 构造前先自检 settings.json：缺失/损坏时用 settings.backup.json 恢复（见 settings-file.ts）
export const settingsStartupRecovery = recoverSettingsAtStartup()
export const Store = _Store['default'] || _Store
export const settingsStore = new Store({ name: 'settings' })
// 之后每次设置变更都刷新同目录下的备份；退出前再补一次
startSettingsBackupWatcher(settingsStore)

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
