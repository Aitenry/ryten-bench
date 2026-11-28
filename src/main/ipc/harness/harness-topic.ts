import { shell } from 'electron'
import logger from 'electron-log'
import * as fs from 'fs'
import type { IpcHandlerMap } from '../register'
import { todoStore } from '../../runtime/harness/todo'
import { goalStore } from '../../runtime/harness/goal'
import { planModeStore } from '../../runtime/harness/plan-mode'
import { teamModeStore } from '../../runtime/harness/team-mode'
import { jobsRegistry } from '../../runtime/harness/jobs'
import { subagentSessions } from '../../runtime/harness/subagent-sessions'
import { teamStore } from '../../runtime/harness/team'
import { SpillStore } from '../../runtime/harness/spill'
import { questionService } from '../../runtime/harness/ask'
import { permissionGate } from '../../runtime/harness/permission-gate'
import { getToolOutputStore } from '../../runtime/harness/tool-output-store'
import { deleteCompactionByTopic } from '../../database/mapper/harness/compaction'
import { settingsStore } from '../../context'
import { mainFormat, mainMessages } from '../../i18n'
import { harnessQueue } from '../../services/harness/queue-store'
import { clearTopicCache } from '../../services/harness/preload-cache'
import type { HarnessSettings } from '../../types/settings'
import { isChatScope } from '../../../shared/harness/memory-scope'
import { memoryScopeRoot, parseMemoryScope } from '../../services/harness/memory-scope'
import { resolveTopicMemoryScope } from '../../services/harness/topic-scope'
import { activateChatTopic } from '../../services/harness/chat/activation'
import { isUserSelectedRoot, workspacePathKey } from '../../workspace/selected-roots'
import {
  getAllWorkspaces,
  createWorkspace,
  updateWorkspace,
  deleteWorkspace,
  getWorkspaceById,
  setTopicPinned,
  setTopicArchived,
  forkTopic,
  getAllTopics,
  getAllTopicsPaginated,
  getArchivedTopics,
  getTopicById,
  createTopic,
  updateTopic,
  deleteTopic,
  getDialoguesByTopicId,
  getDialoguesByTopicIdPaginated,
  addDialogue,
  deleteDialoguesByTopicId,
  deleteDialogueById,
  getUsageByTopic
} from '../../database/mapper/harness/harness'
import type { HarnessTopicRow, HarnessDialogueRow } from '../../database/mapper/harness/harness'

/**
 * Harness workspace / topic / dialogue record CRUD IPC (the 2nd domain of the AI assistant).
 *
 * Channel names are uniformly `harness:<original flat name>` (the 16 flat channels of the former
 * `src/main/ipc/harness-topic.ts` were renamed one by one: 4 workspaces + 6 topics + 6
 * dialogue/usage; parameters and return types are unchanged), registered at startup by
 * `src/main/system/harness.ts` and removed together on exit.
 */
