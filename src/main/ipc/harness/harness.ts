import { BrowserWindow, app, dialog } from 'electron'
import { join } from 'path'
import * as fs from 'fs'
import logger from 'electron-log'
import { isSenderAlive, safeSend } from '../../safe-send'
import { mainFormat, mainMessages } from '../../i18n'
import { getScheduleToolTexts } from '../../i18n/tool-results-schedule'
import {
  mergeAgentSelection,
  normalizeAgentSelection,
  type AgentSelection
} from '../../../shared/harness/agent-config'
import {
  getTopicAgentSelection,
  setTopicAgentSelection
} from '../../database/mapper/topic-agent-config'
import { chatTopicDir, ensureChatTopicDir } from '../../services/harness/chat/workspace'
import { scheduleRunner } from '../../runtime/harness/schedule-runner'
import { isScheduleStoreConfigured, scheduleStore } from '../../runtime/harness/schedule-store'
import type { ScheduledTurnResult } from '../../runtime/harness/schedule-runner'
import type {
  ScheduledTask,
  ScheduleRunArtifact,
  ScheduleRunStep,
  ScheduleRunUsage
} from '../../runtime/harness/schedule-types'
import { extractRunSteps } from '../../runtime/harness/schedule-run-info'
import { resolveVirtualFilePath } from '../../runtime/harness/fs-backend'
import { listFileOpenTargets, openFileWithTarget } from '../../services/harness/file-open'
import { validateScheduleWhen } from '../../runtime/harness/schedule-core'
import type { ScheduleWhen } from '../../runtime/harness/schedule-core'
import { sanitizeSelectionInput } from '../../runtime/harness/schedule-tool-core'
import { normalizeImageDataUrl } from '../../runtime/harness/image-encode'
import { normalizeMemoryScope } from '../../../shared/harness/memory-scope'
import {
  asSearchProviderId,
  clearSearchProviderKey,
  getSearchSettingsView,
  saveSearchProviderKey,
  setSearchBehaviors,
  setSearchDefaultProvider
} from '../../search/settings'
import { testSearchProvider } from '../../search/registry'
import { settingsStore, streamAbortControllers, activeHarnessStreams } from '../../context'
import { harnessQueue, setHarnessQueueLogger } from '../../services/harness/queue-store'
import { drainPendingTurns } from '../../services/harness/turn-drain'
import { registerIpcHandlers, type EffectScope, type IpcHandlerMap } from '../register'
import type { ToolInfo } from '../../services/harness/types'
import {
  effectiveMainAgentTools,
  expandMcpServerGroups,
  type MainAgentConfig
} from '../../../shared/harness/mcp'
import { currentMcpTools } from '../../runtime/harness/mcp'
import { HarnessService } from '../../services/harness/harness'
import { buildTools, listAvailableTools } from '../../tools/harness/builders'
import { scheduleSelectionValues, modelSelectionValues } from '../../tools/harness/capabilities'
import { hasLatticeSession } from '../../lattice/session'
import {
  isUserSelectedRoot,
  rememberSelectedRoot,
  workspacePathKey
} from '../../workspace/selected-roots'
import { readVirtualTextFile } from '../../runtime/harness/fs-backend'
import { getToolOutputStore } from '../../runtime/harness/tool-output-store'
import type {
  AgentInjection,
  ToolCallDetail,
  SubAgentEvent,
  MemoryInjection,
  TurnMeta,
  HistoryCompaction,
  SubAgentMainModelDescriptor
} from '../../services/harness/types'
import type { QueueAttachments } from '../../services/harness/queue-store'
import type { BaseChatModel } from '../../ai/chat-model'
import { getProviderService } from '../../provider/service'
import { listEnabledSubAgents } from '../../services/harness/subagents'
import { todoStore } from '../../runtime/harness/todo'
import { closeOutInProgress, decideCloseOutOnTurnEnd } from '../../runtime/harness/todo-closeout'
import { answerTrailingCount, type TurnFinal } from '../../services/harness/answer-boundary'
import { goalStore } from '../../runtime/harness/goal'
import { planModeStore } from '../../runtime/harness/plan-mode'
import { teamModeStore } from '../../runtime/harness/team-mode'
import { jobsRegistry } from '../../runtime/harness/jobs'
import { subagentSessions } from '../../runtime/harness/subagent-sessions'
import { teamStore } from '../../runtime/harness/team'
import type {
  SubagentConversationEvent,
  SubagentPromptResult
} from '../../runtime/harness/subagent-conversation'
import { startMemoryAgent, type StartMemoryAgentResult } from '../../runtime/harness/memory-agent'
import { resolveModelSpecProviderId } from '../../runtime/harness/subagent-model'
import { questionService } from '../../runtime/harness/ask'
import {
  permissionGate,
  type ApprovalDecision,
  type ApprovalRequestView
} from '../../runtime/harness/permission-gate'
import {
  permissionStateFor,
  setDefaultPermissionMode,
  setTopicPermissionMode,
  wirePermissionGate
} from '../../runtime/harness/permission-store'
import { isPermissionMode, type PermissionMode } from '../../runtime/harness/permission'
import { ensureExecutable, resolveSandboxAsset, sandboxService } from '../../sandbox/service'
import { setSandboxLogger } from '../../sandbox/log'
import { goalRoundDriver } from '../../services/harness/goal-driver'
import { HarnessSettings } from '../../types/settings'
import {
  createTopic,
  addDialogue,
  updateDialogueContent,
  addDialogueUsage,
  getDialoguesByTopicId,
  getUsageByTopic,
  getAllTopics,
  getTopicById,
  getWorkspaceById,
  getAllWorkspaces,
  searchDialogues
} from '../../database/mapper/harness/harness'
import { listTeamTaskEvents } from '../../database/mapper/harness/team-task-event'
import { buildSnippet } from '../../runtime/harness/session-search-core'
import {
  memoryScopeRoot,
  parseMemoryScope,
  serializeMemoryScope,
  type MemoryScope
} from '../../services/harness/memory-scope'
import { getActiveWorkspaceId } from '../../database/workspace-context'
import { getDefaultProvider } from '../../database/mapper/provider'
import { sumUsage, type ModelUsageRecord } from '../../runtime/harness/usage'
import {
  startRendererMemorySampling,
  stopRendererMemorySampling
} from '../../services/harness/renderer-memory'
import { activateChatTopic } from '../../services/harness/chat/activation'

/**
 * Main process → renderer event channel (send-only; no ipcMain handler).
 *
 * Channel names use the `harness:` prefix; the renderer subscribes via the preload system bridge, so no whitelist registration is needed.
 */
export const HARNESS_EVENTS = {
  streamChunk: 'harness:harness-stream-chunk',
  streamDone: 'harness:harness-stream-done',
  streamError: 'harness:harness-stream-error',
  queueUpdated: 'harness:harness-queue-updated',
  queueSteered: 'harness:harness-queue-steered',
  goalUpdated: 'harness:harness-goal-updated',
  /** Plan mode toggle changed (the plan-mode badge in the input box refreshes live) */
  planUpdated: 'harness:harness-plan-updated',
  teamModeUpdated: 'harness:harness-team-mode-updated',
  jobsUpdated: 'harness:harness-jobs-updated',
  agentsUpdated: 'harness:harness-agents-updated',
  /** Sub-agent session event delta (only pushed to windows currently viewing that sub-agent) */
  agentConversationUpdated: 'harness:harness-agent-conversation-updated',
  /** Shared task board changed (team/task projection of main-agent / sub-agent collaboration; whole-board snapshot) */
  teamUpdated: 'harness:harness-team-updated',
  questionAsked: 'harness:harness-question-asked',
  approvalAsked: 'harness:harness-approval-asked',
  /** Whether a topic is currently waiting on the user (sidebar yellow dot): true while a question / approval is pending, false once settled */
  topicPending: 'harness:harness-topic-pending',
  permissionUpdated: 'harness:harness-permission-updated',
  todosUpdated: 'harness:harness-todos-updated',
  /**
   * Cumulative usage for the current turn while generating (one event after each model call).
   *
   * Only feeds the live "this turn: N calls · X tok" number in the input footer; the authoritative ledger is still
   * the harness_dialogue_usage row written when the stream ends (the renderer switches back to it at turn end).
   */
  turnUsage: 'harness:harness-turn-usage'
} as const

/**
 * Turn execution only needs a sender (liveness check, safeSend, renderer-invalidated watch), so the type is narrowed to the minimal interface:
 * user turns and queue-continuation turns share the same `HarnessSenderEvent` pipeline.
 *
 * Note: `registerIpc` only passes the arguments through to the handler (no IpcMainInvokeEvent), so the sender is resolved by
 * `primarySender()` — the app has a single window that actually runs the UI (the loading window does not run the harness), so
 * taking the first live window is equivalent to the original `event.sender`.
 */
interface HarnessSenderEvent {
  sender: Electron.WebContents
}

/** Target renderer frame: the first live window (same trade-off as the notes graph channel broadcasting to all live windows) */
function primarySender(): Electron.WebContents | null {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
  return win ? win.webContents : null
}

/**
 * Minimal sender when no window exists: a scheduled task must still be able to start a turn while the app is in the background with no visible window.
 *
 * There is no receiver for stream events (send is a no-op), but the turn still runs and persists messages; once a window is reopened,
 * the conversation can be seen in history. Only the minimal surface used by runHarnessTurn is implemented: id / isDestroyed /
 * send / on / once (event registration is a no-op).
 */
function headlessSender(): Electron.WebContents {
  const sender: Record<string, unknown> = {}
  sender.id = 0
  sender.isDestroyed = () => false
  sender.send = () => true
  sender.on = () => sender
  sender.once = () => sender
  sender.removeListener = () => sender
  return sender as unknown as Electron.WebContents
}

/**
 * Resolve a scheduled task target: a fixed topic (any topic in chat/work/plugin mode) or "new topic per run".
 *
 * Cross-mode runs must carry this turn's **workspace context**: file tools, memory scope and sub-agents must use the target topic's
 * directory, not whichever workspace the UI currently sits on.
 */
async function resolveScheduledTarget(task: ScheduledTask): Promise<{
  topicId: number
  workspaceContext?: { workspaceId?: number; workspacePath?: string }
} | null> {
  if (task.topicId != null) {
    const rows = await getTopicById(task.topicId)
    const topic = rows[0]
    if (!topic) return null
    const workspaceId = topic.workspace_id ?? task.workspaceId ?? task.targetWorkspaceId ?? 0
    if (String(topic.memory_scope ?? '') === 'chat') {
      return {
        topicId: task.topicId,
        workspaceContext: { workspaceId, workspacePath: chatTopicDir(task.topicId) }
      }
    }
    const workspace = workspaceId ? await getWorkspaceById(workspaceId) : null
    return {
      topicId: task.topicId,
      workspaceContext: { workspaceId, workspacePath: workspace?.path }
    }
  }
  // New-topic task: each run creates a fresh topic; workspace/memory scope comes from the target stored on the task
  if (!task.targetWorkspaceId) return null
  const memoryScope = task.targetMemoryScope
  const topicId = await createTopic(
    task.targetWorkspaceId,
    (task.title || task.prompt).slice(0, 50),
    undefined,
    undefined,
    memoryScope || null
  )
  if (!topicId) return null
  if (memoryScope === 'chat') {
    try {
      await ensureChatTopicDir(topicId)
    } catch (err) {
      logger.warn('[Chat] Failed to prepare scheduled session directory:', err)
    }
    return {
      topicId,
      workspaceContext: {
        workspaceId: task.targetWorkspaceId,
        workspacePath: chatTopicDir(topicId)
      }
    }
  }
  const workspace = await getWorkspaceById(task.targetWorkspaceId)
  return {
    topicId,
    workspaceContext: { workspaceId: task.targetWorkspaceId, workspacePath: workspace?.path }
  }
}

/**
 * Entry point for a due scheduled task: starts a headless turn in the target topic.
 *
 * - Fixed topic: run directly in that topic (cross-mode is fine too);
 * - New topic: create a topic from the task's target mode/workspace first, then run in it;
 * - No concurrency when a turn is already running in the same topic (returns cancelled; the runner retries next cycle).
 */
/**
 * Collect what one scheduled run actually did, right after the turn finished: the assistant
 * dialogue it produced, the token usage of that dialogue, and the tool steps / artifacts derived
 * from its blocks.
 *
 * Best effort: a failed lookup must not turn a successful run into a failure, so the caller wraps
 * this and the panel simply shows less.
 */
async function collectScheduledRunInfo(
  topicId: number,
  startedAtMs: number
): Promise<{
  dialogueId: number | null
  usage: ScheduleRunUsage | null
  steps: ScheduleRunStep[]
  artifacts: ScheduleRunArtifact[]
}> {
  const dialogues = await getDialoguesByTopicId(topicId)
  const lastAssistant = [...dialogues].reverse().find((row) => row.role === 'assistant')
  const { steps, artifacts } = extractRunSteps(lastAssistant?.blocks ?? null)
  const durationMs = Date.now() - startedAtMs
  let usage: ScheduleRunUsage = {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    durationMs
  }
  if (lastAssistant) {
    try {
      const rows = await getUsageByTopic(topicId)
      const row = rows.find((item) => item.dialogue_id === lastAssistant.id)
      if (row) {
        usage = {
          inputTokens: row.input_tokens ?? null,
          outputTokens: row.output_tokens ?? null,
          totalTokens: row.total_tokens ?? null,
          durationMs
        }
      }
    } catch {
      // Usage is decorative; keep the duration we measured
    }
  }
  return {
    dialogueId: lastAssistant?.id ?? null,
    usage,
    steps,
    artifacts
  }
}

/**
 * Mount roots for virtual-path resolution outside the tool layer (file open / read by the UI).
 *
 * Same convention as the tool runtime: the workspace root is `/`, the memory root is
 * `/memories/` and follows the topic's memory scope (`plugin:<id>` / chat).
 */
function virtualFileRoots(scope?: string | null): {
  workspacePath?: string
  memoryPath?: string
} {
  const harnessSettings = settingsStore.get('harness') as HarnessSettings | undefined
  return {
    workspacePath: harnessSettings?.workspacePath || undefined,
    memoryPath:
      memoryScopeRoot(
        harnessSettings?.memoryPath || undefined,
        parseMemoryScope(scope, harnessSettings?.activeWorkspaceId ?? 0)
      ) ??
      (harnessSettings?.memoryPath || undefined)
  }
}

/**
 * Model for a scheduled run: the task's `provider:model` override when it still resolves to an
 * enabled provider, otherwise the default provider (which itself falls back to the first enabled
 * one).
 *
 * A scheduled turn has no input-box selection to carry `providerId` (unlike a user send, where the
 * renderer passes the currently selected model), and `ProviderService.createModel()` no longer
 * falls back to the default provider. Without this lookup every triggered task died in
 * `createModel(undefined)` with "目标模型不存在" right after persisting the user message — the
 * "task fired but produced no reply" symptom.
 *
 * A stale override (provider disabled/deleted) must not fail the run: log it and use the default.
 */
async function resolveScheduledProviderId(model: string | null): Promise<number | undefined> {
  if (model) {
    const overridden = await resolveModelSpecProviderId(model)
    if (overridden != null) return overridden
    logger.warn(
      `[Schedule] Model "${model}" is not an enabled provider route, falling back to the default model`
    )
  }
  const provider = await getDefaultProvider()
  return provider?.id
}

async function runScheduledTurn(
  task: ScheduledTask,
  question: string
): Promise<ScheduledTurnResult> {
  let target: Awaited<ReturnType<typeof resolveScheduledTarget>>
  try {
    target = await resolveScheduledTarget(task)
  } catch (err) {
    logger.warn('[Schedule] Failed to resolve scheduled target:', err)
    return { cancelled: true }
  }
  if (!target) {
    logger.warn('[Schedule] Target conversation/workspace is gone, skipping this run:', task.id)
    return { cancelled: true, detail: 'target-missing' }
  }
  const { topicId, workspaceContext } = target
  if (harnessQueue.isTurnActive(topicId)) return { cancelled: true, topicId }
  let providerId: number | undefined
  try {
    providerId = await resolveScheduledProviderId(task.model)
  } catch (err) {
    // Leave it undefined: runHarnessTurn then fails with the localized "no model" message, which
    // is recorded as this run's detail and is far clearer than aborting silently here.
    logger.warn('[Schedule] Failed to resolve the default model provider:', err)
  }
  // Repair tasks created before the tool validated `agentConfig`: names outside the selectable
  // catalog (e.g. the built-in `task` tool) would otherwise override the conversation's selection
  // with names the registry silently drops, leaving the run without its usual tools.
  let taskSelection: ReturnType<typeof sanitizeSelectionInput> = {
    selection: task.agentConfig ?? null,
    ignored: null
  }
  if (task.agentConfig) {
    try {
      taskSelection = sanitizeSelectionInput(
        task.agentConfig,
        scheduleSelectionValues(listAvailableTools())
      )
      if (taskSelection.ignored) {
        logger.warn(
          `[Schedule] Ignoring unknown agentConfig values on task ${task.id}:`,
          taskSelection.ignored
        )
      }
    } catch (err) {
      // Catalog lookup failure must not make the scheduled run fail: keep the stored selection
      logger.warn('[Schedule] Failed to validate task agentConfig:', err)
    }
  }
  const sender = primarySender() ?? headlessSender()
  const turnId = harnessQueue.beginTurn(topicId)
  const startedAtMs = Date.now()
  try {
    const result = await runHarnessTurn({
      event: { sender },
      question,
      turnId,
      options: {
        topicId,
        providerId,
        workspaceContext,
        // Task-level selection applies to this turn only and is not written back to the topic (session selection belongs to the input box)
        agentConfig: taskSelection.selection,
        persistAgentConfig: false,
        turnMeta: {
          source: 'schedule',
          scheduleId: task.id,
          scheduleTitle: task.title
        }
      }
    })
    // The run detail is derived **after** the turn: the reply row, its tool steps and artifacts
    // only exist once the turn has been persisted.
    const info = await collectScheduledRunInfo(topicId, startedAtMs).catch((err) => {
      logger.warn('[Schedule] Failed to collect run detail:', err)
      return null
    })
    if (result.error) {
      // A phase failure returns normally from runHarnessTurn; surface it so the runner records
      // `failed` with the reason instead of `completed` with an empty reply.
      return { cancelled: false, topicId, detail: result.error }
    }
    return {
      cancelled: result.cancelled,
      topicId,
      dialogueId: info?.dialogueId ?? null,
      usage: info?.usage ?? null,
      steps: info?.steps ?? null,
      artifacts: info?.artifacts ?? null
    }
  } catch (err) {
    logger.warn('[Schedule] Scheduled turn failed:', err)
    return {
      cancelled: false,
      topicId,
      detail: err instanceof Error ? err.message : String(err)
    }
  } finally {
    harnessQueue.endTurn(topicId, turnId)
  }
}

