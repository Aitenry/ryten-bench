import { BrowserWindow, dialog, shell } from 'electron'
import logger from 'electron-log'
import { safeSend } from '../../safe-send'
import type { IpcHandlerMap } from '../register'
import type { WorkshopRendererProbe } from '../../../shared/harness/workshop'
import { resolveProbeResult } from '../../workshop/probe'
import {
  adoptPluginsRoot,
  build,
  createDraftFromTemplate,
  dirOf,
  draftDetail,
  disable,
  exportZip,
  lastReport,
  listDraftSummaries,
  publish,
  readFile,
  removeDraft,
  renameDraft,
  unpublish,
  verify,
  workshopState
} from '../../workshop/service'
import { configurePluginsRoot } from '../../workshop/paths'
import { remapWorkspacePathsUnderRoot } from '../../storage/workspace-refs'
import {
  ensurePluginWorkspace,
  listPluginWorkspaces,
  syncPluginWorkspaceName
} from '../../workshop/workspace'
import {
  clearActiveWorkspaceIfRemoved,
  clearRememberedPluginContent
} from '../../workshop/active-workspace'
import { workshopHost } from '../../workshop/host'

/**
 * Plugin Workshop IPC (the 6th domain of the harness plugin).
 *
 * Channel names are always `harness:workshop-*`: when the "AI assistant" is disabled, the
 * workshop settings page and all its actions disappear together (the same lifecycle semantics
 * as the existing 5 domains).
 *
 * Two design constraints:
 * - **Actions don't throw**: the panel must be able to show the user the exact wording of
 *   "build failed / verification failed / install failed", so everything returns
 *   `{ ok, error?, data? }` (`workshop-probe-result` is the exception: it is a renderer reply
 *   and returns a boolean);
 * - **broadcast `workshop-changed` after any change**: when the AI edits a draft / builds /
 *   publishes in a conversation, a user with the settings page open must see the status change
 *   immediately instead of refreshing manually.
 *
 * The workshop's 4 AI tools are **not mounted here**: they go through the tool registry, and
 * users check them in "Settings → Agent → Tools" (all tools in the app follow this path; the
 * workshop gets no special entry point).
 */

/**
 * Main process → renderer event channels (sender only): `harness:workshop-changed` (the panel
 * refetches its lists) and `harness:workshop-probe` (renderer real-time probe, see
 * workshop/probe.ts). The renderer subscribes through the preload system bridge, so no
 * whitelist registration is needed.
 */

/** Broadcast "workshop state changed" (the renderer may need to re-fetch plugin modules/styles) */
export function broadcastWorkshopChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    safeSend(win.webContents, 'harness:workshop-changed', { at: Date.now() })
  }
}

/** Unified result wrapper (failures don't throw; the panel shows the raw error text) */
async function act<T>(
  run: () => Promise<T> | T
): Promise<{ ok: boolean; error?: string; data?: T }> {
  try {
    return { ok: true, data: await run() }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn('[Workshop] Action failed:', message)
    return { ok: false, error: message }
  }
}

