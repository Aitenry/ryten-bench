import { BaseChatModel } from '../../ai/chat-model'
import { AIMessage, BaseMessage, HumanMessage } from '../../ai/messages'
import { GraphRecursionError } from '../../ai/graph'
import { tool, type StructuredToolInterface } from '../../ai/tools'
import { z } from 'zod'
import logger from 'electron-log'
import { randomUUID } from 'node:crypto'
import type {
  StructuredMessage,
  SubAgentConfig,
  SubAgentMainModelDescriptor
} from '../../services/harness/types'
import {
  produceMessages,
  produceSubAgents,
  produceToolCalls
} from '../../services/harness/stream-producers'
import {
  deleteSubagentSessionsByTopic,
  listSubagentSessions,
  upsertSubagentSession
} from '../../database/mapper/harness/subagent-session'
import { buildAgentGraph, pushMessageRecords, type QueueRef, type StreamMessageLike } from './agent'
import { jobsRegistry } from './jobs'
import { RecordQueue } from './graph'
import type { RuntimeStream } from './types'
import type { SpillStore } from './spill'
import { sumUsage, type ModelUsageRecord } from './usage'
import { mainFormat } from '../../i18n'
import { getAgentToolTexts } from '../../i18n/tool-results-agent'
import type {
  SubagentConversationEvent,
  SubagentConversationEventInput,
  SubagentConversationSnapshot,
  SubagentConversationHistory,
  SubagentTurnStatus
} from './subagent-conversation'

/**
 * Continuable subagent sessions.
 *
 * Mechanics (adapted to conversations organized by topicId):
 * - task(background=true) starts a "continuable" subagent session: persistent message
 *   history + an inbox queue that survives across main-agent turns;
 * - the session snapshot is persisted to the `subagent_session` table (event stream /
 *   message history / config snapshot / terminal state / model descriptor / usage): the
 *   history is still there after a restart, and restored sessions are marked `inactive`;
 *   the first continuation (UI input box / send_message) rebuilds model/tools/prompt from
 *   the snapshot (cold resume), then returns to idle with the normal inbox semantics;
 * - send_message delivers the next turn's message to the session: queued when running
 *   (FIFO inbox), wakes it when idle; it returns only a delivery confirmation
 *   {messageId} without waiting for the subagent reply (the parent observes through
 *   job_output/job_list);
 * - interrupt_agent cancels the current run (keepInbox semantics: queued messages are
 *   kept and can be resumed with send_message);
 * - list_agents lists all sessions and statuses (running = current turn in progress /
 *   idle = waiting / inactive = historical session recovered after a restart);
 * - every session run is registered as a background job with the same name (job id =
 *   session id), reusing job_output/job_kill;
 * - permissions: control tools are only injected into the main agent and can only operate
 *   on sessions of this topic (owners are isolated by topicId).
 */

/** Session status: running / idle are active in-process; inactive = historical session recovered from the database after a restart */
export type SubagentSessionStatus = 'running' | 'idle' | 'inactive'

/** Session status row (list_agents output) */
export interface SubagentSessionRow {
  id: string
  name: string
  label: string
  status: SubagentSessionStatus
  queuedMessages: number
  createdAt: number
  lastRunAt?: number
  /** Terminal state of the most recent run (top bar "in progress > completed/failed/stopped") */
  lastStatus?: 'completed' | 'failed' | 'killed'
  /** Cumulative real token usage for the session (sum of usage_metadata across all turns; 0 = not collected) */
  totalTokens: number
  /** Whether real usage was ever collected (hidden when the model does not return usage) */
  hasUsage: boolean
}

/** Per-session event cap: when exceeded, drop the oldest events by whole turns (long sessions must not use unbounded memory, and snapshots must not grow without bound) */
const MAX_CONVERSATION_EVENTS = 4000

/** Treat a failed JSON column parse as missing (bad historical data must not fail the whole restore path) */
function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function parseJsonArray<T>(raw: string | null): T[] {
  const parsed = parseJson<unknown>(raw)
  return Array.isArray(parsed) ? (parsed as T[]) : []
}

