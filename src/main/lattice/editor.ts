import logger from 'electron-log'
import { settingsStore } from '../context'
import { getAllTopics } from '../database/mapper/harness/harness'
import { emitAppEvent } from '../plugins/app-events'
import { APP_EVENT_WORKSPACE_CHANGED } from '../plugins/app-hooks'
import { broadcastWorkshopChanged } from '../ipc/harness/workshop'
import { isPluginOperationRunning } from '../plugins/operation-lock'
import type { HarnessSettings } from '../types/settings'
import { ensurePluginWorkspace } from '../workshop/workspace'
import { promoteSourceToWorkshop, resolvePluginSource } from './sources'
import type { LatticeOpenSourceResult } from './types'

/**
 * "Edit plugin source in conversation" (`lattice:open-source`).
 *
 * Goal: turn the source directory into a **real plugin workspace** and open a plugin session
 * (reuse an existing one, or start a blank session when there is none), instead of only opening it
 * in a file manager. Reuses the existing workshop / harness mechanisms rather than building a
 * separate one:
 *
 * 1. `ensurePluginWorkspace()`: the `<pluginsPath>/<id>/` directory → a `kind='plugin'` workspace
 *    row (idempotent; it also adopts older plugin sessions under it);
 * 2. Topic: if the workspace already has a session with `memory_scope = 'plugin:<id>'`, reuse the
 *    newest one; **otherwise start a blank session and do not create a topic automatically** —
 *    "edit in conversation" opens the source workspace and lets the user say what to change; it
 *    does not send a request on the user's behalf. This used to create a topic titled "Edit the
 *    source of X", which looked in the sidebar like an extra question the user never asked (user
 *    feedback 2026-11-21: "the plugin conversation oddly added this: edit the source of the music
 *    player, I never asked anything"). A blank session is persisted only when the user actually
 *    sends the first message, and the title is generated from that message;
 * 3. Switch the active workspace: write `harness.workspacePath` + `harness.activeWorkspaceId` and
 *    dispatch `app.workspace-changed` (the AI working directory, explorer root, file IPC boundary
 *    and file change review all rely on it);
 * 4. Broadcast `harness:workshop-changed` (the renderer refreshes the draft/plugin workspace list
 *    with it).
 *
 * Reliability boundaries (**no longer pretend the conversation was opened, and no longer silently
 * pop up a file manager**):
 * - The conversation flow above runs only when the source directory really is under the
 *   user-configured plugin storage path (= the workshop draft directory);
 * - When there is no local source (source package download failed during installation, old
 *   installation, local install package), first **fetch the source once on demand** from the
 *   plugin center for **the locally installed version** (see `ensureLatticePluginSource` in
 *   hub.ts) — clicking "source / edit in conversation" means opening the plugin workspace, not
 *   reinstalling the app or restarting;
 * - When it cannot be fetched (not logged in, no source package for that version on the platform,
 *   network failure, pluginsPath not configured), return `{ok:false,error}` so the UI can show a
 *   readable reason; **never fall back to `shell.openPath`** — the user's 2026-11-25 report was
 *   exactly "clicking source popped up a file explorer window";
 * - Source in the userData fallback directory is first migrated to pluginsPath
 *   (`promoteSourceToWorkshop`); only after a successful migration can the conversation flow run.
 */

/**
 * Switch the active workspace to the plugin source directory (write settings + dispatch event).
 *
 * Exactly the same path as the renderer's
 * `systemSettings.update({harness:{workspacePath,activeWorkspaceId}})`: after the settings are
 * persisted, core dispatches `app.workspace-changed`, and the AI assistant restarts the workspace
 * file watcher accordingly.
 * Idempotent: do nothing when this is already the active workspace (avoid rebuilding the file
 * watcher again).
 *
 * It also writes `activeMode='plugin'` + `pluginContent`: when the renderer jumps from the plugin
 * center to `/harness`, HarnessSidebar reads these two fields on mount to return to "plugin" mode;
 * `topicId` may be null (blank session).
 */
function activatePluginWorkspace(
  dir: string,
  workspaceId: number,
  pluginId: string,
  topicId: number | null
): void {
  const harness = settingsStore.get('harness') as HarnessSettings | undefined
  settingsStore.set('harness', {
    ...(harness ?? ({} as HarnessSettings)),
    workspacePath: dir,
    activeWorkspaceId: workspaceId,
    activeMode: 'plugin',
    pluginContent: { workspaceId, topicId, pluginId }
  })
  emitAppEvent(APP_EVENT_WORKSPACE_CHANGED, { workspaceId, workspacePath: dir })
  logger.info(
    `[Lattice] Active workspace switched to plugin source directory: ${dir} (workspace=${workspaceId})`
  )
}

