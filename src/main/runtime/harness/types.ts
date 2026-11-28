/**
 * Agent runtime — streaming event contract.
 *
 * Design notes:
 * The runtime internally uses a "single event queue + three-way filtering iterators" instead of
 * the streamEvents(v3) contract, keeping the existing stream-producers consumption model
 * (messages / tools / subagents running on three concurrent channels).
 */

/** Main-agent message stream record (text / reasoning / tool block / model retry progress) */
export type MessageRecord =
  | { kind: 'reasoning'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool_block_start'; index: number; name: string; id?: string }
  | { kind: 'tool_args'; index: number }
  | { kind: 'retry_attempt'; attempt: number; retries: number }

/** Tool call record (output is a Promise that resolves to a string when the tool completes) */
export interface ToolCallRecord {
  kind: 'tool_call'
  name: string
  input: Record<string, unknown>
  callId: string
  output: Promise<string>
  /**
   * Images carried by this tool result (media tools such as read_image).
   *
   * Same lifetime as output: resolves only after the tool finishes. Stream producers project it
   * into the completed tool block; the UI renders thumbnails and history replay re-injects them
   * into the model context.
   */
  images?: Promise<import('./image-tool').ToolImage[]>
}

/** Subagent stream record (causeId = ID of the task tool call that dispatched this subagent) */
export type SubAgentRecord =
  | { kind: 'sub_start'; name: string; causeId: string; description?: string }
  | { kind: 'sub_reasoning'; name: string; causeId: string; text: string }
  | { kind: 'sub_text'; name: string; causeId: string; text: string }
  | { kind: 'sub_tool_call'; name: string; causeId: string; tool: ToolCallRecord }
  | { kind: 'sub_end'; name: string; causeId: string; output: string }
  | {
      /** Stage one: the subagent model emits the tool name (argument construction starts) */
      kind: 'sub_tool_block_start'
      name: string
      causeId: string
      index: number
      toolName: string
      id?: string
    }
  | {
      /** Stage two: subagent tool argument deltas (throttled keepalive) */
      kind: 'sub_tool_args'
      name: string
      causeId: string
      index: number
    }

/** Unified runtime event (single queue element) */
export type RuntimeRecord = MessageRecord | ToolCallRecord | SubAgentRecord

/** Runtime three-way streams (one-to-one with the stream-producers consumption contract) */
export interface RuntimeStream {
  /** Main-agent message stream: reasoning/text deltas, tool block starts, tool arg deltas */
  messages: AsyncIterable<MessageRecord>
  /** Main-agent tool call stream: executing → completed state is driven by the output Promise */
  toolCalls: AsyncIterable<ToolCallRecord>
  /** Subagent activity stream */
  subagents: AsyncIterable<SubAgentRecord>
  /** Graph execution error (set on failure; callers propagate it to the frontend) */
  error?: Error
}
