import type {
  AgentConfigInput,
  AgentConfigRow,
  AgentPaginatedResult,
  ApprovalDecision,
  ApprovalRequestView,
  AskAnswer,
  FileChangeContent,
  FileChangeView,
  GoalView,
  HarnessDialogueRow,
  HarnessDialogueUsageRow,
  HarnessTopicRow,
  JobOutputView,
  JobSnapshot,
  MnemonBodiesView,
  MnemonBodyInsight,
  MnemonBodyRef,
  MnemonSnapshot,
  McpServerConfig,
  McpServerInput,
  McpServerView,
  McpToolInfo,
  PaginatedResult,
  PendingQuestionView,
  PermissionMode,
  PlanModeView,
  QueuedMessageView,
  StartMemoryAgentResult,
  SubagentConversationEvent,
  SubagentConversationSnapshot,
  SubagentConversationHistory,
  SubagentPromptResult,
  SubagentSessionRow,
  TeamBoardSnapshot,
  TeamModeView,
  TeamTaskEventView,
  TodoItem,
  TurnFinal,
  TurnUsageView,
  WorkspaceFsChange,
  WorkspaceRow
} from '../../../shared/harness/types'
import type { HarnessToolInfo } from '../types/harness/types'
import type {
  WorkshopActionResult,
  WorkshopBuildInfo,
  WorkshopDraftDetail,
  WorkshopDraftSummary,
  WorkshopPublishResult,
  WorkshopReport
} from '../../../shared/harness/workshop'

/** Permission mode state view (main process is source of truth: current topic mode +
 * new-session default) */
export interface PermissionStateView {
  topicId: number
  mode: PermissionMode
  defaultMode: PermissionMode
}

/** Sidebar search: topics matched by title */
export interface WorkspaceSearchTopicHit {
  id: number
  title: string
  updatedAt: string | null
  archived: boolean
  pinned: boolean
}

/** Sidebar search: message snippets matched in body text */
export interface WorkspaceSearchMessageHit {
  dialogueId: number
  topicId: number
  topicTitle: string
  role: string
  snippet: string
  createdAt: string | null
}

/** Sidebar search results (isolated per workspace) */
export interface WorkspaceSearchResult {
  workspaceId: number
  query: string
  topics: WorkspaceSearchTopicHit[]
  hits: WorkspaceSearchMessageHit[]
}

/** MCP resource entry (shown under Settings → Resources; matches the runtime listResources
 * projection) */
export interface McpResourceEntry {
  uri: string
  name?: string
  description?: string
  mimeType?: string
}

/** MCP resource template entry (parameterized URI) */
export interface McpResourceTemplateEntry {
  uriTemplate: string
  name?: string
  description?: string
  mimeType?: string
}

/** A piece of content read from an MCP resource (either text or base64 blob) */
export interface McpResourceContentEntry {
  uri?: string
  mimeType?: string
  text?: string
  blob?: string
}

/** Persistent terminal session (matches the main process terminal-sessions view) */
export type TerminalShellKind = 'pwsh' | 'cmd' | 'sh'

export interface TerminalSessionView {
  sessionId: string
  shell: TerminalShellKind
  cwd: string
  createdAt: number
  alive: boolean
  unreadChars: number
}

/** One terminal output snapshot (non-consuming; used by panel polling) */
export interface TerminalPeekView {
  ok: true
  sessionId: string
  alive: boolean
  shell: TerminalShellKind
  cwd: string
  createdAt: number
  text: string
  truncated: boolean
  droppedChars: number
  binary: boolean
}

/** User-side real terminal (node-pty) session view */
export type PtyShellKind = 'pwsh' | 'cmd' | 'sh'

export interface PtySessionView {
  sessionId: string
  topicId: number
  shell: PtyShellKind
  cwd: string
  cols: number
  rows: number
  alive: boolean
  createdAt: number
  pid: number
}

/** Scheduled task view (Settings → Scheduled Tasks page; fields match the main process
 * schedule-store) */
export interface ScheduleView {
  id: string
  title: string
  prompt: string
  when:
    | { kind: 'once'; at: string }
    | { kind: 'every'; minutes: number }
    | { kind: 'daily'; time: string }
  enabled: boolean
  /** Target topic (null = create a new topic on every run) */
  topicId: number | null
  /** Target mode (chat/work/plugin); null = legacy data (follows the topic's mode) */
  targetMode: 'chat' | 'work' | 'plugin' | null
  /** Target workspace for new-topic tasks */
  targetWorkspaceId: number | null
  /** Memory scope for new-topic tasks (chat / plugin:<id> / null) */
  targetMemoryScope: string | null
  /** Task-level run selection (tools/skills/MCP; null dimension follows the topic or defaults) */
  agentConfig: AgentSelectionView | null
  /** Model override `provider:model` (null = the default model) */
  model: string | null
  createdAt: string
  updatedAt: string
  nextRunAt: string | null
  lastRunAt?: string
  lastStatus?: 'completed' | 'cancelled' | 'failed'
}

/** Topic-level run selection (tools / skills / MCP tools; null = don't override / disabled) */
export interface AgentSelectionView {
  tools: string[] | null
  skills: string[] | null
  mcpTools: string[] | null
}

/** Schedule rule (shared by the page form and IPC) */
export type ScheduleWhenView = ScheduleView['when']

/** One run record (persisted permanently) */
/** One row of the "open with" menu (see main/services/harness/file-open.ts) */
export interface FileOpenTargetView {
  /** `default` or `app:<exe>` */
  id: string
  /** App label; the `default` row carries a placeholder and is localized by the UI */
  label: string
  /** System icon as a PNG data URL */
  icon?: string
  kind: 'default' | 'app'
}

export interface ScheduleRunView {
  /** Stable record id (used by "re-run" to overwrite this record) */
  id: number
  at: string
  status: 'completed' | 'cancelled' | 'failed'
  detail?: string | null
  /** Conversation this run executed in (null for old runs / early failures) */
  topicId?: number | null
  /** Assistant dialogue row produced by this run */
  dialogueId?: number | null
  usage?: {
    inputTokens: number | null
    outputTokens: number | null
    totalTokens: number | null
    durationMs: number | null
  } | null
  steps?: { name: string; path: string | null; status: 'ok' | 'error' }[] | null
  artifacts?:
    | {
        kind: 'file' | 'deliverable'
        path: string
        description: string | null
      }[]
    | null
}

/** Create/edit result: expected failures don't throw, `error` is a stable code (translated by
 * the page) */
export type ScheduleMutationResult = { ok: true; task: ScheduleView } | { ok: false; error: string }

/** Web search provider id */
export type SearchProviderId = 'builtin' | 'deepseek' | 'tavily'

/** External state of a single search provider (keys are only exposed masked) */
export interface SearchProviderState {
  provider: SearchProviderId
  requiresKey: boolean
  configured: boolean
  maskedKey?: string
  /** A key for the same vendor already exists under Settings → Models; offer to reuse it */
  canReuseModelKey?: boolean
}

/** Complete search settings read by the settings page */
export interface SearchSettingsView {
  defaultProvider: SearchProviderId
  autoFallback: boolean
  includeContent: boolean
  providers: SearchProviderState[]
}

/** Search provider test result */
export interface SearchProviderTestResult {
  ok: boolean
  provider: SearchProviderId
  elapsedMs: number
  itemCount: number
  code?: string
  message?: string
}

