import * as path from 'path'
import {
  CHAT_SCOPE,
  normalizeMemoryScope,
  pluginMemoryScope
} from '../../../shared/harness/memory-scope'
import { getWorkspaceById } from '../../database/mapper/harness/harness'

/**
 * Memory scope string **persisted when creating a topic**.
 *
 * Value priority:
 * 1. The caller passed a valid value (`plugin:<id>` / `chat`) → use it as-is (only the renderer knows plugin ids);
 * 2. Not given / null → fall back by **workspace kind**:
 *    - `chat` workspace → `chat` (chat mode has no workspace, and memory should not hang off a workspace either);
 *    - `plugin` workspace → `plugin:<directory name>` (the directory name is the plugin id, consistent with listPluginWorkspaces);
 *    - `user` / not found → null (= workspace memory, the legacy behavior).
 *
 * Why this fallback is required: in the renderer, "the scope of the next new topic" is a pending value; it may
 * be empty after deleting the current session, or when a session was created elsewhere. Trusting the renderer
 * alone would make **the next topic of a chat / plugin session silently fall back to workspace memory**
 * (memories bleed into each other, and no error is raised). The workspace row's own kind is a persisted fact,
 * more reliable than a renderer variable that may already have been cleared.
 *
 * Why a separate file instead of stuffing it into main/memory-scope.ts: that file is a **pure**
 * scope↔directory conversion (offline tooling imports it directly to verify the directory policy, without a
 * database dependency); here we need the mapper to read the workspace row, and dragging it in would give the
 * pure module a database dependency too.
 */
export async function resolveTopicMemoryScope(
  workspaceId: number,
  explicit?: unknown
): Promise<string | null> {
  const normalized = normalizeMemoryScope(explicit)
  if (normalized) return normalized
  try {
    const workspace = await getWorkspaceById(workspaceId)
    if (workspace?.kind === 'chat') return CHAT_SCOPE
    if (workspace?.kind === 'plugin' && workspace.path) {
      return pluginMemoryScope(path.basename(workspace.path))
    }
  } catch {
    // Workspace unreadable (database not ready / row deleted) → treat as workspace memory rather than failing topic creation
  }
  return null
}
