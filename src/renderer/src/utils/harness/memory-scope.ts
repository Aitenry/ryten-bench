import { useEffect, useState, useSyncExternalStore } from 'react'
import {
  isChatScope,
  normalizeMemoryScope,
  pluginIdOfMemoryScope
} from '../../../../shared/harness/memory-scope'
import { harnessApi } from '../../api/harness'

/**
 * Memory scope of the current session (a minimal store shared by the renderer).
 *
 * Why a module-level singleton instead of props / Context: the same scope has **two readers** —
 * the "Memory" block at the bottom of the sidebar (under HarnessProvider, so it gets props) and
 * Settings → Memory page (rendered by the host's settings modal, not under the plugin Provider,
 * so it gets no props at all). Both must show the same memory, so the value lives here and each
 * side subscribes on its own (user quote 2026-09-28: "the plugin's memory isn't shown in the
 * sidebar like the workspace memory" + "the Settings → Memory page should follow the same
 * scope").
 *
 * The value has exactly the same shape as in the main process: the string form of
 * `harness_topic.memory_scope` (`plugin:<plugin id>` / `chat`), null = follow the current
 * workspace (see shared/memory-scope.ts).
 * The writer is useHarnessHandlers: switching sessions → use the scope stored on the topic row;
 * plugin row / "chat" mode plus button (no topic yet) → use the pending scope.
 */
let scope: string | null = null
const listeners = new Set<() => void>()

/** Memory scope of the current session (for reading in non-React code / callbacks) */
export function getMemoryScope(): string | null {
  return scope
}

/** Set the memory scope of the current session (invalid values / empty plugin id fall back to null = workspace) */
export function setMemoryScope(next: string | null): void {
  const normalized = normalizeMemoryScope(next)
  if (normalized === scope) return
  scope = normalized
  for (const listener of listeners) listener()
}

function subscribeScope(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Subscribe to the memory scope of the current session */
export function useMemoryScope(): string | null {
  return useSyncExternalStore(subscribeScope, getMemoryScope)
}

/** Plugin id the current scope points at (workspace scope / "chat" mode = null) */
export function useMemoryPluginId(): string | null {
  return pluginIdOfMemoryScope(useMemoryScope())
}

/** Whether the current scope is "chat" mode (the Settings → Memory page labels it based on this) */
export function useIsChatScope(): boolean {
  return isChatScope(useMemoryScope())
}

/**
 * **Display name** of the current scope:
 * - plugin scope → the display name of the plugin draft (falls back to the id when unavailable);
 * - "chat" mode → `chatName` (the caller supplies translated text, see Settings → Memory page);
 * - workspace scope → null.
 *
 * Only the Settings → Memory page uses it (the sidebar row **doesn't label the scope**: user
 * quote 2026-09-28 "this (Memory · personal ledger) content isn't needed" — that block is
 * already on the session side, and which set it reads is decided by the current session).
 * The name is always the plugin's own name (same convention as the user quote 2026-09-26 "use
 * the MCP name": entries / options / groups all use real names, never generic category names).
 * It refreshes after a draft rename (the workshop-changed broadcast).
 */
export function useMemoryScopeName(chatName: string): string | null {
  const pluginId = useMemoryPluginId()
  const [name, setName] = useState<string | null>(null)

  useEffect(() => {
    if (!pluginId) {
      setName(null)
      return
    }
    let alive = true
    const load = async (): Promise<void> => {
      try {
        const drafts = await harnessApi.workshop.list()
        if (alive) setName(drafts.find((draft) => draft.id === pluginId)?.title ?? pluginId)
      } catch {
        // workshop isn't wired (e.g. the plugin was just disabled): fall back to the id so it is
        // at least clear whose memory this is
        if (alive) setName(pluginId)
      }
    }
    void load()
    const off = harnessApi.workshop.onChanged(() => void load())
    return () => {
      alive = false
      off()
    }
  }, [pluginId])

  // "Chat" mode memory is **one document shared by the whole mode** and has no name, so use the
  // caller-provided translated text
  return useIsChatScope() ? chatName : name
}
