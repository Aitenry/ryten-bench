import * as path from 'path'
import {
  CHAT_SCOPE,
  isChatScope,
  pluginIdOfMemoryScope,
  pluginMemoryScope
} from '../../../shared/harness/memory-scope'

/**
 * Memory scope: which directory a memory set (hot memory USER.md / MEMORY.md + archive +
 * memory space) lives in.
 *
 * Three kinds:
 * - `workspace`: work-mode sessions, isolated per workspace — `<memoryPath>/workspace-<id>/`
 *   (existing convention);
 * - `plugin`: sessions opened from the "+ New session" plugin row, isolated per **plugin** —
 *   `<memoryPath>/plugin-<plugin id>/`;
 * - `chat`: **"Chat" mode** sessions — `<memoryPath>/chat/`. That mode has no workspace at all;
 *   using the "current workspace" as its memory owner would only mix things up (switching
 *   sessions within the same mode would also switch workspaces for memory).
 *
 * Why the split (user requirement, 2026-09-28: memory inside a plugin should be independent; it
 * used to reuse the memory context previously selected in the workspace, which caused problems):
 * plugin sessions are the "build a plugin" context, and mixing them with work memory dirties both
 * sides — what the assistant records in a plugin session should not enter work memory, and work
 * memory should not dominate plugin sessions.
 *
 * The scope is stored in `harness_topic.memory_scope` (`plugin:<id>` / `chat`; workspace left
 * empty = default), so **reopening a session still uses its own memory**, without relying on the
 * renderer remembering it.
 */
export type MemoryScope =
  | { kind: 'workspace'; workspaceId: number }
  | { kind: 'plugin'; pluginId: string }
  | { kind: 'chat' }

/** Workspace scope (most common; a short name for it) */
export function workspaceScope(workspaceId: number): MemoryScope {
  return { kind: 'workspace', workspaceId }
}

/** Plugin scope */
export function pluginScope(pluginId: string): MemoryScope {
  return { kind: 'plugin', pluginId }
}

/** "Chat" mode scope */
export function chatScope(): MemoryScope {
  return { kind: 'chat' }
}

/**
 * Scope directory name (`workspace-<id>` / `plugin-<id>` / `chat`).
 *
 * Plugin ids are normally lower-case kebab (validated when the workshop creates a draft); this
 * adds **one more guard**: path separators, parent traversal, colons and the like are all
 * replaced with `-`, so an id can never escape `memoryPath` (the memory directory is a
 * model-writable mount point).
 */
export function memoryScopeDirName(scope: MemoryScope): string {
  if (scope.kind === 'chat') return CHAT_SCOPE
  if (scope.kind === 'plugin') {
    const safe = String(scope.pluginId ?? '')
      .trim()
      .replace(/[^A-Za-z0-9._-]/g, '-')
    return `plugin-${safe || 'unknown'}`
  }
  return `workspace-${scope.workspaceId}`
}

/** Scope root directory (undefined when no memory directory is configured) */
export function memoryScopeRoot(
  memoryPath: string | undefined,
  scope: MemoryScope
): string | undefined {
  if (!memoryPath) return undefined
  return path.join(memoryPath, memoryScopeDirName(scope))
}

/**
 * String stored in `harness_topic.memory_scope`; workspace scope stores null (old data needs no
 * backfill). The string convention lives in `shared/memory-scope.ts` (the renderer reads the same
 * copy).
 */
export function serializeMemoryScope(scope: MemoryScope): string | null {
  if (scope.kind === 'chat') return CHAT_SCOPE
  return scope.kind === 'plugin' ? pluginMemoryScope(scope.pluginId) : null
}

/** Parse `harness_topic.memory_scope` (empty / invalid / old data → workspace scope) */
export function parseMemoryScope(raw: unknown, workspaceId: number): MemoryScope {
  if (isChatScope(raw)) return chatScope()
  const pluginId = pluginIdOfMemoryScope(raw)
  return pluginId ? pluginScope(pluginId) : workspaceScope(workspaceId)
}

/** Whether the scope is independent of the workspace (used by logging / UI) */
export function isPluginScope(scope: MemoryScope): boolean {
  return scope.kind === 'plugin'
}