export function workshopIpcHandlers(): IpcHandlerMap {
  const handlers: IpcHandlerMap = {}
  /** Channel receiver: the plugin's namespace prefix appears only here */
  const handle = (channel: string, handler: (...args: never[]) => unknown): void => {
    handlers[`harness:${channel}`] = handler
  }

  /**
   * Workshop state (panel title: availability + root directory + draft count).
   * Also includes the **plugin workspace list** (plugin id → workspace row): the sidebar uses
   * it to match plugin rows with their own sessions and to filter plugin workspaces out of the
   * "Workspaces" list (see main/workshop/workspace.ts).
   */
  handle('workshop-state', async () => ({
    ...workshopState(),
    pluginWorkspaces: await listPluginWorkspaces()
  }))

  /** All drafts (including build/install/latest verification summaries) */
  handle('workshop-list', () => listDraftSummaries())

  /** Single draft details (file tree + manifest + directory) */
  handle('workshop-detail', (id: string) => draftDetail(id))

  /** Draft file content (panel read-only preview) */
  handle('workshop-read-file', (id: string, relPath: string) => readFile(id, relPath))

  /** Latest verification report */
  handle('workshop-report', (id: string) => lastReport(id))

  handle(
    'workshop-build',
    async (id: string, dev?: boolean) =>
      await act(async () => {
        const info = await build(id, { dev: Boolean(dev) })
        broadcastWorkshopChanged()
        return info
      })
  )

  handle(
    'workshop-verify',
    async (id: string, probe?: boolean) =>
      await act(async () => {
        const report = await verify(id, { probeRenderer: probe })
        broadcastWorkshopChanged()
        return report
      })
  )

  handle(
    'workshop-publish',
    async (id: string) =>
      await act(async () => {
        const result = await publish(id)
        broadcastWorkshopChanged()
        return result
      })
  )

  /** Rename plugin (changes the display name: draft title + manifest name; directory name/id unchanged) */
  handle(
    'workshop-rename',
    async (id: string, title: string) =>
      await act(async () => {
        const summary = renameDraft(id, title)
        // The plugin session's working directory (plugin workspace) name follows the plugin
        await syncPluginWorkspaceName(id, summary.title)
        broadcastWorkshopChanged()
        return summary
      })
  )

  /**
   * Get (creating if needed) a plugin's **plugin workspace** — a plugin session's working
   * directory is its source directory (`<plugin storage path>/<plugin id>/`, see
   * main/workshop/workspace.ts).
   *
   * The sidebar calls it on "plugin row + new session" and then switches over like a normal
   * workspace: the AI working directory, the file explorer and the file boundary all follow
   * this workspace (user wording 2026-09-28: "creating a session in plugin mode still uses the
   * workspace selected in work mode, and the file explorer too").
   */
  handle(
    'workshop-ensure-workspace',
    async (id: string) =>
      await act(async () => {
        const workspace = await ensurePluginWorkspace(id)
        // The workspace list changed (one may have just been created): broadcast to the renderer
        // so the sidebar knows this plugin row now has a session to expand and should filter
        // this workspace out of the "Workspaces" list
        broadcastWorkshopChanged()
        return workspace
      })
  )

  handle(
    'workshop-disable',
    async (id: string) =>
      await act(async () => {
        disable(id)
        broadcastWorkshopChanged()
        return true
      })
  )

  handle(
    'workshop-unpublish',
    async (id: string) =>
      await act(async () => {
        unpublish(id)
        broadcastWorkshopChanged()
        return true
      })
  )

  handle(
    'workshop-create',
    async (input: { id: string; title?: string; template?: string; description?: string }) =>
      await act(async () => {
        const result = createDraftFromTemplate({
          id: input?.id,
          title: input?.title,
          // Omitted = default 'full' (all content): template selection is only used on demand by
          // the assistant side
          template: input?.template as never,
          description: input?.description
        })
        broadcastWorkshopChanged()
        return { id: result.meta.id, files: result.files, dir: result.dir }
      })
  )

  /**
   * Open a system picker to configure the **plugin storage path** (the source root of all
   * plugins; preset to the install directory on first launch).
   *
   * This native dialog can't be clicked by automation, so tooling goes through
   * `workshop-set-root` (explicit path) instead.
   */
  handle(
    'workshop-pick-root',
    async () =>
      await act(async () => {
        const picked = await dialog.showOpenDialog({
          title: '选择插件的存放路径（每个插件会在它下面占一个文件夹）',
          properties: ['openDirectory', 'createDirectory']
        })
        if (picked.canceled || picked.filePaths.length === 0) {
          return { canceled: true as const }
        }
        const result = adoptPluginsRoot(picked.filePaths[0])
        if (result.previousDir) {
          await remapWorkspacePathsUnderRoot(result.previousDir, result.dir)
        }
        broadcastWorkshopChanged()
        return { canceled: false as const, ...result }
      })
  )

  /** Configure the plugin storage path by explicit path (panel/tooling use; empty `dir` = clear the config) */
  handle(
    'workshop-set-root',
    async (dir: string) =>
      await act(async () => {
        if (!dir) {
          workshopHost().setPluginsRoot('')
          configurePluginsRoot('')
          broadcastWorkshopChanged()
          return { dir: '', moved: [] as string[] }
        }
        const result = adoptPluginsRoot(dir)
        if (result.previousDir) {
          await remapWorkspacePathsUnderRoot(result.previousDir, result.dir)
        }
        broadcastWorkshopChanged()
        return result
      })
  )

  handle(
    'workshop-remove',
    async (id: string) =>
      await act(async () => {
        // Record the directory first: draftDir can still be computed after removal, but
        // resetting the active workspace must be based on the removed directory
        let removedDir = ''
        try {
          removedDir = dirOf(id)
        } catch {
          // Plugin storage path not configured: removeDraft reports "nothing removed" itself,
          // so there is no active directory to reset here
        }
        removeDraft(id)
        // Removing exactly the current active workspace (plugin mode has its source open): clear
        // the active workspace, otherwise AI file tools / the file explorer still point at a
        // nonexistent directory.
        if (removedDir) clearActiveWorkspaceIfRemoved(removedDir)
        // Whether or not it is the active workspace, don't let "the last content viewed in
        // plugin mode" keep pointing at it
        clearRememberedPluginContent(id)
        broadcastWorkshopChanged()
        return true
      })
  )

  handle('workshop-export', async (id: string) => await act(async () => await exportZip(id)))

  /** Open the draft directory in the system file manager (panel "Open directory") */
  handle(
    'workshop-open-dir',
    async (id: string) =>
      await act(async () => {
        const dir = dirOf(id)
        const error = await shell.openPath(dir)
        if (error) throw new Error(error)
        return dir
      })
  )

  /** Reply from the renderer probe (see workshop/probe.ts; returns false for a late result after timeout) */
  handle('workshop-probe-result', (payload: unknown) => {
    const accepted = resolveProbeResult(payload as WorkshopRendererProbe & { probeId?: string })
    if (!accepted) {
      logger.warn('[Workshop] Probe result discarded (request timed out)')
    }
    return accepted
  })

  return handlers
}
