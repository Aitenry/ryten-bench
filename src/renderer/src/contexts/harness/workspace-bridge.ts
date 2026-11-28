import { createContext, useContext } from 'react'
import type { ToolCardKind } from '../../../../shared/harness/types'

/**
 * Bridge from the chat to the workspace panel on the right.
 *
 * Why a Context instead of threading props further down: tool cards render inside
 * AssistantMessage's **block-level render cache** (see AssistantMessage.renderBlockAt: React
 * elements cached by block object identity, with a cache key of only theme/language/colors).
 * Passing callbacks as props would not let a changed callback identity into the cache key, so a
 * cached node would keep holding the old closure (a pitfall this codebase has hit). With a
 * Context that the card components subscribe to themselves, there is no such mismatch: the
 * callback is always the latest value, and block cache hit rate is unaffected.
 */

export interface ToolDetailRequest {
  /** Topic id (the main process locates the result detail by topicId + callId) */
  topicId: number
  /** Tool call id (tool.id) */
  callId: string
  /** Card semantic kind: determines how the detail tab is presented */
  kind: ToolCardKind
  /** Tab name (command / pattern / path) and the title inside the tab */
  title: string
  /** execute: exit code */
  exitCode?: number
  /** Whether the result was truncated (the detail tab shows a hint) */
  truncated?: boolean
  /** Extra description such as the hit count */
  summary?: string
}

export interface WorkspaceBridge {
  /** Open the file a virtual path points to (read_file / write_file / edit_file cards) */
  openFile: (virtualPath: string) => void
  /**
   * Reveal a directory in the right-hand file explorer (ls card).
   * Returns whether it was revealed — false when the path is outside the workspace
   * (e.g. /memories/...), in which case the card falls back to the detail tab.
   */
  revealPath: (virtualPath: string) => boolean
  /** Open the tool result detail tab (glob / grep / execute cards) */
  openToolDetail: (request: ToolDetailRequest) => void
}

export const WorkspaceBridgeContext = createContext<WorkspaceBridge | null>(null)

/** Read the bridge; returns null when no Provider is mounted (cards still render, just not clickable) */
export function useWorkspaceBridge(): WorkspaceBridge | null {
  return useContext(WorkspaceBridgeContext)
}
