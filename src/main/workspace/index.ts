import { settingsStore } from '../context'
import {
  isWatchingPath,
  startWorkspaceWatcher,
  stopWorkspaceWatcher,
  watchedWorkspaceRoot
} from './watcher'

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

export { isWatchingPath, startWorkspaceWatcher, stopWorkspaceWatcher, watchedWorkspaceRoot }

/**
 * 在**替换/删除某个目录**期间临时放掉工作区文件监听，返回「恢复监听」的函数。
 *
 * 为什么需要：Windows 上 `fs.watch` 的目录句柄不允许删除/改名被监听的目录
 * （重命名或 `rm -rf` 会得到 EPERM）。插件源码目录正好就是「插件工作区」的
 * 活动工作区时，安装/更新源码、删除草稿都会撞上它（用户 2026-11-25 的
 * `.lattice-source-stage-* -> plugins/<id>` EPERM，重启应用后才好）。
 *
 * @returns 需要恢复时返回函数；该目录本来就没在被监听则返回 null（调用方直接执行即可）
 */
export function releaseWorkspaceWatcherFor(dir: string): (() => void) | null {
  if (!isWatchingPath(dir)) return null
  stopWorkspaceWatcher()
  return () => {
    try {
      syncWorkspaceWatcher()
    } catch {
      // 恢复监听失败不影响已经完成的文件操作；下一次切换工作区/设置更新会再同步
    }
  }
}

/** 在临时放掉工作区监听的前提下执行一段同步文件操作（替换/删除被监听的目录） */
export function withWorkspaceWatcherReleased<T>(dir: string, run: () => T): T {
  const release = releaseWorkspaceWatcherFor(dir)
  try {
    return run()
  } finally {
    release?.()
  }
}