/**
 * Return shape for goal actions: every UI entry point (create/edit/pause/resume/complete/clear)
 * uses it.
 *
 * Same convention as workshop actions: expected failures don't throw; `error` holds text ready to
 * display; stable codes like `goal-objective-required` / `goal-missing` are translated by the
 * renderer, everything else (state-machine rejections) shows the localized text returned by the
 * main process.
 */
export interface GoalActionResult {
  ok: boolean
  goal?: GoalView
  error?: string
}

/**
 * Return shape for "chat" mode actions: same convention as workshop (failures don't throw; the
 * renderer displays `error` verbatim). Reuses `WorkshopActionResult` so the same thing doesn't
 * need two types.
 */
export type ChatActionResult<T = unknown> = WorkshopActionResult<T>

/** Sandbox backend status (the settings page shows whether there is real kernel-level isolation) */
export interface SandboxStatusView {
  platform: string
  backend: string | null
  enforcement: 'full' | 'partial' | null
  usable: boolean
  reason?: string
  tempRoot?: string
  windowsRunnerPath?: string
  landlockLauncherPath?: string
}

/**
 * Thin wrapper over the harness plugin's main-process channels.
 *
 * The four namespaces that used to live in `src/preload/index.ts` (`harness` / `agents` /
 * `mainAgent` / `workspace`, with the Mnemon memory methods nested inside `harness`) were removed
 * outright; the method groups here map one-to-one to **names, parameters and return types** (the
 * grouping is kept so `getAll` / `update` / `delete` don't collide across domains), while the
 * implementation now goes through the single generic bridge exposed by preload
 * (`window.api.system.invoke/on`, channel names `harness:*`).
 *
 * Event subscriptions also go through the generic bridge: a channel only enters the preload
 * whitelist if the plugin main process declared it with `ctx.registerEvent`; when the plugin is
 * disabled, subscription calls **no longer throw** (preload only warns), but with no sender there
 * are no events at all — callers must still be written for "the event may never arrive"
 * (historical lesson: an exception escaping useEffect unmounts the whole render tree and blanks
 * the screen).
 *
 * The contract lives in src/main/plugins/context.ts; types come from shared/types.ts
 * (cross-process DTOs with zero runtime dependencies).
 */
const invoke = window.api.system.invoke

/** Subscribe to a main process → renderer event channel (generic bridge + whitelist gate) */
const on = (channel: string, callback: (data: unknown) => void): (() => void) =>
  window.api.system.on(channel, callback)

/** Payload at the end of a streamed turn (harness-stream-done) */
export interface StreamDoneResult {
  topicId: number
  /** Turn id of this round (the renderer uses it to drop stale completion events from other
   * turns) */
  turnId?: number
  userDialogueId?: number
  assistantDialogueId?: number
  /** Assistant segment list (a single segment when nothing was interjected): messageId maps to
   * one assistant bubble */
  segments?: { messageId: string; dialogueId?: number }[]
  /** Turn-final marker for this round (final answer boundary + whether the goal was closed) */
  turnFinal?: TurnFinal
}

/** Topic turn state (main process is the source of truth: the renderer no longer infers
 * "is it generating") */
export interface TurnStateResult {
  active: boolean
  turnId: number | null
}

/** Result of starting a turn: started=false & queued=true means the main process decided the
 * previous turn was still running and this message was queued */
export interface StartTurnResult {
  started: boolean
  queued?: boolean
}

type AskAnswerItem = AskAnswer['answers'][number]

