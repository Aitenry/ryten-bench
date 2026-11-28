import * as path from 'path'
import logger from 'electron-log'
import { settingsStore } from '../context'
import { getAllWorkspaces, updateWorkspacePath } from '../database/mapper/harness/harness'
import { emitAppEvent } from '../plugins/app-events'
import { APP_EVENT_WORKSPACE_CHANGED } from '../plugins/app-hooks'
import type { HarnessSettings } from '../types/settings'
import { isPathInside } from './migration'

/**
 * After the plugin storage path is moved wholesale, point the old paths in the **workspace rows
 * and the active workspace** at the new root as well.
 *
 * Why it is needed: a plugin session's working directory is `<pluginsPath>/<plugin id>/` (see
 * `workshop/workspace.ts`). Once the sources are moved to the new root, the database still holds
 * workspace rows with the old paths, so opening an old session goes to a directory that no
 * longer exists (file tools / file watchers all report ENOENT), while "+ New session" in the
 * plugin creates another row with the new path — the same plugin ends up with two workspaces.
 *
 * Boundaries:
 * - Only rows **under the old root** (including the old root itself) are changed; ordinary
 *   workspaces kept elsewhere are left untouched.
 * - If the target path is already taken by another row (unique constraint), skip it and warn;
 *   never merge the data of two rows.
 * - If the database is unavailable / a row update fails, only warn — **do not veto a file move
 *   that already succeeded** (the data is on disk and the path can be fixed by hand).
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

  // If the active workspace currently sits under the old root, the path in settings must change
  // too; otherwise the UI still points at a directory that no longer exists. This block has its
  // own try, separate from the database changes: when the database cannot be opened for a
  // moment, at least the active directory pointer can still be corrected.
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
