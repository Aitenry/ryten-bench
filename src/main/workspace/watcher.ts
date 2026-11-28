import * as fs from 'fs'
import * as path from 'path'
import { BrowserWindow } from 'electron'
import logger from 'electron-log'
import { safeSend } from '../safe-send'
import { isRecentlyWritten, recordFileChange } from './file-history'

/**
 * Workspace file watching: when the disk changes, the UI must follow.
 *
 * Fixes two long-standing gaps:
 * 1. **The model changed a file but the editor still shows the old content** (previously the
 *    new content was read only after reopening the tab);
 * 2. **The explorer did not refresh** (new/deleted files required a manual refresh click).
 *
 * Responsibilities:
 * - The built-in file tools (write_file / edit_file) **already** record their changes at the
 *   write site (with exact snapshots); watching only broadcasts refreshes, deduplicated via
 *   `isRecentlyWritten`, so nothing is recorded twice;
 * - Other changes (commands run via execute, saves from external editors, git operations) have
 *   no exact snapshot: changes falling inside a tool execution window are recorded as an
 *   `execute` entry **without snapshot** (honestly reported as not revertible), while purely
 *   external changes only broadcast a refresh and produce no review record (otherwise one git
 *   checkout would flood in hundreds of rows).
 */

/** Heavy directories not watched (build output / dependencies / version-control internals) */
const IGNORED_SEGMENTS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  '.cache',
  '.next',
  '.turbo',
  'coverage'
])

/** Coalescing window: one editor save or one model write often fires several low-level events */
const DEBOUNCE_MS = 220
/** Maximum files per batch for which "command execution change" is recorded (prevents one batch write from flooding the database) */
const MAX_TOOL_ATTRIBUTED_PER_BATCH = 12
/** Grace period during which changes after execute ends are still attributed to it (disk events often arrive after the process exits) */
const WINDOW_GRACE_MS = 1500

/** A single entry in a batch of changes */
export interface WorkspaceFsChange {
  path: string
  relPath: string
  exists: boolean
  isDirectory: boolean
}

let watcher: fs.FSWatcher | null = null
let watchedRoot = ''
let watchedWorkspaceId = 0
/**
 * Workspace paths already confirmed as "root directory does not exist".
 *
 * When the workspace directory is deleted / moved (most commonly: the old plugin workspace still
 * points at the old path after "plugin storage path" was changed, or a plugin draft was deleted
 * leaving only sessions), `fs.watch` throws ENOENT. Every settings update triggers a sync, so it
 * must not log two stack traces each time; log once per missing root and clear automatically once
 * the directory comes back.
 */
let missingRoot = ''
const pendingPaths = new Set<string>()
let debounceTimer: NodeJS.Timeout | null = null

/** Currently running tools (disk changes during execute are attributed to them). May be concurrent (subagents / workflows), so take the newest from a stack. */
const activeWindows: {
  topicId: number | null
  callId: string | null
  startedAt: number
}[] = []
/** Most recently finished tool window (there is a time gap between process exit and actual disk writes) */
let endedWindow: { topicId: number | null; callId: string | null; endedAt: number } | null = null

/** Tool execution starts: disk changes in the meantime are attributed to this call */
export function beginToolWriteWindow(info: { topicId?: number; callId?: string }): void {
  activeWindows.push({
    topicId: info.topicId ?? null,
    callId: info.callId ?? null,
    startedAt: Date.now()
  })
}

/** Tool execution ends (still attributed to it within the grace window) */
export function endToolWriteWindow(callId?: string): void {
  const index = callId
    ? activeWindows.findIndex((w) => w.callId === callId)
    : activeWindows.length - 1
  if (index < 0) return
  const [closed] = activeWindows.splice(index, 1)
  endedWindow = { topicId: closed.topicId, callId: closed.callId, endedAt: Date.now() }
}

/** Currently effective attribution window (null when none) */
function currentWindow(): { topicId: number | null; callId: string | null } | null {
  if (activeWindows.length > 0) return activeWindows[activeWindows.length - 1]
  if (endedWindow && Date.now() - endedWindow.endedAt <= WINDOW_GRACE_MS) return endedWindow
  return null
}

function isIgnored(relPath: string): boolean {
  return relPath.split(/[\\/]/).some((segment) => IGNORED_SEGMENTS.has(segment) || segment === '')
}

/**
 * Main process → renderer event channels (send-only).
 *
 * Channel names are always `harness:<original flat name>`: workspace file watching belongs to
 * the "AI assistant"; the renderer subscribes through the preload system bridge, so no
 * whitelist registration is needed.
 */
export const WORKSPACE_FS_CHANGED = 'harness:workspace-fs-changed'

/** Broadcast a refresh (renderers use it to refresh explorer directories and open tab content) */
function broadcastFsChanged(changes: WorkspaceFsChange[]): void {
  if (changes.length === 0) return
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) safeSend(win.webContents, WORKSPACE_FS_CHANGED, { changes })
  }
}

/** Read file text (only when it is text and within the size limit; otherwise null) */
async function readTextIfSmall(filePath: string): Promise<string | null> {
  try {
    const stat = await fs.promises.stat(filePath)
    if (!stat.isFile() || stat.size > 1_500_000) return null
    const text = await fs.promises.readFile(filePath, 'utf-8')
    return text.includes('\u0000') ? null : text
  } catch {
    return null
  }
}

