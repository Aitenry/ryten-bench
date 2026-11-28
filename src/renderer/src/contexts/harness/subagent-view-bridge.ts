import { createContext, useContext } from 'react'

/**
 * Bridge for opening the background subagent conversation view from the message stream.
 *
 * Background: the lightweight "dispatched" card for task(background=true) in the main
 * conversation only has the name, summary and conversation id; besides the top-bar entry,
 * clicking that card should also land in the same view for replaying its full streaming session.
 *
 * Why a Context instead of adding callback props to AssistantMessage:
 * - AssistantMessage caches rendering per block (WeakMap keyed by block object identity), and
 *   function props are not part of the cache key; as props, a cache hit might keep a stale
 *   callback (the same pitfall documented in contexts/harness/workspace-bridge.ts).
 * - The page-level bridge object keeps a stable reference via useMemo, so useContext during
 *   block rendering always yields the latest implementation and cache hit rate is unaffected.
 */
export interface SubagentViewBridge {
  /** Open the streaming conversation view for this background subagent by conversation id (agentId looks like subagent-1) */
  openSubagent: (agentId: string) => void
}

export const SubagentViewContext = createContext<SubagentViewBridge | null>(null)

/** Read the bridge; returns null outside the Harness page (message cards degrade to non-clickable) */
export const useSubagentViewBridge = (): SubagentViewBridge | null =>
  useContext(SubagentViewContext)
