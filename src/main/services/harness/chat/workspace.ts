import * as path from 'path'
import * as fs from 'fs'
import { app } from 'electron'
import logger from 'electron-log'
import {
  createWorkspace,
  findWorkspaceByPath,
  getWorkspacesByKind,
  setWorkspaceKind
} from '../../../database/mapper/harness/harness'
import type { WorkspaceRow } from '../../../database/mapper/harness/harness'
import { isSameFsPath } from '../../../../shared/harness/workshop'

/**
 * The **working directory** of "chat" mode: the mode has no workspace concept, but the model's
 * file tools need a writable root directory (the virtual `/` mounts it), otherwise read/write/edit
 * immediately go out of bounds and the explorer has no root to display.
 *
 * Directory layout (resolved per OS, no user configuration needed):
 *
 * ```
 * <userData>/chat/            ← chat-mode workspace root (workspace row kind='chat')
 *   └── <session id>/          ← one subdirectory per session; it is that session's working directory
 * ```
 *
 * Why under `userData` and not "Documents": the app **deliberately does not auto-create
 * user-visible directories** (the historical "RytenBench workspace" under Documents was rolled
 * back by workspace-migration); chat-mode directories are runtime data of the app, and living in
 * the app data directory next to the database/logs is the most appropriate; users who want to see
 * the files can open them from the explorer panel on the right, or click "open directory".
 *
 * Why make it a real workspace row: same reason as plugin workspaces (see workshop/workspace.ts) —
 * the AI working directory (Runtime's workspacePath), explorer root, file IPC boundary
 * (`assertInsideWorkspace`), file change review and per-workspace isolated memory all read only
 * `harness.workspacePath` + `activeWorkspaceId`. Pointing the active workspace at this directory
 * makes the whole chain work without a single line changed.
 *
 * These rows **do not count as user workspaces**: the sidebar "work" list filters them out by
 * `kind`; they appear only on the "chat" side (`kind='chat'`).
 */

/** Directory name for chat mode (`<userData>/chat/`) */
const CHAT_DIR_NAME = 'chat'

/**
 * Chat-mode root directory (resolved by OS).
 *
 * `app.getPath('userData')` is, per platform,
 * `%APPDATA%\ryten-bench` (Win) / `~/Library/Application Support/ryten-bench` (mac) /
 * `~/.config/ryten-bench` (Linux) — this function is the **single** outlet of that rule; use it
 * everywhere else so the renderer/tooling does not each assemble their own path. In dev the
 * directory name is `ryten-bench-dev` (rule in `src/main/environment/`), so the dev chat
 * directory never mixes with the packaged build.
 */
export function chatWorkspaceRoot(): string {
  return path.join(app.getPath('userData'), CHAT_DIR_NAME)
}

/** Working directory of a session (topic id; 0 = blank session with no topic yet → use the root directory) */
export function chatTopicDir(topicId: number): string {
  const root = chatWorkspaceRoot()
  return topicId > 0 ? path.join(root, String(topicId)) : root
}

/** Ensure the directory exists (idempotent; usable as soon as the model/explorer arrives) */
export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

/** Existing chat workspace row (null if absent; does not create one) */
export async function findChatWorkspace(): Promise<WorkspaceRow | null> {
  const rows = await getWorkspacesByKind('chat')
  return rows[0] ?? null
}

/** IDs of all current chat workspaces (the sidebar uses them to filter "chat" rows out of the "work" list and to recognize its own row) */
export async function listChatWorkspaceIds(): Promise<number[]> {
  return (await getWorkspacesByKind('chat')).map((row) => row.id)
}

/**
 * Get (creating if necessary) the chat-mode root workspace.
 *
 * Idempotent: the path `<userData>/chat` always maps to exactly one row (`workspace_path_key` is
 * unique on the table). If the path is occupied by the wrong kind (should not happen: only this
 * place creates it), change it in place to 'chat' instead of inserting another row — inserting
 * would violate the unique constraint.
 */