export function harnessTopicIpcHandlers(): IpcHandlerMap {
  const handlers: IpcHandlerMap = {}
  /** Inbound channel: the `harness:` prefix appears only here */
  const handle = (channel: string, handler: (...args: never[]) => unknown): void => {
    handlers[`harness:${channel}`] = handler
  }

  // --- Harness Workspace IPC handlers ---

  handle('workspace-get-all', async () => {
    try {
      return await getAllWorkspaces()
    } catch (error) {
      logger.error('Error in workspace-get-all:', error)
      throw error
    }
  })

  handle('workspace-create', async (name: string, path: string) => {
    try {
      // Trust-source hardening (security audit S03): the workspace directory must come from a
      // folder the user picked via the system dialog, or from an already registered workspace
      // row. If only the string were validated, an injected renderer could turn any drive into
      // a workspace root, and every file IPC's assertInsideWorkspace would then target it.
      if (typeof path !== 'string' || !path.trim()) {
        throw new Error(mainMessages().error.invalidPathAbsolute)
      }
      const knownRoot =
        isUserSelectedRoot(path) ||
        (await getAllWorkspaces()).some(
          (workspace) => workspacePathKey(workspace.path) === workspacePathKey(path)
        )
      if (!knownRoot) {
        logger.warn('[Workspace] Rejected workspace-create for a folder not picked by the user')
        throw new Error(mainMessages().error.workspacePathNotSelected)
      }
      return await createWorkspace(name, path)
    } catch (error) {
      logger.error('Error in workspace-create:', error)
      throw error
    }
  })

  handle('workspace-update', async (id: number, updates: { name: string }) => {
    try {
      return await updateWorkspace(id, updates)
    } catch (error) {
      logger.error('Error in workspace-update:', error)
      throw error
    }
  })

  /**
   * Open the workspace directory in the system file manager (sidebar workspace row
   * "⋯ → Show in Folder").
   *
   * The input is the **workspace id, not a path**: the main process looks up the directory by
   * row and opens it, so the renderer cannot use this channel to open an arbitrary path (a
   * workspace directory is user-selected and may sit outside the AI workspace root, so the
   * `assertInsideWorkspace` boundary does not apply). Check first that the directory still
   * exists: when it was deleted or moved, return a readable reason instead of surfacing the raw
   * failure string from `shell.openPath` in the UI.
   */
  handle('workspace-open-dir', async (id: number) => {
    try {
      const messages = mainMessages().error
      const row = await getWorkspaceById(id)
      if (!row) return { ok: false, error: messages.workspaceNotFound }
      const stat = await fs.promises.stat(row.path).catch(() => null)
      if (!stat?.isDirectory()) {
        return { ok: false, error: mainFormat(messages.workspaceDirMissing, { path: row.path }) }
      }
      const failure = await shell.openPath(row.path)
      return failure ? { ok: false, error: failure } : { ok: true, data: row.path }
    } catch (error) {
      logger.error('Error in workspace-open-dir:', error)
      return { ok: false, error: (error as Error).message }
    }
  })

  handle('workspace-delete', async (id: number) => {
    try {
      clearTopicCache()
      return await deleteWorkspace(id)
    } catch (error) {
      logger.error('Error in workspace-delete:', error)
      throw error
    }
  })

  // --- Harness Topic IPC handlers ---

  handle('harness-topic-get-all', async (workspaceId: number) => {
    try {
      return await getAllTopics(workspaceId)
    } catch (error) {
      logger.error('Error in harness-topic-get-all:', error)
      throw error
    }
  })

  handle(
    'harness-topic-get-paginated',
    async (workspaceId: number, page: number, pageSize: number) => {
      try {
        return await getAllTopicsPaginated(workspaceId, page, pageSize)
      } catch (error) {
        logger.error('Error in harness-topic-get-paginated:', error)
        throw error
      }
    }
  )

  /** Archived sessions across all workspaces ("Archived" sidebar group; newest first) */
  handle('harness-topic-get-archived', async () => {
    try {
      return await getArchivedTopics()
    } catch (error) {
      logger.error('Error in harness-topic-get-archived:', error)
      throw error
    }
  })

  handle('harness-topic-get-by-id', async (id: number) => {
    try {
      return await getTopicById(id)
    } catch (error) {
      logger.error('Error in harness-topic-get-by-id:', error)
      throw error
    }
  })

  handle(
    'harness-topic-create',
    async (
      workspaceId: number,
      title: string,
      model?: string,
      selectedTools?: string,
      /** Memory scope (`plugin:<plugin id>` / `chat`; empty = fall back by workspace kind) */
      memoryScope?: string | null,
      /**
       * Team collaboration toggle (Agent Teams): a blank session's draft is persisted along with
       * the topic; omitted = off
       */
      teamMode?: boolean
    ) => {
      try {
        clearTopicCache()
        // Single source of truth for scope: an explicit value wins; otherwise fall back by
        // workspace kind (chat / plugin workspaces must not silently drop back to workspace
        // memory just because the renderer's pending value is empty).
        const scope = await resolveTopicMemoryScope(workspaceId, memoryScope)
        const topicId = await createTopic(workspaceId, title, model, selectedTools, scope, teamMode)
        // Each session in "Chat" mode has its own working directory: switch the active
        // directory as soon as the topic is created.
        // Do it **here** (not only in the renderer): the first message of a new session, forked
        // sessions, and any other topic-creation path all go through this channel, so the
        // model's file tools do not scatter files into the "root" directory and then fail to
        // find them after switching sessions (observed 2026-10-11: files written in the first
        // round landed in chat/ and were gone after switching to chat/<id>/).
        // A failed switch must not affect topic creation: log it and retry on the next turn or
        // when the session is opened.
        if (isChatScope(scope)) {
          try {
            await activateChatTopic(topicId)
          } catch (err) {
            logger.warn(
              '[Chat] Failed to switch session directory for new topic (topic creation unaffected):',
              err
            )
          }
        }
        return topicId
      } catch (error) {
        logger.error('Error in harness-topic-create:', error)
        throw error
      }
    }
  )

  handle(
    'harness-topic-update',
    async (
      id: number,
      updates: Partial<Pick<HarnessTopicRow, 'title' | 'model' | 'selected_tools'>>
    ) => {
      try {
        clearTopicCache()
        return await updateTopic(id, updates)
      } catch (error) {
        logger.error('Error in harness-topic-update:', error)
        throw error
      }
    }
  )

  /** Pin / unpin (only touches pinned_at, not updated_at, so it keeps its active slot) */
  handle('harness-topic-set-pinned', async (id: number, pinned: boolean) => {
    try {
      clearTopicCache()
      return await setTopicPinned(id, pinned)
    } catch (error) {
      logger.error('Error in harness-topic-set-pinned:', error)
      throw error
    }
  })

  /** Archive / unarchive (likewise leaves updated_at untouched) */
  handle('harness-topic-set-archived', async (id: number, archived: boolean) => {
    try {
      clearTopicCache()
      return await setTopicArchived(id, archived)
    } catch (error) {
      logger.error('Error in harness-topic-set-archived:', error)
      throw error
    }
  })

  /**
   * Fork a session: copy the topic row and all dialogues into a new independent session, and
   * return the new row.
   *
   * The title comes from the renderer (e.g. `Original title (fork)`, following the UI
   * language); the main process only handles data, not copy. Return the whole row rather than
   * the id: the UI inserts it into the list and opens it immediately without another query.
   */
  handle('harness-topic-fork', async (id: number, title: string) => {
    try {
      clearTopicCache()
      return await forkTopic(id, title)
    } catch (error) {
      logger.error('Error in harness-topic-fork:', error)
      throw error
    }
  })

  handle('harness-topic-delete', async (id: number) => {
    try {
      clearTopicCache()
      // Clear the topic's todo list (process-level todoStore)
      todoStore.clear(id)
      // Clear the topic's goals (goalStore: cache + database row)
      await goalStore.delete(id)
      // Plan mode: rows cascade with the topic, so only drop the in-memory cache here
      planModeStore.forget(id)
      teamModeStore.forget(id)
      // Clear the topic's background jobs (kill them all)
      jobsRegistry.clearTopic(id)
      // Clear the topic's subagent resume sessions (interrupt them all)
      subagentSessions.clearTopic(id)
      // Clear the topic's shared task board (Agent Teams: tasks are owned by topicId)
      teamStore.clearTopic(id)
      // Clear the topic's compaction checkpoints (topic_compactions table)
      await deleteCompactionByTopic(id)
      // Clear the topic's tool-result spill files (spill directory)
      // The location is derived from **this session's scope**: workspace sessions use
      // <memoryPath>/workspace-<id>/spill/, plugin sessions use <memoryPath>/plugin-<id>/spill/
      // (same convention as the Runtime memoryPath; otherwise the topic is deleted but the spill
      // files stay behind in that scope directory).
      const harnessSettings = settingsStore.get('harness') as HarnessSettings | undefined
      const topicRows = await getTopicById(id).catch(() => [])
      const topicRow = topicRows[0]
      SpillStore.pruneTopic(
        harnessSettings?.workspacePath || undefined,
        memoryScopeRoot(
          harnessSettings?.memoryPath || undefined,
          parseMemoryScope(topicRow?.memory_scope, topicRow?.workspace_id ?? 0)
        ),
        id
      )
      // Clear the topic's tool-result details (ls/glob/grep/execute results opened from cards)
      getToolOutputStore()?.removeTopic(id)
      // Clear the topic's interjection queue (including the pending-injection buffer: that
      // interjection disappeared along with the topic)
      harnessQueue.clear(id)
      // Pending questions / approvals for the topic are settled as "cancelled / rejected".
      // Otherwise, once this session is deleted, that call would never get an answer (the tool
      // card stays in "running…" and the main process keeps a hanging promise) — questions and
      // approvals are isolated per session, so they must be closed out together with it.
      questionService.abortTopic(id)
      permissionGate.abortTopic(id)
      return await deleteTopic(id)
    } catch (error) {
      logger.error('Error in harness-topic-delete:', error)
      throw error
    }
  })

  // --- Harness Dialogue IPC handlers ---

  handle('harness-dialogue-get-by-topic', async (topicId: number) => {
    try {
      return await getDialoguesByTopicId(topicId)
    } catch (error) {
      logger.error('Error in harness-dialogue-get-by-topic:', error)
      throw error
    }
  })

  handle(
    'harness-dialogue-get-by-topic-paginated',
    async (topicId: number, page: number, pageSize: number) => {
      try {
        return await getDialoguesByTopicIdPaginated(topicId, page, pageSize)
      } catch (error) {
        logger.error('Error in harness-dialogue-get-by-topic-paginated:', error)
        throw error
      }
    }
  )

  // Actual dialogue usage (harness_dialogue_usage): renderer backfills it by dialogue_id
  handle('harness-usage-get-by-topic', async (topicId: number) => {
    try {
      return await getUsageByTopic(topicId)
    } catch (error) {
      logger.error('Error in harness-usage-get-by-topic:', error)
      throw error
    }
  })

  handle(
    'harness-dialogue-add',
    async (dialogue: Omit<HarnessDialogueRow, 'id' | 'created_at'>) => {
      try {
        return await addDialogue(dialogue)
      } catch (error) {
        logger.error('Error in harness-dialogue-add:', error)
        throw error
      }
    }
  )

  handle('harness-dialogue-delete-by-topic', async (topicId: number) => {
    try {
      return await deleteDialoguesByTopicId(topicId)
    } catch (error) {
      logger.error('Error in harness-dialogue-delete-by-topic:', error)
      throw error
    }
  })

  handle('harness-dialogue-delete', async (id: number) => {
    try {
      return await deleteDialogueById(id)
    } catch (error) {
      logger.error('Error in harness-dialogue-delete:', error)
      throw error
    }
  })

  return handlers
}
