import logger from 'electron-log'
import type { IpcHandlerMap } from '../register'
import {
  findChatWorkspace,
  listChatWorkspaceIds,
  removeChatTopicDir
} from '../../services/harness/chat/workspace'
import { activateChatRoot, activateChatTopic } from '../../services/harness/chat/activation'

/**
 * IPC for "Chat" mode (the 7th domain of the harness plugin).
 *
 * This mode **has no workspace concept**: the user just opens a session and chats. But the model's
 * file tools need a writable root (that is what the virtual `/` is mounted on), and the file
 * explorer needs a root too — so the mode ships an app-initialized directory of its own; see
 * main/chat/workspace.ts.
 *
 * Two rules:
 * - **Never throw**: actions uniformly return `{ ok, error?, data? }` and the renderer shows
 *   prompts based on that (the same convention as the workshop);
 * - **Switching only goes through "write settings + broadcast"**: the AI working directory, the
 *   explorer root, the file IPC boundary, the file-change review, and the memory scope all
 *   recognize `harness.workspacePath` + `activeWorkspaceId` — the same mechanism as switching a
 *   plugin session to the plugin directory (see workshop/workspace.ts).
 */
export function chatIpcHandlers(): IpcHandlerMap {
  const handlers: IpcHandlerMap = {}
  /** Inbound channel: the plugin's namespace prefix appears only here */
  const handle = (channel: string, handler: (...args: never[]) => unknown): void => {
    handlers[`harness:${channel}`] = handler
  }

  /**
   * Enter "Chat" mode (or create a new session within it): ensure the directory and workspace row
   * exist, and make it the active workspace.
   *
   * Returns the **session directory** (`dir`) rather than the workspace row: a newly created blank
   * session uses the "Chat" root directory, while opening an existing session uses its own
   * subdirectory — in both cases the caller's `workspacePath` to write is `dir`.
   */
  handle('chat-ensure-workspace', async () => {
    try {
      const activation = await activateChatRoot()
      return { ok: true, data: activation }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn('[Chat] Failed to initialize chat working directory:', message)
      return { ok: false, error: message }
    }
  })

  /**
   * Open **a single session** in "Chat" mode: switch the active workspace to that session's own
   * directory (`<userData>/chat/<topic id>/`, created if it does not exist).
   *
   * Why one directory per session: when switching sessions within the same mode, the files the
   * model sees, the explorer root, and the file-change review boundary should all belong to
   * **that session** — sharing one directory would let two sessions step on each other's files.
   */
  handle('chat-activate-topic', async (topicId: number) => {
    try {
      const activation = await activateChatTopic(Number(topicId))
      return { ok: true, data: activation }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn('[Chat] Failed to switch session working directory:', message)
      return { ok: false, error: message }
    }
  })

  /**
   * All current "Chat" workspace ids (sidebar: filters the "Chat" row out of the "Work" list and
   * recognizes its own row).
   *
   * The renderer does not build paths itself to determine the kind (`<userData>/chat` — only the
   * main process knows how to resolve it); same approach as `workshop-state.pluginWorkspaces`.
   */
  handle('chat-workspaces', async () => {
    try {
      const ids = await listChatWorkspaceIds()
      const workspace = await findChatWorkspace()
      return { ok: true, data: { ids, rootWorkspaceId: workspace?.id ?? null } }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn('[Chat] Failed to read chat workspaces:', message)
      return { ok: false, error: message }
    }
  })

  /**
   * Delete a session's directory (called by the renderer after deleting a topic; **a failure does
   * not affect topic deletion**).
   *
   * The main process derives the path solely from the topic id, and only allows deleting
   * "immediate numeric subdirectories of the chat root" (the two gates are in chat/workspace.ts).
   * Here it only additionally confirms that "the chat workspace actually exists" — without that,
   * this action with `recursive: true` would lose its context.
   */
  handle('chat-remove-topic-dir', async (topicId: number) => {
    try {
      const workspace = await findChatWorkspace()
      if (!workspace) return { ok: true, data: false }
      return { ok: true, data: removeChatTopicDir(Number(topicId)) }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn('[Chat] Failed to clean up session directory:', message)
      return { ok: false, error: message }
    }
  })

  return handlers
}