interface SessionRecord {
  id: string
  topicId: number
  config: SubAgentConfig
  /** Main model descriptor at spawn time (used by cold resume; may be empty for older sessions) */
  mainModelDescriptor?: SubAgentMainModelDescriptor
  label: string
  /** Original task instruction at start (shown at the top of the dialog; later send turns are appended conversation) */
  prompt: string
  /** Session message history (systemPrompt is not stored in history; it is injected dynamically when entering the graph) */
  messages: BaseMessage[]
  /** Inbox queue (messages delivered while running are queued) */
  inbox: string[]
  status: SubagentSessionStatus
  createdAt: number
  lastRunAt?: number
  /** Terminal state of the most recent run (shown in the top-bar list as "in progress > completed/failed/stopped") */
  lastStatus?: 'completed' | 'failed' | 'killed'
  /** Cumulative real token usage (summed across turns; 0 = not collected for each field) */
  usageInputTokens: number
  usageOutputTokens: number
  usageTotalTokens: number
  usageCalls: number
  /** Final output of the most recent run (view the result after the terminal state) */
  lastOutput: string
  /** Incremental output of the current run (viewed live while running) */
  /** Cancel controller of the current run (used by interrupt) */
  currentAbort?: AbortController
  /** Set after the topic is deleted: delivery and inbox continuation are forbidden (prevents zombie sessions from continuing to execute) */
  dead?: boolean
  /** Turn number (turn_start event id / turn index in the session view) */
  turnCounter: number
  /** Session event-stream sequence (monotonically increasing cursor for incremental events) */
  conversationSeq: number
  /**
   * Session event stream (replayed in full when opening a subagent session; in-process,
   * isolated per topic, discarded on restart).
   *
   * Append-only: turn_start → chunk* → turn_end. The renderer replays it with the same
   * chunk reducer as the main conversation, producing the same streaming blocks.
   */
  conversation: SubagentConversationEvent[]
}

export type SubagentSessionsListener = (topicId: number, rows: SubagentSessionRow[]) => void

/** Session output update callback (the IPC layer throttles and pushes it to the frontend; output keeps appending incrementally) */

/**
 * Session event callback (consumed by the IPC layer, which throttles and pushes increment
 * events to the renderer process currently viewing this subagent).
 * Events already carry seq; events for unwatched sessions are dropped by the IPC layer at
 * no cost.
 */
export type SubagentConversationListener = (
  topicId: number,
  agentId: string,
  event: SubagentConversationEvent
) => void

/** Runtime context required to start a subagent session (reuses main runtime components) */
export interface SubagentSessionRuntime {
  mainModel: BaseChatModel
  /** Main model descriptor at spawn time (injected by the parent Runtime; used after background sessions are persisted) */
  mainModelDescriptor?: SubAgentMainModelDescriptor
  resolveModel: (spec: string | undefined) => Promise<BaseChatModel | undefined>
  buildTools: (subAgent: SubAgentConfig) => StructuredToolInterface[]
  recursionLimit: number
  /** Total tool call limit (model-level "tool call rounds"; shares the same model setting as the main graph) */
  maxToolCalls: number
  spillRef?: { current?: SpillStore }
  /** Subagent system prompt extension (dedicated memory/skills), from the same source as the task tool */
  extendSystemPrompt: (sa: SubAgentConfig) => string
}

/** Subagent continuable session registry (process-level singleton, isolated by topicId) */
/** Default turns per page in the session view: both first screen and backward loading are bounded by turn_start, avoiding one huge IPC for large-history sessions */
const CONVERSATION_PAGE_TURNS = 20

/** Take the last maxTurns complete turns (starting from turn_start); return whether older turns remain */
function sliceRecentConversationTurns(
  events: SubagentConversationEvent[],
  maxTurns = CONVERSATION_PAGE_TURNS
): { events: SubagentConversationEvent[]; hasOlder: boolean } {
  const starts: number[] = []
  events.forEach((event, index) => {
    if (event.kind === 'turn_start') starts.push(index)
  })
  if (starts.length <= maxTurns) return { events, hasOlder: false }
  return { events: events.slice(starts[starts.length - maxTurns]), hasOlder: true }
}

export class SubagentSessionRegistry {
  private readonly sessions = new Map<string, SessionRecord>()
  /** Whether historical sessions have been restored from the database yet (reset on account switch and re-restored after switching database) */
  private restored = false

  onChange?: SubagentSessionsListener
  /** Incremental output update (throttled IPC push; consumed only when some frontend watches the agent) */
  /** Incremental session events (throttled IPC push; only for frontends currently viewing this subagent session) */
  onConversationEvent?: SubagentConversationListener
  /** Notify upper layers to clean up per-topicId watches/timers when a topic is deleted or the account switches (used by the IPC layer) */
  onTopicCleared?: (topicId: number) => void
  onAllCleared?: () => void
  /**
   * Cold-resume runtime factory: a restored inactive session rebuilds its runtime from the
   * topic/config on the first send. Wired up at system startup (`system/harness.ts`); the
   * registry itself does not depend on model/settings modules.
   */
  private runtimeFactory?: (
    topicId: number,
    descriptor?: SubAgentMainModelDescriptor
  ) => Promise<SubagentSessionRuntime | undefined>