export async function ensureChatWorkspace(): Promise<WorkspaceRow> {
  const root = chatWorkspaceRoot()
  ensureDir(root)
  const existing = await findWorkspaceByPath(root)
  if (existing) {
    if (existing.kind !== 'chat') await setWorkspaceKind(existing.id, 'chat')
    return { ...existing, kind: 'chat' }
  }
  const name = '对话'
  const id = await createWorkspace(name, root, 'chat')
  const created = await findWorkspaceByPath(root)
  if (!created) {
    // It is always readable right after creation; if not, something else is wrong with the
    // database, so throw it as-is rather than fabricating a fake row
    throw new Error(`对话工作区创建后读不回来（id=${id}，path=${root}）`)
  }
  logger.info(`[Chat] created chat workspace id=${id} at ${root}`)
  return created
}

/**
 * Working directory of a session (get (creating if necessary) its subdirectory).
 *
 * The topic id is authoritative rather than the topic title: titles can be changed by the model
 * and may collide, while the directory name must be stable and **already validated** (ids are
 * auto-increment integers that never contain path separators).
 *
 * @param topicId Topic id; ≤0 = no topic yet → returns the root directory itself (a new blank session uses it first)
 */
export async function ensureChatTopicDir(topicId: number): Promise<string> {
  const dir = chatTopicDir(topicId)
  ensureDir(dir)
  return dir
}

/**
 * Delete a chat session's directory (cleaned up when the topic is deleted).
 *
 * Two gates, and nothing happens if either fails — this function uses `recursive: true`, so one
 * miscalculated path deletes user directories:
 * ① The target must be a **direct subdirectory of the chat root** (and not the root itself);
 * ② The name must be all digits (topic id).
 */
export function removeChatTopicDir(topicId: number): boolean {
  if (!(topicId > 0)) return false
  const root = path.resolve(chatWorkspaceRoot())
  const target = path.resolve(chatTopicDir(topicId))
  if (path.dirname(target) !== root) {
    logger.warn(`[Chat] Refusing to delete directory that is not a direct child: ${target}`)
    return false
  }
  if (!/^\d+$/.test(path.basename(target))) {
    logger.warn(`[Chat] Refusing to delete non-topic directory: ${target}`)
    return false
  }
  try {
    fs.rmSync(target, { recursive: true, force: true })
    logger.info(`[Chat] removed conversation dir ${target}`)
    return true
  } catch (err) {
    logger.warn(`[Chat] Failed to delete conversation dir (does not affect topic deletion): ${target}`, err)
    return false
  }
}

/**
 * **Fallback classification** at startup: recognize the historical batch of plugin workspaces as
 * 'plugin' instead of the default 'user'.
 *
 * Before 0010 there was no kind column, so plugin workspaces in old databases all hold the
 * default value; if they are not recognized they leak into the "work" list (on 2026-09-28 the
 * user explicitly requested that plugin directories stay out of the "work" list). The criterion
 * is the same as listPluginWorkspaces: the path is a **direct subdirectory** of the plugin
 * storage path. Only rows with kind='user' are touched; name and path are left alone, and
 * updated_at is not refreshed.
 *
 * Chat workspaces need no classification here: ensureChatWorkspace writes 'chat' itself.
 */
export async function classifyLegacyPluginWorkspaces(
  pluginsRoot: string | undefined
): Promise<number> {
  if (!pluginsRoot) return 0
  const rows = await getWorkspacesByKind('user')
  let classified = 0
  for (const row of rows) {
    if (!row.path) continue
    if (!isSameFsPath(path.dirname(path.resolve(row.path)), pluginsRoot)) continue
    if (await setWorkspaceKind(row.id, 'plugin')) classified += 1
  }
  if (classified > 0) {
    logger.info(`[Chat] classified ${classified} legacy workspace(s) as kind=plugin`)
  }
  return classified
}