/** Process one (debounced) batch of disk changes */
async function flush(): Promise<void> {
  debounceTimer = null
  if (!watchedRoot) return
  const batch = [...pendingPaths]
  pendingPaths.clear()
  if (batch.length === 0) return

  const changes: WorkspaceFsChange[] = []
  const toolWindow = currentWindow()
  let attributed = 0

  for (const abs of batch) {
    const relPath = path.relative(watchedRoot, abs)
    if (isIgnored(relPath)) continue
    let exists = true
    let isDirectory = false
    try {
      const stat = await fs.promises.stat(abs)
      isDirectory = stat.isDirectory()
    } catch {
      exists = false
    }
    changes.push({ path: abs, relPath: relPath.split(path.sep).join('/'), exists, isDirectory })

    // File changes inside a command execution window: record a "no snapshot" change (traceable, but honestly marked as not revertible)
    if (
      exists &&
      !isDirectory &&
      toolWindow &&
      !isRecentlyWritten(abs) &&
      attributed < MAX_TOOL_ATTRIBUTED_PER_BATCH
    ) {
      const after = await readTextIfSmall(abs)
      if (after !== null) {
        attributed++
        void recordFileChange({
          workspaceId: watchedWorkspaceId,
          workspaceRoot: watchedRoot,
          realPath: abs,
          before: null,
          after,
          kind: 'modify',
          source: 'execute',
          topicId: toolWindow.topicId,
          callId: toolWindow.callId,
          note: 'command'
        })
      }
    }
  }

  broadcastFsChanged(changes)
}

/** Whether the target root exists and is a directory (when the workspace directory is deleted/moved, `fs.watch` necessarily throws ENOENT) */
function isExistingDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/** Currently watched workspace root (empty string = not watching) */
export function watchedWorkspaceRoot(): string {
  return watchedRoot
}

/**
 * Whether `dir` is **directly or indirectly** occupied by the workspace watcher (watch root is
 * dir, or the watch root is inside dir).
 *
 * On Windows the directory handle opened by `fs.watch` lacks `FILE_SHARE_DELETE`: as long as the
 * watcher is still attached to this directory (or its subdirectory), deleting/renaming it yields
 * `EPERM`. So replacing the plugin source directory or deleting a draft must call
 * `stopWorkspaceWatcher()` first (installSourceBytes / the workshop delete both do this).
 *
 * The reverse case (dir inside the watch root) does not count: when the watcher is attached to a
 * parent directory, subdirectory names can be deleted/renamed normally.
 */
export function isWatchingPath(dir: string): boolean {
  if (!watchedRoot) return false
  const root = path.resolve(watchedRoot)
  const target = path.resolve(dir)
  return root === target || root.startsWith(target + path.sep)
}

/** Start watching the workspace (stop then start when switching workspaces; repeated calls for the same workspace are a no-op) */
export function startWorkspaceWatcher(root: string, workspaceId: number): void {
  if (!root) {
    stopWorkspaceWatcher()
    return
  }

  // Directory missing: do not watch, and do not take the "recursive unavailable → retry" fallback
  // (that would only log two stack traces). Stop watching the old root, warn once for the same
  // missing root; watching restarts once the directory is restored or another workspace is chosen.
  // This check must come before "already watching the same root": when the directory is deleted
  // **while being watched**, the watcher is still non-null, and an early return would never
  // discover that it went stale.
  if (!isExistingDirectory(root)) {
    if (watchedRoot) stopWorkspaceWatcher()
    if (missingRoot !== root) {
      missingRoot = root
      logger.warn(
        `[WorkspaceWatcher] Workspace folder is missing (or is not a directory), file watching skipped: ${root}` +
          ' (restore it or switch workspace to resume watching)'
      )
    }
    return
  }
  missingRoot = ''

  if (watcher && watchedRoot === root && watchedWorkspaceId === workspaceId) return

  stopWorkspaceWatcher()
  watchedRoot = root
  watchedWorkspaceId = workspaceId
  try {
    watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
      if (!filename) return
      const rel = filename.toString()
      if (isIgnored(rel)) return
      pendingPaths.add(path.join(root, rel))
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => void flush(), DEBOUNCE_MS)
    })
    watcher.on('error', (err) => logger.warn('[WorkspaceWatcher] Watch error:', err))
    logger.info(`[WorkspaceWatcher] Started watching ${root}`)
  } catch (err) {
    // On Linux fs.watch does not support recursive: fall back to watching the root only (not fatal; the refresh button still works)
    logger.warn(
      '[WorkspaceWatcher] Recursive watch unavailable, falling back to root-only watch:',
      err
    )
    try {
      watcher = fs.watch(root, (_event, filename) => {
        if (!filename) return
        pendingPaths.add(path.join(root, filename.toString()))
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(() => void flush(), DEBOUNCE_MS)
      })
    } catch (inner) {
      logger.error('[WorkspaceWatcher] Failed to start watcher:', inner)
      watcher = null
    }
  }
}

/** Stop watching */
export function stopWorkspaceWatcher(): void {
  if (watcher) {
    try {
      watcher.close()
    } catch {
      // Already closed
    }
    watcher = null
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  pendingPaths.clear()
  watchedRoot = ''
  watchedWorkspaceId = 0
}