/** Parameters for one chat turn (user turn / queue-continuation turn / goal auto turn all share the runHarnessTurn pipeline) */
interface RunHarnessTurnParams {
  event: HarnessSenderEvent
  question: string
  /**
   * Turn id for this run (the value from `harnessQueue.beginTurn`).
   *
   * launchTurn registers and passes it in when starting a turn for an **existing topic**; for a new topic (first message)
   * runHarnessTurn registers it after creating the topic. This id is sent with every chunk / done / error so the
   * renderer can drop events from stale turns (two overlapping turns in one topic are the root cause of garbled output).
   */
  turnId?: number
  options?: {
    topicId?: number
    providerId?: number
    images?: string[]
    documents?: { fileName: string; filePath: string }[]
    turnMeta?: TurnMeta
    /**
     * "Edit and resend": the question for this turn already exists in the DB (edited in place in the bubble), so overwrite that row
     * instead of inserting a new user message — otherwise the DB gets a duplicate question and history order is moved to the end.
     */
    reuseUserDialogueId?: number
    /**
     * Frontend temporary id registered for this turn's assistant message (first segment). In-turn interjections split assistant output;
     * the main process generates a new temporary id per segment and sends it with the steered chunk so the frontend can attach segments to bubbles.
     */
    messageId?: string
    /**
     * Memory scope (`plugin:<plugin id>`). Only used when the **main process creates the topic as a fallback** —
     * normally the renderer calls `harness-topic-create` first (writing the scope into the topic row) and the main process reads it from the topic.
     */
    memoryScope?: string | null
    /**
     * Runtime selection for this turn (tools / skills / MCP tools): non-null dimensions override the session config.
     * Comes from the selection below the input box, or the task-level selection stored on a scheduled task.
     */
    agentConfig?: AgentSelection | null
    /** Workspace context for this turn (set by the caller for cross-mode scheduled runs; defaults to current settings) */
    workspaceContext?: { workspaceId?: number; workspacePath?: string }
    /** Whether to write this turn's selection back to the topic (user send = true; scheduled/internal turns = false) */
    persistAgentConfig?: boolean
  }
}

/** Assistant message after persistence (one row per turn; interjections are pure injection and do not split it) */
interface AssistantSegment {
  messageId: string
  dialogueId: number | null
  content: string
}

/** Streaming segment accumulator: a fresh set of state at each interjection boundary */
interface SegmentAccumulator {
  blocks: {
    type: string
    text?: string
    tool?: ToolCallDetail
    reasoning?: string
    subAgent?: SubAgentEvent
    memory?: MemoryInjection
    compaction?: HistoryCompaction
    children?: {
      type: string
      text?: string
      tool?: ToolCallDetail
      reasoning?: string
    }[]
  }[]
  content: string
  reasoning: string
  failed: boolean
  /** Whether this segment already wrote the early-conversation summary block (the summary card stays in the first segment only, avoiding duplication after interjections) */
  compactionSeen: boolean
}

/**
 * Write dialogue usage for this turn (harness_dialogue_usage).
 *
 * - Only write when the model **actually returned token numbers**: no row is better than a fake all-zero row;
 * - Tokens accumulate over the whole turn (the tool loop makes several model round-trips); the raw usage_metadata of each call
 *   is stored as a JSON array in the usage_metadata column, keeping per-provider details such as reasoning / cached;
 * - Provider and model are stored as a **snapshot**: later edits or deletion of the provider config do not affect this accounting row.
 */
async function persistTurnUsage(params: {
  dialogueId: number
  topicId: number
  providerId?: number
  records: ModelUsageRecord[]
}): Promise<void> {
  const { dialogueId, topicId, providerId, records } = params
  if (records.length === 0) return
  const totals = sumUsage(records)
  if (!totals.hasTokens) {
    logger.info('[Harness] Model returned no usage_metadata, skipping usage persistence')
    return
  }
  try {
    let providerMark: string | null = null
    let configuredModel: string | null = null
    try {
      const config = await getProviderService().getConfig(providerId)
      providerMark = config?.provider ?? null
      configuredModel = config?.model ?? null
    } catch (err) {
      logger.warn(
        '[Harness] Failed to read provider config, usage row will only record tokens:',
        err
      )
    }
    await addDialogueUsage({
      workspace_id: getActiveWorkspaceId(),
      topic_id: topicId,
      dialogue_id: dialogueId,
      provider_id: providerId ?? null,
      provider: providerMark,
      // Prefer the model name returned in the response (the user may have switched models temporarily), else the current config
      model: records.find((r) => r.model)?.model ?? configuredModel,
      input_tokens: totals.inputTokens,
      output_tokens: totals.outputTokens,
      total_tokens: totals.totalTokens,
      calls: totals.calls,
      usage_metadata: JSON.stringify(
        records.map((r) => ({ model: r.model, subagent: r.subagent ?? false, usage: r.usage }))
      )
    })
    logger.info(
      `[Harness] Usage persisted dialogue=${dialogueId} in/out/total=${totals.inputTokens}/${totals.outputTokens}/${totals.totalTokens} calls=${totals.calls}`
    )
  } catch (err) {
    logger.error('[Harness] Failed to write dialogue usage:', err)
  }
}

/**
 * Run one complete conversation: create model → create topic → save user message → stream → save AI reply → notify the frontend.
 * Returns { topicId, cancelled, turnId } (cancelled=true means the user pressed stop).
 */
/**
 * Narrow the trusted source of "this turn's workspace path" (security audit S03).
 *
 * The renderer/caller may pass `workspaceContext.workspacePath` as the mount root for this turn's file tools;
 * only directories the user personally picked via a system dialog, or registered workspace rows, are trusted; everything else falls back
 * to the active workspace path in settings (main-process callers such as scheduled tasks pass DB paths, so they are unaffected).
 */
async function resolveTrustedWorkspacePath(
  requested: string | undefined,
  fallback: string | undefined,
  topicId?: number
): Promise<string | undefined> {
  if (!requested) return fallback
  try {
    if (isUserSelectedRoot(requested)) return requested
    // Chat sessions work in `<chat root>/<topic id>`, a directory the app creates itself and never
    // asks the user to pick, so it has no row in the workspace table (only the chat root does).
    // Scheduled runs pass it as the turn's mount root; without this check it was rejected and the
    // turn silently fell back to whichever workspace the UI happened to sit on.
    if (
      topicId != null &&
      topicId > 0 &&
      workspacePathKey(requested) === workspacePathKey(chatTopicDir(topicId))
    ) {
      return requested
    }
    const rows = await getAllWorkspaces()
    if (rows.some((row) => workspacePathKey(row.path) === workspacePathKey(requested))) {
      return requested
    }
  } catch (err) {
    logger.warn('[Harness] Failed to validate requested workspace path:', err)
  }
  logger.warn('[Harness] Ignored a workspacePath that is not a registered workspace')
  return fallback
}

