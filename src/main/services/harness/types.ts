import type { TurnFinal } from './answer-boundary'
import type { ToolImageData } from '../../../shared/harness/types'

export interface HarnessOptions {
  images?: string[]
  documents?: { fileName: string; filePath: string }[]
  /** Topic ID; HarnessService loads conversation history from the database using it */
  topicId?: number
  /** AbortSignal used to cancel streaming output */
  signal?: AbortSignal
  /** Turn source metadata (for goal-system authority checks; absent for user messages, injected by the driver for auto-continuation turns) */
  turnMeta?: TurnMeta
  /** Compaction start callback: called as soon as an over-long history triggers LLM compaction (the frontend shows a "compacting" transition card) */
  onCompactionStart?: () => void
  /** Compaction model request auto-retry callback (attempt/retries; the IPC layer pushes a "retrying" transition chunk from it) */
  onCompactionRetry?: (attempt: number, retries: number) => void
  /** History context character budget (derived from the current model's context window, minimum 60,000; defaults when absent) */
  contextBudget?: number
  /**
   * Current model context window (tokens, from provider profile metadata.context_window).
   *
   * Compaction pressure is judged first on **real tokens** (context actually used by the previous model call ÷
   * window ≥ 79%, see runtime/harness/context-pressure.ts); without this value it falls back to the
   * "chars ÷ budget" heuristic.
   */
  contextWindow?: number
  /**
   * In-turn steering: called before each tool node in the graph executes, merging a message the user flagged
   * "steer now" while it was queued into the running context (placed after this tool result), so the model can
   * read it on its next step. Persistence, segment splitting and sending the steered chunk are all handled inside
   * this callback (provided by the IPC layer). Unset = steering injection disabled (subagents and non-streaming
   * paths do not pass it).
   */
  drainInjections?: () => Promise<AgentInjection[] | null>
}

/** Payload of one "steer now" injection (pure injection: body only, never persisted, produces no conversation content) */
export interface AgentInjection {
  /** Steering message body */
  text: string
}

/** Turn source metadata (injected into the tool layer via graph configurable, for execution-time permission checks in goal tools) */
export interface TurnMeta {
  /**
   * Source:
   * - user = a turn the user started directly (default);
   * - goal-round = goal auto-continuation turn;
   * - queue = a turn the main process started automatically for a queued message after the previous turn ended
   *   (the frontend has no local placeholder, so it mounts the bubble from the `queueTurn` marker at the head of
   *   the stream);
   * - schedule = a turn started headlessly by the main process when a scheduled task fires (the message is
   *   persisted as usual).
   */
  source?: 'user' | 'goal-round' | 'queue' | 'schedule'
  /** Task behind a schedule turn (for logging/troubleshooting, not used in permission checks) */
  scheduleId?: string
  scheduleTitle?: string
  /** Queued entry id behind a queue turn (the frontend removes the queue row and mounts the user bubble from it) */
  queueItemId?: string
  /** Goal identity carried on goal-round turns (only an exact match with the current goal turn has complete/blocked authority) */
  goalId?: string
  goalRevision?: number
  goalRound?: number
  /** Goal objective for goal-round turns (shown in the frontend banner) */
  objective?: string
}

export interface HarnessMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

/** Tool card semantic category: decides the frontend icon, metadata and "what opens on click" */
export type ToolCardKind = 'file' | 'dir' | 'search' | 'command'

/**
 * Custom tool card data (for built-in file/command tools).
 *
 * Design premise: these tools' results are **no longer sent over IPC or persisted** (see
 * service/tool-presentation.ts); the frontend only receives this card. To view content, click the card to open
 * the real file or result details in the right-side panel. The card must therefore carry enough metadata (path,
 * line count, item count, exit code, failure reason).
 */
