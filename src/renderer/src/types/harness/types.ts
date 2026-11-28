import type { MessageBlock, ToolCall } from '../../../../shared/harness/types'

/**
 * Renderer-layer types for the harness plugin: **pure frontend** view models and display shapes.
 *
 * Cross-process DTOs (message blocks / tool cards / runtime view rows) live in
 * `../shared/types.ts` — the types here are only constructed and consumed in the renderer process;
 * they never travel over IPC and are never persisted.
 */

/** Chat message (the renderer-side conversation model: assembled from stored dialogue rows + streaming chunks) */
export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  blocks: MessageBlock[]
  timestamp: number
  toolCalls?: ToolCall[]
  loading?: boolean
  reasoning_content?: string
  /** Timestamp of the last received streaming chunk (renderer-only transient field, not persisted; used to decide the silence indicator) */
  lastChunkAt?: number
  /**
   * The dialogue row id of this assistant message in the database.
   * During streaming the message uses a temporary id; after the main process saves it, the id is
   * sent back with harness-stream-done and written back here, so usage rows
   * (harness_dialogue_usage.dialogue_id) can be matched up without reloading the conversation.
   */
  dialogueId?: number
  /**
   * Index set of the "final answer" within this message's `blocks` array (the protocol-layer
   * source of truth; the renderer reads it but never guesses).
   *
   * - `Set`: these blocks are this turn's answer and are always shown outside the task fold;
   * - `null`: the main process explicitly says there is no answer this turn (aborted / only tools
   *   and reasoning), or the marker was withdrawn;
   * - `undefined`: the main process gave no verdict (older version or an exceptional path) — keep
   *   the old "extract once the whole turn ends" behavior.
   *
   * Origin: main/service/answer-boundary.ts and the `answer` chunk sent by the main process.
   */
  answer?: Set<number> | null
}

/** Attachment (the renderer holds the dataUrl; not persisted) */
export interface Attachment {
  dataUrl: string
  fileName: string
  isImage: boolean
}

/**
 * Tool list row (the return shape of `harness:harness-get-tools`).
 *
 * The main process fills in `label` for each tool from the `mainMessages().tools` copy dictionary;
 * `icon`/`color` are display metadata for the settings page dropdown. This used to borrow `ToolInfo`
 * from core's `resource/types/window`, which was in fact a leftover copy in the window/api type
 * table; it now lives in the plugin's own renderer-layer types.
 */
export interface HarnessToolInfo {
  name: string
  label: string
  description: string
  icon: string
  color: string
  /**
   * Source tag: `system` = compiled with the app (local tools + built-in material organization),
   * `plugin` = contributed by a third-party plugin, `mcp` = an external MCP server. The main
   * process writes it in `harness-get-tools`; when absent, no tag is shown.
   * Kept consistent with the main process `ToolSourceKind` (`main/plugins/tool-contract.ts`).
   */
  source?: 'system' | 'plugin' | 'mcp'
}
