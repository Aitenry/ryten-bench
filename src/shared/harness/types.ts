/**
 * Cross-process DTOs for the harness plugin: shapes of main-process IPC inputs/outputs; the
 * renderer reads the same definitions.
 *
 * Two parts:
 * 1. **Row types and view types**: following the approach of planner/notes, they are **derived
 *    by the main process modules** (the mappers in turn derive them with drizzle schema's
 *    `$inferSelect`), so there is no second hand-maintained field table — change the schema in
 *    one place and both sides agree. Only `export type` here, so no runtime dependency is left
 *    after compilation: the renderer doesn't pull drizzle, the main directory or electron into
 *    its bundle because of this (contract in src/main/plugins/context.ts).
 * 2. **Message block shapes**: `MessageBlock` / `ToolCard` etc. are the contract that travels
 *    across processes with stream chunks and the persisted `blocks` column; they used to live in
 *    `src/renderer/src/types/harness.ts` (core) and moved here with the plugin this round.
 *
 * Pure frontend types (`Message` / `Attachment` etc., models made by the renderer) are in
 * `../renderer/types.ts`.
 */

/* ── Main process row types (topic / dialogue / usage / workspace) ── */
export type {
  HarnessTopicRow,
  HarnessDialogueRow,
  HarnessDialogueUsageRow,
  WorkspaceRow,
  PaginatedResult
} from '../../main/database/mapper/harness/harness'

/* ── Agent config (subagents) ── */
export type {
  AgentConfigRow,
  AgentConfigInput,
  PaginatedResult as AgentPaginatedResult
} from '../../main/database/mapper/harness/agent'

/* ── Runtime views (plan list / goals / background jobs / subagents / questions / memory consolidation) ── */
export type { TodoItem } from '../../main/runtime/harness/todo'
export type { GoalView } from '../../main/runtime/harness/goal'
export type { JobSnapshot, JobOutputView } from '../../main/runtime/harness/jobs'
export type { SubagentSessionRow } from '../../main/runtime/harness/subagent-sessions'
export type { TeamModeView } from '../../main/runtime/harness/team-mode'

/** Agent Teams task event (IPC recent-activity view; see main/database/mapper/harness/team-task-event) */
export interface TeamTaskEventView {
  id: number
  taskId: string
  action: 'created' | 'claimed' | 'completed' | 'updated' | 'deleted'
  actorId: string
  actorName: string
  subject: string
  taskRevision: number
  createdAt: string | null
}
export type {
  SubagentConversationEvent,
  SubagentConversationSnapshot,
  SubagentConversationHistory,
  SubagentPromptResult,
  SubagentTurnStatus
} from '../../main/runtime/harness/subagent-conversation'
export type {
  TeamBoardSnapshot,
  TeamTask,
  TeamTaskStatus,
  TeamTaskView
} from '../../main/runtime/harness/team'
export type { PendingQuestionView, AskAnswer } from '../../main/runtime/harness/ask'
export type { StartMemoryAgentResult } from '../../main/runtime/harness/memory-agent'

/** Plan mode state (persisted per topic; shared by the input box badge and the command surface) */
export interface PlanModeView {
  topicId: number
  active: boolean
}

/**
 * Cross-process contract for plan review (exit_plan_mode).
 *
 * Answers use stable markers instead of button copy: switching the UI language doesn't affect
 * the main process's judgement of "approve / keep planning". It lives in shared because both the
 * renderer's review modal and the main process's exit tool need it, and the main process modules
 * (electron / database / question service) must not be bundled into the renderer.
 */
export const PLAN_REVIEW_KIND = 'plan-review'
export const PLAN_REVIEW_APPROVE = 'plan-approve'
export const PLAN_REVIEW_KEEP_PLANNING = 'plan-keep-planning'

/* ── Sandbox permissions (tier + approval modal view) ── */
export type { PermissionMode, DenyReason } from '../../main/runtime/harness/permission'
export type {
  ApprovalRequestView,
  ApprovalDecision
} from '../../main/runtime/harness/permission-gate'

/* ── Workspace file change history and file watching ── */
export type { FileChangeView, FileChangeContent } from '../../main/workspace/file-history'
export type { WorkspaceFsChange } from '../../main/workspace/watcher'

/* ── MCP servers (config / status / tools; shared contract of the Settings → MCP page and tool assembly) ── */
export type {
  McpServerConfig,
  McpServerInput,
  McpServerStatus,
  McpServerView,
  McpToolInfo,
  McpTransport,
  MainAgentConfig
} from './mcp'