export const harnessApi = {
  /* ── Assistant core (topic chat / streaming / queue / goals / background jobs / subagents /
   * questions / VFS) ── */
  harness: {
    sendMessage: (message: string, options?: { providerId?: number }) =>
      invoke('harness:harness-send-message', message, options),
    startMessageStream: (
      message: string,
      options?: {
        topicId?: number
        providerId?: number
        images?: string[]
        documents?: { fileName: string; filePath: string }[]
        /** Run selection for this turn (tools/skills/MCP chosen below the input box; the main
         * process writes it back to the topic) */
        agentConfig?: AgentSelectionView
        /** Edit and resend: rewrite this existing user message row instead of inserting a new
         * one */
        reuseUserDialogueId?: number
        /** Frontend temporary id for the first assistant segment of this turn (interjections
         * split segments; the main process returns dialogueId per segment) */
        messageId?: string
      }
    ) => {
      // harness-start-stream has moved from ipcMain.on to an invoke channel (see plugin
      // main/index.ts)
      return invoke('harness:harness-start-stream', message, options) as Promise<
        StartTurnResult | undefined
      >
    },
    /** Whether the topic currently has a running turn (main process source of truth; the
     * renderer asks before sending to avoid two concurrent turns) */
    getTurnState: (topicId: number) =>
      invoke('harness:harness-turn-state', topicId) as Promise<TurnStateResult>,

    // ── Interjection queue while generating ──────────────────────────────────────
    /** Send while generating: the main process decides — queue it if a turn is running
     * (queued=true), otherwise start a new turn */
    enqueueMessage: (payload: {
      topicId: number
      text: string
      attachments?: {
        images?: string[]
        documents?: { fileName: string; filePath: string }[]
      }
    }) => invoke('harness:harness-queue-enqueue', payload) as Promise<{ queued: boolean }>,
    listQueuedMessages: (topicId: number) =>
      invoke('harness:harness-queue-list', topicId) as Promise<QueuedMessageView[]>,
    removeQueuedMessage: (topicId: number, itemId: string) =>
      invoke('harness:harness-queue-remove', { topicId, itemId }) as Promise<boolean>,
    updateQueuedMessage: (topicId: number, itemId: string, text: string) =>
      invoke('harness:harness-queue-update', { topicId, itemId, text }) as Promise<boolean>,
    /** Interject immediately: inject this queued message into the running turn (takes effect at
     * the next tool node boundary) */
    steerQueuedMessage: (topicId: number, itemId: string) =>
      invoke('harness:harness-queue-steer', { topicId, itemId }) as Promise<{
        accepted: boolean
      }>,
    onQueueUpdated: (
      callback: (data: { topicId: number; queue: QueuedMessageView[] }) => void
    ): (() => void) =>
      on('harness:harness-queue-updated', (data) =>
        callback(data as { topicId: number; queue: QueuedMessageView[] })
      ),
    onQueueSteered: (
      callback: (data: { topicId: number; itemId: string; text: string }) => void
    ): (() => void) =>
      on('harness:harness-queue-steered', (data) =>
        callback(data as { topicId: number; itemId: string; text: string })
      ),

    getTools: () => invoke('harness:harness-get-tools') as Promise<HarnessToolInfo[]>,

    onStreamChunk: (callback: (chunk: Record<string, unknown>) => void): (() => void) =>
      on('harness:harness-stream-chunk', (chunk) => callback(chunk as Record<string, unknown>)),
    onStreamDone: (callback: (result: StreamDoneResult) => void): (() => void) =>
      on('harness:harness-stream-done', (result) => callback(result as StreamDoneResult)),
    onStreamError: (
      callback: (error: { error: string; topicId?: number; turnId?: number }) => void
    ): (() => void) =>
      on('harness:harness-stream-error', (error) =>
        callback(error as { error: string; topicId?: number; turnId?: number })
      ),

    /**
     * A document was modified/deleted by a chat tool (the notes plugin's editor syncs or warns on
     * it to avoid overwriting tool writes). Nobody in the renderer subscribes to it directly any
     * more — the harness renderer install bridges it to the host event bus's semantic event
     * `doc:changed` (see renderer/plugin.tsx), consumed by the notes document editor.
     */
    onDocChanged: (
      callback: (data: { docId: number; action: 'updated' | 'deleted' }) => void
    ): (() => void) =>
      on('harness:harness-doc-changed', (data) =>
        callback(data as { docId: number; action: 'updated' | 'deleted' })
      ),

    getHarnessTodos: (topicId: number) =>
      invoke('harness:harness-todos-get', topicId) as Promise<TodoItem[]>,
    onHarnessTodosUpdated: (
      callback: (data: { topicId: number; todos: TodoItem[] }) => void
    ): (() => void) =>
      on('harness:harness-todos-updated', (data) =>
        callback(data as { topicId: number; todos: TodoItem[] })
      ),

    // Goal system (goal)
    getGoal: (topicId: number) =>
      invoke('harness:harness-goal-get', topicId) as Promise<GoalView | null>,
    onGoalUpdated: (
      callback: (data: { topicId: number; goal: GoalView | null }) => void
    ): (() => void) =>
      on('harness:harness-goal-updated', (data) =>
        callback(data as { topicId: number; goal: GoalView | null })
      ),
    /** Create a goal (UI entry point: direct human request; success arms automatic continuation) */
    createGoal: (payload: { topicId: number; objective: string; maxGoalRounds?: number }) =>
      invoke('harness:harness-goal-create', payload) as Promise<GoalActionResult>,
    /** Update goal: edit objective text / pause / resume / mark complete */
    updateGoal: (payload: {
      topicId: number
      action: 'edit' | 'pause' | 'resume' | 'complete'
      objective?: string
      maxGoalRounds?: number
    }) => invoke('harness:harness-goal-update', payload) as Promise<GoalActionResult>,
    /** Clear the goal (delete this topic's goal row; automatic continuation is released with it) */
    clearGoal: (topicId: number) =>
      invoke('harness:harness-goal-clear', topicId) as Promise<GoalActionResult>,

    // Plan mode: per-topic persisted "plan first, execute after approval" switch
    getPlanMode: (topicId: number) =>
      invoke('harness:harness-plan-get', topicId) as Promise<PlanModeView>,
    setPlanMode: (payload: { topicId: number; active: boolean }) =>
      invoke('harness:harness-plan-set', payload) as Promise<PlanModeView>,
    onPlanModeUpdated: (callback: (data: PlanModeView) => void): (() => void) =>
      on('harness:harness-plan-updated', (data) => callback(data as PlanModeView)),

    // Agent Teams mode (opt-in, per topic): when off, team_task_* tools and team prompts are
    // not injected
    getTeamMode: (topicId: number) =>
      invoke('harness:harness-team-mode-get', topicId) as Promise<TeamModeView>,
    setTeamMode: (payload: { topicId: number; enabled: boolean }) =>
      invoke('harness:harness-team-mode-set', payload) as Promise<TeamModeView>,
    onTeamModeUpdated: (callback: (data: TeamModeView) => void): (() => void) =>
      on('harness:harness-team-mode-updated', (data) => callback(data as TeamModeView)),

    // Scheduled tasks (Settings → "Scheduled Tasks" page): list + pause/resume/delete
    listSchedules: () => invoke('harness:harness-schedule-list') as Promise<ScheduleView[]>,
    updateSchedule: (payload: { id: string; action: 'pause' | 'resume' | 'delete' }) =>
      invoke('harness:harness-schedule-update', payload) as Promise<{ ok: boolean }>,
    // Sidebar "Scheduled Tasks" page: create / full edit / run history
    createSchedule: (payload: {
      title: string
      prompt: string
      when: ScheduleWhenView
      /** Fixed-topic task: target topic id */
      topicId?: number | null
      /** New-topic task: target mode + workspace + memory scope */
      targetMode?: 'chat' | 'work' | 'plugin' | null
      targetWorkspaceId?: number | null
      targetMemoryScope?: string | null
      /** Task-level run selection */
      agentConfig?: AgentSelectionView | null
      /** Model override `provider:model`; omitted/null = default model */
      model?: string | null
    }) => invoke('harness:harness-schedule-create', payload) as Promise<ScheduleMutationResult>,
    updateScheduleFull: (payload: {
      id: string
      title?: string
      prompt?: string
      when?: ScheduleWhenView
      enabled?: boolean
      topicId?: number | null
      targetMode?: 'chat' | 'work' | 'plugin' | null
      targetWorkspaceId?: number | null
      targetMemoryScope?: string | null
      agentConfig?: AgentSelectionView | null
      /** Model override `provider:model`; omitted = keep, null = clear */
      model?: string | null
    }) =>
      invoke('harness:harness-schedule-update-full', payload) as Promise<ScheduleMutationResult>,
    // Topic-level run selection (tools/skills/MCP chosen below the input box, persisted per topic)
    getTopicAgentSelection: (topicId: number) =>
      invoke('harness:harness-topic-agent-selection-get', {
        topicId
      }) as Promise<AgentSelectionView | null>,
    setTopicAgentSelection: (topicId: number, selection: AgentSelectionView) =>
      invoke('harness:harness-topic-agent-selection-set', { topicId, selection }) as Promise<
        { ok: true; selection: AgentSelectionView } | { ok: false; error: string }
      >,
    getScheduleRuns: (id: string, limit?: number, offset?: number) =>
      invoke('harness:harness-schedule-runs', { id, limit, offset }) as Promise<{
        runs: ScheduleRunView[]
        total: number
      }>,
    /**
     * Re-run one execution record, overwriting that record's data in place (no new history row).
     * Resolves when the turn finished; `error` is a stable code the page translates.
     */
    rerunScheduleRun: (payload: { taskId: string; runId: number }) =>
      invoke('harness:harness-schedule-rerun', payload) as Promise<
        { ok: true; run: ScheduleRunView } | { ok: false; error: string }
      >,

    // Web search settings (Settings → "Web Search" page)
    getSearchSettings: () =>
      invoke('harness:harness-search-settings-get') as Promise<SearchSettingsView | null>,
    saveSearchProviderKey: (provider: SearchProviderId, apiKey: string) =>
      invoke('harness:harness-search-provider-save-key', { provider, apiKey }) as Promise<
        { ok: true; maskedKey: string } | { ok: false; error: string }
      >,
    clearSearchProviderKey: (provider: SearchProviderId) =>
      invoke('harness:harness-search-provider-clear-key', { provider }) as Promise<{
        ok: boolean
        error?: string
      }>,
    setSearchDefault: (provider: SearchProviderId) =>
      invoke('harness:harness-search-default-set', { provider }) as Promise<
        { ok: true; provider: SearchProviderId } | { ok: false; error: string }
      >,
    setSearchBehaviors: (patch: { autoFallback?: boolean; includeContent?: boolean }) =>
      invoke('harness:harness-search-behavior-set', patch) as Promise<{ ok: boolean }>,
    testSearchProvider: (provider: SearchProviderId) =>
      invoke('harness:harness-search-provider-test', {
        provider
      }) as Promise<SearchProviderTestResult>,

    // Background job system (jobs)
    onJobsUpdated: (
      callback: (data: { topicId: number; jobs: JobSnapshot[] }) => void
    ): (() => void) =>
      on('harness:harness-jobs-updated', (data) =>
        callback(data as { topicId: number; jobs: JobSnapshot[] })
      ),
    /** Background job list for the current topic (fetched once when the top bar first opens or
     * the topic changes) */
    listJobs: (topicId: number) =>
      invoke('harness:harness-jobs-list', topicId) as Promise<JobSnapshot[]>,
    /** Manually stop a background job (cancellation request; the job finishes in the killed
     * terminal state) */
    killJob: (topicId: number, jobId: string) =>
      invoke('harness:harness-job-kill', topicId, jobId) as Promise<{
        outcome: 'cancellation-requested' | 'already-finished' | 'not-found'
        job: JobSnapshot | null
      }>,
    /** Peek at a job output snapshot (tail-truncated; does not consume the model's job_output
     * cursor) */
    peekJobOutput: (topicId: number, jobId: string) =>
      invoke('harness:harness-job-output-peek', topicId, jobId) as Promise<JobOutputView>,

    // Background subagent sessions (top bar list: running > finished; click to view results)
    listAgents: (topicId: number) =>
      invoke('harness:harness-agents-list', topicId) as Promise<SubagentSessionRow[]>,
    /**
     * Store to memory: start a background "memory consolidation" subagent that summarizes and
     * writes to Mnemon itself, then return immediately. Progress and results go through the top
     * bar's background agent entry (onAgentsUpdated); no need to wait for it to finish.
     */
    startMemoryAgent: (payload: {
      topicId: number
      answer: string
      dialogueId?: number
      providerId?: number
    }) => invoke('harness:harness-memory-agent-start', payload) as Promise<StartMemoryAgentResult>,
    onAgentsUpdated: (
      callback: (data: { topicId: number; rows: SubagentSessionRow[] }) => void
    ): (() => void) =>
      on('harness:harness-agents-updated', (data) =>
        callback(data as { topicId: number; rows: SubagentSessionRow[] })
      ),

    // Background subagent session view: click a subagent → the main chat area switches to its
    // streamed session record
    /** Session snapshot (event stream + seq; does not register a watch, used for re-pulling
     * from a checkpoint) */
    agentConversation: (topicId: number, agentId: string) =>
      invoke(
        'harness:harness-agent-conversation',
        topicId,
        agentId
      ) as Promise<SubagentConversationSnapshot | null>,
    /** Page backwards: fetch the most recent full page of turns before beforeSeq (called when
     * the session view scrolls to the top) */
    agentConversationOlder: (topicId: number, agentId: string, beforeSeq: number, maxTurns = 20) =>
      invoke(
        'harness:harness-agent-conversation-older',
        topicId,
        agentId,
        beforeSeq,
        maxTurns
      ) as Promise<SubagentConversationHistory | null>,
    /**
     * Open/close the session view. With watch=true the main process registers a watch and returns
     * the **current snapshot** directly; incremental events then arrive via
     * onAgentConversationUpdated (merged by seq).
     */
    watchAgentConversation: (topicId: number, agentId: string, watch: boolean) =>
      invoke(
        'harness:harness-agent-conversation-watch',
        topicId,
        agentId,
        watch
      ) as Promise<SubagentConversationSnapshot | null>,
    onAgentConversationUpdated: (
      callback: (data: {
        topicId: number
        agentId: string
        events: SubagentConversationEvent[]
      }) => void
    ): (() => void) =>
      on('harness:harness-agent-conversation-updated', (data) =>
        callback(data as { topicId: number; agentId: string; events: SubagentConversationEvent[] })
      ),
    /** Manual follow-up: send a message to the subagent (starts a new turn when idle, queues
     * while running; returns a delivery receipt) */
    sendAgentPrompt: (topicId: number, agentId: string, message: string) =>
      invoke('harness:harness-agent-prompt', {
        topicId,
        agentId,
        message
      }) as Promise<SubagentPromptResult>,
    /** Stop the subagent's current turn (already queued messages are kept) */
    interruptAgent: (topicId: number, agentId: string) =>
      invoke('harness:harness-agent-interrupt', topicId, agentId) as Promise<{
        accepted: boolean
      }>,

    // Agent Teams / super agent: shared task board (team/task projection of main agent +
    // subagent collaboration)
    /** Shared task board snapshot for the current topic (fetched once when the top bar task
     * entry opens) */
    listTeamTasks: (topicId: number) =>
      invoke('harness:harness-team-tasks', topicId) as Promise<TeamBoardSnapshot>,
    /** Whole-board change push (the main process pushes a full snapshot on every change, with a
     * revision to discard stale ones) */
    onTeamUpdated: (callback: (snapshot: TeamBoardSnapshot) => void): (() => void) =>
      on('harness:harness-team-updated', (data) => callback(data as TeamBoardSnapshot)),
    listTeamEvents: (topicId: number, limit = 20) =>
      invoke('harness:harness-team-events', topicId, limit) as Promise<TeamTaskEventView[]>,

    // Ask the user a question (ask_user_question)
    onQuestionAsked: (callback: (pending: PendingQuestionView) => void): (() => void) =>
      on('harness:harness-question-asked', (pending) => callback(pending as PendingQuestionView)),
    answerQuestion: (requestId: string, answers: AskAnswerItem[]) =>
      invoke('harness:harness-question-answer', requestId, answers) as Promise<boolean>,
    /**
     * The user cancels answering: the main process settles the pending question with
     * `cancelled: true`, **the turn does not end**, and the model continues after receiving it;
     * after this call the frontend collapses the inline question panel immediately.
     */
    cancelQuestion: (requestId: string) =>
      invoke('harness:harness-question-cancel', requestId) as Promise<boolean>,
    getQuestion: (topicId: number) =>
      invoke('harness:harness-question-get', topicId) as Promise<PendingQuestionView | null>,
    /**
     * Broadcast of a topic's "does it still need user confirmation" flip (pending=true when a
     * question / approval is pending; false on answer / allow / deny / abort). The yellow
     * breathing dot at the start of the sidebar row switches on it. Not filtered by the current
     * topic: when another topic is pending, that row lights up too.
     */
    onTopicPending: (
      callback: (data: { topicId: number; pending: boolean }) => void
    ): (() => void) =>
      on('harness:harness-topic-pending', (data) =>
        callback(data as { topicId: number; pending: boolean })
      ),

    /* ── Sandbox permissions (mode selector + dangerous-operation approval modal) ── */
    /** Current mode and new-session default (fetched once when switching topics) */
    getPermission: (topicId?: number | null) =>
      invoke(
        'harness:harness-permission-get',
        topicId ?? undefined
      ) as Promise<PermissionStateView>,
    /** Switch mode: scope='default' changes the new-session default, otherwise this topic */
    setPermission: (payload: {
      topicId?: number | null
      mode: PermissionMode
      scope?: 'topic' | 'default'
    }) =>
      invoke('harness:harness-permission-set', {
        topicId: payload.topicId ?? undefined,
        mode: payload.mode,
        scope: payload.scope
      }) as Promise<PermissionStateView>,
    onPermissionUpdated: (callback: (state: PermissionStateView) => void): (() => void) =>
      on('harness:harness-permission-updated', (state) => callback(state as PermissionStateView)),
    /** Sandbox backend status: commands are refused when no backend is available (the settings
     * page must surface this) */
    sandboxStatus: () => invoke('harness:harness-sandbox-status') as Promise<SandboxStatusView>,
    /** Revoke the persistent ACE on a workspace (only meaningful for the Windows backend;
     * uninstall/cleanup entry) */
    cleanupSandbox: (workspacePath: string) =>
      invoke('harness:harness-sandbox-cleanup', workspacePath) as Promise<boolean>,
    /** The sandbox blocked a dangerous / out-of-bounds operation → show a modal and wait for the
     * user */
    onApprovalAsked: (callback: (pending: ApprovalRequestView) => void): (() => void) =>
      on('harness:harness-approval-asked', (pending) => callback(pending as ApprovalRequestView)),
    /** Decide: allow-once (let this one through only) / deny */
    decideApproval: (requestId: string, decision: ApprovalDecision) =>
      invoke('harness:harness-approval-decide', requestId, decision) as Promise<boolean>,
    getApproval: (topicId: number) =>
      invoke('harness:harness-approval-get', topicId) as Promise<ApprovalRequestView | null>,

    cancelStream: () => {
      void invoke('harness:harness-cancel-stream')
    },
    selectSkillsDirectory: () =>
      invoke('harness:harness-select-skills-directory') as Promise<string | null>,
    selectWorkspace: () => invoke('harness:harness-select-workspace') as Promise<string | null>,
    listSkills: () =>
      invoke('harness:harness-list-skills') as Promise<
        { id: string; name: string; description: string }[]
      >,
    /** Single skill (content = preview body; raw = original SKILL.md, for editing) */
    getSkill: (skillId: string) =>
      invoke('harness:harness-get-skill', skillId) as Promise<{
        id: string
        name: string
        description: string
        content: string
        raw: string
      } | null>,
    /** Save the original SKILL.md (including frontmatter) */
    saveSkill: (skillId: string, content: string) =>
      invoke('harness:harness-save-skill', skillId, content) as Promise<boolean>,
    /** Delete the skill directory (including SKILL.md) */
    deleteSkill: (skillId: string) =>
      invoke('harness:harness-delete-skill', skillId) as Promise<boolean>,
    /** Enable/disable a skill (the full directory check happens in the main process) */
    setSkillEnabled: (skillId: string, enabled: boolean) =>
      invoke('harness:harness-set-skill-enabled', skillId, enabled) as Promise<
        string[] | undefined
      >,

    // Memory management (Mnemon three-layer memory)
    // The trailing memoryScope decides **which set** of memory to read: `plugin:<plugin id>` = this
    // plugin's own; empty / omitted = the current workspace (see renderer/memory-scope.ts)
    selectMemoryDirectory: () =>
      invoke('harness:harness-select-memory-directory') as Promise<string | null>,
    mnemonSnapshot: (memoryScope?: string | null) =>
      invoke('harness:mnemon-snapshot', memoryScope ?? null) as Promise<MnemonSnapshot>,
    mnemonRuntimeMutate: (
      request: {
        action: string
        target: string
        content?: string
        old_text?: string
        importance?: string
      },
      memoryScope?: string | null
    ) =>
      invoke('harness:mnemon-runtime-mutate', request, memoryScope ?? null) as Promise<{
        success: boolean
        message: string
      }>,
    mnemonBodies: (memoryScope?: string | null) =>
      invoke('harness:mnemon-bodies', memoryScope ?? null) as Promise<MnemonBodiesView>,
    mnemonBodyCreate: (name: string, description: string, memoryScope?: string | null) =>
      invoke('harness:mnemon-body-create', { name, description }, memoryScope ?? null) as Promise<{
        success: boolean
        body?: MnemonBodyRef
        message?: string
      }>,
    mnemonBodyUpdate: (
      id: string,
      request: { name?: string; description?: string; active?: boolean },
      memoryScope?: string | null
    ) =>
      invoke('harness:mnemon-body-update', id, request, memoryScope ?? null) as Promise<{
        success: boolean
        body?: MnemonBodyRef
        message?: string
      }>,
    mnemonBodyList: (memoryBodyIds?: string[], memoryScope?: string | null) =>
      invoke('harness:mnemon-body-list', memoryBodyIds, memoryScope ?? null) as Promise<
        MnemonBodyInsight[]
      >,
    mnemonDocumentSnapshot: (memoryScope?: string | null) =>
      invoke('harness:mnemon-document-snapshot', memoryScope ?? null) as Promise<
        MnemonSnapshot['documents'] | null
      >,

    // Workspace management
    getAllWorkspaces: () => invoke('harness:workspace-get-all') as Promise<WorkspaceRow[]>,
    createWorkspace: (name: string, path: string) =>
      invoke('harness:workspace-create', name, path) as Promise<number>,
    updateWorkspace: (id: number, updates: { name: string }) =>
      invoke('harness:workspace-update', id, updates) as Promise<boolean>,
    /**
     * "Show in folder": open this workspace's directory in the system file manager.
     * Only the id is passed (the main process resolves the directory per row); when the directory
     * has been deleted/moved, a readable reason is returned instead of throwing.
     */
    openWorkspaceDir: (id: number) =>
      invoke('harness:workspace-open-dir', id) as Promise<WorkshopActionResult<string>>,
    deleteWorkspace: (id: number) => invoke('harness:workspace-delete', id) as Promise<boolean>,

    /**
     * "Chat" mode: it has no workspace concept, but the model needs a writable root directory (see
     * main/chat/workspace.ts). `ensureWorkspace` = enter this mode (or create a new topic in it);
     * `activateTopic` = open a topic (the active directory switches to `chat/<topic id>/`);
     * `removeTopicDir` = clean up that topic's directory after deletion.
     */
    ensureChatWorkspace: () =>
      invoke('harness:chat-ensure-workspace') as Promise<
        ChatActionResult<{ workspaceId: number; dir: string }>
      >,
    activateChatTopic: (topicId: number) =>
      invoke('harness:chat-activate-topic', topicId) as Promise<
        ChatActionResult<{ workspaceId: number; dir: string }>
      >,
    chatWorkspaces: () =>
      invoke('harness:chat-workspaces') as Promise<
        ChatActionResult<{ ids: number[]; rootWorkspaceId: number | null }>
      >,
    removeChatTopicDir: (topicId: number) =>
      invoke('harness:chat-remove-topic-dir', topicId) as Promise<ChatActionResult<boolean>>,

    // Topic management
    getAllTopics: (workspaceId: number) =>
      invoke('harness:harness-topic-get-all', workspaceId) as Promise<HarnessTopicRow[]>,
    /** Archived topics across all workspaces (used by the sidebar's "Archived" group at the
     * bottom, newest archived first) */
    getArchivedTopics: () =>
      invoke('harness:harness-topic-get-archived') as Promise<HarnessTopicRow[]>,
    getAllTopicsPaginated: (workspaceId: number, page: number, pageSize: number) =>
      invoke('harness:harness-topic-get-paginated', workspaceId, page, pageSize) as Promise<
        PaginatedResult<HarnessTopicRow>
      >,
    getTopicById: (id: number) =>
      invoke('harness:harness-topic-get-by-id', id) as Promise<HarnessTopicRow[]>,
    /**
     * Sidebar search: mixed "topic title + message body" search within the current workspace.
     * When workspaceId is omitted the main process uses the active workspace; body matches are
     * returned as keyword snippets.
     */
    searchWorkspace: (payload: { query: string; workspaceId?: number; limit?: number }) =>
      invoke('harness:harness-search-workspace', payload) as Promise<WorkspaceSearchResult>,
    createTopic: (
      workspaceId: number,
      title: string,
      model?: string,
      selectedTools?: string,
      /** Memory scope: `plugin:<plugin id>` = this plugin's own memory; empty = follow the
       * workspace */
      memoryScope?: string | null,
      /**
       * Team collaboration (Agent Teams) switch: persisted together with the topic.
       * The toggle clicked in a blank topic is a "draft"; the renderer passes it along when the
       * first message creates the topic. Omitted = off.
       */
      teamMode?: boolean
    ) =>
      invoke(
        'harness:harness-topic-create',
        workspaceId,
        title,
        model,
        selectedTools,
        memoryScope,
        teamMode
      ) as Promise<number>,
    updateTopic: (
      id: number,
      updates: Partial<Pick<HarnessTopicRow, 'title' | 'model' | 'selected_tools'>>
    ) => invoke('harness:harness-topic-update', id, updates) as Promise<boolean>,
    /** Pin / unpin (only changes pinned_at: does not refresh activity time, so unpinning returns
     * it to its original position) */
    setTopicPinned: (id: number, pinned: boolean) =>
      invoke('harness:harness-topic-set-pinned', id, pinned) as Promise<boolean>,
    /** Archive / unarchive (archived topics move from the main list into the "Archived" group;
     * data is kept) */
    setTopicArchived: (id: number, archived: boolean) =>
      invoke('harness:harness-topic-set-archived', id, archived) as Promise<boolean>,
    /**
     * Fork a topic: copy a topic (topic + all dialogues) into a new independent topic and return
     * the new row. The title is supplied by the caller (`Original title (fork)`, following the UI
     * language).
     */
    forkTopic: (id: number, title: string) =>
      invoke('harness:harness-topic-fork', id, title) as Promise<HarnessTopicRow | null>,
    deleteTopic: (id: number) => invoke('harness:harness-topic-delete', id) as Promise<boolean>,

    /** Candidate apps for "Open in app" (File Explorer is always included; the rest are detected
     * per local installation) */
    openInAppTargets: () =>
      invoke('harness:open-in-app-targets') as Promise<
        { id: string; label: string; icon?: string }[]
      >,
    /**
     * Open a workspace's directory with the given app (topic ⋯ → Open in app).
     * Only the workspace id is passed (the main process resolves the directory); a deleted
     * directory or a missing app both return a readable reason instead of throwing.
     */
    openWorkspaceInApp: (workspaceId: number, appId: string) =>
      invoke('harness:open-workspace-in-app', workspaceId, appId) as Promise<WorkshopActionResult>,

    // Message management
    getDialoguesByTopic: (topicId: number) =>
      invoke('harness:harness-dialogue-get-by-topic', topicId) as Promise<HarnessDialogueRow[]>,
    getDialoguesByTopicPaginated: (topicId: number, page: number, pageSize: number) =>
      invoke('harness:harness-dialogue-get-by-topic-paginated', topicId, page, pageSize) as Promise<
        PaginatedResult<HarnessDialogueRow>
      >,
    addDialogue: (dialogue: Omit<HarnessDialogueRow, 'id' | 'created_at'>) =>
      invoke('harness:harness-dialogue-add', dialogue) as Promise<number>,
    deleteDialoguesByTopic: (topicId: number) =>
      invoke('harness:harness-dialogue-delete-by-topic', topicId) as Promise<boolean>,
    deleteDialogue: (id: number) =>
      invoke('harness:harness-dialogue-delete', id) as Promise<boolean>,

    // Actual dialogue usage (one row per assistant reply)
    getUsageByTopic: (topicId: number) =>
      invoke('harness:harness-usage-get-by-topic', topicId) as Promise<HarnessDialogueUsageRow[]>,
    /** Accumulated usage for the current turn while generating: pushed after each model round
     * trip (no events after the stream ends; read the persisted data above instead) */
    onTurnUsage: (callback: (data: TurnUsageView) => void): (() => void) =>
      on('harness:harness-turn-usage', (data) => callback(data as TurnUsageView)),

    // Tool results read on demand: built-in tools (read_file/execute etc.) no longer stream
    // their results; they are fetched when a chat card is expanded (ls/glob/grep/execute
    // details by topicId+callId)
    getToolOutput: (topicId: number, callId: string) =>
      invoke('harness:harness-tool-output-get', topicId, callId) as Promise<string | null>,

    // Read a text file by virtual path (card "Open file"; both workspace and memory mounts are
    // readable)
    // Memory mounts resolve by **the current topic's scope** (plugin topics read this plugin's
    // own memory directory)
    readVirtualFile: (virtualPath: string, memoryScope?: string | null) =>
      invoke('harness:harness-vfs-read', virtualPath, memoryScope ?? null) as Promise<
        { content: string } | { error: string }
      >,
    /** Apps that can open this workspace file ("open with" menu): system default first */
    getFileOpenTargets: (virtualPath: string, memoryScope?: string | null) =>
      invoke('harness:harness-file-open-targets', virtualPath, memoryScope ?? null) as Promise<{
        targets: FileOpenTargetView[]
        error?: string
      }>,
    /** Open a workspace file with a system app (`default` or `app:<exe>` from the targets call) */
    openFileWith: (virtualPath: string, targetId: string, memoryScope?: string | null) =>
      invoke(
        'harness:harness-file-open-with',
        virtualPath,
        targetId,
        memoryScope ?? null
      ) as Promise<{
        ok: boolean
        error?: string
      }>
  },

  /* ── Agent configs (subagents, attached under a workspace) ── */
  agents: {
    getAll: (workspaceId: number) =>
      invoke('harness:agent-get-all', workspaceId) as Promise<AgentConfigRow[]>,
    getPaginated: (workspaceId: number, page: number, pageSize: number) =>
      invoke('harness:agent-get-paginated', workspaceId, page, pageSize) as Promise<
        AgentPaginatedResult<AgentConfigRow>
      >,
    getById: (workspaceId: number, id: number) =>
      invoke('harness:agent-get-by-id', workspaceId, id) as Promise<AgentConfigRow | null>,
    create: (input: AgentConfigInput) => invoke('harness:agent-create', input) as Promise<number>,
    update: (
      workspaceId: number,
      id: number,
      updates: Partial<AgentConfigInput>,
      expectedRevision?: number
    ) =>
      invoke(
        'harness:agent-update',
        workspaceId,
        id,
        updates,
        expectedRevision
      ) as Promise<boolean>,
    delete: (workspaceId: number, id: number) =>
      invoke('harness:agent-delete', workspaceId, id) as Promise<boolean>
  },

  /* ── Main agent config (default tools and skills) ── */
  mainAgent: {
    get: () =>
      invoke('harness:main-agent-get') as Promise<{
        tools: string[]
        skills: string[]
        mcpTools?: string[]
      }>,
    update: (config: { tools: string[]; skills: string[] }) =>
      invoke('harness:main-agent-update', config) as Promise<boolean>
  },

  /* ── MCP servers (Settings → MCP page) ── */
  mcp: {
    /** Server list + live status (reconnects once when the settings page opens, returning the
     * real current state) */
    list: () => invoke('harness:mcp-servers-list') as Promise<McpServerView[]>,
    save: (input: McpServerInput) =>
      invoke('harness:mcp-server-save', input) as Promise<McpServerConfig>,
    remove: (id: string) => invoke('harness:mcp-server-remove', id) as Promise<boolean>,
    toggle: (id: string, enabled: boolean) =>
      invoke('harness:mcp-server-toggle', id, enabled) as Promise<boolean>,
    /** Manually reconnect all servers (click after an external process is killed by the
     * system / network recovery) */
    reconnect: () => invoke('harness:mcp-server-reconnect') as Promise<boolean>,
    /** Test-connect a config that has **not been saved yet**: returns the tool list on success,
     * the raw error on failure (doesn't throw) */
    test: (input: McpServerInput) =>
      invoke('harness:mcp-server-test', input) as Promise<{
        ok: boolean
        tools?: McpToolInfo[]
        error?: string
      }>,
    /** Import a config in mcp.json form */
    importServers: (raw: unknown) =>
      invoke('harness:mcp-servers-import', raw) as Promise<{
        imported: string[]
        failed: { name: string; reason: string }[]
      }>,
    /** Import: open a file picker to read mcp.json (the main process reads the file;
     * the renderer never touches fs) */
    pickImportFile: () =>
      invoke('harness:mcp-servers-import-file') as Promise<{
        imported: string[]
        failed: { name: string; reason: string }[]
      } | null> /** All tools brought by checking/unchecking a server (written to
        mainAgent.mcpTools) */,
    setToolsEnabled: (toolNames: string[]) =>
      invoke('harness:mcp-tools-set', toolNames) as Promise<boolean>,
    /* ── Resource browsing (read-only, user-side entry; the model side maps to tools like
     * list_mcp_resources) ── */
    listResources: (server: string, cursor?: string) =>
      invoke('harness:mcp-resources-list', { server, cursor }) as Promise<
        | { ok: true; resources: McpResourceEntry[]; nextCursor?: string }
        | { ok: false; error: string; resources: McpResourceEntry[] }
      >,
    listResourceTemplates: (server: string, cursor?: string) =>
      invoke('harness:mcp-resources-templates', { server, cursor }) as Promise<
        | { ok: true; templates: McpResourceTemplateEntry[]; nextCursor?: string }
        | { ok: false; error: string; templates: McpResourceTemplateEntry[] }
      >,
    readResource: (server: string, uri: string) =>
      invoke('harness:mcp-resources-read', { server, uri }) as Promise<
        | { ok: true; contents: McpResourceContentEntry[] }
        | { ok: false; error: string; contents: McpResourceContentEntry[] }
      >,
    /** Catalog changes (connect/disconnect/tool added or removed): both the MCP page and the
     * agent page tool dropdowns refresh on it */
    onCatalogUpdated: (callback: () => void): (() => void) =>
      on('harness:harness-mcp-updated', () => callback())
  },

  /**
   * Persistent terminal (right-side panel).
   *
   * Shares the same session manager as the model's terminal_* tools; `open` / `send` only run
   * in the full-permission mode (the main process validates again; the renderer just disables
   * the buttons early), while `peek` / `close` are always available.
   */
  terminal: {
    list: (topicId: number) =>
      invoke('harness:terminal-list', { topicId }) as Promise<{
        ok: boolean
        error?: string
        sessions: TerminalSessionView[]
        maxSessions: number
      }>,
    open: (payload: { topicId: number; cwd?: string; shell?: TerminalShellKind }) =>
      invoke('harness:terminal-open', payload) as Promise<
        | { ok: true; session: TerminalSessionView; initOutput: string }
        | { ok: false; error: string; detail?: string }
      >,
    send: (payload: { topicId: number; sessionId: string; command: string; waitMs?: number }) =>
      invoke('harness:terminal-send', payload) as Promise<
        | {
            ok: true
            result: {
              output: string
              timedOut: boolean
              binary: boolean
              unreadChars: number
            }
          }
        | { ok: false; error: string; detail?: string }
      >,
    peek: (payload: { sessionId: string; maxChars?: number; raw?: boolean }) =>
      invoke('harness:terminal-peek', payload) as Promise<
        TerminalPeekView | { ok: false; error: string }
      >,
    close: (sessionId: string) =>
      invoke('harness:terminal-close', { sessionId }) as Promise<{
        ok: boolean
        found?: boolean
        exitCode?: number | null
        error?: string
      }>,
    closeTopic: (topicId: number) =>
      invoke('harness:terminal-close-topic', { topicId }) as Promise<{
        ok: boolean
        error?: string
      }>
  },

  /**
   * User-side **real terminal** (node-pty + xterm.js).
   *
   * Independent of the `terminal` above (the model tool's line-mode session): this is the
   * interaction closest to a system terminal — real TTY, echo, prompt, Ctrl+C, colors and
   * window resize. Output is pushed to xterm via the `onData` event, and replayed with `buffer`
   * when switching tabs/reopening the panel.
   */
  ptyTerminal: {
    list: (topicId: number) =>
      invoke('harness:pty-terminal-list', { topicId }) as Promise<{
        ok: boolean
        sessions: PtySessionView[]
      }>,
    open: (payload: {
      topicId: number
      cwd?: string
      shell?: PtyShellKind
      cols?: number
      rows?: number
    }) =>
      invoke('harness:pty-terminal-open', payload) as Promise<
        { ok: true; session: PtySessionView } | { ok: false; error: string; detail?: string }
      >,
    write: (sessionId: string, data: string) =>
      invoke('harness:pty-terminal-write', { sessionId, data }) as Promise<{ ok: boolean }>,
    resize: (sessionId: string, cols: number, rows: number) =>
      invoke('harness:pty-terminal-resize', { sessionId, cols, rows }) as Promise<{
        ok: boolean
      }>,
    close: (sessionId: string) =>
      invoke('harness:pty-terminal-close', { sessionId }) as Promise<{
        ok: boolean
        found: boolean
      }>,
    buffer: (sessionId: string) =>
      invoke('harness:pty-terminal-buffer', { sessionId }) as Promise<{
        ok: boolean
        data: string
      }>,
    /** Global stats: the start page / sidebar badge shows "running N" */
    stats: () =>
      invoke('harness:pty-terminal-stats') as Promise<{
        ok: boolean
        alive: number
        total: number
      }>,
    /** Live output (batched to ~12ms) */
    onData: (callback: (payload: { sessionId: string; data: string }) => void): (() => void) =>
      on('harness:pty-terminal-data', (payload) =>
        callback(payload as { sessionId: string; data: string })
      ),
    onExit: (
      callback: (payload: { sessionId: string; exitCode: number | null }) => void
    ): (() => void) =>
      on('harness:pty-terminal-exit', (payload) =>
        callback(payload as { sessionId: string; exitCode: number | null })
      ),
    /** Session list changes (created/exited/closed) */
    onSessionsChanged: (callback: () => void): (() => void) =>
      on('harness:pty-sessions-changed', callback)
  },

  /* ── Workspace files and change review (AI change review + file browser) ── */
  workspace: {
    listDir: (dirPath: string) =>
      invoke('harness:workspace-list-dir', dirPath) as Promise<
        { name: string; isDirectory: boolean; path: string }[]
      >,
    readFile: (filePath: string) =>
      invoke('harness:workspace-read-file', filePath) as Promise<string>,
    saveFile: (filePath: string, content: string) =>
      invoke('harness:workspace-save-file', filePath, content) as Promise<boolean>,

    // --- File change history (traceable / revertible) ---
    /** Pending changes in the current workspace awaiting review */
    pendingChanges: () => invoke('harness:workspace-changes-pending') as Promise<FileChangeView[]>,
    /** Change history for a single file (newest first) */
    fileChanges: (filePath: string) =>
      invoke('harness:workspace-changes-file', filePath) as Promise<FileChangeView[]>,
    /** Before/after content of a change */
    changeContent: (id: number) =>
      invoke('harness:workspace-change-content', id) as Promise<FileChangeContent | null>,
    /** Review: keep (clear the pending-review flag) */
    keepChanges: (ids: number[]) => invoke('harness:workspace-change-keep', ids) as Promise<number>,
    /** Review: revert to before a change */
    revertChange: (id: number) =>
      invoke('harness:workspace-change-revert', id) as Promise<
        { path: string; content: string | null } | { error: string }
      >,
    /** Review: write the content selected in the diff view to disk and mark it kept */
    applyReview: (filePath: string, content: string) =>
      invoke('harness:workspace-apply-review', filePath, content) as Promise<
        { ok: true } | { error: string }
      >,
    /** Disk changes (model writes / command execution / external editor): refresh the explorer
     * and open tabs */
    onFsChanged: (callback: (data: { changes: WorkspaceFsChange[] }) => void): (() => void) =>
      on('harness:workspace-fs-changed', (data) =>
        callback(data as { changes: WorkspaceFsChange[] })
      ),
    /** Record a new change (the model modified a file) */
    onChangeRecorded: (callback: (change: FileChangeView) => void): (() => void) =>
      on('harness:workspace-change-recorded', (change) => callback(change as FileChangeView)),
    /** Change review status changed (keep / revert) */
    onChangesUpdated: (
      callback: (data: { ids: number[]; status: string; path?: string; obsolete?: number }) => void
    ): (() => void) =>
      on('harness:workspace-changes-updated', (data) =>
        callback(data as { ids: number[]; status: string; path?: string; obsolete?: number })
      )
  },

  /* ── Plugin workshop (conversational plugin building + automatic verification,
   * Settings → Plugin Workshop) ── */
  workshop: {
    /** Whether the workshop is available (false when the AI assistant is disabled) + root
     * directory + draft count */
    state: () =>
      invoke('harness:workshop-state') as Promise<{
        ready: boolean
        /** Whether a plugin storage path is configured (preset from the install directory on
         * first launch; false after the user clears it) */
        configured: boolean
        /** User-configured plugin storage path (empty string when unconfigured) */
        pluginsPath: string
        drafts: number
        /**
         * Plugin workspace list (plugin id → its workspace row): a plugin topic's working
         * directory is the plugin source directory; the sidebar uses this to match plugin rows
         * with their topics and to filter plugin workspaces out of the "Work" list.
         */
        pluginWorkspaces: { draftId: string; workspaceId: number; path: string }[]
      }>,
    list: () => invoke('harness:workshop-list') as Promise<WorkshopDraftSummary[]>,
    detail: (id: string) => invoke('harness:workshop-detail', id) as Promise<WorkshopDraftDetail>,
    readFile: (id: string, relPath: string) =>
      invoke('harness:workshop-read-file', id, relPath) as Promise<string>,
    report: (id: string) => invoke('harness:workshop-report', id) as Promise<WorkshopReport | null>,
    create: (input: { id: string; title?: string; template?: string; description?: string }) =>
      invoke('harness:workshop-create', input) as Promise<
        WorkshopActionResult<{ id: string; files: string[]; dir: string }>
      >,
    build: (id: string, dev?: boolean) =>
      invoke('harness:workshop-build', id, dev) as Promise<WorkshopActionResult<WorkshopBuildInfo>>,
    verify: (id: string, probe?: boolean) =>
      invoke('harness:workshop-verify', id, probe) as Promise<WorkshopActionResult<WorkshopReport>>,
    publish: (id: string) =>
      invoke('harness:workshop-publish', id) as Promise<
        WorkshopActionResult<WorkshopPublishResult>
      >,
    disable: (id: string) =>
      invoke('harness:workshop-disable', id) as Promise<WorkshopActionResult<boolean>>,
    unpublish: (id: string) =>
      invoke('harness:workshop-unpublish', id) as Promise<WorkshopActionResult<boolean>>,
    remove: (id: string) =>
      invoke('harness:workshop-remove', id) as Promise<WorkshopActionResult<boolean>>,
    /** Rename plugin: change the display name (draft title + manifest name), leaving the
     * directory name/id untouched */
    rename: (id: string, title: string) =>
      invoke('harness:workshop-rename', id, title) as Promise<
        WorkshopActionResult<WorkshopDraftSummary>
      >,
    /**
     * Get (creating if needed) a plugin's **plugin workspace**: a plugin topic's working
     * directory is its source directory (`<plugin storage path>/<plugin id>/`). The sidebar
     * "plugin row +" calls this first, then switches to it like any normal workspace.
     */
    ensureWorkspace: (id: string) =>
      invoke('harness:workshop-ensure-workspace', id) as Promise<
        WorkshopActionResult<{ id: number; name: string; path: string }>
      >,
    exportZip: (id: string) =>
      invoke('harness:workshop-export', id) as Promise<
        WorkshopActionResult<{ file: string; bytes: number; files: string[] }>
      >,
    openDir: (id: string) =>
      invoke('harness:workshop-open-dir', id) as Promise<WorkshopActionResult<string>>,
    /**
     * Open a system dialog to configure the **plugin storage path** (source root for all plugins).
     * On first launch it is preset from the install directory; when the user changes the location,
     * plugin sources under the old path are migrated to the new one. Returns `{ canceled: true }`
     * when the user cancels (cancellation is not a failure).
     */
    pickRoot: () =>
      invoke('harness:workshop-pick-root') as Promise<
        WorkshopActionResult<{ canceled: boolean; dir?: string; moved?: string[] }>
      >,
    /** Configure the plugin storage path by explicit path (for tooling; empty string = clear the
     * config) */
    setRoot: (dir: string) =>
      invoke('harness:workshop-set-root', dir) as Promise<
        WorkshopActionResult<{ dir: string; moved: string[] }>
      >,
    /** Draft/artifact/install state changed (when the assistant edits a draft in conversation,
     * open panels follow) */
    onChanged: (callback: () => void): (() => void) =>
      on('harness:workshop-changed', () => callback()),
    /**
     * Renderer live probe request (sent by the main process; on receipt the assistant UI imports
     * the plugin artifact once and reports back). The subscription itself is held permanently by
     * the Provider, so it can respond whether or not the user is on the workshop page.
     */
    onProbe: (
      callback: (payload: { probeId: string; id: string; entry: string }) => void
    ): (() => void) =>
      on('harness:workshop-probe', (data) =>
        callback(data as { probeId: string; id: string; entry: string })
      ),
    /** Report back (the main process settles by probeId; results that have already timed out are
     * dropped) */
    reportProbe: (payload: {
      probeId: string
      status: 'pass' | 'fail' | 'skip'
      detail?: string
      registrations?: string[]
      durationMs?: number
    }) => invoke('harness:workshop-probe-result', payload) as Promise<boolean>
  }
}

export default harnessApi
