import * as fs from 'fs'
import * as path from 'path'
import {
  createWorkspace,
  findWorkspaceByPath,
  getWorkspacesByKind,
  reparentPluginTopics,
  setWorkspaceKind,
  updateWorkspace
} from '../database/mapper/harness/harness'
import type { WorkspaceRow } from '../database/mapper/harness/harness'
import { draftDir } from './paths'
import { draftSummary } from './service'

/**
 * The **working directory** of a plugin session: this plugin's own source directory
 * (`<plugin storage path>/<plugin id>/`).
 *
 * Why make it a real workspace row instead of just swapping the root in the renderer:
 * the AI working directory (Runtime's workspacePath), the explorer root, the file IPC
 * boundary (`assertInsideWorkspace`) and file change review all rely solely on
 * `harness.workspacePath` + `activeWorkspaceId` — turning the plugin directory into a
 * workspace and switching to it when opening a session leaves that whole chain untouched,
 * and the topic row records `workspace_id`, so **reopening this session (even after an app
 * restart) still lands in the plugin directory**.
 *
 * User requirement (2026-09-28: "a session created in plugin mode still uses the workspace
 * selected in work mode, and so does the explorer"): a plugin session must not occupy the
 * workspace selected in work mode.
 *
 * These workspaces **do not count as user workspaces**: the sidebar "Work" list filters
 * them out by path and they appear only in plugin mode (expanding a plugin row shows that
 * plugin's own sessions; same-day requirement: "plugin directories must not enter the
 * 'Work' list, they belong only to that plugin").
 *
 * Lifecycle: **created on demand** (the first time a session is opened for this plugin),
 * renamed together with the plugin; deleting the draft does **not** touch this row or the
 * sessions beneath it (removing source is not removing conversations, consistent with
 * uninstalling a plugin: code removal and data retention are two separate things) —
 * recreating a draft with the same name makes those sessions reappear under the plugin row.
 */

/** Plugin workspace for one plugin (null when absent, never created here) */
export async function findPluginWorkspace(pluginId: string): Promise<WorkspaceRow | null> {
  const dir = draftDir(pluginId)
  return await findWorkspaceByPath(dir)
}

/**
 * All current "plugin workspaces": workspace row → the plugin id it maps to.
 *
 * The sidebar uses this list for two things, and **only this one source** is consulted for
 * both (paths are not recomputed in the renderer):
 * - pairing a plugin row with its own sessions (`draftId` → `workspaceId`);
 * - filtering plugin workspaces out of the "Work" list (2026-09-28 requirement: "plugin
 *   directories must not enter the 'Work' list").
 *
 * Criterion = the row's own `kind='plugin'` (the single source of truth since 0010). It used
 * to be computed as "path is a direct child of the plugin storage path" — once the plugin
 * root config changed, or a user happened to pick a workspace under the plugin root, the
 * same record would be claimed by both lists; `kind` does not have that problem. Plugin
 * workspaces whose **draft has already been deleted** still count (kind does not change
 * when the draft disappears), which is exactly the semantics needed here.
 */
export async function listPluginWorkspaces(): Promise<
  { draftId: string; workspaceId: number; path: string }[]
> {
  const rows = await getWorkspacesByKind('plugin')
  const result: { draftId: string; workspaceId: number; path: string }[] = []
  for (const row of rows) {
    if (!row.path) continue
    result.push({
      draftId: path.basename(path.resolve(row.path)),
      workspaceId: row.id,
      path: row.path
    })
  }
  return result
}

/**
 * Get (creating if necessary) the "plugin workspace" of one plugin. Idempotent: a plugin
 * directory always maps to exactly one row.
 *
 * Also **rehomes old sessions**: plugin sessions opened before the plugin working directory
 * shipped (2026-09-28) already carry `plugin:<id>` on the topic, but their workspace_id still
 * points at the workspace back then — collect them under the plugin workspace so that
 * reopening those sessions lands in the plugin directory (see the mapper's
 * `reparentPluginTopics`).
 */
export async function ensurePluginWorkspace(pluginId: string): Promise<WorkspaceRow> {
  const dir = draftDir(pluginId)
  const name = draftSummary(pluginId).title || pluginId
  const existing = await findPluginWorkspace(pluginId)
  if (existing) {
    /**
     * The old row exists but the source directory is gone (user deleted the draft / changed
     * the plugin storage path): do not return this row as a usable workspace — after
     * switching to it, the AI's file tools and watchers would all hit ENOENT on a missing
     * directory. Keep the session rows themselves (removing source is not removing
     * conversations) but report honestly that it cannot be opened right now.
     */
    if (!fs.existsSync(dir)) {
      throw new Error(
        `插件源码目录不存在：${dir}（源码可能已被删除或移走；重新下载/导入插件后再开会话）`
      )
    }
    if (existing.name !== name) {
      // Plugin was renamed: the workspace name follows (these rows are not in the "Work" list, so the user will not rename them manually)
      await updateWorkspace(existing.id, { name })
    }
    // Rows created before 0010 still have the default 'user' kind: classify in place on claim so they are not pushed back into the "Work" list
    if (existing.kind !== 'plugin') await setWorkspaceKind(existing.id, 'plugin')
    await reparentPluginTopics(existing.id, `plugin:${pluginId}`)
    return { ...existing, name, kind: 'plugin' }
  }
  /**
   * Create a new row only when the source directory **actually exists**.
   *
   * Why the disk check is required: after the plugin storage path changes, the plugin
   * remembered by plugin mode and the old sessions still exist, but its source may not be
   * under the new root. This used to call `createWorkspace` directly, silently producing a
   * workspace row pointing at a nonexistent directory (that is where the user's 2026-11-23
   * `fs.watch ENOENT` log came from: the old `personal-ledger` workspace lived under the old
   * plugin root, and switching to the new plugin root created another row with a new path).
   * Leave existing rows alone (old sessions' ownership and history must be preserved) and
   * simply stop adding rows for nonexistent directories.
   */
  if (!fs.existsSync(dir)) {
    throw new Error(
      `插件源码目录不存在：${dir}（插件可能已被删除或移走；请恢复插件存放路径，或重新导入插件后再开会话）`
    )
  }
  const id = await createWorkspace(name, dir, 'plugin')
  const created = await findPluginWorkspace(pluginId)
  if (!created) {
    // It was just created, so it must be readable; if not, the database has another problem — throw instead of inventing a fake row
    throw new Error(`插件工作区创建后读不回来（id=${id}，path=${dir}）`)
  }
  await reparentPluginTopics(created.id, `plugin:${pluginId}`)
  return created
}

/** Sync the workspace name after a plugin rename (no-op when there is no matching workspace) */
export async function syncPluginWorkspaceName(pluginId: string, name: string): Promise<void> {
  try {
    const existing = await findPluginWorkspace(pluginId)
    if (existing && existing.name !== name) await updateWorkspace(existing.id, { name })
  } catch {
    // Plugin storage path not configured / database read failed: the rename already completed, and skipping the workspace name sync affects nothing
  }
}