/* ── Stream chunks (main-process StructuredMessage + injected topicId) ── */
export type { StreamChunk } from '../../main/services/harness/types'

/**
 * Final status marker of a turn (authoritative conclusion from the main process; the renderer
 * only reads it, never guesses): part of the `harness-stream-done` payload, source of truth in
 * main/service/answer-boundary.ts.
 */
export type { TurnFinal } from '../../main/services/harness/answer-boundary'

/**
 * Queued interjection entry during generation (the main process is the single source of truth;
 * the broadcast view doesn't include attachment bodies).
 *
 * Originally defined in `src/renderer/resource/types/window.d.ts` (core's window/api type table),
 * used only by harness's QueueDock and useHarnessHandlers, and moved into the plugin this round.
 */
export interface QueuedMessageView {
  id: string
  topicId: number
  text: string
  createdAt: number
  attachments: { fileName: string; isImage: boolean }[]
  /** Interjection clicked but this turn never reached the injection boundary: kept in the queue and sent with the next send */
  held?: boolean
}

/**
 * Accumulated usage for the current turn during generation (`harness-turn-usage` event payload).
 *
 * One is pushed after each model round-trip; `calls` and the token counts are **accumulated for
 * the turn** (not the latest one), used by the input box footer to show "N calls this turn · X
 * tok" while generating. It is only a progress signal: discarded after the stream ends, when the
 * authoritative ledger in harness_dialogue_usage is read instead.
 */
