import * as path from 'path'
import { buildMnemon, type MnemonComponent } from '../../runtime/harness/mnemon'
import { chatScope, memoryScopeRoot, workspaceScope, type MemoryScope } from './memory-scope'
import { normalizeMemoryScope, pluginIdOfMemoryScope } from '../../../shared/harness/memory-scope'

/**
 * Mnemon process-level singleton — cached by storage root.
 *
 * HarnessService creates a new Runtime on every request, but the memory system (PGlite database,
 * file control plane) must be a process-level component shared across requests. Cached by
 * storageRoot and closed together when the app quits.
 *
 * Storage roots are isolated by **memory scope** (one directory per complete memory system, see
 * memory-scope.ts):
 *   <memoryPath>/workspace-<workspaceId>/mnemon/   work-mode sessions (per workspace)
 *   <memoryPath>/plugin-<pluginId>/mnemon/         plugin sessions (per plugin, user requirement
 *                                                  2026-09-28)
 *   <memoryPath>/chat/mnemon/                      "Chat" mode sessions (that mode has no
 *                                                  workspace)
 * Sibling to the sub-agent memory directory (sub-agents/ at the same level). Hot memory / archive
 * / memory space of different scopes never cross over.
 */

const instances = new Map<string, MnemonComponent>()

/**
 * Get (or create) the memory component; returns undefined when no memory directory is configured.
 *
 * @param scopeRaw Scope string passed back from the renderer (`plugin:<id>` / `chat`; empty or
 *   invalid = current workspace). Parsing always goes through normalizeMemoryScope in
 *   shared/memory-scope — "Chat" mode must go through it, otherwise `chat` would be treated as a
 *   plugin id and become `<memoryPath>/plugin-chat/`.
 */
export function getMnemonComponent(
  memoryPath?: string,
  workspaceId = 0,
  scopeRaw?: string | null
): MnemonComponent | undefined {
  const normalized = normalizeMemoryScope(scopeRaw)
  const pluginId = pluginIdOfMemoryScope(normalized)
  const scope: MemoryScope = normalized
    ? pluginId
      ? { kind: 'plugin', pluginId }
      : chatScope()
    : workspaceScope(workspaceId)
  const root = memoryScopeRoot(memoryPath, scope)
  if (!root) return undefined
  const storageRoot = path.join(root, 'mnemon')
  const existing = instances.get(storageRoot)
  if (existing) return existing
  const component = buildMnemon(storageRoot)
  instances.set(storageRoot, component)
  return component
}

/** Close all memory components (called when the app quits) */
export async function closeAllMnemon(): Promise<void> {
  for (const component of instances.values()) {
    try {
      await component.close()
    } catch {
      // A close failure must not block quitting
    }
  }
  instances.clear()
}

/** For diagnostics: currently cached storage roots */
export function mnemonStorageRoots(): string[] {
  return [...instances.keys()]
}
