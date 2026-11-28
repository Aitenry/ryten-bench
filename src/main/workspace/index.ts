import { settingsStore } from '../context'
import {
  isWatchingPath,
  startWorkspaceWatcher,
  stopWorkspaceWatcher,
  watchedWorkspaceRoot
} from './watcher'

/** Current active workspace (path + id), null when not configured */
export function activeWorkspace(): { path: string; id: number } | null {
  const harness = settingsStore.get('harness') as
    { workspacePath?: string; activeWorkspaceId?: number } | undefined
  const root = harness?.workspacePath
  const id = harness?.activeWorkspaceId
  if (!root || !id) return null
  return { path: root, id }
}

/**
 * Make the file watcher follow the current workspace (called at startup and after switching
 * or rebuilding a workspace). Idempotent: returns immediately when the workspace is
 * unchanged, so the watcher is not rebuilt repeatedly.
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
 * Temporarily release the workspace file watcher while a directory is being **replaced or
 * deleted**, returning a function that restores watching.
 *
 * Why this is needed: on Windows the directory handle held by `fs.watch` does not allow
 * deleting or renaming the watched directory (rename or `rm -rf` yields EPERM). When the
 * plugin source directory happens to be the active workspace of a "plugin workspace",
 * installing/updating source and deleting drafts all run into it (the user's 2026-11-25
 * `.lattice-source-stage-* -> plugins/<id>` EPERM, which only cleared after an app restart).
 *
 * @returns a function to restore watching; null when the directory is not watched at all
 * (the caller can proceed directly)
 */
export function releaseWorkspaceWatcherFor(dir: string): (() => void) | null {
  if (!isWatchingPath(dir)) return null
  stopWorkspaceWatcher()
  return () => {
    try {
      syncWorkspaceWatcher()
    } catch {
      // Failing to restore the watcher does not affect the completed file operation; the next workspace switch / settings update syncs again
    }
  }
}

/** Run a synchronous file operation (replacing/deleting a watched directory) with the workspace watcher temporarily released */
export function withWorkspaceWatcherReleased<T>(dir: string, run: () => T): T {
  const release = releaseWorkspaceWatcherFor(dir)
  try {
    return run()
  } finally {
    release?.()
  }
}
