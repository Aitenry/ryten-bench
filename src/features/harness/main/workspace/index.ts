import { settingsStore } from '../../../../main/context'
import { startWorkspaceWatcher, stopWorkspaceWatcher } from './watcher'

/** 当前活动工作区（路径 + id），未配置时返回 null */
export function activeWorkspace(): { path: string; id: number } | null {
  const harness = settingsStore.get('harness') as
    { workspacePath?: string; activeWorkspaceId?: number } | undefined
  const root = harness?.workspacePath
  const id = harness?.activeWorkspaceId
  if (!root || !id) return null
  return { path: root, id }
}

/**
 * 让文件监听跟随当前工作区（启动时、切换工作区/重建工作区后调用）。
 * 幂等：工作区没变时直接返回，不会把监听反复重建。
 */
export function syncWorkspaceWatcher(): void {
  const active = activeWorkspace()
  if (!active) {
    stopWorkspaceWatcher()
    return
  }
  startWorkspaceWatcher(active.path, active.id)
}

export { startWorkspaceWatcher, stopWorkspaceWatcher }