  /** Inject/remove the cold-resume runtime factory */
  setRuntimeFactory(
    factory?: (
      topicId: number,
      descriptor?: SubAgentMainModelDescriptor
    ) => Promise<SubagentSessionRuntime | undefined>
  ): void {
    this.runtimeFactory = factory
  }

  /** Start a new session (spawn semantics: fresh context); the first message starts running immediately */
  start(
    topicId: number,
    config: SubAgentConfig,
    firstMessage: string,
    rt: SubagentSessionRuntime
  ): SubagentSessionRow {
    const id = `subagent-${randomUUID()}`
    const displayName = config.rename && config.rename !== config.name ? config.rename : config.name
    const record: SessionRecord = {
      id,
      topicId,
      config,
      mainModelDescriptor: rt.mainModelDescriptor,
      label: mainFormat(getAgentToolTexts().subagentSessions.sessionLabel, {
        name: displayName,
        task: firstMessage.slice(0, 40)
      }),
      prompt: firstMessage,
      messages: [],
      inbox: [],
      // Initially idle: run() has a defensive guard that queues and returns when status is
      // running; if we set running here the first message would be swallowed back into the
      // inbox and the task would never be registered (the root cause of job_output saying
      // "task not found" and list_agents being stuck at running+queuedMessages=1). run() sets running uniformly.
      status: 'idle',
      usageInputTokens: 0,
      usageOutputTokens: 0,
      usageTotalTokens: 0,
      usageCalls: 0,
      createdAt: Date.now(),
      lastOutput: '',
      turnCounter: 0,
      conversationSeq: 0,
      conversation: []
    }
    this.sessions.set(id, record)
    // Persist a snapshot first: even if the first turn crashes/exits midway, the session is still visible after a restart (history read-only)
    this.persist(record)
    void this.run(record, firstMessage, rt)
    return this.row(record)
  }

  /** Deliver a message: run immediately when idle; enqueue when running (FIFO). Returns a delivery confirmation */
  async send(id: string, topicId: number, message: string): Promise<{ messageId: string }> {
    const messageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const record = this.sessions.get(id)
    if (!record || record.topicId !== topicId) {
      throw new Error(mainFormat(getAgentToolTexts().subagentSessions.notFound, { id }))
    }
    if (record.dead) {
      throw new Error(mainFormat(getAgentToolTexts().subagentSessions.deletedWithTopic, { id }))
    }
    // Cold resume: for an inactive session restored after a restart / an idle session with
    // no runtime, the first delivery rebuilds model/tools/prompt/runtime from the persisted
    // config, then switches to idle and continues with normal inbox semantics.
    let rt = this.lastRuntime(record)
    if (!rt) {
      if (!this.runtimeFactory) {
        throw new Error(
          mainFormat(getAgentToolTexts().subagentSessions.inactiveCannotResume, { id })
        )
      }
      rt = await this.runtimeFactory(record.topicId, record.mainModelDescriptor)
      if (!rt) {
        throw new Error(
          mainFormat(getAgentToolTexts().subagentSessions.inactiveCannotResume, { id })
        )
      }
      this.runtimes.set(record, rt)
      if (record.status === 'inactive') record.status = 'idle'
    }
    record.inbox.push(message)
    // The queued count must appear in the session view in real time: broadcast a row snapshot first when delivering while running
    this.broadcast(record.topicId)
    this.persist(record)
    if (record.status === 'idle') {
      const next = record.inbox.shift()!
      void this.run(record, next, rt)
    }
    return { messageId }
  }

  /** Cancel the current run (keepInbox: queued messages are kept). Absent/already idle = accepted no-op */
  interrupt(id: string, topicId: number): { accepted: boolean } {
    const record = this.sessions.get(id)
    if (!record || record.topicId !== topicId) return { accepted: true } // absent/finished = no-op
    if (record.status === 'running') {
      record.currentAbort?.abort()
    }
    return { accepted: true }
  }