export interface TurnUsageView {
  topicId: number
  turnId: number
  calls: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

/* ── Mnemon three-layer memory (IPC return shapes read by the memory settings page) ── */

/** Hot memory entry (USER user profile / MEMORY project memory) */
export interface MnemonRuntimeEntry {
  content: string
  created_at: string
  updated_at: string
  target: 'user' | 'memory'
  importance: 'critical' | 'normal' | 'low'
}

/** Capacity usage of one hot memory layer */
export interface MnemonTargetUsage {
  target: 'user' | 'memory'
  used: number
  limit: number
  entryCount: number
  markdownPath: string
}

/** Long-term memory space (Memory Space) entry */
export interface MnemonBodyItem {
  id: string
  name: string
  description: string
  active: boolean
  dbPath?: string
  healthy: boolean
  error?: string
  stats?: {
    totalInsights: number
    edgeCount: number
    deletedInsights: number
  }
}

/** Receipt body for creating/updating a memory space */
export interface MnemonBodyRef {
  id: string
  name: string
  description: string
  active: boolean
}

/** Project Documents entry */
export interface MnemonDocumentItem {
  id: string
  title: string
  description?: string
  status: 'active' | 'archived'
  updatedAt: string
  lastAccessedAt?: string
  revision: number
  sizeBytes?: number
  healthy?: boolean
  excerpt: string
}

/** Return of `harness:mnemon-snapshot` (only configured:false when no memory directory is configured) */
export interface MnemonSnapshot {
  configured: boolean
  error?: string
  runtime?: {
    revision: string
    entries: MnemonRuntimeEntry[]
    targets: Record<'user' | 'memory', MnemonTargetUsage>
  }
  bodies?: {
    items: MnemonBodyItem[]
    total: number
    activeCount: number
    directory: string
  }
  documents?: {
    total: number
    activeCount: number
    archivedCount: number
    activeBytes?: number
    limitBytes?: number
    documents: MnemonDocumentItem[]
  }
}

/** Return of `harness:mnemon-bodies` */
export interface MnemonBodiesView {
  items: MnemonBodyItem[]
  total: number
  activeCount: number
  directory?: string
}

/** Memory space content browse row (`harness:mnemon-body-list`) */
export interface MnemonBodyInsight {
  id: string
  content: string
  category?: string
  importance?: number
  createdAt?: string
}

/* ── Message blocks (contract of both ends: stream chunks / persisted blocks column) ── */

/** Tool card semantic category: decides the icon, the meta info and "what opens on click" */
export type ToolCardKind = 'file' | 'dir' | 'search' | 'command'

/**
 * Customized tool card data (for built-in file/command tools only).
 *
 * Results of these tools are no longer streamed/persisted with the stream (see
 * main/service/tool-presentation.ts): the chat only has this card, and clicking it opens the
 * real file or result detail in the right panel.
 */
export interface ToolCard {
  kind?: ToolCardKind
  path?: string
  pattern?: string
  count?: number
  command?: string
  /** Result status; on error the card shows the failure reason */
  status?: 'ok' | 'error'
  /** Failure reason / result summary (single line) */
  message?: string
  /** read_file: total line count of the file */
  lines?: number
  /** read_file / execute: number of characters in the result */
  chars?: number
  /** read_file: file is longer than the inline limit, output was truncated */
  truncated?: boolean
  /** read_file: line range read by offset/limit (1-based, inclusive) */
  range?: { start: number; end: number; total: number }
  /** write_file: number of bytes written */
  bytes?: number
  /** write_file / edit_file: lines added in this change (same source as the change record; hidden when missing) */
  added?: number
  /** write_file / edit_file: lines removed in this change */
  removed?: number
  /** ls: number of subdirectories */
  dirs?: number
  /** ls / glob: number of files */
  files?: number
  /** grep: number of matching files (deduped) */
  fileCount?: number
  /** execute: exit code */
  exitCode?: number
  /** execute: job id of the background job (when run_in_background=true) */
  jobId?: string
  /** execute: this call only put the command in the background; result/exit code live in the background job */
  background?: boolean
  /** Full result detail exists; clicking the card opens it in the right panel */
  detail?: boolean
}

/** Images in tool results (data URL: rendered directly by the UI, also used for history replay) */
export interface ToolImageData {
  dataUrl: string
  /** Virtual path (used in card title / history replay copy) */
  path: string
  mimeType?: string
}

/** Tool call */
export interface ToolCall {
  name: string
  input: object
  output: string
  status?: 'preparing' | 'executing' | 'completed'
  id?: string
  card?: ToolCard
  /** Images carried by this tool result (media tools such as read_image); the UI renders thumbnails and history replay re-injects them */
  images?: ToolImageData[]
}

/** Agent activity event */
export interface SubAgentEvent {
  name: string
  /** Unique ID of the task tool call that dispatched this agent */
  causeId?: string
  /** dispatched = background job dispatched (lightweight card: name + brief + session id only, result viewable in the top bar) */
  status: 'started' | 'running' | 'dispatched' | 'completed' | 'error'
  output?: string
  message?: string
  error?: string
  content?: string
  reasoning_content?: string
  tool?: ToolCall
  /** Task description carried by the task tool call (only converted by the frontend from the task tool input) */
  taskDescription?: string
  /** Session ID when dispatched in the background (status='dispatched') (subagent-N) */
  subagentId?: string
}

/** Memory injection block data (relayed from the main-process MemoryInjection) */
export interface MemoryInjectionBlock {
  /** User profile entries (USER) */
  user: string[]
  /** Project memory entries (MEMORY) */
  memory: string[]
  /** Capacity info display string */
  usage: { user: string; memory: string }
}

/** Early conversation summary compaction block data (relayed from the main-process HistoryCompaction) */
export interface HistoryCompactionBlock {
  /** Number of early conversation entries compressed into a checkpoint summary */
  compressedCount: number
  /** Number of recent conversation entries kept as is */
  retainedCount: number
  /** Compaction boundary (ID of the last conversation entry in the compressed segment) */
  boundaryId: number
}

/** Automatic retry progress after a model request fails (retrying transition block: shown only for the turn, not persisted) */
export interface RetryInfoBlock {
  /** Current retry attempt (starts at 1, e.g. 1/2, 2/2) */
  attempt: number
  /** Maximum retries for this turn */
  retries: number
}

/** Message block */
export interface MessageBlock {
  type:
    | 'text'
    | 'tool'
    | 'reasoning'
    | 'image'
    | 'document'
    | 'subAgent'
    | 'memoryInjected'
    | 'historyCompacting'
    | 'historyCompacted'
    | 'goalRound'
    | 'retrying'
    /** In-turn interjection marker: the main process uses it to exclude this row from the model context (display and audit trail only) */
    | 'interjection'
  text?: string
  tool?: ToolCall
  reasoning?: string
  image_url?: string
  fileName?: string
  subAgent?: SubAgentEvent
  /** Hot memory content injected this turn (used by the memoryInjected type) */
  memory?: MemoryInjectionBlock
  /** Early conversation summary compaction info for this turn (used by the historyCompacted type) */
  compaction?: HistoryCompactionBlock
  /** Goal auto-continuation round number (used by the goalRound type) */
  round?: number
  /** The goal objective for that continuation round (used by the goalRound type; persisted with the message, shown directly by the renderer) */
  objective?: string
  /** Automatic retry progress after a model request fails (used by the retrying type; a transition block that is not persisted) */
  retrying?: RetryInfoBlock
  /** Nested sub-blocks of the agent (only for the subAgent type, used to build the agent's text/tool/reasoning while streaming) */
  children?: MessageBlock[]
}
