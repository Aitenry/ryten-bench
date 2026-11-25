import * as fs from 'fs'
import logger from 'electron-log'
import type { IpcHandlerMap } from '../register'
import { mainFormat, mainMessages } from '../../i18n'
import { getWorkspaceById } from '../../database/mapper/harness/harness'
import { listOpenInAppTargets, openPathInApp } from '../../services/harness/open-in-app'

/**
 * 「在应用中打开」IPC（会话 ⋯ 菜单的子菜单）。
 *
 * 两个通道：
 * - `harness:open-in-app-targets`：本机装了哪些可以打开工作区的应用（文件资源管理器永远在内）；
 * - `harness:open-workspace-in-app`：按**工作区 id**（不是路径）解析出目录再用指定应用打开。
 *
 * 为什么仍然按 id 解析：工作区目录是用户自选的任意目录，不能给渲染层一条「传路径就能拉起程序」
 * 的通道；目录被删/被挪走时也给可读原因，而不是把 OS 的英文失败串丢到界面上。
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