  /** All session rows (in creation order) */
  list(topicId: number): SubagentSessionRow[] {
    return [...this.sessions.values()]
      .filter((s) => s.topicId === topicId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((s) => this.row(s))
  }

  /** Clean up when a topic is deleted (interrupt all sessions first, then set dead to stop in-flight closures from continuing the inbox) */
  clearTopic(topicId: number): void {
    for (const [id, record] of this.sessions) {
      if (record.topicId !== topicId) continue
      record.dead = true
      record.inbox.length = 0
      record.currentAbort?.abort()
      this.sessions.delete(id)
    }
    this.onTopicCleared?.(topicId)
    // Persisted snapshots are deleted with the topic (FK cascade is the main path; delete explicitly here too to guard against old-version databases / partial deletions)
    void deleteSubagentSessionsByTopic(topicId).catch((err) =>
      logger.warn('[SubagentSessions] Failed to delete persisted sessions for topic:', err)
    )
  }

  private row(record: SessionRecord): SubagentSessionRow {
    return {
      id: record.id,
      name: record.config.name,
      label: record.label,
      status: record.status,
      queuedMessages: record.inbox.length,
      totalTokens: record.usageTotalTokens,
      hasUsage: record.usageCalls > 0,
      createdAt: record.createdAt,
      lastRunAt: record.lastRunAt,
      lastStatus: record.lastStatus
    }
  }

  /**
   * Read a subagent session snapshot (fetched once when opening the session view).
   *
   * Returns the event stream + current seq: the renderer replays events to get the same
   * streaming block list as the main conversation, then merges increment events by seq.
   * Returns undefined when the session does not exist / does not belong to the topic.
   */
  readConversation(id: string, topicId: number): SubagentConversationSnapshot | undefined {
    const record = this.sessions.get(id)
    if (!record || record.topicId !== topicId) return undefined
    const page = sliceRecentConversationTurns(record.conversation)
    return {
      topicId: record.topicId,
      agentId: record.id,
      name: record.config.name,
      label: record.label,
      prompt: record.prompt,
      status: record.status,
      lastStatus: record.lastStatus,
      queuedMessages: record.inbox.length,
      hasOlder: page.hasOlder,
      seq: record.conversationSeq,
      events: page.events
    }
  }

  /**
   * Page backwards: take the most recent page of complete turns before `beforeSeq`
   * (bounded by turn_start). Opening a session returns only the latest
   * CONVERSATION_PAGE_TURNS turns; older history is loaded on demand when scrolling to the top.
   */
  readOlderConversation(
    id: string,
    topicId: number,
    beforeSeq: number,
    maxTurns = CONVERSATION_PAGE_TURNS
  ): SubagentConversationHistory | undefined {
    const record = this.sessions.get(id)
    if (!record || record.topicId !== topicId) return undefined
    if (!Number.isFinite(beforeSeq) || beforeSeq <= 0) {
      return { events: [], hasOlder: false }
    }
    const older = record.conversation.filter((event) => event.seq < beforeSeq)
    return sliceRecentConversationTurns(older, Math.max(1, Math.floor(maxTurns)))
  }

  /**
   * Clear all sessions (called when switching account data spaces / exiting).
   *
   * Sessions are indexed by topicId, so after switching databases the same id may point at
   * another topic; without clearing, opening a background subagent in the new account could
   * show a session from the previous account (the same class of problem as jobs).
   */
  clearAll(): void {
    for (const record of this.sessions.values()) {
      record.dead = true
      record.inbox.length = 0
      record.currentAbort?.abort()
    }
    this.sessions.clear()
    this.onAllCleared?.()
    // After switching account spaces, historical sessions must be restorable from the new database (old database data is not deleted: only memory is cleared)
    this.restored = false
  }

  /**
   * Overwrite the session's current snapshot into `subagent_session` (warn only on failure).
   *
   * Why overwrite instead of event-by-event: the event stream / message history already
   * accumulate in memory and a single session is small; writing the whole row once at the
   * end of a turn is enough, avoiding one DB write per chunk. Persistence failures must not
   * affect session execution.
   */
  private persist(record: SessionRecord): void {
    const messages = record.messages.map((message) => ({
      role: message._getType?.() === 'human' ? 'human' : 'ai',
      content: typeof message.content === 'string' ? message.content : ''
    }))
    void upsertSubagentSession({
      id: record.id,
      topic_id: record.topicId,
      name: record.config.name,
      label: record.label,
      prompt: record.prompt,
      config: JSON.stringify(record.config),
      messages: JSON.stringify(messages),
      conversation: JSON.stringify(record.conversation),
      conversation_seq: record.conversationSeq,
      turn_counter: record.turnCounter,
      last_status: record.lastStatus ?? null,
      last_output: record.lastOutput || null,
      inbox: record.inbox.length > 0 ? JSON.stringify(record.inbox) : null,
      last_run_at: record.lastRunAt ? new Date(record.lastRunAt).toISOString() : null,
      main_model_provider_id: record.mainModelDescriptor?.providerId ?? null,
      main_model_name: record.mainModelDescriptor?.model ?? null,
      usage_input_tokens: record.usageInputTokens,
      usage_output_tokens: record.usageOutputTokens,
      usage_total_tokens: record.usageTotalTokens,
      usage_calls: record.usageCalls
    }).catch((err) => logger.warn('[SubagentSessions] Failed to persist session snapshot:', err))
  }

  /**
   * Restore historical sessions from the database (called once on app start / after an
   * account switch).
   *
   * Restored sessions are marked `inactive`: the event stream / message history are
   * viewable read-only, and the runtime is **not rebuilt immediately** (cold resume is
   * lazy); only on the first send/continuation are the model/tools/prompt rebuilt from the
   * persisted snapshot and the session returned to idle, avoiding building models/tools for
   * all historical sessions at startup.
   */
  async restorePersistedSessions(): Promise<void> {
    if (this.restored) return
    this.restored = true
    try {
      const rows = await listSubagentSessions()
      const touchedTopics = new Set<number>()
      let count = 0
      for (const row of rows) {
        if (this.sessions.has(row.id)) continue
        const config = parseJson<SubAgentConfig>(row.config)
        if (!config || typeof config.name !== 'string' || typeof config.systemPrompt !== 'string') {
          continue
        }
        const messages = parseJsonArray<{ role?: string; content?: string }>(row.messages).map(
          (item) =>
            item.role === 'human'
              ? new HumanMessage(item.content ?? '')
              : new AIMessage({ content: item.content ?? '' })
        )
        const conversation = parseJsonArray<SubagentConversationEvent>(row.conversation).filter(
          (event) =>
            !!event &&
            typeof event === 'object' &&
            typeof (event as { seq?: unknown }).seq === 'number' &&
            typeof (event as { kind?: unknown }).kind === 'string'
        )
        const createdAt = row.created_at ? Date.parse(row.created_at) : Date.now()
        const lastRunAt = row.last_run_at ? Date.parse(row.last_run_at) : undefined
        const lastStatus =
          row.last_status === 'completed' ||
          row.last_status === 'failed' ||
          row.last_status === 'killed'
            ? row.last_status
            : undefined
        const mainModelDescriptor: SubAgentMainModelDescriptor | undefined =
          row.main_model_provider_id != null && row.main_model_name
            ? { providerId: row.main_model_provider_id, model: row.main_model_name }
            : undefined
        const record: SessionRecord = {
          id: row.id,
          topicId: row.topic_id,
          config,
          mainModelDescriptor,
          label: row.label,
          prompt: row.prompt,
          messages,
          inbox: parseJsonArray<string>(row.inbox).filter((item) => typeof item === 'string'),
          status: 'inactive',
          usageInputTokens: row.usage_input_tokens,
          usageOutputTokens: row.usage_output_tokens,
          usageTotalTokens: row.usage_total_tokens,
          usageCalls: row.usage_calls,
          createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
          lastRunAt,
          lastStatus,
          lastOutput: row.last_output ?? '',
          turnCounter: row.turn_counter,
          conversationSeq: row.conversation_seq,
          conversation
        }
        this.sessions.set(row.id, record)
        touchedTopics.add(row.topic_id)
        count += 1
      }
      for (const topicId of touchedTopics) this.broadcast(topicId)
      if (count > 0) {
        logger.info(`[SubagentSessions] Restored ${count} persisted session(s) as inactive`)
      }
    } catch (err) {
      this.restored = false
      logger.warn('[SubagentSessions] Failed to restore persisted sessions:', err)
    }
  }

  /** Append a session event (seq strictly increasing; the IPC layer relies on it for dedup/continuation) */
  private emitConversation(record: SessionRecord, event: SubagentConversationEventInput): void {
    record.conversationSeq += 1
    const full = { ...event, seq: record.conversationSeq } as SubagentConversationEvent
    record.conversation.push(full)
    this.trimConversation(record)
    this.onConversationEvent?.(record.topicId, record.id, full)
  }

  /**
   * Trim the event stream by whole turns: renderer replay depends on turn_start → chunk →
   * turn_end, so it cannot cut inside a chunk; drop the oldest complete turns until back
   * under the cap (keep the current turn even if it alone exceeds the cap, so it does not
   * disappear mid-turn).
   */
  private trimConversation(record: SessionRecord): void {
    while (record.conversation.length > MAX_CONVERSATION_EVENTS) {
      let cut = 0
      for (let i = 1; i < record.conversation.length; i++) {
        if (record.conversation[i].kind === 'turn_start') {
          cut = i
          break
        }
      }
      if (cut === 0) return
      record.conversation.splice(0, cut)
    }
  }

  private broadcast(topicId: number): void {
    this.onChange?.(topicId, this.list(topicId))
  }

  /** Runtime reference cache for one session run (reused when send wakes it; injected at start) */
  private runtimes = new WeakMap<SessionRecord, SubagentSessionRuntime>()

  private lastRuntime(record: SessionRecord): SubagentSessionRuntime | undefined {
    return this.runtimes.get(record)
  }

  /**
   * Run one session turn: use the session history as prefix + the new message, stream the
   * subgraph; write output increments to the same-named background job (readable via
   * job_output); settle the job when done, then continue with the next queued message (FIFO).
   *
   * 2026-11-26: also record this turn's streaming chunks as the session event stream (see
   * subagent-conversation) so they can be viewed live after opening the "background
   * subagents" entry in the top-right of the main conversation area. Chunk production reuses
   * the main conversation's stream-producers — incremental shape, tool card projection, and
   * the execution/completion lifecycle all come from the same source as the main conversation.
   */
  private async run(
    record: SessionRecord,
    message: string,
    rt: SubagentSessionRuntime
  ): Promise<void> {
    if (record.status === 'running') {
      // Theoretically unreachable (send only wakes when idle); queue defensively
      record.inbox.unshift(message)
      return
    }
    record.status = 'running'
    record.currentAbort = new AbortController()
    this.runtimes.set(record, rt)
    this.broadcast(record.topicId)
    const m = getAgentToolTexts()

    // Events for this turn: user message + assistant stream (replaying in the renderer yields a session view identical to the main conversation)
    record.turnCounter += 1
    const turnId = `turn-${record.turnCounter}`
    const startedAt = Date.now()
    this.emitConversation(record, { kind: 'turn_start', turnId, prompt: message, startedAt })

    // Register the same-named background job (job id = session id; settlement first-wins)
    const job = jobsRegistry.start(record.topicId, 'subagent', record.label, record.id)
    jobsRegistry.attachCancel(record.id, () => record.currentAbort?.abort())
    const abortSignal = record.currentAbort.signal

    /** Whether this turn is still collecting chunks: after abort/error settlement, late tool results are no longer written into the finished turn */
    const collecting = { value: true }
    let fullText = ''
    /** Real usage for this turn (one record per model call; accumulated into the session total and persisted at settlement) */
    const usageRecords: ModelUsageRecord[] = []
    let turnStatus: SubagentTurnStatus = 'completed'
    let turnNote: string | undefined
    let queue: RecordQueue | undefined

    /**
     * Structured chunk pipeline: write to the session event stream + the same-named
     * background job output.
     *
     * The job_output contract is unchanged: body increments + one line per tool call; the
     * parent agent still observes the subagent through job_output. The session view instead
     * receives chunks fully isomorphic to the main conversation (including tool card data).
     */
    const enqueue = (chunk: StructuredMessage): void => {
      if (!collecting.value) return
      this.emitConversation(record, { kind: 'chunk', turnId, chunk })
      if (chunk.content) {
        fullText += chunk.content
        job.appendOutput(chunk.content)
      }
      if (chunk.tool && chunk.tool.status === 'executing') {
        const inputText = JSON.stringify(chunk.tool.input ?? {}).slice(0, 200)
        job.appendOutput(
          mainFormat(m.subagentSessions.toolCallLine, { name: chunk.tool.name, input: inputText })
        )
      }
      // Consumed by the IPC layer (throttled push to the session view); only costs anything when there are watchers
    }

    /** Read a tool result: normalize AbortError on interruption (same convention as the main conversation) */
    const safeGetOutput = async (call: { output: unknown }): Promise<unknown> => {
      try {
        return await call.output
      } catch (err) {
        if (abortSignal.aborted) {
          const abortErr = new Error('Tool call aborted')
          abortErr.name = 'AbortError'
          throw abortErr
        }
        throw err
      }
    }

    try {
      const sa = record.config
      const model = (await rt.resolveModel(sa.model)) ?? rt.mainModel
      const tools = rt.buildTools(sa)
      const systemPrompt = rt.extendSystemPrompt(sa)

      // Record queue + three-way producers: convert RuntimeRecord into StructuredMessages isomorphic to the main conversation
      queue = new RecordQueue()
      const queueRef: QueueRef = { current: queue }
      const graph = buildAgentGraph({
        model,
        tools,
        systemPrompt,
        queue: queueRef,
        spill: rt.spillRef?.current,
        maxToolCalls: rt.maxToolCalls,
        // Real usage: the subagent graph and the main graph share callModel and the same usageSink collection convention
        usageSink: { push: (record) => usageRecords.push(record) }
      })

      const run: RuntimeStream = {
        messages: queue.iterateMessages(),
        toolCalls: queue.iterateToolCalls(),
        subagents: queue.iterateSubAgents()
      }
      const markDone = (): void => {}
      const msgProducer = produceMessages(run, abortSignal, enqueue, markDone).catch(() => {})
      const toolProducer = produceToolCalls(
        run,
        abortSignal,
        enqueue,
        markDone,
        safeGetOutput,
        undefined,
        record.topicId
      ).catch(() => {})
      const subAgentProducer = produceSubAgents(
        run,
        abortSignal,
        enqueue,
        markDone,
        safeGetOutput,
        record.topicId
      ).catch(() => {})

      // Session input: history + this turn's message
      const input = [...record.messages, new HumanMessage(message)]
      const seenIndexes = new Set<number>()
      const stream = await graph.stream(
        { messages: input },
        {
          streamMode: ['messages'] as const,
          recursionLimit: rt.recursionLimit,
          signal: abortSignal,
          // Team identity: this session is a member on the team board (task claims/updates are recorded against the session id)
          configurable: {
            topicId: record.topicId,
            teamAgent: {
              id: record.id,
              name:
                record.config.rename && record.config.rename !== record.config.name
                  ? record.config.rename
                  : record.config.name,
              isLead: false
            }
          }
        }
      )
      for await (const item of stream) {
        if (abortSignal.aborted) break
        const [, payload] = item as readonly [string, [StreamMessageLike, unknown]]
        const chunk = payload[0]
        const chunkType = chunk._getType?.()
        if (chunkType && chunkType !== 'ai') continue
        // Convert model chunks into runtime records (session view and background job output share one source)
        // Otherwise the session view gets no streaming content; this adds the same conversion source as the main conversation.
        pushMessageRecords(chunk, queue, seenIndexes)
      }
      queue.close()
      await Promise.allSettled([msgProducer, toolProducer, subAgentProducer])

      if (abortSignal.aborted) {
        turnStatus = 'killed'
        turnNote = m.subagentSessions.interrupted
        const partial = fullText.trim()
        record.messages.push(new HumanMessage(message))
        if (partial) record.messages.push(new AIMessage({ content: partial }))
        record.lastStatus = 'killed'
        record.lastOutput = partial
          ? `${partial}\n${m.subagentSessions.interrupted}`
          : m.subagentSessions.interrupted
        job.settle('killed', record.lastOutput, 'interrupted')
        return
      }
      const output = fullText.trim() || m.subagent.noTextOutput
      if (!fullText.trim()) turnNote = m.subagent.noTextOutput
      record.messages.push(new HumanMessage(message))
      record.messages.push(new AIMessage({ content: output }))
      record.lastStatus = 'completed'
      record.lastOutput = output
      job.settle('completed', output)
    } catch (err) {
      // An interruption (interrupt_agent/job_kill) during streaming throws AbortError — settle
      // as killed rather than failed (fix: it previously fell into the failed branch, leaking an
      // English abort error message into history and getting the status semantics wrong)
      if (abortSignal.aborted) {
        turnStatus = 'killed'
        turnNote = m.subagentSessions.interrupted
        const partial = fullText.trim()
        record.messages.push(new HumanMessage(message))
        if (partial) record.messages.push(new AIMessage({ content: partial }))
        record.lastStatus = 'killed'
        record.lastOutput = partial
          ? `${partial}\n${m.subagentSessions.interrupted}`
          : m.subagentSessions.interrupted
        job.settle('killed', record.lastOutput, 'interrupted')
        return
      }
      const isRecursion =
        err instanceof GraphRecursionError || (err as Error)?.name === 'GraphRecursionError'
      const messageText = isRecursion
        ? m.subagentSessions.roundLimitReached
        : err instanceof Error
          ? err.message
          : String(err)
      logger.warn(`[SubagentSession] ${record.id} failed to run:`, err)
      const partial = fullText.trim()
      const failureNote = mainFormat(m.subagentSessions.runFailed, { message: messageText })
      turnStatus = 'failed'
      turnNote = failureNote
      record.messages.push(new HumanMessage(message))
      if (partial) record.messages.push(new AIMessage({ content: partial }))
      record.lastStatus = 'failed'
      record.lastOutput = partial ? `${partial}\n${failureNote}` : failureNote
      job.settle('failed', record.lastOutput, messageText)
    } finally {
      collecting.value = false
      // On abort/error paths the producers may still be stuck on the queue iterator: close the queue so they finish (without blocking settlement)
      try {
        queue?.close()
      } catch {
        /* The queue is already closed: ignore */
      }
      record.lastRunAt = Date.now()
      record.currentAbort = undefined
      // End of this turn in the session view: the renderer finalizes the stream and freezes the last assistant message (failures/interruptions get a note)
      this.emitConversation(record, {
        kind: 'turn_end',
        turnId,
        status: turnStatus,
        finishedAt: Date.now(),
        note: turnNote
      })
      record.status = 'idle'
      // Accumulate this turn's real usage into the session total (failed/interrupted turns still keep the model calls that happened)
      const turnUsage = sumUsage(usageRecords)
      record.usageInputTokens += turnUsage.inputTokens
      record.usageOutputTokens += turnUsage.outputTokens
      record.usageTotalTokens += turnUsage.totalTokens
      record.usageCalls += turnUsage.calls
      this.broadcast(record.topicId)
      // Persist a snapshot at the end of each turn: after restore the full history + terminal state + accumulated usage can be replayed
      this.persist(record)

      // Topic already deleted (clearTopic set dead): no more inbox continuation (zombie session
      // closures used to run through the inbox one by one and register unmanageable ghost jobs under a deleted topic — fixed)
      if (!record.dead) {
        // Inbox non-empty → continue with the next turn (FIFO)
        const next = record.inbox.shift()
        if (next) {
          void this.run(record, next, rt)
        }
      }
    }
  }
}

/** Process-level singleton */
export const subagentSessions = new SubagentSessionRegistry()

/** Build subagent continuation control tools (injected into the main agent only; owners isolated by topicId) */
export function buildSubagentControlTools(
  registry: SubagentSessionRegistry,
  topicId: number
): StructuredToolInterface[] {
  return [
    tool(
      async ({ subagent_id, message }) => {
        try {
          const { messageId } = await registry.send(subagent_id, topicId, message)
          return JSON.stringify({ messageId })
        } catch (err) {
          return mainFormat(getAgentToolTexts().subagentSessions.sendFailed, {
            message: (err as Error).message
          })
        }
      },
      {
        name: 'send_message',
        description:
          'Send the next message to a background subagent session so it keeps working (continuing the same conversation and context). If that session is currently running, the message is queued and runs automatically after its current turn ends. Returns only a delivery confirmation (messageId); poll the subagent reply with job_output(job_id).',
        schema: z.object({
          subagent_id: z
            .string()
            .describe(
              'Subagent session ID (returned when the task tool starts in background mode, e.g. subagent-1)'
            ),
          message: z.string().describe('Message content to send to the subagent')
        })
      }
    ),
    tool(
      async ({ agent_id }) => {
        const { accepted } = registry.interrupt(agent_id, topicId)
        return JSON.stringify({ accepted })
      },
      {
        name: 'interrupt_agent',
        description:
          'Interrupt the turn currently running in a background subagent session. Messages already queued but not yet started are kept and can be resumed later with send_message. A harmless no-op when the session does not exist or is idle.',
        schema: z.object({
          agent_id: z.string().describe('ID of the subagent session to interrupt')
        })
      }
    ),
    tool(
      async ({ scope }) => {
        void scope
        return JSON.stringify({ agents: registry.list(topicId) })
      },
      {
        name: 'list_agents',
        description:
          'List all background subagent sessions for this topic with their statuses (running = current turn in progress / idle = waiting between turns) and queued message counts.',
        schema: z.object({
          scope: z
            .enum(['children', 'descendants'])
            .optional()
            .describe('Scope (the current implementation returns a flat list of subagents)')
        })
      }
    )
  ]
}