async function runHarnessTurn(params: RunHarnessTurnParams): Promise<TurnOutcome> {
  const { event, question, options } = params

  // User-uploaded/pasted images share the same normalization as read_image: before entering the context or being persisted they are
  // scaled or re-encoded to pixel and byte budgets (the bubble preview stays the original; the two may differ).
  if (options?.images?.length) {
    options.images = options.images.map((image) => normalizeImageDataUrl(image).dataUrl)
  }

  // Skip this turn when the renderer is already gone (crash/window closed): no model, no message writes, nothing sent to a dead frame
  if (!isSenderAlive(event.sender)) {
    logger.warn(
      `[Harness] Renderer process is gone (senderId=${event.sender.id}), skipping this turn`
    )
    return { topicId: options?.topicId ?? 0, cancelled: true, turnId: 0 }
  }

  // Load main agent defaults (electron-store)
  const mainAgentDefaults = settingsStore.get('mainAgent') as MainAgentConfig | undefined
  let harnessSettings = settingsStore.get('harness') as HarnessSettings | undefined
  logger.info(`[Harness] Creating model with providerId: ${options?.providerId ?? 'default'}`)

  // Workspace context for this turn: scheduled tasks may run across modes/workspaces, so the caller specifies it; defaults to current settings.
  const turnWorkspaceId =
    options?.workspaceContext?.workspaceId ?? harnessSettings?.activeWorkspaceId ?? 0
  const turnWorkspacePath = await resolveTrustedWorkspacePath(
    options?.workspaceContext?.workspacePath,
    harnessSettings?.workspacePath,
    options?.topicId
  )

  // 0. This turn's memory scope and "plugin mode". **Must be fixed before creating the topic and tools**:
  //    plugin mode decides whether the 4 workshop tools are mounted automatically (see PLUGIN_MODE_TOOL_NAMES in shared/mcp.ts),
  //    and the tool snapshot on the topic must match the set actually mounted.
  //    The scope comes from the topic when stored (still honored after reopening the topic or restarting the app); before the topic exists, use the caller's fallback.
  const memoryScope = await resolveTurnMemoryScope(
    options?.topicId,
    options?.memoryScope,
    turnWorkspaceId
  )
  const pluginMode = memoryScope.kind === 'plugin'

  // Runtime selection for this turn (tools / skills / MCP): request values win, then session-level config.
  // Skills and MCP both default to "none enabled" (newly added items must not be enabled by default).
  const requestSelection = normalizeAgentSelection(options?.agentConfig)
  const topicSelection = options?.topicId ? await getTopicAgentSelection(options.topicId) : null
  const turnSelection = mergeAgentSelection(topicSelection, requestSelection)

  // Tool names and instances for this turn: user-checked tools (including MCP tools checked on the MCP page) + mode tools auto-mounted in plugin mode.
  // Release builds need the plugin-center session (without login not even names are appended), so the login state must be read here:
  // after the user logs in/out mid-session, the next turn's tool set follows without a restart.
  // MCP selections may be server groups (mcp@<namespace>): expand them into concrete tool names before mounting.
  // Only selected servers/tools are injected into this turn; nothing is mounted by default (see the topic_agent_config comment).
  const expandedMcpTools = expandMcpServerGroups(
    turnSelection.mcpTools ?? [],
    currentMcpTools().infos.map((info) => info.name)
  )
  const selectedTools = effectiveMainAgentTools(
    {
      tools: turnSelection.tools ?? mainAgentDefaults?.tools ?? [],
      mcpTools: expandedMcpTools
    },
    {
      pluginMode,
      signedIn: hasLatticeSession()
    }
  )
  const tools = buildTools(selectedTools)
  logger.info(
    `[Harness] Tools for this turn: pluginMode=${pluginMode} count=${selectedTools.length} [${selectedTools.join(',')}]`
  )

  // 1. Ensure the topic exists
  let topicId = options?.topicId
  if (!topicId) {
    const title = question.slice(0, 50)
    const workspaceId = turnWorkspaceId
    try {
      // Record a "tools enabled for this turn" snapshot on the topic (including MCP tools checked on the MCP page and mode tools, matching what is actually mounted)
      topicId = await createTopic(
        workspaceId,
        title,
        undefined,
        selectedTools.length ? JSON.stringify(selectedTools) : undefined,
        // Memory scope: persisted when the plugin / chat topic is created (see memory-scope.ts)
        serializeMemoryScope(memoryScope)
      )
      // "Chat" mode: this topic's directory is the working directory for this turn (the renderer usually created and switched the topic already;
      // this is the fallback path, ensuring the first send without a topic id does not write files into the root directory).
      if (memoryScope.kind === 'chat' && topicId) {
        try {
          await activateChatTopic(topicId)
          harnessSettings = settingsStore.get('harness') as HarnessSettings | undefined
        } catch (err) {
          logger.warn(
            '[Chat] Failed to switch session directory for this turn (turn unaffected):',
            err
          )
        }
      }
    } catch (err) {
      logger.error('Failed to create topic:', err)
      topicId = 0
    }
  }

  // Write this turn's selection back to the topic (user send = persist; scheduled/internal turns = this turn only)
  if (topicId && requestSelection && options?.persistAgentConfig !== false) {
    try {
      await setTopicAgentSelection(topicId, turnSelection)
    } catch (err) {
      logger.warn('[Harness] Failed to persist session agent selection:', err)
    }
  }

  // 1.5 Turn id for this run: for an existing topic, launchTurn registers and passes it in (so another window or another click
  //     racing before the turn starts is blocked by the busy check); a new topic is created here, so register it now.
  const turnId = params.turnId || (topicId ? harnessQueue.beginTurn(topicId) : 0)

  /** Push one chunk to the renderer: always carries topic and turn ids (the renderer drops stale events by turn id) */
  const sendChunk = (payload: Record<string, unknown>): boolean =>
    safeSend(event.sender, HARNESS_EVENTS.streamChunk, {
      ...payload,
      __topicId: topicId,
      __turnId: turnId
    })

  // Unified failure close-out for a chat turn: notify the frontend of the error and reset the loading state (so the UI can stop for a failure in any phase)
  const failTurn = (error: unknown): TurnOutcome => {
    const errMsg = error instanceof Error ? error.message : String(error)
    logger.error('[Harness] Turn failed:', error)
    safeSend(event.sender, HARNESS_EVENTS.streamError, { error: errMsg, topicId, turnId })
    safeSend(event.sender, HARNESS_EVENTS.streamDone, { topicId, turnId })
    return { topicId, cancelled: false, turnId, error: errMsg }
  }

  // 2. Save the user message (including images, documents and the goal auto-continue marker).
  // Do this before model creation (fix: on model creation failure the old code returned early, so the user message was never persisted and was lost on reload)
  // Keep the returned row id: it is sent back with harness-stream-done after streaming so the frontend can find the user row when deleting this turn
  let userDialogueId: number | null = null
  try {
    if (options?.reuseUserDialogueId) {
      // Edit and resend: overwrite the original question row (keeping id and position) instead of inserting a new row
      userDialogueId = options.reuseUserDialogueId
      await updateDialogueContent(userDialogueId, question)
    } else {
      const userBlocks: {
        type: string
        image_url?: string
        fileName?: string
        round?: number
        objective?: string
      }[] = []
      if (options?.images?.length) {
        for (const img of options.images) {
          userBlocks.push({ type: 'image', image_url: img })
        }
      }
      if (options?.documents?.length) {
        for (const doc of options.documents) {
          userBlocks.push({ type: 'document', fileName: doc.fileName })
        }
      }
      if (options?.turnMeta?.source === 'goal-round') {
        userBlocks.push({
          type: 'goalRound',
          round: options.turnMeta.goalRound,
          objective: options.turnMeta.objective ?? ''
        })
      }
      userDialogueId = await addDialogue({
        topic_id: topicId,
        role: 'user',
        content: question,
        blocks: JSON.stringify(userBlocks)
      })
    }
  } catch (err) {
    // Do not keep running if the user message was not persisted: otherwise the answer exists without the question, and the whole turn vanishes on refresh with no user-visible signal.
    logger.error('Failed to save user message:', err)
    return failTurn(new Error(mainMessages().error.turnPersistFailed))
  }

  // Model creation can fail because the provider is missing, disabled, the model name is empty, etc.; catch it and notify the frontend
  let model: BaseChatModel
  try {
    model = await getProviderService().createModel(options?.providerId)
  } catch (modelErr) {
    return failTurn(modelErr)
  }

  // Compute the history context character budget from the model's context window (default 20,000 tokens; conservative 1 token ≈ 1 character)
  // Also read this model's "tool-call rounds" limit and inject it as this turn's runtime guardrail
  let modelDescriptor: SubAgentMainModelDescriptor | undefined
  let contextBudget: number | undefined
  let maxToolRounds: number | undefined
  /** Raw window (tokens): used when compaction pressure is judged on real tokens, kept separate from the 1:1 character budget above */
  let contextWindowTokens: number | undefined
  /** Whether the current model profile declares image input support: when false, read_image refuses at execution time */
  let supportsImageInput = false
  try {
    const providerConfig = await getProviderService().getConfig(options?.providerId)
    modelDescriptor = { providerId: providerConfig.id, model: providerConfig.model }
    const windowTokens =
      typeof providerConfig.metadata?.context_window === 'number'
        ? providerConfig.metadata.context_window
        : 0
    contextBudget = Math.max(20_000, windowTokens)
    contextWindowTokens = windowTokens > 0 ? windowTokens : undefined
    maxToolRounds = providerConfig.max_tool_rounds
    supportsImageInput =
      (providerConfig.metadata as { capabilities?: { supports_image_input?: boolean } } | null)
        ?.capabilities?.supports_image_input === true
    logger.info(
      `[Harness] Model context window=${windowTokens} tokens → history budget=${contextBudget} chars, maxToolRounds=${maxToolRounds}`
    )
  } catch (err) {
    logger.warn(
      '[Harness] Failed to read model context window, using default history budget 20000:',
      err
    )
  }

  // Create an AbortController to cancel streaming output
  const abortController = new AbortController()
  streamAbortControllers.set(event.sender.id, abortController)

  // Renderer memory sampling (OOM observability): sample every 5s from the start to the end of this turn;
  // on crash, main-window's render-process-gone handler writes the last snapshot.
  // Must stop on every exit path of the try/finally (including early returns), otherwise the sampler stays registered forever.
  let memSampling = true
  startRendererMemorySampling(`topic=${topicId}`)
  const stopMemSampling = (): void => {
    if (!memSampling) return
    memSampling = false
    stopRendererMemorySampling()
  }

  // Renderer invalidation tracking: on crash/window close the render frame is destroyed before the WebContents object,
  // so send does not throw (Electron silently logs "Error sending from webFrameMain ...") and isDestroyed() is still false —
  // the stream must be aborted via the render-process-gone / destroyed events,
  // otherwise the streaming loop keeps sending chunks to a dead frame, spamming errors and burning tokens for nothing.
  let senderDead = false
  const onSenderGone = (): void => {
    if (senderDead) return
    senderDead = true
    logger.warn(
      `[Harness] Renderer process is gone (senderId=${event.sender.id}), aborting streaming output`
    )
    abortController.abort()
  }
  event.sender.on('render-process-gone', onSenderGone)
  event.sender.once('destroyed', onSenderGone)

  // 2.5. HarnessService loads history context internally from the database (auto-compacting when too long)

  // 2.6. Turns initiated by the main process itself: a marker chunk is sent first so the frontend mounts the user message + assistant placeholder and
  // starts listening to this turn's stream (normal user turns are mounted by the frontend on send).
  //  - goalRound: a goal auto-continue turn;
  //  - queueTurn: a turn continued automatically after the previous one ended (the user did not press send,
  //    so the frontend has no local placeholder; without this marker it looks like the message disappeared but nothing happened).
  if (options?.turnMeta?.source === 'goal-round' && options.turnMeta.goalRound != null) {
    sendChunk({
      goalRound: {
        round: options.turnMeta.goalRound,
        objective: options.turnMeta.objective ?? ''
      }
    })
  }
  if (options?.turnMeta?.source === 'queue') {
    sendChunk({
      queueTurn: {
        itemId: options.turnMeta.queueItemId ?? null,
        text: question,
        attachments: (options.documents ?? [])
          .map((doc) => doc.fileName)
          .concat((options.images ?? []).map((_, index) => `image-${index + 1}`))
      }
    })
  }
  // Scheduled turn: stream-start marker (the user did not press send; the frontend uses it to mount the user bubble + assistant placeholder)
  if (options?.turnMeta?.source === 'schedule') {
    sendChunk({
      scheduleTurn: {
        scheduleId: options.turnMeta.scheduleId ?? null,
        title: options.turnMeta.scheduleTitle ?? '',
        text: question
      }
    })
  }

  // Skills: enable only the session-level selection (none by default)
  const effectiveSkills = turnSelection.skills ?? []

  let harnessService: HarnessService
  try {
    harnessService = new HarnessService(
      model,
      tools,
      await listEnabledSubAgents(turnWorkspaceId),
      getDialoguesByTopicId,
      harnessSettings?.skillsPath || undefined,
      effectiveSkills,
      turnWorkspacePath || undefined,
      harnessSettings?.memoryPath || undefined,
      turnWorkspaceId,
      maxToolRounds,
      memoryScope,
      modelDescriptor,
      options?.turnMeta?.source === 'goal-round',
      supportsImageInput,
      // Scheduled runs are unattended: no ask/plan-approval tools, no approval suspension
      options?.turnMeta?.source === 'schedule'
    )
  } catch (err) {
    // HarnessService initialization (including sub-agent definition loading) failed: clean up this turn's resources and notify the frontend,
    // so the UI does not sit at "generating..." with no reaction
    logger.error('[Harness] Failed to initialize HarnessService:', err)
    streamAbortControllers.delete(event.sender.id)
    event.sender.removeListener('render-process-gone', onSenderGone)
    event.sender.removeListener('destroyed', onSenderGone)
    return failTurn(err)
  }
  // Real model usage for this turn (usage_metadata): reported by HarnessService when the stream ends; written to the usage table after the assistant message is persisted
  let usageRecords: ModelUsageRecord[] = []

  // ── Assistant message accumulator (one turn = one assistant row) ─────────────────────────────────
  // The segment list keeps a multi-segment shape (persistence and messageId → dialogueId mapping are per segment),
  // but currently **only 0/1 segments** exist: in-turn interjections are pure injection (see drainInjections below) and do not split assistant output,
  // so one Q&A turn always persists one assistant message, equivalent to the old behavior. The structure stays so real segmentation later needs no protocol change.
  const segments: AssistantSegment[] = []
  /** Frontend temporary id of this turn's assistant message (the frontend created the placeholder in startMessageStream and sent it) */
  const segmentMessageId = options?.messageId ?? `seg_${Date.now()}`
  /** Accumulator (structure kept for future multi-segment support) */
  const newAccumulator = (): SegmentAccumulator => ({
    blocks: [],
    content: '',
    reasoning: '',
    failed: false,
    /** Whether the early-conversation summary block was already written (avoids inserting the summary card twice) */
    compactionSeen: false
  })
  const acc = newAccumulator()

  /**
   * This turn's "final answer" boundary (authoritative in the protocol layer; see TurnFinal detection in service/answer-boundary.ts).
   *
   * Content advances it and **retraction** is expressed by it: `markAnswer` recomputes from the accumulated blocks every time;
   * when the result flips from "has answer" to "no answer", an explicit `answer: false` retraction chunk is sent
   * — otherwise the renderer already rendered that content outside the collapsed area and would never learn the main process changed its mind.
   * Empty-content chunks do not vote (`undefined`), so the renderer's marker is not cleared by accident.
   */
  let answerBlocks = 0
  let answerHas = false
  const markAnswer = (): void => {
    const next = answerTrailingCount(acc.blocks)
    // Flip from "has answer" back to "no answer": explicit retraction, otherwise the renderer already rendered that content outside the collapsed area
    if (next === 0 && answerHas) {
      sendChunk({ answer: false })
    }
    answerBlocks = next
    answerHas = next > 0
  }

  /** Final marker for this turn (sent with harness-stream-done; the renderer uses it to know this is the last turn) */
  let goalRoundWillContinue: boolean | null = null
  let goalRoundClosed: boolean | null = null

  /** Reason the assistant output failed to persist (non-null means this turn cannot be considered settled) */
  let assistantPersistError: unknown = null

  /** Persist and register this turn's assistant output */
  const flushSegment = async (): Promise<void> => {
    let dialogueId: number | null = null
    if (!acc.failed) {
      try {
        dialogueId = await addDialogue({
          topic_id: topicId,
          role: 'assistant',
          content: acc.content,
          blocks: JSON.stringify(acc.blocks)
        })
      } catch (err) {
        // Persistence failure cannot be only logged: the frontend would lack the DB row id and the whole reply would vanish on refresh,
        // so mark this turn as unsettled and report it to the user during close-out (see turnFinal.settled and streamError).
        assistantPersistError = err
        logger.error('[Harness] Failed to save AI message:', err)
      }
    }
    segments.push({ messageId: segmentMessageId, dialogueId, content: acc.content })
  }

  const stream = harnessService.sendMessageStream(
    question,
    {
      ...options,
      topicId,
      signal: abortController.signal,
      contextBudget,
      // Raw window (tokens): compaction pressure is judged first from last turn's real tokens ÷ window ≥ 79%,
      // with the character budget only as fallback (see runtime/harness/context-pressure.ts)
      contextWindow: contextWindowTokens,
      // Summary compaction starts: immediately push a "compacting" transition chunk (not persisted; the result rides on historyCompacted at stream end,
      // and the renderer replaces the transition block in place when the result arrives, forming a "compacting → compacted" transition)
      onCompactionStart: () => {
        sendChunk({ historyCompacting: true })
      },
      // Auto-retry of the summary compaction model request: push a "retrying (N/2)" transition chunk (not persisted);
      // compaction model failures recover the same way as the main model — after retries are exhausted, ModelRecoveryModal switches models and continues compacting in place
      onCompactionRetry: (attempt, retries) => {
        sendChunk({ retrying: { attempt, retries } })
      },
      // In-turn interjection (steering): **pure injection** — merge the text into the model context; it is not persisted and creates no dialogue content.
      // Two call sites (see runtime/agent.ts): before the model node call (main path, so mid-answer interjections also take effect) and
      // before tool node execution. Entries not consumed by the end of the turn are returned to the queue by releaseHolds, never silently dropped.
      drainInjections: async (): Promise<AgentInjection[] | null> => {
        const items = harnessQueue.takeInjections(topicId)
        if (items.length === 0) return null
        logger.info(
          `[HarnessQueue] Draining ${items.length} queued message(s) for injection (topic=${topicId})`
        )
        return items.map((item) => {
          sendChunk({ steered: { text: item.text } })
          // The queue already removed this entry: broadcast to all windows (including the origin) to clear the queue row
          harnessQueue.notifyConsumed(topicId, { item })
          return { text: item.text }
        })
      }
    },
    (records) => {
      usageRecords = records
    },
    // Live progress while generating: only sends this turn's cumulative total, not persisted and not part of settlement. Calls without token numbers
    // (no usage_metadata returned by the model) are skipped, so the footer does not flash a fake 0-token message.
    (records) => {
      const totals = sumUsage(records)
      if (!totals.hasTokens) return
      safeSend(event.sender, HARNESS_EVENTS.turnUsage, {
        topicId,
        turnId,
        calls: totals.calls,
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        totalTokens: totals.totalTokens
      })
    }
  )

  try {
    for await (const chunk of stream) {
      // Abort immediately when the renderer is gone (crash/window close); no more chunks to a dead frame
      if (!isSenderAlive(event.sender)) {
        senderDead = true
        abortController.abort()
        break
      }
      if (abortController.signal.aborted) {
        logger.info('[Harness] Stream cancelled by user')
        break
      }
      // Stream failed after partial output: forward the error event to the frontend and mark to skip persistence
      if (chunk.streamError) {
        acc.failed = true
        logger.error(
          '[Harness] Stream failed (partial output already produced):',
          chunk.streamError.message
        )
        safeSend(event.sender, HARNESS_EVENTS.streamError, {
          error: chunk.streamError.message,
          topicId,
          turnId
        })
      }
      // Hot-memory injection for this turn: placed at the very top of the message blocks (arrives with the first chunk, accumulated once, persisted with blocks)
      if (chunk.memoryInjected) {
        const exists = acc.blocks.some((b) => b.type === 'memoryInjected')
        if (!exists) {
          acc.blocks.unshift({
            type: 'memoryInjected',
            memory: chunk.memoryInjected
          })
        }
      }
      // Early-conversation summary compaction for this turn: right after the injected memory block (arrives before the main stream starts, accumulated once).
      // The summary card lands in the first segment only: after an interjection splits segments, new segments do not re-insert it (duplicate historyCompacted is ignored)
      if (chunk.historyCompacted) {
        if (!acc.compactionSeen) {
          acc.compactionSeen = true
          acc.blocks.push({
            type: 'historyCompacted',
            compaction: chunk.historyCompacted
          })
        }
      }
      if (chunk.reasoning_content) {
        const rc = String(chunk.reasoning_content)
        // Handle providers that send the full text instead of a delta: when the new content is a prefix of the existing content, take only the added suffix.
        // No more endsWith de-duplication (fix): main-process deltas are already de-duplicated by shape, so what arrives here is a real delta;
        // a delta that happens to equal the accumulated tail is usually genuine model repetition, and a false positive would drop real content,
        // making the persisted result differ from what the renderer displayed.
        if (acc.reasoning && rc.startsWith(acc.reasoning) && rc.length > acc.reasoning.length) {
          const delta = rc.slice(acc.reasoning.length)
          const lastBlock = acc.blocks[acc.blocks.length - 1]
          if (lastBlock && lastBlock.type === 'reasoning') {
            lastBlock.reasoning = (lastBlock.reasoning || '') + delta
          } else {
            acc.blocks.push({ type: 'reasoning', reasoning: delta })
          }
          acc.reasoning = rc
        } else {
          acc.reasoning += rc
          const lastBlock = acc.blocks[acc.blocks.length - 1]
          if (lastBlock && lastBlock.type === 'reasoning') {
            lastBlock.reasoning = (lastBlock.reasoning || '') + rc
          } else {
            acc.blocks.push({ type: 'reasoning', reasoning: rc })
          }
        }
        // The answer boundary advances with content (recomputed as content arrives, no longer waiting for the renderer-guessed turn end);
        // answer=false means the model has started doing work, so the renderer retracts the marker
        if (chunk.answer !== false) markAnswer()
      }
      if (chunk.content) {
        const c = String(chunk.content)
        // Same as the reasoning branch: only startsWith suffix slicing (full-form defense), no endsWith de-duplication;
        // when creating a new text block in accumulated form, also store only the delta to avoid double counting against the renderer (which stores the suffix)
        if (acc.content && c.startsWith(acc.content) && c.length > acc.content.length) {
          const delta = c.slice(acc.content.length)
          acc.content = c
          const lastBlock = acc.blocks[acc.blocks.length - 1]
          if (lastBlock && lastBlock.type === 'text') {
            lastBlock.text = (lastBlock.text || '') + delta
          } else {
            acc.blocks.push({ type: 'text', text: delta })
          }
        } else {
          acc.content += c
          const lastBlock = acc.blocks[acc.blocks.length - 1]
          if (lastBlock && lastBlock.type === 'text') {
            lastBlock.text = (lastBlock.text || '') + c
          } else {
            acc.blocks.push({ type: 'text', text: c })
          }
        }
        if (chunk.answer !== false) markAnswer()
      }
      if (chunk.tool) {
        if (chunk.tool.name === 'task') {
          // The task tool is converted to subAgent events by service.ts and sent there, so skip it here
        } else {
          // Prefer an exact callId match for the same call; fall back to name when the preparing phase has no id;
          // ids from different sources may disagree, so also fall back to name when an unfinished block has the same name
          const matchesTool = (t: ToolCallDetail): boolean => {
            if (chunk.tool!.id) {
              if (t.id === chunk.tool!.id) return true
              if (!t.id && t.status === 'preparing' && t.name === chunk.tool!.name) return true
              if (t.id && t.status && t.status !== 'completed' && t.name === chunk.tool!.name)
                return true
              return false
            }
            return t.name === chunk.tool!.name || t.name === ''
          }
          if (chunk.tool.status === 'completed') {
            // Match and update the unfinished tool block for the same call
            for (let i = acc.blocks.length - 1; i >= 0; i--) {
              const b = acc.blocks[i]
              if (
                b.type === 'tool' &&
                b.tool &&
                b.tool.status !== 'completed' &&
                matchesTool(b.tool)
              ) {
                b.tool.output = chunk.tool.output
                b.tool.status = chunk.tool.status
                b.tool.card = chunk.tool.card
                b.tool.images = chunk.tool.images
                break
              }
            }
          } else if (chunk.tool.status === 'preparing') {
            // The model started building tool arguments; later progress chunks are only keep-alive and are skipped once the block exists.
            // Skip too if the same call is already executing/completed (out-of-order events), avoiding duplicate blocks.
            const exists = acc.blocks.some(
              (b) => b.type === 'tool' && matchesTool(b.tool as ToolCallDetail)
            )
            if (!exists) {
              acc.blocks.push({
                type: 'tool',
                tool: {
                  name: chunk.tool.name,
                  input: {},
                  output: '',
                  status: 'preparing',
                  id: chunk.tool.id
                }
              })
            }
          } else {
            // executing: prefer merging into the preparing block of the same call
            let merged = false
            for (let i = acc.blocks.length - 1; i >= 0; i--) {
              const b = acc.blocks[i]
              if (b.type === 'tool' && b.tool?.status === 'preparing' && matchesTool(b.tool)) {
                b.tool.name = chunk.tool.name
                b.tool.input = chunk.tool.input
                b.tool.status = 'executing'
                b.tool.id = b.tool.id ?? chunk.tool.id
                merged = true
                break
              }
            }
            // Defense: some providers send the first tool block without a tool name (registered under the placeholder name 'tool') —
            // when no preparing block matches by name, merge into the nearest placeholder block and rename it to the real tool name,
            // avoiding a ghost 'tool · generating…' block next to the real tool block (consistent with the renderer's applyChunkToMessages)
            if (!merged) {
              for (let i = acc.blocks.length - 1; i >= 0; i--) {
                const b = acc.blocks[i]
                if (b.type === 'tool' && b.tool?.status === 'preparing' && b.tool.name === 'tool') {
                  b.tool.name = chunk.tool.name
                  b.tool.input = chunk.tool.input
                  b.tool.status = 'executing'
                  b.tool.id = b.tool.id ?? chunk.tool.id
                  merged = true
                  break
                }
              }
            }
            if (!merged) {
              acc.blocks.push({
                type: 'tool',
                tool: {
                  name: chunk.tool.name,
                  input: chunk.tool.input,
                  output: chunk.tool.output,
                  status: 'executing',
                  id: chunk.tool.id
                }
              })
            }
          }
        }
        // A tool card breaks the "answer tail": the boundary falls back to the last non-tool content (usually null)
        markAnswer()
      }
      if (chunk.subAgent) {
        const sa = chunk.subAgent
        // Note: do not append sub-agent output to acc.content (the main message content).
        // Sub-agent details are already persisted in the subAgent block (including children),
        // so reloading history renders from blocks; appending to content as well would cause:
        // (1) on message copy / context injection, the full sub-agent text appears twice in the main agent's speech;
        // (2) the main model sees the duplicated text next turn, further amplifying repetition.
        // Sub-agent block matching logic is below:

        // Match agent accumulator blocks: prefer causeId, fall back to name
        const matchesSa = (b: (typeof acc.blocks)[number]): boolean => {
          if (b.type !== 'subAgent' || !b.subAgent) return false
          if (sa.causeId && b.subAgent.causeId) return b.subAgent.causeId === sa.causeId
          return b.subAgent.name === sa.name
        }

        // Find or create an agent accumulator block with the same name
        let saBlock = acc.blocks.find(matchesSa)
        if (!saBlock) {
          saBlock = {
            type: 'subAgent',
            subAgent: {
              name: sa.name,
              causeId: sa.causeId,
              status: sa.status,
              taskDescription: sa.taskDescription
            },
            children: []
          }
          acc.blocks.push(saBlock)
        }

        if (sa.status === 'started') {
          saBlock.subAgent!.status = sa.status
          saBlock.subAgent!.taskDescription =
            saBlock.subAgent!.taskDescription || sa.taskDescription
        } else if (sa.status === 'dispatched') {
          // Lightweight background dispatch event: the block settles at "dispatched" (name + summary + session id), with no child blocks/content
          saBlock.subAgent!.status = 'dispatched'
          saBlock.subAgent!.taskDescription =
            saBlock.subAgent!.taskDescription || sa.taskDescription
          saBlock.subAgent!.subagentId = sa.subagentId ?? saBlock.subAgent!.subagentId
        } else if (sa.status === 'completed' || sa.status === 'error') {
          saBlock.subAgent!.status = sa.status
          saBlock.subAgent!.output = sa.output
          saBlock.subAgent!.error = sa.error
        } else if (sa.content || sa.reasoning_content || sa.tool) {
          if (saBlock.subAgent!.status !== 'completed' && saBlock.subAgent!.status !== 'error') {
            saBlock.subAgent!.status = 'running'
          }
          if (!saBlock.children) saBlock.children = []

          if (sa.reasoning_content) {
            const lastChild = saBlock.children[saBlock.children.length - 1]
            if (lastChild && lastChild.type === 'reasoning') {
              lastChild.reasoning = (lastChild.reasoning || '') + sa.reasoning_content
            } else {
              saBlock.children.push({ type: 'reasoning', reasoning: sa.reasoning_content })
            }
          }

          if (sa.content) {
            const lastChild = saBlock.children[saBlock.children.length - 1]
            if (lastChild && lastChild.type === 'text') {
              lastChild.text = (lastChild.text || '') + sa.content
            } else {
              saBlock.children.push({ type: 'text', text: sa.content })
            }
          }

          if (sa.tool) {
            // Prefer an exact callId match for the same call; fall back to name when the preparing phase has no id;
            // ids from different sources may disagree, so also fall back to name when an unfinished block has the same name
            const matchesTool = (t: ToolCallDetail): boolean => {
              if (sa.tool!.id) {
                if (t.id === sa.tool!.id) return true
                if (!t.id && t.status === 'preparing' && t.name === sa.tool!.name) return true
                if (t.id && t.status && t.status !== 'completed' && t.name === sa.tool!.name)
                  return true
                return false
              }
              return t.name === sa.tool!.name || t.name === ''
            }
            if (sa.tool.status === 'completed') {
              for (let i = saBlock.children.length - 1; i >= 0; i--) {
                const c = saBlock.children[i]
                if (
                  c.type === 'tool' &&
                  c.tool &&
                  c.tool.status !== 'completed' &&
                  matchesTool(c.tool)
                ) {
                  c.tool.output = sa.tool.output
                  c.tool.status = 'completed'
                  c.tool.card = sa.tool.card
                  break
                }
              }
            } else if (sa.tool.status === 'preparing') {
              const exists = saBlock.children.some(
                (c) => c.type === 'tool' && c.tool?.status === 'preparing' && matchesTool(c.tool)
              )
              if (!exists) {
                saBlock.children.push({
                  type: 'tool',
                  tool: {
                    name: sa.tool.name,
                    input: {},
                    output: '',
                    status: 'preparing',
                    id: sa.tool.id
                  }
                })
              }
            } else {
              let merged = false
              for (let i = saBlock.children.length - 1; i >= 0; i--) {
                const c = saBlock.children[i]
                if (c.type === 'tool' && c.tool?.status === 'preparing' && matchesTool(c.tool)) {
                  c.tool.name = sa.tool.name
                  c.tool.input = sa.tool.input
                  c.tool.status = 'executing'
                  c.tool.id = c.tool.id ?? sa.tool.id
                  merged = true
                  break
                }
              }
              // Defense: 'tool' placeholder name fallback (same as the main-agent accumulator logic above)
              if (!merged) {
                for (let i = saBlock.children.length - 1; i >= 0; i--) {
                  const c = saBlock.children[i]
                  if (
                    c.type === 'tool' &&
                    c.tool?.status === 'preparing' &&
                    c.tool.name === 'tool'
                  ) {
                    c.tool.name = sa.tool.name
                    c.tool.input = sa.tool.input
                    c.tool.status = 'executing'
                    c.tool.id = c.tool.id ?? sa.tool.id
                    merged = true
                    break
                  }
                }
              }
              if (!merged) {
                saBlock.children.push({
                  type: 'tool',
                  tool: {
                    name: sa.tool.name,
                    input: sa.tool.input,
                    output: sa.tool.output || '',
                    status: 'executing',
                    id: sa.tool.id
                  }
                })
              }
            }
          }
        }
        // Dispatching a sub-agent also breaks the answer tail (sub-agent blocks are not answer content)
        markAnswer()
      }
      // Abort the stream when sending fails (the render frame is gone), avoiding repeated sends to a dead frame.
      // Always go through safeSend (fix: a bare send does not throw during the frame-invalidated window, the try/catch was dead code,
      // and it violated the project convention that main-process pushes go through safeSend)
      if (!sendChunk({ ...chunk })) {
        logger.warn('[Harness] Failed to send stream chunk (renderer disposed)')
        senderDead = true
        abortController.abort()
        break
      }
    }
  } catch (error) {
    if ((error as Error)?.name !== 'AbortError') {
      logger.error('Error in harness stream:', error)
      const errMsg = error instanceof Error ? error.message : String(error)
      safeSend(event.sender, HARNESS_EVENTS.streamError, { error: errMsg, topicId, turnId })
      // On abnormal stream interruption do not save an incomplete AI reply; jump straight to cleanup
      streamAbortControllers.delete(event.sender.id)
      stopMemSampling()
      safeSend(event.sender, HARNESS_EVENTS.streamDone, { topicId, turnId })
      return { topicId, cancelled: false, turnId }
    }
  } finally {
    // Remove the invalidation watch after the stream ends (normal/cancelled/errored/renderer gone)
    event.sender.removeListener('render-process-gone', onSenderGone)
    event.sender.removeListener('destroyed', onSenderGone)
    stopMemSampling()
  }

  // 3.9 Final value of this turn's answer boundary: the stream has stopped appending (including stopped/errored/invalid-frame paths),
  //     so one recompute here gives the verdict. When the boundary flips from "has" to "none", a retraction chunk is sent here.
  markAnswer()

  // 4. Save this turn's AI reply segments (skip per segment on stream failure: a truncated reply should not be persisted as a complete message).
  //    Send the new dialogue row id back to the frontend after persisting: messages during streaming use temporary ids, and only with the DB row id
  //    can the frontend attach the usage row (linked by dialogue_id) to this message on the spot without reloading the topic.
  //    Without interjections there is exactly one segment here, fully consistent with the old behavior.
  await flushSegment()
  if (assistantPersistError) {
    // The reply was already streamed to the user, so add an explicit error here: this turn may disappear after a refresh
    safeSend(event.sender, HARNESS_EVENTS.streamError, {
      error: mainMessages().error.assistantPersistFailed,
      topicId,
      turnId
    })
  }
  const lastPersisted = [...segments].reverse().find((seg) => seg.dialogueId != null)
  const assistantDialogueId = lastPersisted?.dialogueId ?? null
  if (assistantDialogueId != null) {
    // Persist real usage (skipped when the model returned no usage_metadata; no fake all-zero data).
    // One usage row links to one segment: with multiple segments it hangs on the last one (turn tokens accumulate and cannot be split per segment)
    await persistTurnUsage({
      dialogueId: assistantDialogueId,
      topicId,
      providerId: options?.providerId,
      records: usageRecords
    })
  }

  // 4.5 Close out the task list: when no one will take this list over after the turn ends, mark items still in_progress as completed.
  //
  // Why this fallback exists: the list is written by the model and its close-out writing is unreliable — 2026-09-18 instance:
  // all six items were done and the answer delivered, but the last write_todos still left one item in_progress, so the card sat
  // forever at '5/6 completed · 1 in progress'. 2026-09-23 the user reported the same symptom again (the task is clearly done but
  // the page still shows one task incomplete); the root cause was that this code **skipped goal auto-continue turns entirely**:
  // after the goal completed in its final turn there was no next turn to close out, so that item kept spinning forever.
  //
  // The decision rule (see decideCloseOutOnTurnEnd in runtime/todo-closeout.ts) is single:
  // "will another turn take over after this one ends?" — if yes (goal active + armed and under the round limit), leave it;
  // if no, close out. So user stop, stream failure, goal completed/blocked/disarmed/round limit also close out:
  // nothing is running then, and leaving in-progress is a false state (the frontend would read it back from the store after restart).
  // "Will it continue?" always asks goalStore.willContinue (same source of truth as the driver dispatch gate, avoiding drift).
  try {
    const decision = await decideCloseOutOnTurnEnd({
      isGoalRound: options?.turnMeta?.source === 'goal-round',
      goalWillContinue: () => goalStore.willContinue(topicId),
      hasPendingQuestion: () => questionService.getPending(topicId) != null
    })
    // Record the two final-marker facts along the way (same source of truth as the close-out decision, no extra DB reads):
    // the renderer learns from them whether this is the last turn and whether the goal wrapped up, with no inference elsewhere
    if (options?.turnMeta?.source === 'goal-round') {
      goalRoundWillContinue = await goalStore.willContinue(topicId)
      goalRoundClosed = (await goalStore.load(topicId))?.phase === 'complete'
    }
    if (decision.close) {
      const closed = closeOutInProgress(todoStore, topicId)
      if (closed) {
        logger.info(
          `[Harness] Closing out this turn: closed ${closed.closed} in-progress items -> ${closed.completed}/${closed.total} completed`
        )
      }
    } else {
      logger.info(`[Harness] Not closing out todo list this turn (${decision.reason})`)
    }
  } catch (err) {
    // Close-out is only a fallback: decision or broadcast failures must not affect persistence or the frontend close-out notification
    logger.warn('[Harness] Failed to close out todo list:', err)
  }

  /**
   * Final marker for this turn (authoritative protocol conclusion; see TurnFinal in service/answer-boundary.ts).
   *
   * These facts used to go only to logs: to know where this turn's answer is and whether it is the last turn, the renderer
   * had to guess from its own loading state — while loading flips are suppressed in goal continuation
   * (goal-driver is `while (await driveOnce())`, so the previous turn's done and the next turn's goalRound land on almost the same tick).
   * Now the conclusion is sent with the done event.
   */
  const turnFinal: TurnFinal = {
    settled: !abortController.signal.aborted && !acc.failed && assistantPersistError === null,
    goalRound: options?.turnMeta?.source === 'goal-round',
    round: options?.turnMeta?.goalRound,
    goalClosed: goalRoundClosed ?? undefined,
    goalWillContinue: goalRoundWillContinue ?? undefined,
    answerFrom: answerBlocks > 0 ? acc.blocks.length - answerBlocks : null,
    answerBlocks
  }
  logger.info(
    `[Harness] Turn final: settled=${turnFinal.settled}, goalRound=${turnFinal.goalRound}` +
      `${turnFinal.round != null ? `(round=${turnFinal.round}, closed=${turnFinal.goalClosed}, willContinue=${turnFinal.goalWillContinue})` : ''}` +
      `, answer=${turnFinal.answerBlocks} blocks (from ${turnFinal.answerFrom}), blocks=${acc.blocks.length}`
  )

  // 5. Clean up and notify the renderer that streaming output is complete
  streamAbortControllers.delete(event.sender.id)
  safeSend(event.sender, HARNESS_EVENTS.streamDone, {
    topicId,
    // Turn id for this run: the renderer drops stale close-out events that belong to another turn
    turnId,
    // DB ids of this turn's two dialogue rows: the frontend swaps temporary ids for real ones (needed for deleting the turn and linking usage)
    userDialogueId: userDialogueId ?? undefined,
    assistantDialogueId: assistantDialogueId ?? undefined,
    // Assistant segment list: one segment without interjections (equivalent to the old single assistantDialogueId);
    // with interjections, one per segment, and the frontend attaches DB row ids back to the matching assistant bubbles by messageId
    segments: segments.map((seg) => ({
      messageId: seg.messageId,
      dialogueId: seg.dialogueId ?? undefined
    })),
    // Final marker (including the final answer boundary): the renderer reads it instead of guessing
    turnFinal
  })
  return { topicId, cancelled: abortController.signal.aborted, turnId }
}

