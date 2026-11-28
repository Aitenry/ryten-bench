import type { StructuredMessage } from '../../services/harness/types'

/**
 * Viewable-conversation event contract for background subagent sessions.
 *
 * Context: after opening a subagent from the background-subagent entry in the top-right
 * corner, the main conversation area switches to this subagent's **streaming session
 * transcript** (body / reasoning / tool cards, the same as the main conversation) and can
 * return to the main agent. The previous implementation only pushed the plain-text
 * `lastOutput` into a dialog when the session ended, so nothing was visible while it ran.
 * This module records each turn's streaming chunks from the subagent as an event stream
 * and hands it to the renderer, which replays it with the same reducer as the main
 * conversation, producing identical streaming rendering.
 *
 * Design notes:
 * - The event stream is the **single source of truth**: the main process only appends
 *   events (seq strictly increasing); a snapshot = all events + current seq, and the
 *   renderer merges increments by seq. No separate block state is kept in the main
 *   process (avoiding a second block-merge model besides the main conversation's).
 * - The chunks in events are the main conversation's `StructuredMessage` (content /
 *   reasoning_content / tool / retrying subset); the renderer reuses the same
 *   `applyChunkToMessages` reducer.
 * - Sessions are isolated by topicId; the event-stream snapshot is persisted to
 *   `subagent_session` (see subagent-sessions), restored as inactive after a restart and
 *   can be cold-resumed to continue; opening a session returns only the most recent turns
 *   by default, and older turns are loaded on demand through the history channel
 *   (avoiding a single IPC with huge history).
 */

/** Terminal state of one subagent run */
export type SubagentTurnStatus = 'completed' | 'failed' | 'killed'

/** Start of a turn: append one user message and one assistant placeholder message */
export interface SubagentConversationTurnStart {
  kind: 'turn_start'
  seq: number
  /** Turn id (unique within the event stream; not reused across turns) */
  turnId: string
  /** User message body for this turn (first turn = prompt given at dispatch; later = send_message content) */
  prompt: string
  startedAt: number
}

/** Streaming chunk within a turn (isomorphic to the main conversation) */
export interface SubagentConversationChunk {
  kind: 'chunk'
  seq: number
  turnId: string
  chunk: StructuredMessage
}

/** End of a turn: finalize the assistant message stream and mark the terminal state */
export interface SubagentConversationTurnEnd {
  kind: 'turn_end'
  seq: number
  turnId: string
  status: SubagentTurnStatus
  finishedAt: number
  /** Extra note on failure/interruption (the renderer appends it to the end of the body for troubleshooting) */
  note?: string
}

export type SubagentConversationEvent =
  SubagentConversationTurnStart | SubagentConversationChunk | SubagentConversationTurnEnd

/**
 * Input shape when appending an event (seq is assigned by the registry).
 *
 * An explicit union is used instead of `Omit<SubagentConversationEvent,'seq'>`: Omit does
 * not distribute over union types and would lose the discriminant fields.
 */
export type SubagentConversationEventInput =
  | Omit<SubagentConversationTurnStart, 'seq'>
  | Omit<SubagentConversationChunk, 'seq'>
  | Omit<SubagentConversationTurnEnd, 'seq'>

/**
 * Session snapshot (fetched once when opening a subagent session):
 * the renderer only needs to replay events to obtain the same `Message[]` structure as
 * the main conversation; increments after seq are filled in by the
 * `harness:harness-agent-conversation-updated` event.
 */
export interface SubagentConversationSnapshot {
  topicId: number
  agentId: string
  name: string
  label: string
  /** Task instruction for the session's first turn (compatible with the prompt field of the legacy readOutput) */
  prompt: string
  status: 'running' | 'idle' | 'inactive'
  lastStatus?: SubagentTurnStatus
  /** Number of user messages queued while running (shown in the top-bar breadcrumb) */
  queuedMessages: number
  /** Whether turns older than the snapshot exist (loaded by scrolling at the top of the session view) */
  hasOlder: boolean
  /** Highest event sequence emitted so far; the renderer uses it to drop events from before the snapshot or duplicates */
  seq: number
  events: SubagentConversationEvent[]
}

/** An earlier page of session events (fetched by beforeSeq when scrolling to the top, bounded by turn_start) */
export interface SubagentConversationHistory {
  /** A page of events older than the currently loaded first event (ascending seq) */
  events: SubagentConversationEvent[]
  /** Whether turns older than this page exist */
  hasOlder: boolean
}

/**
 * Result of delivering a message from the session view to the subagent.
 *
 * Semantics match the main agent's `send_message` tool exactly (the same registry.send):
 * - Session idle: a new turn starts immediately (a turn_start appears in the conversation
 *   events after the delivery receipt is returned);
 * - Session running: the message enters the FIFO inbox and continues automatically after
 *   the current turn ends (the view shows the queued count).
 */
export interface SubagentPromptResult {
  ok: boolean
  /** Delivery receipt id (present when ok=true) */
  messageId?: string
  /** Failure reason (session missing / topic deleted, etc.; present when ok=false) */
  error?: string
}
