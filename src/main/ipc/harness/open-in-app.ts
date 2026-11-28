import * as fs from 'fs'
import logger from 'electron-log'
import type { IpcHandlerMap } from '../register'
import { mainFormat, mainMessages } from '../../i18n'
import { getWorkspaceById } from '../../database/mapper/harness/harness'
import { listOpenInAppTargets, openPathInApp } from '../../services/harness/open-in-app'

/**
 * "Open in app" IPC (the submenu of the session ⋯ menu).
 *
 * Two channels:
 * - `harness:open-in-app-targets`: which apps installed on this machine can open the workspace
 *   (File Explorer is always included);
 * - `harness:open-workspace-in-app`: resolves the directory by **workspace id** (not path) and
 *   opens it with the given app.
 *
 * Why still resolve by id: the workspace directory is any directory the user picked, so the
 * renderer must not get a channel where "passing a path launches a program"; and when the
 * directory was deleted/moved we return a readable reason instead of dumping the OS's English
 * failure string into the UI.
 */
export function openInAppIpcHandlers(): IpcHandlerMap {
  const handlers: IpcHandlerMap = {}
  const handle = (channel: string, handler: (...args: never[]) => unknown): void => {
    handlers[`harness:${channel}`] = handler
  }

  handle('open-in-app-targets', async () => {
    try {
      return await listOpenInAppTargets()
    } catch (error) {
      logger.error('Error in open-in-app-targets:', error)
      return []
    }
  })

  handle('open-workspace-in-app', async (workspaceId: number, appId: string) => {
    try {
      const messages = mainMessages().error
      const row = await getWorkspaceById(workspaceId)
      if (!row) return { ok: false, error: messages.workspaceNotFound }
      const stat = await fs.promises.stat(row.path).catch(() => null)
      if (!stat?.isDirectory()) {
        return { ok: false, error: mainFormat(messages.workspaceDirMissing, { path: row.path }) }
      }
      const result = await openPathInApp(row.path, appId)
      if (result.ok) logger.info(`Opened workspace ID=${workspaceId} in "${appId}" (${row.path})`)
      return result
    } catch (error) {
      logger.error('Error in open-workspace-in-app:', error)
      return { ok: false, error: (error as Error).message }
    }
  })

  return handlers
}