/** Broadcast the current state of the interjection queue (all windows; the frontend filters by topicId) */
function broadcastQueue(topicId: number): void {
  const queue = harnessQueue.view(topicId)
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed())
      safeSend(win.webContents, HARNESS_EVENTS.queueUpdated, { topicId, queue })
  }
}

/**
 * Whether this topic currently has something waiting for user confirmation (question / sandbox approval).
 *
 * The two services each keep a pending table (questions in questionService, approvals in permissionGate);
 * the sidebar only cares whether the topic still needs a human, so take the union; settling one side recomputes,
 * and it stays true while the other side is still pending (one turn may ask a question first, then request an approval).
 */
function isTopicAwaitingUser(topicId: number): boolean {
  return questionService.getPending(topicId) != null || permissionGate.getPending(topicId) != null
}

/**
 * Broadcast whether this topic still needs user confirmation — the sidebar uses it to switch the row indicator from **in progress** to a **breathing yellow dot**
 * (user requirement 2026-11-23: when the operation needs the user to confirm again, this icon should become a yellow breathing dot).
 *
 * Send timing: once when a question/approval **becomes pending**, once when **settled** (allow / deny / abort).
 * Both sides compute live from `isTopicAwaitingUser`, so two pending items in one topic, or one settled while the other is still pending,
 * never produce a wrong state; duplicate same-value events are de-duplicated by the renderer (a Set lookup is idempotent anyway).
 */
function broadcastTopicPending(topicId: number): void {
  if (!Number.isFinite(topicId) || topicId <= 0) return
  const pending = isTopicAwaitingUser(topicId)
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed())
      safeSend(win.webContents, HARNESS_EVENTS.topicPending, { topicId, pending })
  }
}

/** sender.id → the topic that this renderer frame is currently running (used on stop to drop the pending injection buffer) */
const senderTopic = new Map<number, number>()

/** Public payload of an in-turn interjection (queue entry + DB row id) */
interface StartStreamOptions {
  topicId?: number
  providerId?: number
  images?: string[]
  documents?: { fileName: string; filePath: string }[]
  turnMeta?: TurnMeta
  reuseUserDialogueId?: number
  messageId?: string
  /**
   * Memory scope (`plugin:<plugin id>`). Only used when the **main process creates the topic as a fallback** —
   * normally the renderer calls `harness-topic-create` first (writing the scope into the topic row) and the main process reads it from the topic.
   */
  memoryScope?: string | null
  /**
   * Runtime selection for this turn (tools / skills / MCP tools): non-null dimensions override the session config.
   * Comes from the selection below the input box, or the task-level selection stored on a scheduled task.
   */
  agentConfig?: AgentSelection | null
  /** Workspace context for this turn (set by the caller for cross-mode scheduled runs; defaults to current settings) */
  workspaceContext?: { workspaceId?: number; workspacePath?: string }
  /** Whether to write this turn's selection back to the topic (user send = true; scheduled/internal turns = false) */
  persistAgentConfig?: boolean
}

/**
 * Memory scope for this turn: the **topic-stored** value wins (`harness_topic.memory_scope`);
 * when the topic does not exist yet (just created this turn or unreadable), use the caller's fallback; if neither, workspace memory.
 *
 * Why the topic wins: a topic opened from the plugin row "+" carries `plugin:<id>`, and after reopening it (or even restarting the app)
 * that plugin's memory must still be used, not something the renderer happens to remember (user requirement 2026-09-28).
 */
async function resolveTurnMemoryScope(
  topicId: number | undefined,
  fallback: string | null | undefined,
  workspaceId: number
): Promise<MemoryScope> {
  if (topicId) {
    try {
      const rows = await getTopicById(topicId)
      const raw = rows[0]?.memory_scope
      if (raw) return parseMemoryScope(raw, workspaceId)
    } catch (err) {
      logger.warn(
        '[Harness] Failed to read topic memory scope, falling back to workspace memory:',
        err
      )
    }
  }
  return parseMemoryScope(fallback, workspaceId)
}

/** Outcome of one chat turn (turnId maps close-out events back to their turn) */
interface TurnOutcome {
  topicId: number
  cancelled: boolean
  turnId: number
  /**
   * Set when the turn ended in a phase failure (missing model, persistence failure, …) instead of
   * producing a reply. Scheduled runs read it to record the run as `failed` with the reason,
   * rather than as a completed run that mysteriously has no answer.
   */
  error?: string
}

/**
 * Start one chat turn and track its lifecycle (waits for persistence before quitting the app).
 *
 * Shared by three entry points: user send (harness-start-stream), queue continuation (drainPendingQueue),
 * goal auto-continue (goalRoundDriver). Turn registration (beginTurn / endTurn) also lives here, so
 * any turn started from any entry point makes `isTurnActive` true — a second send while generating is not treated as idle.
 */
