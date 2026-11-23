import * as path from 'path'
import logger from 'electron-log'
import { settingsStore } from '../context'
import { getAllWorkspaces, updateWorkspacePath } from '../database/mapper/harness/harness'
import { emitAppEvent } from '../plugins/app-events'
import { APP_EVENT_WORKSPACE_CHANGED } from '../plugins/app-hooks'
import type { HarnessSettings } from '../types/settings'
import { isPathInside } from './migration'

/**
 * 插件存放路径整体搬迁后，把**工作区行与活动工作区**里的旧路径一起改到新根下。
 *
 * 为什么需要它：插件会话的工作目录就是 `<pluginsPath>/<插件 id>/`（见
 * `workshop/workspace.ts`）。源码被搬到新根后，数据库里还留着旧路径的 workspace 行，
 * 直接打开旧会话就会去一个已经不存在的目录（文件工具 / 文件监听全报 ENOENT），
 * 而插件里「＋ 新建会话」又会另建一条新路径的行——同一个插件出现两条工作区。
 *
 * 边界：
 * - 只改**位于旧根之下**（含旧根本身）的行，用户放在别处的普通工作区一律不动；
 * - 目标路径已被另一行占用（唯一约束）时跳过并告警，绝不合并两行数据；
 * - 数据库不可用 / 改行失败只告警，**不否决已经成功的文件搬迁**（数据在盘上，路径可手工修）。
 */
export async function remapWorkspacePathsUnderRoot(
  oldRootRaw: string,
  newRootRaw: string
): Promise<number> {
  const oldRoot = typeof oldRootRaw === 'string' ? oldRootRaw.trim() : ''
  const newRoot = typeof newRootRaw === 'string' ? newRootRaw.trim() : ''
  if (!oldRoot || !newRoot) return 0
  if (pathKey(oldRoot) === pathKey(newRoot)) return 0

  let updated = 0
  try {
    const rows = await getAllWorkspaces()
    const taken = new Set(rows.map((row) => pathKey(row.path)))

    for (const row of rows) {
      const nextPath = remapPath(oldRoot, newRoot, row.path)
      if (!nextPath || pathKey(nextPath) === pathKey(row.path)) continue
      if (taken.has(pathKey(nextPath))) {
        logger.warn(
          `[Storage] Workspace path remap skipped (target already exists): ${row.path} -> ${nextPath}`
        )
        continue
      }
      try {
        if (await updateWorkspacePath(row.id, nextPath)) {
          taken.delete(pathKey(row.path))
          taken.add(pathKey(nextPath))
          updated += 1
        }
      } catch (err) {
        logger.warn(
          `[Storage] Failed to remap workspace path (row ${row.id}): ${row.path} -> ${nextPath}`,
          err
        )
      }
    }
  } catch (err) {
    logger.warn('[Storage] Failed to remap workspace rows (storage files were already moved):', err)
  }

  // 当前活动工作区如果正落在旧根下，设置里的路径也要跟着换；否则界面还指着不存在的目录。
  // 这一段与数据库改动分开 try：库暂时打不开时，至少活动目录的指向还能修对。
  try {
    const rawHarness = settingsStore.get('harness')
    const harness =
      rawHarness && typeof rawHarness === 'object' && !Array.isArray(rawHarness)
        ? (rawHarness as HarnessSettings)
        : undefined
    const activePath = typeof harness?.workspacePath === 'string' ? harness.workspacePath : ''
    const nextActive = activePath ? remapPath(oldRoot, newRoot, activePath) : null
    if (harness && nextActive && pathKey(nextActive) !== pathKey(activePath)) {
      settingsStore.set('harness', { ...harness, workspacePath: nextActive })
      emitAppEvent(APP_EVENT_WORKSPACE_CHANGED, {
        workspaceId: harness.activeWorkspaceId ?? null,
        workspacePath: nextActive
      })
      logger.info(`[Storage] Active workspace path remapped: ${activePath} -> ${nextActive}`)
    }
  } catch (err) {
    logger.warn('[Storage] Failed to remap the active workspace path:', err)
  }

  if (updated > 0) {
    logger.info(
      `[Storage] Remapped ${updated} workspace path(s) after storage move: ${oldRoot} -> ${newRoot}`
    )
  }
  return updated
}

function remapPath(oldRoot: string, newRoot: string, target: string): string | null {
  if (typeof target !== 'string' || target.trim() === '') return null
  if (pathKey(target) === pathKey(oldRoot)) return path.resolve(newRoot)
  if (!isPathInside(target, oldRoot)) return null
  const relative = path.relative(path.resolve(oldRoot), path.resolve(target))
  return path.join(path.resolve(newRoot), relative)
}

function pathKey(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}
