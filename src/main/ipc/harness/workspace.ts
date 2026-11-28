import { join, resolve, isAbsolute, sep } from 'path'
import type { IpcHandlerMap } from '../register'
import * as fs from 'fs'
import logger from 'electron-log'
import { mainMessages } from '../../i18n'
import { settingsStore } from '../../context'
import { activeWorkspace, syncWorkspaceWatcher } from '../../workspace'
import { isReallyInsideRoot } from '../../workspace/selected-roots'
import { markPathWritten, recordFileChange } from '../../workspace/file-history'
import {
  keepFileChanges,
  listFileChangeHistory,
  listWorkspacePendingChanges,
  readFileChangeContent,
  revertFileChange
} from '../../workspace/file-history'

/**
 * Validate that a renderer-supplied path is inside the AI workspace directory (prevents
 * arbitrary path reads/writes). The renderer process risks being injected or navigated to a
 * remote page (preload exposes the full API), so file IPC entry points must guard their own
 * boundary: non-absolute paths and out-of-bounds paths are rejected.
 * Returns the normalized absolute path.
 */
function assertInsideWorkspace(inputPath: string): string {
  const m = mainMessages().error
  if (typeof inputPath !== 'string' || !isAbsolute(inputPath)) {
    throw new Error(m.invalidPathAbsolute)
  }
  const harnessSettings = settingsStore.get('harness') as { workspacePath?: string } | undefined
  const root = harnessSettings?.workspacePath
  if (!root) {
    throw new Error(m.workspaceDirNotConfigured)
  }
  const normalizedRoot = resolve(root)
  const target = resolve(inputPath)
  if (target !== normalizedRoot && !target.startsWith(normalizedRoot + sep)) {
    throw new Error(m.pathOutsideWorkspace)
  }
  // Symlink escape (security audit S06): string prefix comparison can't stop "a link inside the
  // workspace pointing outside the root". When the target doesn't exist (new file), compare
  // against the realpath of the nearest existing ancestor.
  if (!isReallyInsideRoot(target, normalizedRoot)) {
    throw new Error(m.pathOutsideWorkspace)
  }
  return target
}

/**
 * Workspace file browsing + file change review IPC (file operations in the AI workspace
 * directory, the 4th domain of the harness plugin).
 *
 * Channel names are always `harness:<original flat name>` (the 9 flat channels of the former
 * `src/main/ipc/workspace.ts` were renamed one by one). Ownership rationale: these workspace
 * file channels are used only by the harness renderer components (change review and file
 * browser of WorkspacePanel / FileExplorer / FileDiffView, called through the plugin's own
 * `renderer/api.ts` `harnessApi.workspace.*`), and they are AI change-review capability; so
 * they move out of the core group, and disabling the "AI assistant" removes these channels too.
 */
export function workspaceIpcHandlers(): IpcHandlerMap {
  const handlers: IpcHandlerMap = {}
  /** Channel receiver: the plugin's namespace prefix appears only here */
  const handle = (channel: string, handler: (...args: never[]) => unknown): void => {
    handlers[`harness:${channel}`] = handler
  }

  handle('workspace-list-dir', async (dirPath: string) => {
    try {
      const safePath = assertInsideWorkspace(dirPath)
      const entries = await fs.promises.readdir(safePath, { withFileTypes: true })
      return entries
        .filter((d) => !d.name.startsWith('.') || d.name === '.gitignore')
        .map((d) => ({
          name: d.name,
          isDirectory: d.isDirectory(),
          path: join(safePath, d.name)
        }))
        .sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
          return a.name.localeCompare(b.name)
        })
    } catch (error) {
      logger.error('Error in workspace-list-dir:', error)
      throw error
    }
  })

  handle('workspace-read-file', async (filePath: string) => {
    try {
      const safePath = assertInsideWorkspace(filePath)
      return await fs.promises.readFile(safePath, 'utf-8')
    } catch (error) {
      logger.error('Error in workspace-read-file:', error)
      throw error
    }
  })

  /**
   * User saves a file in the workspace (editor Ctrl+S).
   *
   * The user's own saves don't create pending-review changes (pending review only targets model
   * changes); but if this save is the result of a "diff review", it goes through
   * workspace-apply-review.
   */
  handle('workspace-save-file', async (filePath: string, content: string) => {
    try {
      const safePath = assertInsideWorkspace(filePath)
      await fs.promises.writeFile(safePath, content, 'utf-8')
      // Self-write marker: the file watcher must not treat it as an "external change"
      markPathWritten(safePath)
      return true
    } catch (error) {
      logger.error('Error in workspace-save-file:', error)
      throw error
    }
  })

  // --- File change history (traceable / revertible) ---

  /** All pending-review changes in the current workspace (used by explorer badges + tab corner badges) */
  handle('workspace-changes-pending', async () => {
    try {
      syncWorkspaceWatcher()
      const active = activeWorkspace()
      if (!active) return []
      return await listWorkspacePendingChanges(active.id)
    } catch (error) {
      logger.error('Error in workspace-changes-pending:', error)
      return []
    }
  })

  /** Change history of a single file (reverse chronological, newest first) */
  handle('workspace-changes-file', async (filePath: string) => {
    try {
      const safePath = assertInsideWorkspace(filePath)
      return await listFileChangeHistory(safePath)
    } catch (error) {
      logger.error('Error in workspace-changes-file:', error)
      return []
    }
  })

  /** Before/after content of one change (data source for the diff view) */
  handle('workspace-change-content', async (id: number) => {
    try {
      return await readFileChangeContent(id)
    } catch (error) {
      logger.error('Error in workspace-change-content:', error)
      return null
    }
  })

  /** Review: keep (clears the pending-review marker, disk content untouched) */
  handle('workspace-change-keep', async (ids: number[]) => {
    try {
      return await keepFileChanges(Array.isArray(ids) ? ids : [])
    } catch (error) {
      logger.error('Error in workspace-change-keep:', error)
      return 0
    }
  })

  /** Review: revert to before one change (writes the pre-change snapshot back to disk) */
  handle('workspace-change-revert', async (id: number) => {
    try {
      return await revertFileChange(id)
    } catch (error) {
      logger.error('Error in workspace-change-revert:', error)
      return { error: (error as Error).message }
    }
  })

  /**
   * Persist the "diff review result": write the content the user selected in the diff view back
   * to the file, and mark all pending-review changes of that file as kept.
   *
   * If the review result differs from the model's final written content (the user made per-hunk
   * choices), an extra `review` change is recorded so there is a trace of "what was actually
   * left this time".
   */
  handle('workspace-apply-review', async (filePath: string, content: string) => {
    try {
      const safePath = assertInsideWorkspace(filePath)
      const active = activeWorkspace()
      const pending = active ? await listWorkspacePendingChanges(active.id) : []
      const mine = pending.filter((c) => c.path === safePath)

      const current = await fs.promises.readFile(safePath, 'utf-8').catch(() => null)
      await fs.promises.writeFile(safePath, content, 'utf-8')
      markPathWritten(safePath)

      if (active && mine.length > 0) {
        const latest = mine[mine.length - 1]
        if (current !== null && current !== content) {
          await recordFileChange({
            workspaceId: active.id,
            workspaceRoot: active.path,
            realPath: safePath,
            before: current,
            after: content,
            source: 'review',
            status: 'kept',
            topicId: latest.topicId,
            callId: latest.callId,
            note: 'review'
          })
        }
        await keepFileChanges(mine.map((c) => c.id))
      }
      return { ok: true }
    } catch (error) {
      logger.error('Error in workspace-apply-review:', error)
      return { error: (error as Error).message }
    }
  })

  return handlers
}