function launchTurn(
  event: HarnessSenderEvent,
  question: string,
  options: StartStreamOptions | undefined,
  trackTurn: (p: Promise<TurnOutcome>) => Promise<TurnOutcome>
): Promise<TurnOutcome> {
  const requestedTopicId = options?.topicId
  // Existing topic: register this turn's id before starting (the renderer's busy check uses it to decide whether a turn is running)
  const turnId = requestedTopicId != null ? harnessQueue.beginTurn(requestedTopicId) : 0
  if (requestedTopicId != null) senderTopic.set(event.sender.id, requestedTopicId)

  let outcome: TurnOutcome | null = null
  return trackTurn(runHarnessTurn({ event, question, options, turnId }))
    .then((result) => {
      outcome = result
      return result
    })
    .finally(() => {
      // The new topic (first message) id comes back from runHarnessTurn; close-out registers under it
      const settledTopicId = outcome?.topicId ?? requestedTopicId ?? 0
      if (settledTopicId > 0) {
        harnessQueue.endTurn(settledTopicId, outcome?.turnId ?? turnId)
        // Entries interjected this turn that never reached an injection boundary go back to the queue (see releaseHolds):
        // they were neither persisted nor added to the dialogue, so the user must still see them; otherwise the content silently vanishes
        harnessQueue.releaseHolds(settledTopicId)
      }
      // Remove the mapping only when this frame has no other running topic (two turns starting at once on frame switch is rare; be conservative)
      if (requestedTopicId != null && senderTopic.get(event.sender.id) === requestedTopicId) {
        senderTopic.delete(event.sender.id)
      }
    })
}

/**
 * Queue handling after a turn ends: send queued messages **one by one** as new turns (FIFO) until the queue is empty.
 *
 * The old implementation continued only one message (the continuation turn's own close-out never re-triggered this), so the second queued message onwards never went out.
 * Now the whole loop is delegated to turn-drain (pure function, unit-tested); this only wires up "start a turn + goal continuation".
 *
 * Termination: queue empty / goal driver running (do not preempt) / user aborted some turn (the rest stay queued,
 * decided on the user's next send) / turn start failed (logged, no infinite retry).
 */
async function drainPendingQueue(
  event: HarnessSenderEvent,
  topicId: number,
  options: StartStreamOptions | undefined,
  trackTurn: (p: Promise<TurnOutcome>) => Promise<TurnOutcome>
): Promise<void> {
  const drained = await drainPendingTurns({
    isTurnActive: () => harnessQueue.isTurnActive(topicId),
    isGoalRunning: () => goalRoundDriver.isRunning(topicId),
    hasPending: () => harnessQueue.hasPending(topicId),
    shift: () => harnessQueue.shift(topicId),
    onContinue: (item) =>
      logger.info(
        `[HarnessQueue] Turn ended, continuing with queued message: ${item.text.slice(0, 40)}`
      ),
    runTurn: async (item) => {
      const outcome = await launchTurn(
        event,
        item.text,
        {
          ...options,
          topicId,
          // Continuation turns do not inherit the "edit and resend" target row or old message ids
          reuseUserDialogueId: undefined,
          messageId: undefined,
          images: item.images,
          documents: item.documents,
          // Marker source: runHarnessTurn sends the queueTurn marker at stream start based on it,
          // so the renderer knows this turn continued from a queued message and mounts the user bubble
          turnMeta: { source: 'queue', queueItemId: item.id }
        },
        trackTurn
      )
      if (!outcome.cancelled) {
        // Goal continuation: after the continuation turn ends, hand control to the driver; then continue with the next queued message
        await goalRoundDriver.maybeDrive(topicId, (p) =>
          launchTurn(
            event,
            p.question,
            { ...options, topicId: p.topicId, turnMeta: p.turnMeta },
            trackTurn
          )
        )
      }
      return outcome
    },
    onError: (error) =>
      logger.error('[HarnessQueue] Failed to continue with queued message:', error)
  })
  if (drained > 0) {
    logger.info(`[HarnessQueue] Drained ${drained} queued message(s) for topic ${topicId}`)
  }
}

/**
 * Chat send / streaming output / directory selection / skill list IPC: grouped into a `harness:*` handler table,
 * assembled together with the global subscriptions the assistant depends on (onChange / onAsk / conversation event stream).
 *
 * - Channel names are all `harness:<original flat name>` and registered on ipcMain by `registerIpcHandlers`;
 * - The former `ipcMain.on` channels (start-stream / cancel-stream / agent-watch) became normal invoke channels,
 *   and preload's send switched to invoke (same as the library's graph-build-start);
 * - Global subscriptions are registered in an `EffectScope` and rolled back LIFO on exit.
 */