/**
 * Plugin sessions that already exist under this plugin workspace: return the newest one, or `null`.
 *
 * **Look up only, never create**: opening the source means "let the user say what to change", not
 * asking on the user's behalf. It returns null when there is no session, and the renderer then
 * starts a blank plugin session (the first topic is created when the user actually sends a message,
 * with the title generated from that message).
 *
 * Only topics with `memory_scope = 'plugin:<id>'` count: a plugin session must use this plugin's
 * own memory (user feedback 2026-09-28: "memory inside a plugin should be independent"); reusing a
 * topic with a null scope would leak plugin memory into working memory.
 */
async function findPluginTopic(workspaceId: number, pluginId: string): Promise<number | null> {
  const scope = `plugin:${pluginId}`
  const topics = await getAllTopics(workspaceId)
  const existing = topics.find((topic) => topic.memory_scope === scope)
  return existing ? existing.id : null
}

/**
 * Business implementation of `lattice:open-source` (see the file header comment).
 *
 * Returns:
 * - conversation really opened: `{ok:true,workspaceId,topicId?,mode:'conversation',path}` (topicId
 *   absent = blank session)
 * - failure: `{ok:false,error}` (**there is no "quietly opened the file manager" kind of success**)
 */
export async function openLatticePluginSource(
  rawPluginId: unknown
): Promise<LatticeOpenSourceResult> {
  const pluginId = typeof rawPluginId === 'string' ? rawPluginId.trim() : ''
  if (!pluginId) return { ok: false, error: '缺少插件 id' }
  /**
   * An install/update is rewriting the source directory: opening the source now would only reveal
   * half the files, or drop the user into a workspace that is about to be replaced. Refuse
   * explicitly and wait for the install to finish.
   */
  if (isPluginOperationRunning(pluginId)) {
    return { ok: false, error: '插件正在安装/更新，请等它完成后再打开源码' }
  }

  let resolved = resolvePluginSource(pluginId)
  // Source in the userData fallback directory: try migrating it to the user-configured plugin storage path first; only a successful migration allows opening a plugin session
  if (resolved && !resolved.inWorkshop) {
    resolved = promoteSourceToWorkshop(pluginId) ?? resolved
  }

  /**
   * There is no local source at all: fetch it once on demand (source download failure during
   * installation is a known state, see hub.ts). Clicking "source" means opening the plugin
   * workspace; a past download failure should not force the user to uninstall and reinstall.
   */
  let ensureError: string | null = null
  if (!resolved) {
    // Dynamic import avoids an editor ↔ hub module cycle (hub also imports source/session modules)
    const { ensureLatticePluginSource } = await import('./hub')
    const ensured = await ensureLatticePluginSource(pluginId)
    if (ensured.ok) {
      resolved = resolvePluginSource(pluginId)
      if (resolved && !resolved.inWorkshop) {
        resolved = promoteSourceToWorkshop(pluginId) ?? resolved
      }
    } else {
      ensureError = ensured.error ?? '自动下载源码失败'
    }
  }

  if (resolved?.inWorkshop) {
    try {
      const workspace = await ensurePluginWorkspace(pluginId)
      // Reuse an existing plugin session if there is one; otherwise leave it empty (topicId absent)
      // so the renderer starts a blank plugin session and never fabricates a question-like topic
      // such as "edit the source of X" for the user (user feedback 2026-11-21).
      const topicId = await findPluginTopic(workspace.id, pluginId)
      activatePluginWorkspace(workspace.path, workspace.id, pluginId, topicId)
      // The workspace list may have just been created / the draft may have just appeared: have the renderer refresh the plugin sidebar
      broadcastWorkshopChanged()
      logger.info(
        topicId == null
          ? `[Lattice] Opened plugin source (blank session, waiting for the user to speak): ${pluginId} (workspace=${workspace.id})`
          : `[Lattice] Opened plugin source session: ${pluginId} (workspace=${workspace.id}, topic=${topicId})`
      )
      return {
        ok: true,
        workspaceId: workspace.id,
        ...(topicId == null ? {} : { topicId }),
        mode: 'conversation',
        path: workspace.path
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn(`[Lattice] Failed to create/reuse plugin workspace for '${pluginId}': ${message}`)
      return {
        ok: false,
        error: `创建插件工作区失败：${message}。请检查插件的源码目录是否还在（${resolved.path}）。`
      }
    }
  }

  // Source exists but is not under the plugin storage path (pluginsPath not configured / migration failed): report honestly, do not open a folder
  if (resolved) {
    return {
      ok: false,
      error:
        `源码已在本机（${resolved.path}），但它不在「插件存放路径」下，无法创建插件工作区。` +
        '请到 设置 → 助手 → 插件工坊 配置插件存放路径后重试。'
    }
  }

  return {
    ok: false,
    error:
      ensureError ?? `本机没有 '${pluginId}' 的源码目录：请先在插件中心安装（会自动下载源码）后再试`
  }
}