export interface ToolCard {
  /** Card semantic category */
  kind?: ToolCardKind
  /** File/directory path (read_file / write_file / edit_file / ls) */
  path?: string
  /** Search pattern (glob / grep) */
  pattern?: string
  /** Result count (ls / glob / grep) */
  count?: number
  /** Command executed (execute) */
  command?: string
  /** Result status; on error the card shows the failure reason */
  status?: 'ok' | 'error'
  /** Failure reason / result summary (truncated, for single-line display only) */
  message?: string
  /** read_file: total lines in the file */
  lines?: number
  /** read_file / execute: result character count */
  chars?: number
  /** read_file: output was truncated by the inline limit (the file is longer than shown here) */
  truncated?: boolean
  /** read_file: line range when reading with offset/limit (1-based, inclusive) */
  range?: { start: number; end: number; total: number }
  /** write_file: bytes written */
  bytes?: number
  /**
   * write_file / edit_file: lines added on disk by this call (diff size; same source as the change record).
   *
   * What the user sees in chat must be "how much this file actually changed", not just "how many replacements
   * were made": a single replace_all may replace 3 places yet touch 40 lines. Missing = no reliable number
   * (legacy data, failed write); the card shows nothing rather than pretending with 0.
   */
  added?: number
  /** write_file / edit_file: lines deleted on disk by this call */
  removed?: number
  /** ls: subdirectory count */
  dirs?: number
  /** ls / glob: file count */
  files?: number
  /** grep: number of matched files (deduplicated) */
  fileCount?: number
  /** execute: exit code */
  exitCode?: number
  /** execute: job id of the background task (with run_in_background=true) */
  jobId?: string
  /** execute: this call only moved the command to the background; results/exit code live in the background job */
  background?: boolean
  /** This call has full result details; clicking the card opens them in the right-side panel */
  detail?: boolean
}

export interface ToolCallDetail {
  name: string
  input: Record<string, unknown>
  output: string
  status?: 'preparing' | 'executing' | 'completed'
  id?: string
  /** Custom card data, set only for built-in tools */
  card?: ToolCard
  /** Images carried by tool results (read_image etc.): persisted into conversation blocks for the UI and history replay */
  images?: ToolImageData[]
}

/** Hot memory content injected into the system prompt each turn (shown by the frontend as "injected memory") */
export interface MemoryInjection {
  /** User profile entries (target=user) */
  user: string[]
  /** Project memory entries (target=memory) */
  memory: string[]
  /** Capacity info (display strings for user/memory used/limit, e.g. "512/4096") */
  usage: { user: string; memory: string }
}

/** Early-conversation summary compaction that happened this turn (shown by the frontend as a "context compacted" card) */
export interface HistoryCompaction {
  /** Number of early messages compacted into the checkpoint summary */
  compressedCount: number
  /** Number of recent messages kept as-is */
  retainedCount: number
  /** Compaction boundary (ID of the last message in the compacted segment; only a boundary advance counts as a new compaction event) */
  boundaryId: number
}

/** Auto-retry progress after a failed model request (transition signal: the frontend shows "retrying (N/M)", never persisted) */
export interface RetryInfo {
  /** Current retry number (1-based, e.g. 1/2, 2/2) */
  attempt: number
  /** Maximum retries for this turn */
  retries: number
}

export interface StructuredMessage {
  tool?: ToolCallDetail
  content?: string
  reasoning_content?: string
  /**
   * Whether this segment of content/reasoning is this turn's **final answer** (the protocol layer gives the
   * verdict, the renderer only reads it and never guesses).
   *
   * - `true`: when the content arrived the turn had no tool/subagent activity yet, so it is the answer delivered
   *   to the user;
   * - `false`: **revoke** the earlier mark (this turn has already seen tool/subagent activity, so the earlier
   *   content was exploratory);
   * - omitted: this chunk expresses no opinion (always omitted for non-content chunks, so the renderer is never
   *   cleared by mistake).
   *
   * The source of truth and the decision live in service/answer-boundary.ts (`answerTrailingCount`), which
   * together with the `TurnFinal` sent at stream end forms the authoritative conclusion of "which part of the
   * last task segment is the answer".
   */
  answer?: boolean
  /** Agent activity event */
  subAgent?: SubAgentEvent
  /** Hot memory content injected this turn (sent at the head of the stream when Mnemon is enabled and hot memory is non-empty) */
  memoryInjected?: MemoryInjection
  /** Early-conversation summary compaction this turn (sent at the head of the stream when an over-long history is compacted into a checkpoint) */
  historyCompacted?: HistoryCompaction
  /** Compaction has started (transition signal: the frontend shows "compacting" first, then historyCompacted carries the result) */
  historyCompacting?: boolean
  /** Auto-retrying after a failed model request (no output yet) (transition signal: the frontend shows "retrying", never persisted) */
  retrying?: RetryInfo
  /** Streaming execution failed (sent when graph execution fails after partial output; the IPC layer uses it to skip persisting the incomplete reply) */
  streamError?: { message: string }
  /**
   * The user's steering message has been merged into the current turn (steering receipt). **Pure injection**:
   * never persisted, generates no new bubble in the conversation stream, and does not split the assistant
   * message — the frontend only uses it for a brief transient acknowledgement.
   */
  steered?: {
    /** Steering body (for display only) */
    text: string
  }
}