export function registerHarnessIpc(scope: EffectScope): () => void {
  const handlers: IpcHandlerMap = {}
  /** Receive channel: the `harness:` prefix appears only here */
  const handle = (channel: string, handler: (...args: never[]) => unknown): void => {
    handlers[`harness:${channel}`] = handler
  }

  // Permission gate wiring: tier source (electron-store) + workspace root + UI-language text
  wirePermissionGate()
  // The queue is a pure state machine (no electron dependency, so tests/ can assert directly); the log sink is injected here
  setHarnessQueueLogger(logger)
  // The sandbox layer does not import electron (it must run in any node environment: fixtures / container verification); logs are injected here
  setSandboxLogger(logger)

  // Sandbox service wiring: inject the real paths of the bundled assets (Windows runner / Linux Landlock launcher).
  // Two candidates: under resources/sandbox in the repo during development; in packaged builds electron-builder's
  // extraResources copies them to process.resourcesPath/sandbox (scripts cannot be spawned directly from the asar).
  const sandboxRoots = { devRoot: app.getAppPath(), resourcesPath: process.resourcesPath }
  const archDir =
    process.arch === 'x64'
      ? 'linux-x64'
      : process.arch === 'arm64'
        ? 'linux-arm64'
        : `linux-${process.arch}`
  const landlockLauncher =
    process.platform === 'linux'
      ? resolveSandboxAsset(join(archDir, 'ryten-landlock-launcher'), sandboxRoots)
      : undefined
  if (landlockLauncher) ensureExecutable(landlockLauncher)
  sandboxService.configure({
    nodePath: process.execPath,
    appRoot: app.getAppPath(),
    windowsRunnerPath:
      process.platform === 'win32'
        ? resolveSandboxAsset('win32-sandbox-runner.cjs', sandboxRoots)
        : undefined,
    landlockLauncherPath: landlockLauncher
  })
  const sandboxStatus = sandboxService.status()
  logger.info(
    `[Sandbox] Wiring complete backend=${sandboxStatus.backend ?? 'unavailable'} enforcement=${sandboxStatus.enforcement ?? '-'} ${sandboxStatus.reason ?? ''}`
  )

  // Dangerous / out-of-bounds operations caught by the sandbox → broadcast to all windows; the approval modal asks the user to allow once / deny
  scope.effect(() => {
    permissionGate.onApprovalAsked = (pending: ApprovalRequestView) => {
      // Only broadcast serializable views (no resolve / signal, pure JSON)
      const payload = {
        topicId: pending.topicId,
        requestId: pending.requestId,
        toolName: pending.toolName,
        detail: pending.detail,
        reason: pending.reason,
        reasonCode: pending.reasonCode,
        requestedMode: pending.requestedMode,
        justification: pending.justification
      }
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) safeSend(win.webContents, HARNESS_EVENTS.approvalAsked, payload)
      }
      // At the moment of pending, tell the sidebar the topic is waiting: row indicator switches from in progress to the breathing yellow dot
      broadcastTopicPending(pending.topicId)
      logger.info(
        `[Permission] Pending approval requestId=${pending.requestId} tool=${pending.toolName} reason=${pending.reasonCode}`
      )
    }
    // Settled (allow / deny / abort) → retract the yellow dot and return to in progress
    permissionGate.onResolved = broadcastTopicPending
    return () => {
      // Once teardown starts no one can answer: settle all pending approvals as denied (fail closed)
      permissionGate.onApprovalAsked = undefined
      permissionGate.onResolved = undefined
      permissionGate.abortAll()
    }
  })

  // Queue changed → broadcast to all windows (the interjection queue above the input box refreshes live)
  scope.effect(() => {
    harnessQueue.onChanged = ({ topicId }) => broadcastQueue(topicId)
    return () => {
      harnessQueue.onChanged = null
    }
  })
  // Interjection merged into the current turn (pure injection) → broadcast to all windows: the frontend clears the queue row and shows a brief confirmation
  scope.effect(() => {
    harnessQueue.onConsumed = (eventPayload) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          safeSend(win.webContents, HARNESS_EVENTS.queueSteered, {
            topicId: eventPayload.topicId,
            itemId: eventPayload.item.id,
            text: eventPayload.item.text
          })
        }
      }
    }
    return () => {
      harnessQueue.onConsumed = null
    }
  })
  handle(
    'harness-send-message',
    async (
      question: string,
      options?: {
        topicId?: number
        providerId?: number
        images?: string[]
        documents?: { fileName: string; filePath: string }[]
        agentConfig?: AgentSelection | null
        workspaceContext?: { workspaceId?: number; workspacePath?: string }
        persistAgentConfig?: boolean
      }
    ) => {
      // Load main agent defaults (electron-store)
      const mainAgentDefaults = settingsStore.get('mainAgent') as MainAgentConfig | undefined
      const harnessSettings = settingsStore.get('harness') as HarnessSettings | undefined
      logger.info(`[Harness] Creating model with providerId: ${options?.providerId ?? 'default'}`)

      const syncWorkspaceId =
        options?.workspaceContext?.workspaceId ?? harnessSettings?.activeWorkspaceId ?? 0
      const syncWorkspacePath = await resolveTrustedWorkspacePath(
        options?.workspaceContext?.workspacePath,
        harnessSettings?.workspacePath,
        options?.topicId
      )
      const syncRequestSelection = normalizeAgentSelection(options?.agentConfig)
      const syncTopicSelection = options?.topicId
        ? await getTopicAgentSelection(options.topicId)
        : null
      const syncSelection = mergeAgentSelection(syncTopicSelection, syncRequestSelection)

      // This synchronous path must also honor the topic's memory scope (plugin topic → that plugin's own memory)
      // and decide from it whether plugin-mode mode tools are auto-mounted (see PLUGIN_MODE_TOOL_NAMES in shared/mcp.ts)
      const syncMemoryScope = await resolveTurnMemoryScope(
        options?.topicId,
        undefined,
        syncWorkspaceId
      )
      const pluginMode = syncMemoryScope.kind === 'plugin'
      const expandedSyncMcpTools = expandMcpServerGroups(
        syncSelection.mcpTools ?? [],
        currentMcpTools().infos.map((info) => info.name)
      )
      const selectedTools = effectiveMainAgentTools(
        {
          tools: syncSelection.tools ?? mainAgentDefaults?.tools ?? [],
          mcpTools: expandedSyncMcpTools
        },
        {
          pluginMode,
          signedIn: hasLatticeSession()
        }
      )
      const tools = buildTools(selectedTools)
      logger.info(
        `[Harness] Tools for this turn: pluginMode=${pluginMode} count=${selectedTools.length} [${selectedTools.join(',')}]`
      )

      const model = await getProviderService().createModel(options?.providerId)

      // Skills: enable only the session-level selection (none by default)
      const effectiveSkills = syncSelection.skills ?? []

      // This model's "tool-call rounds" limit (fall back to the project default, with HarnessService as the last resort);
      // also record the provider/model descriptor so background sub-agents can persist and cold-resume on the same model
      let maxToolRounds: number | undefined
      let syncModelDescriptor: SubAgentMainModelDescriptor | undefined
      let syncSupportsImageInput = false
      try {
        const providerConfig = await getProviderService().getConfig(options?.providerId)
        maxToolRounds = providerConfig.max_tool_rounds
        syncModelDescriptor = { providerId: providerConfig.id, model: providerConfig.model }
        syncSupportsImageInput =
          (providerConfig.metadata as { capabilities?: { supports_image_input?: boolean } } | null)
            ?.capabilities?.supports_image_input === true
      } catch (err) {
        logger.warn('[Harness] Failed to read model max tool call rounds, using default:', err)
      }

      if (options?.topicId && syncRequestSelection && options?.persistAgentConfig !== false) {
        try {
          await setTopicAgentSelection(options.topicId, syncSelection)
        } catch (err) {
          logger.warn('[Harness] Failed to persist session agent selection:', err)
        }
      }
      const harnessService = new HarnessService(
        model,
        tools,
        await listEnabledSubAgents(syncWorkspaceId),
        getDialoguesByTopicId,
        harnessSettings?.skillsPath || undefined,
        effectiveSkills,
        syncWorkspacePath || undefined,
        harnessSettings?.memoryPath || undefined,
        syncWorkspaceId,
        maxToolRounds,
        syncMemoryScope,
        syncModelDescriptor,
        false,
        syncSupportsImageInput,
        false
      )
      return await harnessService.sendMessage(question, options)
    }
  )

  handle(
    'harness-start-stream',
    (question: string, options?: StartStreamOptions): { started: boolean; queued?: boolean } => {
      // The event.sender of the former ipcMain.on('harness-start-stream'): the new contract does not pass the event object
      const sender = primarySender()
      if (!sender) return { started: false }
      const event: HarnessSenderEvent = { sender }
      // A turn is already running in this topic: never start a second one concurrently.
      //
      // Concurrency would put both turns' chunks into the same assistant bubble under the same __topicId (garbled output),
      // so this send is enqueued and continued by drainPendingQueue when the current turn ends.
      // Returns queued=true; the renderer then removes the optimistic bubble it just mounted (the message is not lost, it is queued).
      const requestedTopicId = options?.topicId
      if (requestedTopicId != null && harnessQueue.isTurnActive(requestedTopicId)) {
        logger.info(
          `[HarnessQueue] Topic ${requestedTopicId} already running, queueing the new message instead of starting a second turn`
        )
        harnessQueue.enqueue({
          topicId: requestedTopicId,
          senderId: sender.id,
          text: question,
          attachments: { images: options?.images, documents: options?.documents }
        })
        return { started: false, queued: true }
      }
      // Track running streams: abort all of them uniformly on app quit and wait for data to be saved.
      // After a user turn completes, trigger the goal-round driver (auto-continue turns are scheduled recursively inside the driver)
      // Every turn (including auto turns dispatched by the goal driver) is registered in activeHarnessStreams,
      // so lifecycle can intercept and wait for persistence on quit (fix: previously only the first turn was tracked, so quitting during an auto turn lost the reply)
      const trackTurn = (p: Promise<TurnOutcome>): Promise<TurnOutcome> => {
        activeHarnessStreams.add(p)
        p.finally(() => activeHarnessStreams.delete(p))
        return p
      }
      const streamPromise = launchTurn(event, question, options, trackTurn)
        .then(async ({ topicId, cancelled }) => {
          if (options?.turnMeta?.source === 'goal-round') return
          if (cancelled) {
            // The user stopped this turn: disarm the goal and skip auto-continue scheduling (fix: previously cancelled was dropped,
            // so a wasted auto turn ran immediately after stop; the goal stays active and is re-armed via resume when the user asks to continue)
            logger.info(
              '[Harness] Turn cancelled by user, goal disarmed, skipping automatic continuation'
            )
            goalStore.disarm(topicId)
            return
          }
          await goalRoundDriver.maybeDrive(topicId, (p) =>
            launchTurn(
              event,
              p.question,
              { ...options, topicId: p.topicId, turnMeta: p.turnMeta },
              trackTurn
            )
          )
          // Handle the queue only after all goal continuation ends: send queued messages one by one as new turns
          await drainPendingQueue(event, topicId, options, trackTurn)
        })
        .catch((err) => logger.error('[Harness] Error executing turn:', err))
      activeHarnessStreams.add(streamPromise)
      streamPromise.finally(() => activeHarnessStreams.delete(streamPromise))
      return { started: true }
    }
  )

  /**
   * Send while generating: if the current topic has a running turn → enqueue as an interjection; otherwise let the renderer send normally.
   *
   * This **deliberately does not start a turn itself** (the old implementation started one and the renderer also started one when it got queued=false,
   * so one message ran as two turns and two user rows appeared in the DB). The main process only decides queued or not.
   */
  handle(
    'harness-queue-enqueue',
    async (payload: {
      topicId: number
      text: string
      attachments?: QueueAttachments
    }): Promise<{ queued: boolean }> => {
      const { topicId, text } = payload
      const attachments = payload.attachments ?? {}
      if (!Number.isInteger(topicId) || topicId <= 0 || !text.trim()) {
        return { queued: false }
      }
      // Former event.sender.id (the queue is accounted per sending frame): the new contract uses the main window's webContents
      const sender = primarySender()
      if (!sender) return { queued: false }
      if (!harnessQueue.isTurnActive(topicId)) return { queued: false }
      harnessQueue.enqueue({ topicId, senderId: sender.id, text, attachments })
      return { queued: true }
    }
  )

  /** Queue query (fetch the current queue when a window/topic remounts) */
  handle('harness-queue-list', (topicId: number) => harnessQueue.view(topicId))

  /**
   * Current turn state of a topic (the renderer asks before sending).
   *
   * The main process is the single source of truth for whether a turn is running: the renderer's own loading state lags for turns such as
   * main-process continuation of a queued message or goal auto-continue, so using it would start a second turn concurrently.
   */
  handle('harness-turn-state', (topicId: number) => ({
    active: Number.isInteger(topicId) && harnessQueue.isTurnActive(topicId),
    turnId: Number.isInteger(topicId) ? harnessQueue.currentTurnId(topicId) : null
  }))

  /** Delete a queued message */
  handle('harness-queue-remove', (payload: { topicId: number; itemId: string }) => {
    return harnessQueue.remove(payload.topicId, payload.itemId)
  })

  /** Rewrite the text of a queued message */
  handle('harness-queue-update', (payload: { topicId: number; itemId: string; text: string }) => {
    if (!payload.text.trim()) return false
    return harnessQueue.update(payload.topicId, payload.itemId, payload.text)
  })

  /**
   * "Interject now": merge this queued message into the **running** turn.
   * This only moves it into the pending-injection buffer, persists it and sends an ack; the actual injection happens at the next tool node boundary
   * (see createInterjectionHandler in runtime/agent.ts).
   */
  handle(
    'harness-queue-steer',
    async (payload: { topicId: number; itemId: string }): Promise<{ accepted: boolean }> => {
      const { topicId, itemId } = payload
      const item = harnessQueue.steer(topicId, itemId)
      if (!item) return { accepted: false }
      // Pure injection: the entry enters the pending-injection buffer and is merged into the model context at the next tool node boundary;
      // it is not persisted and creates no dialogue content; entries that never reach a boundary this turn are returned to the queue by releaseHolds.
      logger.info(
        `[HarnessQueue] Queued message accepted for topic ${topicId} (waiting for injection at the next tool node boundary): ${item.text.slice(0, 40)}`
      )
      return { accepted: true }
    }
  )

  // Goal queries (the renderer loads goal state)
  handle('harness-goal-get', async (topicId: number) => {
    return await goalStore.load(topicId)
  })

  /**
   * Goal writes (manual entry points: input box / goal modal).
   *
   * Create, edit, pause, resume, complete and clear all go through the same GoalStore (shared state machine, single-goal semantics and CAS with the goal tools);
   * only the authority differs — UI actions are themselves direct human requests and do not go through the tool layer.
   * Failures do not throw; they return `{ ok:false, error }` for the renderer to display in its own language (same convention as workshop actions).
   */
  handle(
    'harness-goal-create',
    async (payload: { topicId: number; objective: string; maxGoalRounds?: number }) => {
      try {
        const objective = payload.objective?.trim() ?? ''
        if (!objective) return { ok: false, error: 'goal-objective-required' }
        const goal = await goalStore.create(payload.topicId, objective, payload.maxGoalRounds)
        return { ok: true, goal }
      } catch (err) {
        logger.warn('[Goal] Failed to create goal from the UI:', err)
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  handle(
    'harness-goal-update',
    async (payload: {
      topicId: number
      action: 'edit' | 'pause' | 'resume' | 'complete'
      objective?: string
      maxGoalRounds?: number
    }) => {
      try {
        const current = await goalStore.load(payload.topicId)
        if (!current) return { ok: false, error: 'goal-missing' }
        const goal = await goalStore.update(
          payload.topicId,
          current.id,
          current.revision,
          payload.action,
          { objective: payload.objective, maxGoalRounds: payload.maxGoalRounds }
        )
        return { ok: true, goal }
      } catch (err) {
        logger.warn('[Goal] Failed to update goal from the UI:', err)
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  handle('harness-goal-clear', async (topicId: number) => {
    try {
      await goalStore.delete(topicId)
      // GoalStore.delete only clears the cache and DB row (topic deletion uses it too): the UI goal bar is retracted by broadcast,
      // so add a null goal here to keep the banner from lingering above the input box after cleanup.
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed())
          safeSend(win.webContents, HARNESS_EVENTS.goalUpdated, { topicId, goal: null })
      }
      return { ok: true }
    } catch (err) {
      logger.warn('[Goal] Failed to clear goal from the UI:', err)
      return { ok: false, error: (err as Error).message }
    }
  })

  // Plan mode: read (backfilling the in-memory cache) / toggle (persist + broadcast)
  handle('harness-plan-get', async (topicId: number) => {
    const active = await planModeStore.ensure(topicId)
    return { topicId, active }
  })

  handle('harness-plan-set', async (payload: { topicId: number; active: boolean }) => {
    const active = await planModeStore.setActive(payload.topicId, payload.active)
    return { topicId: payload.topicId, active }
  })

  // Plan mode changed → broadcast to all windows (input badge refreshes live)
  scope.effect(() => {
    planModeStore.onChange = (topicId, active) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed())
          safeSend(win.webContents, HARNESS_EVENTS.planUpdated, { topicId, active })
      }
    }
    return () => {
      planModeStore.onChange = undefined
    }
  })

  // Agent Teams mode (opt-in, per topic): read (backfilling the in-memory cache) / toggle (persist + broadcast)
  handle('harness-team-mode-get', async (topicId: number) => {
    const enabled = await teamModeStore.ensure(topicId)
    return { topicId, enabled }
  })

  handle('harness-team-mode-set', async (payload: { topicId: number; enabled: boolean }) =>
    teamModeStore.setEnabled(payload.topicId, payload.enabled)
  )

  // Team mode changed → broadcast to all windows (sidebar menu checkbox / top bar hint refreshes live)
  scope.effect(() => {
    teamModeStore.onChange = (view) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) safeSend(win.webContents, HARNESS_EVENTS.teamModeUpdated, view)
      }
    }
    return () => {
      teamModeStore.onChange = undefined
    }
  })

  // Goal changed → broadcast to all windows (GoalBar refreshes live)
  scope.effect(() => {
    goalStore.onChange = (topicId, goal) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed())
          safeSend(win.webContents, HARNESS_EVENTS.goalUpdated, { topicId, goal })
      }
    }
    return () => {
      goalStore.onChange = undefined
    }
  })

  // Background task changed → broadcast to all windows (task status refreshes live)
  scope.effect(() => {
    jobsRegistry.onChange = (topicId, jobs) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed())
          safeSend(win.webContents, HARNESS_EVENTS.jobsUpdated, { topicId, jobs })
      }
    }
    return () => {
      jobsRegistry.onChange = undefined
    }
  })

  // Top bar background-tasks entry: list / manual stop / output snapshot (peek does not consume the model cursor)
  handle('harness-jobs-list', (topicId: number) => jobsRegistry.list(topicId))
  handle('harness-job-kill', (topicId: number, jobId: string) => {
    const result = jobsRegistry.kill(jobId, topicId)
    // undefined is ambiguous after IPC structured cloning, so normalize to null (the renderer checks for null)
    return { outcome: result.outcome, job: result.job ?? null }
  })
  handle('harness-job-output-peek', (topicId: number, jobId: string) =>
    jobsRegistry.peek(jobId, topicId)
  )

  // Background sub-agent session changed → broadcast (top bar agent list refreshes live)
  scope.effect(() => {
    subagentSessions.onChange = (topicId, rows) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed())
          safeSend(win.webContents, HARNESS_EVENTS.agentsUpdated, { topicId, rows })
      }
    }
    return () => {
      subagentSessions.onChange = undefined
    }
  })
  handle('harness-agents-list', (topicId: number) => subagentSessions.list(topicId))

  // Shared task board (Agent Teams / super agent): whole-board snapshot push + per-topic fetch.
  // The board is small (max 200 items per topic), so whole-board replacement is simpler and more reliable than a delta protocol; the renderer drops old revisions.
  scope.effect(() => {
    teamStore.onChange = (snapshot) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue
        safeSend(win.webContents, HARNESS_EVENTS.teamUpdated, snapshot)
      }
    }
    return () => {
      teamStore.onChange = undefined
    }
  })
  // Task board read: lazily load the persisted snapshot first (restores the first time the collaboration panel is opened or the tool is called after a restart)
  handle('harness-team-tasks', async (topicId: number) => {
    await teamStore.ensureLoaded(topicId)
    return teamStore.snapshot(topicId)
  })

  // Agent Teams recent activity (task event log; append-only, the panel footer shows the latest entry)
  handle('harness-team-events', async (topicId: number, limit = 20) => {
    const rows = await listTeamTaskEvents(topicId, limit)
    return rows.map((row) => ({
      id: row.id,
      taskId: row.task_id,
      action: row.action,
      actorId: row.actor_id,
      actorName: row.actor_name,
      subject: row.subject,
      taskRevision: row.task_revision,
      createdAt: row.created_at
    }))
  })

  // Sub-agent conversation view (2026-11-26): watch returns a snapshot immediately; afterwards event deltas are batched at 40ms and pushed,
  // and flushed immediately on turn_end so the in-progress → completed/failed flip is visible promptly.
  const AGENT_CONVERSATION_FLUSH_MS = 40
  const conversationWatchSet = new Set<string>()
  const conversationBuffers = new Map<string, SubagentConversationEvent[]>()
  const conversationTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const conversationKey = (topicId: number, agentId: string): string => `${topicId}:${agentId}`
  const flushAgentConversation = (topicId: number, agentId: string): void => {
    const key = conversationKey(topicId, agentId)
    const timer = conversationTimers.get(key)
    if (timer) {
      clearTimeout(timer)
      conversationTimers.delete(key)
    }
    const events = conversationBuffers.get(key)
    conversationBuffers.delete(key)
    if (!events || events.length === 0) return
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      safeSend(win.webContents, HARNESS_EVENTS.agentConversationUpdated, {
        topicId,
        agentId,
        events
      })
    }
  }
  scope.effect(() => {
    subagentSessions.onConversationEvent = (topicId, agentId, event) => {
      const key = conversationKey(topicId, agentId)
      if (!conversationWatchSet.has(key)) return
      let buffer = conversationBuffers.get(key)
      if (!buffer) {
        buffer = []
        conversationBuffers.set(key, buffer)
      }
      buffer.push(event)
      // Turn end is a state flip and must be delivered as soon as possible; other token-level events are batched at 40ms
      if (event.kind === 'turn_end') {
        flushAgentConversation(topicId, agentId)
        return
      }
      if (!conversationTimers.has(key)) {
        conversationTimers.set(
          key,
          setTimeout(() => flushAgentConversation(topicId, agentId), AGENT_CONVERSATION_FLUSH_MS)
        )
      }
    }
    return () => {
      subagentSessions.onConversationEvent = undefined
      for (const timer of conversationTimers.values()) clearTimeout(timer)
      conversationTimers.clear()
      conversationBuffers.clear()
      conversationWatchSet.clear()
    }
  })
  handle(
    'harness-agent-conversation',
    (topicId: number, agentId: string) =>
      subagentSessions.readConversation(agentId, topicId) ?? null
  )
  /** Page back in the conversation view: fetch the nearest complete turn before beforeSeq (called when scrolled to the top) */
  handle(
    'harness-agent-conversation-older',
    (topicId: number, agentId: string, beforeSeq: number, maxTurns?: number) =>
      subagentSessions.readOlderConversation(agentId, topicId, beforeSeq, maxTurns) ?? null
  )
  /**
   * Open/close the sub-agent conversation view:
   * - watch=true: register interest and **return a snapshot directly** (the renderer subscribes before invoking, so deltas
   *   before the snapshot are dropped by seq and no window of loss exists);
   * - watch=false: unsubscribe and drop unsent buffers (no more IPC after leaving the conversation view).
   */
  handle('harness-agent-conversation-watch', (topicId: number, agentId: string, watch: boolean) => {
    const key = conversationKey(topicId, agentId)
    if (watch) {
      conversationWatchSet.add(key)
      return subagentSessions.readConversation(agentId, topicId) ?? null
    }
    conversationWatchSet.delete(key)
    const timer = conversationTimers.get(key)
    if (timer) clearTimeout(timer)
    conversationTimers.delete(key)
    conversationBuffers.delete(key)
    return null
  })

  // Cleanup linkage: on topic delete / account switch the main process must not keep watch state
  // and batching timers for sessions that no longer exist (previously only cleaned on renderer unwatch, so refresh/topic delete left dangling entries).
  scope.effect(() => {
    const clearTopicWatches = (topicId: number): void => {
      const prefix = `${topicId}:`
      for (const key of [...conversationWatchSet]) {
        if (!key.startsWith(prefix)) continue
        conversationWatchSet.delete(key)
        const timer = conversationTimers.get(key)
        if (timer) clearTimeout(timer)
        conversationTimers.delete(key)
        conversationBuffers.delete(key)
      }
    }
    const clearAllWatches = (): void => {
      conversationWatchSet.clear()
      for (const timer of conversationTimers.values()) clearTimeout(timer)
      conversationTimers.clear()
      conversationBuffers.clear()
    }
    subagentSessions.onTopicCleared = clearTopicWatches
    subagentSessions.onAllCleared = clearAllWatches
    return () => {
      subagentSessions.onTopicCleared = undefined
      subagentSessions.onAllCleared = undefined
      clearAllWatches()
    }
  })

  /**
   * Deliver a message from the conversation view to a sub-agent (manual follow-up).
   *
   * Reuses the main agent's `send_message` registry.send: starts a new turn immediately when idle, enters the FIFO
   * inbox when running; delivery returns an ack without waiting for the sub-agent's reply (new-turn events go through the conversation channel).
   */
  handle(
    'harness-agent-prompt',
    async (payload: {
      topicId: number
      agentId: string
      message: string
    }): Promise<SubagentPromptResult> => {
      const topicId = typeof payload?.topicId === 'number' ? payload.topicId : -1
      const agentId = typeof payload?.agentId === 'string' ? payload.agentId : ''
      const text = typeof payload?.message === 'string' ? payload.message.trim() : ''
      if (!text) return { ok: false, error: 'empty message' }
      try {
        // An inactive session is cold-restored here (runtime recreated) and continues; failures return a readable error
        const { messageId } = await subagentSessions.send(agentId, topicId, text)
        return { ok: true, messageId }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
  /** Stop this sub-agent's current turn (keepInbox: messages queued but not started are kept so the conversation can continue) */
  handle('harness-agent-interrupt', (topicId: number, agentId: string) =>
    subagentSessions.interrupt(agentId, topicId)
  )

  /**
   * "Save to memory": instead of the renderer truncating the text and stuffing it into hot memory, this starts a background memory-curation
   * sub-agent — it reads this turn's Q&A, decides which facts are reusable and which layer they belong to (hot memory /
   * project docs / long-term memory space), then writes them with the mnemon_* tools.
   *
   * Progress and results reuse the top bar background-agent entry (subagentSessions changes broadcast harness-agents-updated);
   * this only completes the context (this turn's question + model guardrails) and hands the task off without waiting for it.
   */
  handle(
    'harness-memory-agent-start',
    async (payload: {
      topicId: number
      answer: string
      dialogueId?: number
      providerId?: number
    }): Promise<StartMemoryAgentResult> => {
      const harnessSettings = settingsStore.get('harness') as HarnessSettings | undefined

      // This turn's question: walk back from the dialogue row id to the latest user message to complete the curator agent's context
      // (if unavailable, curate the answer only; the main flow is unaffected)
      let question: string | undefined
      try {
        const rows = await getDialoguesByTopicId(payload.topicId)
        const at =
          payload.dialogueId != null ? rows.findIndex((row) => row.id === payload.dialogueId) : -1
        const before = at >= 0 ? rows.slice(0, at) : rows
        for (let i = before.length - 1; i >= 0; i -= 1) {
          if (before[i].role === 'user') {
            question = before[i].content
            break
          }
        }
      } catch (err) {
        logger.warn(
          '[Harness] Failed to read the question for this turn, memory consolidation will only include the answer:',
          err
        )
      }

      // Same tool-call round guardrail as the main turn (fall back to defaults in startMemoryAgent when unavailable)
      let maxToolRounds: number | undefined
      try {
        maxToolRounds = (await getProviderService().getConfig(undefined)).max_tool_rounds
      } catch (err) {
        logger.warn(
          '[Harness] Failed to read model max tool call rounds, memory consolidation will use the default:',
          err
        )
      }

      // "Save to memory" must also land in **this topic's own** memory scope (plugin topic → that plugin's memory)
      const memoryAgentScope = await resolveTurnMemoryScope(
        payload.topicId,
        undefined,
        harnessSettings?.activeWorkspaceId ?? 0
      )

      const result = await startMemoryAgent({
        topicId: payload.topicId,
        answer: payload.answer ?? '',
        question,
        workspaceId: harnessSettings?.activeWorkspaceId ?? 0,
        memoryPath: harnessSettings?.memoryPath || undefined,
        memoryScope: serializeMemoryScope(memoryAgentScope),
        // Prefer the provider of that reply itself (carried from the usage row by the frontend), falling back to the default provider
        providerId: payload.providerId,
        maxToolRounds
      })
      logger.info(
        `[Harness] Memory consolidation subagent: ${result.ok ? `${result.agentId} (${result.label})` : result.reason}`
      )
      return result
    }
  )

  // Real-time content of background sub-agent sessions goes through the conversation event stream channel (subagent-conversation);
  // the old plain-text output watch/throttle pipeline was removed (no consumers and duplicate of the conversation event stream).

  // Question system: new question → broadcast to all windows (frontend modal); answer/query go through the handler
  scope.effect(() => {
    questionService.onAsk = (pending) => {
      // Only send serializable views (topicId/requestId/questions are all plain JSON);
      // never send records containing resolve/reject/signal over IPC (Electron throws serialization errors)
      const payload = {
        topicId: pending.topicId,
        requestId: pending.requestId,
        questions: pending.questions
      }
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) safeSend(win.webContents, HARNESS_EVENTS.questionAsked, payload)
      }
      // At the moment of pending, tell the sidebar the topic is waiting: row indicator switches from in progress to the breathing yellow dot
      broadcastTopicPending(pending.topicId)
    }
    // Settled (user answered / turn aborted) → retract the yellow dot and return to in progress
    questionService.onResolved = broadcastTopicPending
    return () => {
      questionService.onAsk = undefined
      questionService.onResolved = undefined
    }
  })
  handle('harness-question-answer', (requestId: string, answers: unknown) => {
    return questionService.answer(
      requestId,
      (answers ?? []) as Array<{ id: string; selected: string[]; custom?: string }>
    )
  })
  handle('harness-question-get', (topicId: number) => {
    return questionService.getPending(topicId)
  })
  /**
   * User cancels the answer: **does not abort this turn**; settle as cancelled and let the model keep running.
   * (The old behavior was cancel = abort this turn; the user explicitly required on 2026-11-27 that cancel must not terminate the task.)
   */
  handle('harness-question-cancel', (requestId: string) => {
    return questionService.cancel(requestId)
  })

  // ── Sandbox approval (waiting for the user after a dangerous / out-of-bounds operation was blocked) ─────────
  // Unlike questions, approval affects only this one call and has no always-allow — persistent policy is handled by the tier.
  handle('harness-approval-decide', (requestId: string, decision: string) => {
    const allowed = permissionGate.decide(
      requestId,
      decision === 'allow-once' ? 'allow-once' : ('deny' as ApprovalDecision)
    )
    logger.info(
      `[Permission] Approval decision requestId=${requestId} decision=${decision} matched=${allowed}`
    )
    return allowed
  })
  // Fetch the currently pending approvals on topic switch / reload (the modal may have been opened from another view)
  handle('harness-approval-get', (topicId: number) => permissionGate.getPending(topicId))

  // ── Permission tiers (input box bottom-left picker + settings new-session default) ───────────────────
  handle('harness-permission-get', (topicId?: number) => permissionStateFor(topicId ?? null))
  // Sandbox backend status (for settings and diagnostics): commands are rejected when no backend is available, so the UI must surface it
  handle('harness-sandbox-status', () => {
    const status = sandboxService.status()
    return { ...status, ...sandboxService.describe() }
  })
  // Revoke the persistent ACE on a workspace (uninstall/cleanup entry; only meaningful for the Windows backend)
  handle('harness-sandbox-cleanup', (workspacePath: string) => {
    if (!workspacePath) return false
    return sandboxService.cleanupWorkspace({
      mode: 'workspace-write',
      workspaceRoot: workspacePath
    })
  })
  handle(
    'harness-permission-set',
    (payload: { topicId?: number; mode?: unknown; scope?: 'topic' | 'default' }) => {
      const mode = payload?.mode
      if (!isPermissionMode(mode)) {
        logger.warn(`[Permission] Rejected invalid permission mode: ${String(mode)}`)
        return permissionStateFor(payload?.topicId ?? null)
      }
      // scope='default' changes the default for topics created from now on; otherwise the current topic is changed
      if (payload?.scope === 'default') {
        setDefaultPermissionMode(mode)
      } else if (typeof payload.topicId === 'number' && payload.topicId > 0) {
        setTopicPermissionMode(payload.topicId, mode as PermissionMode)
      } else {
        setDefaultPermissionMode(mode)
      }
      const state = permissionStateFor(payload?.topicId ?? null)
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          safeSend(win.webContents, HARNESS_EVENTS.permissionUpdated, state)
        }
      }
      logger.info(`[Permission] Mode switched topic=${state.topicId} mode=${state.mode}`)
      return state
    }
  )

  // Cancel streaming output (also aborts pending questions)
  handle('harness-cancel-stream', () => {
    const sender = primarySender()
    if (!sender) return
    const controller = streamAbortControllers.get(sender.id)
    if (controller) {
      controller.abort()
      streamAbortControllers.delete(sender.id)
    }
    // The user pressed stop: abort only the current turn's injection buffer; **queued interjections are kept** —
    // those are messages the user explicitly wrote and that were not processed yet (after stop, the turn close-out continues them as new turns).
    const topicId = senderTopic.get(sender.id)
    if (topicId != null) {
      harnessQueue.dropInjections(topicId)
      broadcastQueue(topicId)
    }
    // Pending questions / approvals: **retract only this topic's own**.
    // Previously abortAll() was unconditional: pressing stop generating in topic B settled topic A's pending questions/approvals as denied
    // (user requirement 2026-09-28: they get occupied by other topics... it should be isolated per topic).
    // Only when the topic cannot be identified (should not happen) fall back to aborting everything — better over-abort than a call hanging forever.
    if (topicId != null) {
      questionService.abortTopic(topicId)
      permissionGate.abortTopic(topicId)
    } else {
      questionService.abortAll()
      permissionGate.abortAll()
    }
  })

  // Dialogue plan list (write_todos) changed → broadcast to the renderer (in-progress task card above the input box)
  scope.effect(() => {
    todoStore.onChange = (topicId, todos) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed())
          safeSend(win.webContents, HARNESS_EVENTS.todosUpdated, { topicId, todos })
      }
    }
    return () => {
      todoStore.onChange = undefined
    }
  })

  // Read the current topic's plan list: the card actively fetches it every time it remounts (page/topic switch);
  // relying on write broadcasts alone would leave the card empty after switching away and back until the model writes the list again
  handle('harness-todos-get', async (topicId: number) => todoStore.get(topicId))

  // Choose the memory storage directory
  handle('harness-select-memory-directory', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: mainMessages().dialog.selectMemoryDir
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // Choose the skills storage directory
  handle('harness-select-skills-directory', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: mainMessages().dialog.selectSkillsDir
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // Choose the AI workspace directory (FilesystemBackend mount root)
  handle('harness-select-workspace', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: mainMessages().dialog.selectWorkspaceDir
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const picked = result.filePaths[0]
    // Register personally picked by the user: workspace-create / system-settings-update accept only such directories,
    // so the renderer cannot inject an arbitrary drive as the workspace root (security audit S03).
    rememberSelectedRoot(picked)
    return picked
  })

  // ── Tool list (settings → Agent page tool dropdown) ─────────────────────────────
  // The list is fetched on every request (local tools + current contributions from each plugin), so enabling/disabling a plugin shows up immediately in settings;
  // label/description are **UI metadata**, overwritten to the current UI language before sending.
  // ── Sidebar search: hybrid topic title + message body search of the current workspace (read-only) ─────────
  // Sidebar search previously filtered only loaded topic titles in the renderer; body search was only available to model tools.
  // This gives the user side a read-only entry point: title hits + body hits (with keyword snippets) returned together,
  // isolated per workspace, on the same data as the session_search tool (mapper.searchDialogues).
  handle(
    'harness-search-workspace',
    async (payload: { query?: unknown; workspaceId?: unknown; limit?: unknown }) => {
      const query = typeof payload?.query === 'string' ? payload.query.trim() : ''
      const requested = Number(payload?.workspaceId)
      const harnessSettings = settingsStore.get('harness') as HarnessSettings | undefined
      const workspaceId =
        Number.isFinite(requested) && requested > 0
          ? Math.floor(requested)
          : (harnessSettings?.activeWorkspaceId ?? 0)
      const empty = { workspaceId, query, topics: [], hits: [] }
      if (!query || !workspaceId) return empty
      const limit = Math.max(1, Math.min(30, Math.floor(Number(payload?.limit) || 12)))
      try {
        const [topics, rows] = await Promise.all([
          getAllTopics(workspaceId),
          searchDialogues(workspaceId, query, limit)
        ])
        const needle = query.toLowerCase()
        return {
          workspaceId,
          query,
          topics: topics
            .filter((topic) => (topic.title ?? '').toLowerCase().includes(needle))
            .slice(0, 8)
            .map((topic) => ({
              id: topic.id,
              title: topic.title ?? '',
              updatedAt: topic.updated_at ?? null,
              archived: Boolean(topic.archived_at),
              pinned: Boolean(topic.pinned_at)
            })),
          hits: rows.map((row) => ({
            dialogueId: row.id,
            topicId: row.topic_id,
            topicTitle: row.topic_title ?? '',
            role: row.role,
            snippet: buildSnippet(row.content, query),
            createdAt: row.created_at ?? null
          }))
        }
      } catch (error) {
        logger.warn('[Harness] Workspace search failed:', error)
        return empty
      }
    }
  )

  // ── Session-level runtime selection (tools/skills/MCP pickers below the input box) ──────────────────
  handle('harness-topic-agent-selection-get', async (payload: { topicId: number }) => {
    const topicId = Number(payload?.topicId)
    if (!Number.isFinite(topicId) || topicId <= 0) return null
    try {
      return await getTopicAgentSelection(topicId)
    } catch (err) {
      logger.warn('[Harness] Failed to read topic agent selection:', err)
      return null
    }
  })

  handle(
    'harness-topic-agent-selection-set',
    async (payload: { topicId: number; selection: unknown }) => {
      const topicId = Number(payload?.topicId)
      if (!Number.isFinite(topicId) || topicId <= 0) {
        return { ok: false, error: 'invalid-input' }
      }
      try {
        const selection = normalizeAgentSelection(payload?.selection)
        if (!selection) return { ok: false, error: 'invalid-input' }
        await setTopicAgentSelection(topicId, selection)
        return { ok: true, selection }
      } catch (err) {
        logger.warn('[Harness] Failed to save topic agent selection:', err)
        return { ok: false, error: 'save-failed' }
      }
    }
  )

  handle('harness-get-tools', async () => {
    const dict: Record<string, { label: string; description: string }> = mainMessages().tools
    return listAvailableTools().map((tool: ToolInfo) => {
      const text = dict[tool.name]
      return text ? { ...tool, label: text.label, description: text.description } : tool
    })
  })

  // ── On-demand tool result reads (built-in tool results are no longer streamed/persisted with the turn) ─────────────────────
  // Tool cards in chat carry only metadata; full results are fetched by (topicId, callId) when the user expands them.
  // A miss (details never saved / already cleaned up) returns null and the UI shows details unavailable instead of a blank.
  handle('harness-tool-output-get', (topicId: number, callId: string) => {
    try {
      return getToolOutputStore()?.read(topicId, callId) ?? null
    } catch (err) {
      logger.error('Error in harness-tool-output-get:', err)
      return null
    }
  })

  // Open a workspace file with a **system app** (deliverables / run artifacts): the menu lists the
  // system default plus (Windows) the apps registered for that extension, with real icons.
  // The virtual path is resolved through the same mounts as the fs tools, so a renderer cannot ask
  // the OS to open an arbitrary path.
  handle('harness-file-open-targets', async (virtualPath: string, scope?: string | null) => {
    try {
      const roots = virtualFileRoots(scope)
      const resolved = resolveVirtualFilePath(roots, virtualPath)
      if ('error' in resolved) return { targets: [], error: resolved.error }
      const targets = await listFileOpenTargets(resolved.realPath)
      return { targets }
    } catch (err) {
      logger.error('Error in harness-file-open-targets:', err)
      return { targets: [], error: (err as Error).message }
    }
  })

  handle(
    'harness-file-open-with',
    async (virtualPath: string, targetId: string, scope?: string | null) => {
      try {
        const roots = virtualFileRoots(scope)
        const resolved = resolveVirtualFilePath(roots, virtualPath)
        if ('error' in resolved) return { ok: false, error: resolved.error }
        const result = await openFileWithTarget(resolved.realPath, String(targetId))
        if (result.ok) logger.info(`[FileOpen] Opened ${resolved.realPath} with "${targetId}"`)
        return result
      } catch (err) {
        logger.error('Error in harness-file-open-with:', err)
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  // Read a text file by virtual path (for the tool card open-file action):
  // unlike workspace-read-file, this resolves by mount (workspace + memory directory),
  // and the boundary remains: the path must be inside some mounted root directory.
  //
  // The second parameter is **the current topic's memory scope** (`plugin:<id>`, supplied by the renderer from the scope store):
  // the memory mount root is the scope directory (`<memoryPath>/plugin-<id>/`), the same convention as the Runtime's /memories/ —
  // without scope resolution, opening `/memories/...` in a plugin topic would look in the workspace copy (and find nothing).
  handle('harness-vfs-read', (virtualPath: string, scope?: string | null) => {
    try {
      const harnessSettings = settingsStore.get('harness') as HarnessSettings | undefined
      return readVirtualTextFile(
        {
          workspacePath: harnessSettings?.workspacePath || undefined,
          memoryPath:
            memoryScopeRoot(
              harnessSettings?.memoryPath || undefined,
              parseMemoryScope(scope, harnessSettings?.activeWorkspaceId ?? 0)
            ) ??
            (harnessSettings?.memoryPath || undefined)
        },
        virtualPath
      )
    } catch (err) {
      logger.error('Error in harness-vfs-read:', err)
      return { error: (err as Error).message }
    }
  })

  /**
   * Skill root usability check: throw when missing / not a directory / unreadable, so the renderer shows
   * failed to read instead of no skills found — the latter makes people think the directory is empty.
   *
   * Exception: a **missing** directory (ENOENT) is treated as an empty skill directory and does not throw. Typical case:
   * the packaged default path lands in the install directory (e.g. `D:\Program Files\RytenBench\data\skills`),
   * and the directory disappears after the app is moved/uninstalled or the install directory becomes read-only; the settings page then reports
   * `ENOENT: no such file or directory, stat …` on the Agent page and blocks the user out of the page;
   * this now returns an empty list, and the user can still change to a usable directory in settings.
   */
  const assertSkillsRootReadable = (skillsPath: string): void => {
    try {
      const stat = fs.statSync(skillsPath)
      if (!stat.isDirectory()) throw new Error('skills path is not a directory')
      fs.accessSync(skillsPath, fs.constants.R_OK | fs.constants.X_OK)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        logger.warn(`[Skills] Skills directory does not exist, treating as empty: ${skillsPath}`)
        return
      }
      throw error
    }
  }

  /**
   * Skill directory scan (main process): only confirms SKILL.md is a readable **regular file**; does not read its content.
   *
   * Two boundaries to block:
   * - `SKILL.md` is a directory with the same name: `accessSync(R_OK)` succeeds for directories too, but a later `readFileSync` will
   *   fail with EISDIR, so the skill would never open;
   * - `SKILL.md` is a symlink: reads and writes go through to outside the skills root, bypassing the only-operate-on-scan-results
   *   path guard. Here `lstat` rejects links and `stat` confirms a regular file.
   */
  const isRegularSkillFile = (skillsPath: string, dirName: string): boolean => {
    try {
      const file = join(skillsPath, dirName, 'SKILL.md')
      if (fs.lstatSync(file).isSymbolicLink()) return false
      return fs.statSync(file).isFile()
    } catch {
      return false
    }
  }

  const listSkillDirNames = (skillsPath: string): string[] => {
    try {
      return (
        fs
          .readdirSync(skillsPath, { withFileTypes: true })
          // withFileTypes is based on lstat: a directory symlink itself will not match isDirectory (inconsistent support)
          .filter((entry) => entry.isDirectory())
          .filter((entry) => isRegularSkillFile(skillsPath, entry.name))
          .map((entry) => entry.name)
      )
    } catch (error) {
      logger.error('Error scanning skills dir:', error)
      return []
    }
  }

  /**
   * Decode SKILL.md: UTF-8 only.
   *
   * - UTF-8 BOM (EF BB BF): stripped; editing/saving always writes back as UTF-8 without BOM, avoiding the first character
   *   becoming an invisible U+FEFF that breaks frontmatter matching (the list title degrades to the directory name, the preview shows frontmatter
   *   as body text);
   * - UTF-16 / invalid UTF-8: `toString('utf8')` produces U+FFFD, and writing it back would permanently replace the original characters
   *   with replacement characters. Return null here and let the caller report unreadable / unsupported encoding — never corrupt silently.
   */
  const decodeSkillText = (buffer: Buffer): string | null => {
    if (buffer.length >= 2) {
      const b0 = buffer[0]
      const b1 = buffer[1]
      if ((b0 === 0xff && b1 === 0xfe) || (b0 === 0xfe && b1 === 0xff)) return null
    }
    let start = 0
    if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
      start = 3
    }
    const text = buffer.subarray(start).toString('utf8')
    return text.includes('\uFFFD') ? null : text
  }

  /** frontmatter stripping (for get-skill preview; consistent with skills-core's body convention) */
  const stripSkillFrontmatter = (raw: string): string =>
    raw.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n)?/, '')

  /** Read a single skill's metadata (front matter name / description) */
  const readSkillMeta = (
    skillsPath: string,
    dirName: string
  ): { id: string; name: string; description: string } => {
    let name = dirName
    let description = ''
    try {
      const raw = decodeSkillText(fs.readFileSync(join(skillsPath, dirName, 'SKILL.md')))
      const fm = raw?.match(/^---\s*\n([\s\S]*?)\n---/)
      if (fm) {
        const n = fm[1].match(/^name:\s*(.+)$/m)
        const d = fm[1].match(/^description:\s*(.+)$/m)
        if (n) name = n[1].trim()
        if (d) description = d[1].trim()
      }
    } catch {
      // Fall back to a default name when unreadable
    }
    return { id: dirName, name, description }
  }

  // List all skills in the skills directory (for the skills page / picker; small data volume)
  handle('harness-list-skills', async () => {
    const skillsPath = (settingsStore.get('harness') as HarnessSettings | undefined)?.skillsPath
    if (!skillsPath) return []
    // Throw when the directory itself is unreadable (rather than returning an empty list and showing no skills)
    assertSkillsRootReadable(skillsPath)
    return listSkillDirNames(skillsPath).map((dirName) => readSkillMeta(skillsPath, dirName))
  })

  /**
   * Read a single skill (open a card in the skills page for viewing / editing).
   *
   * Accepts only ids from directory scan results: this blocks path traversal such as `../` and prevents reading arbitrary files
   * outside the directory to the renderer. Returns two bodies:
   * - `content`: body with frontmatter stripped, for the Markdown preview;
   * - `raw`: original SKILL.md (with frontmatter, UTF-8 BOM stripped), for saving back from edit.
   */
  handle('harness-get-skill', async (skillId: string) => {
    const skillsPath = (settingsStore.get('harness') as HarnessSettings | undefined)?.skillsPath
    if (!skillsPath || typeof skillId !== 'string' || !skillId) return null
    if (!listSkillDirNames(skillsPath).includes(skillId)) return null
    try {
      const raw = decodeSkillText(fs.readFileSync(join(skillsPath, skillId, 'SKILL.md')))
      if (raw === null) {
        logger.warn(`[Skills] Unsupported encoding for skill "${skillId}"; refusing to edit it`)
        return null
      }
      return { ...readSkillMeta(skillsPath, skillId), content: stripSkillFrontmatter(raw), raw }
    } catch (error) {
      logger.warn('[Skills] Failed to read skill content:', error)
      return null
    }
  })

  /**
   * Save the original skill text (skills page edit). The complete SKILL.md is written, so name / description
   * in the frontmatter can be changed too; after saving the renderer refetches the list and card titles update accordingly.
   *
   * Writes use temp file + rename: `writeFileSync` truncates the target first, and an error midway would leave a
   * half-written SKILL.md; rename is atomic within the same directory. The result is always UTF-8 (no BOM).
   */
  handle('harness-save-skill', async (skillId: string, content: string) => {
    const skillsPath = (settingsStore.get('harness') as HarnessSettings | undefined)?.skillsPath
    if (!skillsPath || typeof skillId !== 'string' || !skillId) return false
    if (typeof content !== 'string' || content.trim().length === 0) return false
    // A replacement character means the content was decoded with the wrong encoding earlier; writing it back would permanently corrupt it: reject and let the user reopen
    if (content.includes('\uFFFD')) {
      logger.warn(`[Skills] Refusing to save skill "${skillId}": content contains U+FFFD`)
      return false
    }
    if (!listSkillDirNames(skillsPath).includes(skillId)) return false
    const target = join(skillsPath, skillId, 'SKILL.md')
    const temp = `${target}.saving-${process.pid}`
    try {
      fs.writeFileSync(temp, content, 'utf-8')
      fs.renameSync(temp, target)
      return true
    } catch (error) {
      try {
        fs.rmSync(temp, { force: true })
      } catch {
        // Cleanup failures do not affect the return value
      }
      logger.error('[Skills] Failed to save skill content:', error)
      return false
    }
  })

  /**
   * Delete a skill directory (skills page delete). Only deletes skill directories that exist in scan results; never accepts arbitrary paths.
   * The renderer asks for a second confirmation before deleting; this is only the final gate.
   */
  handle('harness-delete-skill', async (skillId: string) => {
    const skillsPath = (settingsStore.get('harness') as HarnessSettings | undefined)?.skillsPath
    if (!skillsPath || typeof skillId !== 'string' || !skillId) return false
    if (!listSkillDirNames(skillsPath).includes(skillId)) return false
    try {
      fs.rmSync(join(skillsPath, skillId), { recursive: true, force: true })
      return true
    } catch (error) {
      logger.error('[Skills] Failed to delete skill:', error)
      return false
    }
  })

  /**
   * Skill enable/disable: decided in the main process.
   *
   * Enable all is represented by `enabledSkills: undefined` in the config; disabling one skill requires expanding it into a full list,
   * and only the main process knows the complete skill directory — doing it in the renderer would rely on the frontend having loaded all skills,
   * which breaks when there are many directories or pagination changes.
   */
  handle('harness-set-skill-enabled', async (skillId: string, enabled: boolean) => {
    const harness = (settingsStore.get('harness') as HarnessSettings | undefined) ?? {}
    const skillsPath = harness.skillsPath
    const current = harness.enabledSkills
    let next: string[] | undefined
    if (enabled) {
      // No list = all enabled, nothing to write
      next = current ? (current.includes(skillId) ? current : [...current, skillId]) : undefined
    } else {
      const base = current ?? (skillsPath ? listSkillDirNames(skillsPath) : [])
      next = base.filter((id) => id !== skillId)
    }
    settingsStore.set('harness', { ...harness, enabledSkills: next })
    return next
  })

  /** Target config submitted by the scheduled task page (fixed topic or new topic per run) */
  interface ScheduleTargetPayload {
    topicId?: number | null
    targetMode?: unknown
    targetWorkspaceId?: number | null
    targetMemoryScope?: unknown
  }

  /**
   * Validate and resolve the task target: fixed-topic tasks resolve the workspace from the topic; new-topic tasks require mode and workspace to match.
   *
   * Returns null for invalid input (the handler replies invalid-input).
   */
  async function resolveScheduleTargetPayload(payload: ScheduleTargetPayload): Promise<{
    topicId: number | null
    workspaceId: number | null
    targetMode: 'chat' | 'work' | 'plugin' | null
    targetWorkspaceId: number | null
    targetMemoryScope: string | null
  } | null> {
    const topicId =
      typeof payload.topicId === 'number' && Number.isFinite(payload.topicId) && payload.topicId > 0
        ? payload.topicId
        : null
    const mode =
      payload.targetMode === 'chat' ||
      payload.targetMode === 'work' ||
      payload.targetMode === 'plugin'
        ? payload.targetMode
        : null
    if (topicId != null) {
      const rows = await getTopicById(topicId).catch(() => [])
      const topic = rows[0]
      if (!topic) return null
      return {
        topicId,
        workspaceId: topic.workspace_id ?? null,
        targetMode: mode,
        targetWorkspaceId: topic.workspace_id ?? null,
        targetMemoryScope: null
      }
    }
    // New-topic type: mode and workspace must match; plugin mode must also carry a plugin:<id> scope
    const workspaceId =
      typeof payload.targetWorkspaceId === 'number' &&
      Number.isFinite(payload.targetWorkspaceId) &&
      payload.targetWorkspaceId > 0
        ? payload.targetWorkspaceId
        : null
    if (!mode || !workspaceId) return null
    const workspace = await getWorkspaceById(workspaceId).catch(() => null)
    if (!workspace) return null
    const kind = workspace.kind ?? 'user'
    if (mode === 'chat' && kind !== 'chat') return null
    if (mode === 'plugin' && kind !== 'plugin') return null
    if (mode === 'work' && kind !== 'user') return null
    const scope = normalizeMemoryScope(payload.targetMemoryScope)
    if (mode === 'chat' && scope !== 'chat') return null
    if (mode === 'plugin' && !String(scope ?? '').startsWith('plugin:')) return null
    if (mode === 'work' && scope !== null) return null
    return {
      topicId: null,
      workspaceId: null,
      targetMode: mode,
      targetWorkspaceId: workspaceId,
      targetMemoryScope: scope
    }
  }

  // ── Scheduled task management (sidebar → Scheduled tasks page) ─────────────
  // List / create / full edit / pause-resume-delete / execution records.
  // The `schedule_*` model tools and the page share the same storage backend.

  /**
   * Page input → stored model override: undefined/null/empty = the default model, otherwise the
   * value must be one of the currently enabled `provider:model` routes (same catalog as
   * list_capabilities kind:"models"). Rejecting an unknown route keeps "what the page shows" and
   * "what actually runs" identical.
   */
  async function normalizeScheduleModelInput(
    raw: unknown
  ): Promise<{ ok: true; value: string | null } | { ok: false }> {
    if (raw === undefined || raw === null) return { ok: true, value: null }
    if (typeof raw !== 'string') return { ok: false }
    const value = raw.trim()
    if (!value) return { ok: true, value: null }
    const models = await modelSelectionValues()
    return models.has(value) ? { ok: true, value } : { ok: false }
  }
  handle('harness-schedule-list', async () => {
    if (!isScheduleStoreConfigured()) return []
    try {
      return await scheduleStore.list()
    } catch (err) {
      logger.warn('[Schedule] Failed to list tasks:', err)
      return []
    }
  })

  /** Create from the page: target (fixed/new topic) + title + prompt + rule + task-level selection */
  handle(
    'harness-schedule-create',
    async (
      payload: {
        title: string
        prompt: string
        when: unknown
        agentConfig?: unknown
        model?: unknown
      } & ScheduleTargetPayload
    ) => {
      if (!isScheduleStoreConfigured()) return { ok: false, error: 'unavailable' }
      const title = typeof payload?.title === 'string' ? payload.title.trim() : ''
      const prompt = typeof payload?.prompt === 'string' ? payload.prompt.trim() : ''
      if (!title || !prompt) return { ok: false, error: 'invalid-input' }
      const target = await resolveScheduleTargetPayload(payload ?? {})
      if (!target) return { ok: false, error: 'invalid-target' }
      const validated = validateScheduleWhen(payload.when as ScheduleWhen)
      if (!validated.ok) return { ok: false, error: `invalid-when:${validated.reason}` }
      const model = await normalizeScheduleModelInput(payload.model)
      if (!model.ok) return { ok: false, error: 'invalid-model' }
      try {
        const task = await scheduleStore.create({
          title,
          prompt,
          when: payload.when as ScheduleWhen,
          topicId: target.topicId,
          workspaceId: target.workspaceId,
          targetMode: target.targetMode,
          targetWorkspaceId: target.targetWorkspaceId,
          targetMemoryScope: target.targetMemoryScope,
          agentConfig: normalizeAgentSelection(payload.agentConfig),
          model: model.value,
          nextRunAt: validated.nextRunAt
        })
        return { ok: true, task }
      } catch (err) {
        logger.warn('[Schedule] Failed to create task:', err)
        return { ok: false, error: 'create-failed' }
      }
    }
  )

  /** Full edit from the page: title / prompt / rule / enabled state (recompute the next trigger when the rule changes) */
  handle(
    'harness-schedule-update-full',
    async (
      payload: {
        id: string
        title?: string
        prompt?: string
        when?: unknown
        enabled?: boolean
        agentConfig?: unknown
        model?: unknown
      } & ScheduleTargetPayload
    ) => {
      if (!isScheduleStoreConfigured()) return { ok: false, error: 'unavailable' }
      const id = typeof payload?.id === 'string' ? payload.id : ''
      if (!id) return { ok: false, error: 'invalid-input' }
      const model = await normalizeScheduleModelInput(payload.model)
      if (!model.ok) return { ok: false, error: 'invalid-model' }
      try {
        const task = await scheduleStore.get(id)
        if (!task) return { ok: false, error: 'not-found' }
        const patch: {
          title?: string
          prompt?: string
          when?: ScheduleWhen
          enabled?: boolean
          nextRunAt?: string | null
          topicId?: number | null
          targetMode?: 'chat' | 'work' | 'plugin' | null
          targetWorkspaceId?: number | null
          targetMemoryScope?: string | null
          agentConfig?: ReturnType<typeof normalizeAgentSelection>
          model?: string | null
          workspaceId?: number | null
        } = {}
        const wantsTargetChange =
          payload.topicId !== undefined ||
          payload.targetMode !== undefined ||
          payload.targetWorkspaceId !== undefined ||
          payload.targetMemoryScope !== undefined
        if (wantsTargetChange) {
          const target = await resolveScheduleTargetPayload(payload ?? {})
          if (!target) return { ok: false, error: 'invalid-target' }
          patch.topicId = target.topicId
          patch.targetMode = target.targetMode
          patch.targetWorkspaceId = target.targetWorkspaceId
          patch.targetMemoryScope = target.targetMemoryScope
          patch.workspaceId = target.workspaceId
        }
        if (payload.agentConfig !== undefined) {
          patch.agentConfig = normalizeAgentSelection(payload.agentConfig)
        }
        // undefined = keep the current override; null / "" = clear it and use the default model
        if (payload.model !== undefined) {
          patch.model = model.value
        }
        if (typeof payload.title === 'string' && payload.title.trim()) {
          patch.title = payload.title.trim()
        }
        if (typeof payload.prompt === 'string' && payload.prompt.trim()) {
          patch.prompt = payload.prompt.trim()
        }
        const nextWhen = payload.when !== undefined ? (payload.when as ScheduleWhen) : task.when
        if (payload.when !== undefined) {
          const validated = validateScheduleWhen(nextWhen)
          if (!validated.ok) return { ok: false, error: `invalid-when:${validated.reason}` }
          patch.when = nextWhen
          patch.nextRunAt = validated.nextRunAt
          patch.enabled = true
        }
        if (payload.enabled === false) {
          patch.enabled = false
          patch.nextRunAt = null
        } else if (payload.enabled === true) {
          const validated = validateScheduleWhen(nextWhen)
          if (!validated.ok) return { ok: false, error: `invalid-when:${validated.reason}` }
          patch.enabled = true
          patch.nextRunAt = validated.nextRunAt
        }
        const updated = await scheduleStore.update(id, patch)
        return updated ? { ok: true, task: updated } : { ok: false, error: 'not-found' }
      } catch (err) {
        logger.warn('[Schedule] Failed to update task:', err)
        return { ok: false, error: 'update-failed' }
      }
    }
  )

  /** Execution records (kept forever, reverse-chronological pages) */
  handle(
    'harness-schedule-runs',
    async (payload: { id: string; limit?: number; offset?: number }) => {
      if (!isScheduleStoreConfigured()) return { runs: [], total: 0 }
      const id = typeof payload?.id === 'string' ? payload.id : ''
      if (!id) return { runs: [], total: 0 }
      try {
        const limit = typeof payload.limit === 'number' ? payload.limit : 20
        const offset = typeof payload.offset === 'number' ? payload.offset : 0
        const [runs, total] = await Promise.all([
          scheduleStore.listRuns(id, limit, offset),
          scheduleStore.countRuns(id)
        ])
        return { runs, total }
      } catch (err) {
        logger.warn('[Schedule] Failed to list runs:', err)
        return { runs: [], total: 0 }
      }
    }
  )

  /**
   * Re-run one execution record and overwrite that record's data (rows keep their id / time, so
   * nothing is appended). The turn runs through the same headless pipeline as a scheduled trigger;
   * the schedule itself is not shifted by a manual re-run.
   */
  handle('harness-schedule-rerun', async (payload: { taskId: string; runId: number }) => {
    if (!isScheduleStoreConfigured()) return { ok: false, error: 'unavailable' }
    const taskId = typeof payload?.taskId === 'string' ? payload.taskId : ''
    const runId = Number(payload?.runId)
    if (!taskId || !Number.isInteger(runId) || runId <= 0) {
      return { ok: false, error: 'invalid-input' }
    }
    try {
      return await scheduleRunner.rerun(taskId, runId)
    } catch (err) {
      logger.warn('[Schedule] Failed to re-run record:', err)
      return { ok: false, error: 'rerun-failed' }
    }
  })

  handle(
    'harness-schedule-update',
    async (payload: { id: string; action: 'pause' | 'resume' | 'delete' }) => {
      if (!isScheduleStoreConfigured()) return { ok: false }
      try {
        if (payload.action === 'delete') {
          return { ok: await scheduleStore.remove(payload.id) }
        }
        if (payload.action === 'pause') {
          return {
            ok: Boolean(await scheduleStore.update(payload.id, { enabled: false, nextRunAt: null }))
          }
        }
        const task = await scheduleStore.get(payload.id)
        if (!task) return { ok: false }
        const validated = validateScheduleWhen(task.when)
        if (!validated.ok) return { ok: false }
        return {
          ok: Boolean(
            await scheduleStore.update(payload.id, {
              enabled: true,
              nextRunAt: validated.nextRunAt
            })
          )
        }
      } catch (err) {
        logger.warn('[Schedule] Failed to update task:', err)
        return { ok: false }
      }
    }
  )

  // ── Web search settings (settings → Web search page) ─────────────────────────
  handle('harness-search-settings-get', async () => {
    try {
      return await getSearchSettingsView()
    } catch (err) {
      logger.warn('[Search] Failed to read search settings:', err)
      return null
    }
  })

  handle(
    'harness-search-provider-save-key',
    async (payload: { provider: string; apiKey: string }) => {
      try {
        return await saveSearchProviderKey(payload?.provider, payload?.apiKey)
      } catch (err) {
        logger.warn('[Search] Failed to save search key:', err)
        return { ok: false, error: 'save-failed' }
      }
    }
  )

  handle('harness-search-provider-clear-key', async (payload: { provider: string }) => {
    try {
      return await clearSearchProviderKey(payload?.provider)
    } catch (err) {
      logger.warn('[Search] Failed to clear search key:', err)
      return { ok: false, error: 'save-failed' }
    }
  })

  handle('harness-search-default-set', async (payload: { provider: string }) => {
    try {
      return await setSearchDefaultProvider(payload?.provider)
    } catch (err) {
      logger.warn('[Search] Failed to change default provider:', err)
      return { ok: false, error: 'save-failed' }
    }
  })

  handle(
    'harness-search-behavior-set',
    async (payload: { autoFallback?: boolean; includeContent?: boolean }) => {
      try {
        await setSearchBehaviors(payload ?? {})
        return { ok: true }
      } catch (err) {
        logger.warn('[Search] Failed to update behaviors:', err)
        return { ok: false }
      }
    }
  )

  handle('harness-search-provider-test', async (payload: { provider: string }) => {
    const id = asSearchProviderId(payload?.provider)
    if (!id) return { ok: false, provider: payload?.provider ?? '', elapsedMs: 0, itemCount: 0 }
    try {
      return await testSearchProvider(id)
    } catch (err) {
      logger.warn('[Search] Provider test failed:', err)
      return { ok: false, provider: id, elapsedMs: 0, itemCount: 0, code: 'provider-error' }
    }
  })

  // Scheduled task execution entry: the runner only signals when due; actually starting the turn still goes through runHarnessTurn
  scheduleRunner.configureQuestionBuilder((task) =>
    mainFormat(getScheduleToolTexts().question, { title: task.title, prompt: task.prompt })
  )
  scheduleRunner.configureDrive(({ task, question }) => runScheduledTurn(task, question))

  const unregister = registerIpcHandlers(handlers)
  return () => {
    scheduleRunner.configureDrive(undefined)
    scheduleRunner.configureQuestionBuilder(undefined)
    unregister()
  }
}
