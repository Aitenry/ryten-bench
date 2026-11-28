/**
 * **String form** of the memory scope (cross-process DTO):
 * - `plugin:<plugin id>` = memory of the plugin itself;
 * - `chat` = memory of **"chat" mode** itself (that mode has no workspace, so its memory must
 *   not hang off some workspace);
 * - empty = follow the current workspace.
 *
 * Why a separate file: this string must be understood in three places —
 *  - main-process persistence (`harness_topic.memory_scope`, see `main/db/mapper/harness.ts`);
 *  - main-process memory component lookup (`main/ipc/mnemon.ts` turns the scope sent back by the
 *    renderer into a directory);
 *  - the renderer (the sidebar memory block and Settings → Memory decide "whose memory to read"
 *    from it, see `renderer/memory-scope.ts`).
 *
 * Directory names (`plugin-<id>` / `chat` / `workspace-<id>`) and path joining happen only in
 * the main process (`main/memory-scope.ts`); this file contains **no path logic at all**: what
 * the renderer receives is always just a validatable string.
 */

/** Plugin scope prefix (changing this changes the convention across the whole chain) */
export const PLUGIN_SCOPE_PREFIX = 'plugin:'

/** "Chat" mode memory scope (that mode has no workspace; one memory shared by the mode) */
export const CHAT_SCOPE = 'chat'

/**
 * Plugin id → scope string; an empty id returns null (= workspace scope).
 *
 * No path sanitizing here: path separators in the id are uniformly replaced with `-` by
 * `memoryScopeDirName` in the main process; rewriting early in the renderer would make "the id
 * shown in the UI" and "the directory name" disagree.
 */
export function pluginMemoryScope(pluginId: unknown): string | null {
  if (typeof pluginId !== 'string') return null
  const id = pluginId.trim()
  return id ? `${PLUGIN_SCOPE_PREFIX}${id}` : null
}

/** Scope string → plugin id; workspace / chat / empty / illegal / legacy data all yield null */
export function pluginIdOfMemoryScope(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.startsWith(PLUGIN_SCOPE_PREFIX)) return null
  const pluginId = raw.slice(PLUGIN_SCOPE_PREFIX.length).trim()
  return pluginId || null
}

/** Whether this scope string belongs to "chat" mode (no separate string comparisons) */
export function isChatScope(raw: unknown): boolean {
  return raw === CHAT_SCOPE
}

/**
 * Normalize a scope string **sent up from the renderer**: `plugin:<id>` / `chat` pass through
 * unchanged, everything else becomes null (= follow the current workspace).
 *
 * The renderer's memory scope is a module-level singleton (see renderer/memory-scope.ts), written
 * by various entry points when switching sessions/modes; this is its only gate — illegal values
 * must never reach the main process's directory joining step.
 */
export function normalizeMemoryScope(raw: unknown): string | null {
  if (isChatScope(raw)) return CHAT_SCOPE
  const pluginId = pluginIdOfMemoryScope(raw)
  return pluginId ? `${PLUGIN_SCOPE_PREFIX}${pluginId}` : null
}
