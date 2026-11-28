import { settingsStore } from '../../../context'
import { syncWorkspaceWatcher } from '../../../workspace'
import type { HarnessSettings } from '../../../types/settings'
import { ensureChatTopicDir, ensureChatWorkspace } from './workspace'

/**
 * Writes the "chat" mode directory as the **active workspace** (recognized by the AI working
 * directory / explorer root / file IPC boundary).
 *
 * Why a separate module: the chat directory **calculation** lives in chat/workspace.ts (pure
 * filesystem + database), while "switching the active workspace" writes electron-store and
 * re-roots the file watcher — that is main-process environment work. Split apart, the offline
 * tooling can import workspace.ts alone to verify directory rules without dragging in the
 * settings store or the watcher.
 *
 * Two rules (the same ones the workshop uses when switching plugin workspaces):
 * - Only one path: "write settings + resync watcher" — file tools, the explorer, change review
 *   and memory scope all read only `harness.workspacePath` + `activeWorkspaceId`;
 * - **Idempotent**: if the directory / workspace is unchanged, do nothing, avoiding rebuilding
 *   the file watcher on every session entry.
 */
export interface ChatActivation {
  workspaceId: number
  /** Working directory of this session (or of the blank session) */
  dir: string
}

/** Write settings + re-root the watcher (does not write again when unchanged) */
export function activateChatWorkspace(dir: string, workspaceId: number): void {
  const harness = settingsStore.get('harness') as HarnessSettings | undefined
  if (harness?.workspacePath === dir && harness?.activeWorkspaceId === workspaceId) return
  settingsStore.set('harness', {
    ...(harness ?? ({} as HarnessSettings)),
    workspacePath: dir,
    activeWorkspaceId: workspaceId
  })
  syncWorkspaceWatcher()
}

/** Blank session entering "chat" mode: active workspace = the mode root directory (`<userData>/chat/`) */
export async function activateChatRoot(): Promise<ChatActivation> {
  const workspace = await ensureChatWorkspace()
  activateChatWorkspace(workspace.path, workspace.id)
  return { workspaceId: workspace.id, dir: workspace.path }
}

/**
 * Open a session: active workspace = its own subdirectory (`<userData>/chat/<topic id>/`).
 *
 * The directory is created **on demand**: this recreates it when a session is opened after an
 * app restart, or when the directory was deleted manually; otherwise the model's file tools
 * would hit ENOENT ("file content not operable").
 */
export async function activateChatTopic(topicId: number): Promise<ChatActivation> {
  const workspace = await ensureChatWorkspace()
  const dir = await ensureChatTopicDir(Number(topicId))
  activateChatWorkspace(dir, workspace.id)
  return { workspaceId: workspace.id, dir }
}