/** Streaming chunk sent over IPC (StructuredMessage + topicId / turn id injected by the main process) */
export interface StreamChunk extends StructuredMessage {
  __topicId?: number
  /**
   * Turn id for this round (the value of `harnessQueue.beginTurn`).
   *
   * On the same topic, the previous turn's teardown events and the new turn's stream may arrive interleaved at
   * the renderer; the renderer uses this id to drop chunks / done / error that do not belong to the current turn.
   */
  __turnId?: number
  /** Final marker for this turn (only used by the `harness-stream-done` payload, see service/answer-boundary.ts) */
  turnFinal?: TurnFinal
  /** Start marker for a goal auto-continuation turn (first chunk of the stream; the frontend mounts the new user message and assistant placeholder from it) */
  goalRound?: { round: number; objective: string }
  /**
   * Start marker for a queued-message continuation turn (first chunk of the stream; the frontend mounts the
   * user message and assistant placeholder from it). The user did not press send at the time and has no local
   * placeholder, so the main process must tell it.
   */
  queueTurn?: { itemId: string | null; text: string; attachments: string[] }
  /**
   * Start marker for a scheduled-task turn (first chunk of the stream; the frontend mounts the user message
   * and assistant placeholder from it).
   *
   * The user did not press send, so there is no local placeholder; `text` is the message body actually delivered
   * by the main process (including the schedule note) and matches what is persisted, keeping the live view
   * consistent with history after refresh.
   */
  scheduleTurn?: { scheduleId: string | null; title: string; text: string }
}

/** Agent definition */
export interface SubAgentConfig {
  /** Unique identifier used when the main agent calls it through the task() tool */
  name: string
  /** Chinese display name (optional) */
  rename?: string
  /** Describes the agent's function; the main agent uses it to decide when to delegate */
  description: string
  /** The agent's system prompt */
  systemPrompt: string
  /** Tool names available to the agent (selected from the main agent's tool set) */
  tools?: string[]
  /** Optional: override the main agent's model, format 'provider:model' */
  model?: string
  /** Optional: available skill IDs (selected from the skill catalog); empty means no skills */
  skills?: string[]
  /** Config revision (incremented on every edit; sessions/snapshots can trace the revision they were created with) */
  revision?: number
}

/**
 * Main model descriptor captured when a subagent session is created (provider row id + model name).
 *
 * Cold recovery uses it to return to "the model used at spawn time" instead of always using the current default
 * provider; if the provider was deleted/disabled it falls back to the default model (degraded capability rather
 * than blocking recovery).
 */
export interface SubAgentMainModelDescriptor {
  providerId: number
  model: string
}

/** Agent activity event */
export interface SubAgentEvent {
  /** Agent name */
  name: string
  /** Unique ID of the task tool call that dispatched this agent (to distinguish multiple calls to agents with the same name) */
  causeId?: string
  /** Event type; dispatched = the background task has been dispatched (lightweight card: name + summary + session id only, results are viewed in the top bar) */
  status: 'started' | 'running' | 'dispatched' | 'completed' | 'error'
  /** Agent output content (on completed) */
  output?: string
  /** Message emitted during agent execution */
  message?: string
  /** Error message */
  error?: string
  /** Text delta streamed by the agent */
  content?: string
  /** Reasoning content delta streamed by the agent */
  reasoning_content?: string
  /** The agent's tool call */
  tool?: ToolCallDetail
  /** Task description carried by the task tool call (converted by frontend / persistence from the task tool input) */
  taskDescription?: string
  /** Session ID for background dispatch (status='dispatched') (subagent-N), shown by the lightweight conversation card */
  subagentId?: string
}

/**
 * Available tool definition for the frontend dropdown.
 *
 * The definition moved to the host contract `src/main/plugins/tool-contract.ts` (plugins contributing tools
 * need it too; keeping it in harness would make plugins import harness backwards), so this is only a re-export
 * to keep existing import paths working.
 */
export type { ToolInfo } from '../../plugins/tool-contract'
