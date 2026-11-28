import logger from 'electron-log'
import { StructuredMessage, ToolCard } from './types'
import type { AgentInjection } from './types'
import type {
  RuntimeStream,
  MessageRecord,
  ToolCallRecord,
  SubAgentRecord
} from '../../runtime/harness/types'
import { takeToolFacts } from '../../runtime/harness/tool-result-facts'
import { getToolOutputStore } from '../../runtime/harness/tool-output-store'
import { buildToolProjection, projectToolInput, PROJECTED_TOOLS } from './tool-presentation'

/**
 * Stream producers — consume the agent runtime's three record streams and convert them into the
 * frontend protocol StructuredMessage.
 *
 * Behavior matches the previous streamEvents(v3) implementation:
 * - Message producer: dedupe reasoning/text deltas (handles both delta and full-text forms) and
 *   throttle tool `preparing`;
 * - Tool producer: executing → completed + custom cards; the task tool is converted into sub-agent
 *   started/completed;
 * - Sub-agent producer: group by (name, causeId), forward running events record by record, and send
 *   an early completed at the end.
 *
 * Result projection (2026-09-19): results of built-in file/command tools are **no longer sent
 * as-is** — inputs are trimmed to what the card needs (whole bodies of write_file and old/new
 * strings of edit_file are always dropped), output is emptied, and only a card is kept. When the
 * content is needed, the renderer fetches details by callId (ls/glob/grep/execute are stored
 * separately in tool-output-store). See service/tool-presentation.ts.
 */

type EnqueueFn = (item: StructuredMessage) => void
type MarkDoneFn = () => void
type SafeGetOutputFn = (call: { output: unknown }) => Promise<unknown>
/**
 * Drain callback for in-turn steering (provided by the main-process queue): returns the steering
 * messages to merge into the model this turn. The callback itself already does "persist + emit
 * steered chunk + split assistant segment boundary"; producers only care about timing.
 */
type DrainInjectionsFn = () => Promise<AgentInjection[] | null>

/** Delay 100ms so the renderer has time to render the loading state */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Stream silence watchdog threshold (used to diagnose "stuck"): log once if no new record arrives for longer than this */
const STREAM_SILENCE_LOG_MS = 6000

/**
 * Stream silence watchdog: while a reasoning-capable model generates long tool arguments the stream
 * may go quiet for a long time; reset() is called on every new record, and when the threshold passes
 * without a reset a "silence reminder" log line is written as direct evidence that "the model is
 * still generating, there are just no events in the stream" (one reproduction is enough to
 * conclude).
 */
function createSilenceWatchdog(tag: string): { reset: () => void; dispose: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastResetAt = Date.now()
  const arm = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      logger.info(
        `[Stream] Silence warning (${tag}): no new records for ${((Date.now() - lastResetAt) / 1000).toFixed(0)}s, model is still generating (no events in stream)`
      )
    }, STREAM_SILENCE_LOG_MS)
  }
  return {
    reset: () => {
      lastResetAt = Date.now()
      arm()
    },
    dispose: () => {
      if (timer) clearTimeout(timer)
      timer = null
    }
  }
}

// ============================================================================
// In-turn steering: determining segment boundaries
// ============================================================================

/**
 * Create the "steering drainer".
 *
 * Timing (message stream): drain only after this round's tools have **all been emitted** —
 * `toolsStarted.value === false` means either the model hasn't emitted a tool call yet (the first
 * tool record hasn't arrived) or it has already moved to the next output round (a new
 * tool_block_start resets the flag). The latter is exactly the boundary we want: the previous tool
 * card (executing → completed) has been fully emitted, so the steering message becomes a clean
 * assistant-message segment boundary and there is no "previous segment's tool completion card
 * popping up after the steering message".
 *
 * The tool stream also drains once after each tool call record (same guard), covering the window
 * "after the last tool call, before the model produces any output".
 */
function createInjectionDrainer(
  toolsStarted: { value: boolean } | undefined,
  drain?: DrainInjectionsFn
): (force: boolean) => Promise<void> {
  return async (force: boolean) => {
    if (!drain) return
    // Non-forced mode: tools have started but not all results have been emitted yet; draining now
    // would place the steering message before the tool completion card
    if (!force && toolsStarted?.value) return
    await drain()
  }
}

// ============================================================================
// Tool result projection: how completed states are emitted / persisted
// ============================================================================

/** Completed tool block (already projected: trimmed input, emptied output, card attached) */
interface ProjectedToolCall {
  name: string
  input: Record<string, unknown>
  output: string
  status: 'completed'
  id: string
  card?: ToolCard
  /** Images carried by the tool result (read_image): persisted with the block, rendered in the UI + replayed from history */
  images?: Array<{ dataUrl: string; path: string; mimeType?: string }>
}

/**
 * Byte limit for a single tool result image entering conversation blocks (data URL chars, roughly
 * a 1.1MB original image).
 *
 * Images, like user-uploaded pictures, are stored as base64 inside the blocks JSON: without a limit
 * a single read_image could blow a session row up to tens of MB. Images over the limit are not
 * persisted (the model still sees them this turn; the UI shows a text result).
 */
const MAX_STORED_TOOL_IMAGE_CHARS = 1_500_000

/**
 * Finalize the completed state of one tool call: read raw output → project → save details aside.
 *
 * All three must happen together: details must be written to the store **before** the output is
 * discarded, otherwise the card's detail marker would be a lie.
 */
async function finishToolCall(
  topicId: number | undefined,
  name: string,
  input: Record<string, unknown>,
  callId: string,
  safeGetOutput: SafeGetOutputFn,
  call: {
    output: unknown
    images?: Promise<Array<{ dataUrl: string; path: string; mimeType?: string }>>
  }
): Promise<ProjectedToolCall> {
  const raw = await safeGetOutput(call)
  const output = typeof raw === 'string' ? raw : JSON.stringify(raw)
  // Tool result images: keep only a bounded few (over-limit images are not persisted, avoiding bloated session rows)
  const images = call.images ? await call.images.catch(() => []) : []
  const storedImages = images
    .filter((image) => image.dataUrl.length <= MAX_STORED_TOOL_IMAGE_CHARS)
    .slice(0, 2)
  if (!PROJECTED_TOOLS.has(name)) {
    // Non-built-in tools (mnemon_* / manage_* etc.): keep as-is; the frontend parses the JSON to render a dedicated card
    return {
      name,
      input,
      output,
      status: 'completed',
      id: callId,
      images: storedImages.length > 0 ? storedImages : undefined
    }
  }
  const projected = buildToolProjection({
    name,
    input,
    output,
    facts: takeToolFacts(callId)
  })
  let savedDetail = false
  if (projected.detailText && topicId) {
    savedDetail = getToolOutputStore()?.save(topicId, callId, projected.detailText) ?? false
  }
  // If details weren't saved, don't imply the card is openable; opening it would only say "details unavailable"
  const card =
    projected.card?.detail && !savedDetail ? { ...projected.card, detail: false } : projected.card
  return {
    name,
    input: projected.input,
    output: projected.output,
    status: 'completed',
    id: callId,
    card,
    images: storedImages.length > 0 ? storedImages : undefined
  }
}

/** Inputs of an executing tool block: built-in tools are likewise trimmed to what the card needs (write_file body never enters IPC) */
function executingToolInput(name: string, input: Record<string, unknown>): Record<string, unknown> {
  return PROJECTED_TOOLS.has(name) ? projectToolInput(name, input) : input
}

// ============================================================================
// Message stream producer: reasoning deltas / text deltas / tool blocks
// ============================================================================

/** Streaming delta shape: unknown=undetermined / cumulative=full accumulated text / incremental=pure delta */
type DeltaMode = 'unknown' | 'cumulative' | 'incremental'

/**
 * Text delta computer (with shape locking):
 * - The first two chunks determine the provider's shape: if the second extends the first →
 *   cumulative text, otherwise pure delta;
 * - Cumulative shape: return only the newly added suffix; an equal-length repeat = no new content,
 *   skip;
 * - Pure-delta shape: always emit — including repeated phrases identical to the previous one
 *   ("ok, ok, …" is genuine model output) and adjacent chunks where the latter happens to start
 *   with the former (e.g. '\n' and '\n| table row'); a mistaken startsWith/slice would swallow real
 *   content.
 */
function makeDeltaComputer(): (tokenText: string, lastSent: string) => string | undefined {
  let mode: DeltaMode = 'unknown'
  return (tokenText: string, lastSent: string): string | undefined => {
    if (!tokenText) return undefined
    if (mode === 'incremental') return tokenText
    if (mode === 'cumulative') {
      if (tokenText.startsWith(lastSent)) {
        if (tokenText.length > lastSent.length) {
          return tokenText.slice(lastSent.length)
        }
        return undefined
      }
      // Anomaly (shape changed mid-stream): emit as a delta to avoid losing content
      return tokenText
    }
    // unknown: emit the first chunk directly; determine the shape from the second
    if (!lastSent) return tokenText
    if (tokenText.startsWith(lastSent)) {
      if (tokenText.length > lastSent.length) {
        mode = 'cumulative'
        return tokenText.slice(lastSent.length)
      }
      // Identical to the previous chunk: shape still undetermined (a repeated phrase in delta shape); emit as a delta
      return tokenText
    }
    mode = 'incremental'
    return tokenText
  }
}

export async function produceMessages(
  run: RuntimeStream,
  signal: AbortSignal | undefined,
  enqueue: EnqueueFn,
  markDone: MarkDoneFn,
  /** Shared flag with produceToolCalls: true once the first tool starts executing (the model
   *  message has ended and arguments are fully generated, so the preparing keep-alive must stop to
   *  avoid reviving a completed tool card as "building arguments…"); reset to false when a new
   *  model output round starts (new tool_block_start). */
  toolsStarted?: { value: boolean },
  /** In-turn steering: drain callback for pending messages (disabled when not configured) */
  drainInjections?: DrainInjectionsFn,
  /**
   * "Does this segment belong to the final answer" flag (protocol-level source of truth, see
   * service/answer-boundary.ts).
   *
   * Shared by both producers: the message stream tags content/reasoning, and the tool stream flips
   * the flag to false as soon as it starts (this turn has entered the working phase, so everything
   * streamed before is exploratory talk). After a new model output round (tool_block_start) the
   * body is tagged true again — the last segment left is this turn's answer. The renderer places
   * the answer outside the collapse based on this, no longer guessing from its own loading state.
   */
  answerMark?: { value: boolean }
): Promise<void> {
  // lastSent is shared across all records: some providers split the full text into several repeated sends
  let lastSentReasoning = ''
  let lastSentContent = ''
  const reasoningDelta = makeDeltaComputer()
  const contentDelta = makeDeltaComputer()
  const toolBlocks = new Map<number, { id?: string; name: string }>()
  /** Whether any tool activity appeared (including `task` dispatch): after that the model is in a turn "after the tool round" */
  let sawToolActivity = false
  let lastProgressAt = 0
  const silenceWatchdog = createSilenceWatchdog('message stream')
  const drainInjectionsInto = createInjectionDrainer(toolsStarted, drainInjections)
  try {
    for await (const rec of run.messages as AsyncIterable<MessageRecord>) {
      if (signal?.aborted) break
      silenceWatchdog.reset()
      // Segment boundary: when this round's tools have all been emitted (flag false), merge pending
      // steering into the model and emit the steered chunk
      await drainInjectionsInto(false)
      if (rec.kind === 'reasoning') {
        // A segment after the tool round: the model doesn't both run tools and answer in the same
        // segment, so this content is the answer
        if (sawToolActivity && answerMark) answerMark.value = true
        const delta = reasoningDelta(rec.text, lastSentReasoning)
        if (delta) {
          enqueue({ reasoning_content: delta, answer: answerMark?.value ?? true })
        }
        lastSentReasoning = rec.text
      } else if (rec.kind === 'retry_attempt') {
        // After a single failed model request, retry in place at the original call (no whole-turn
        // rerun); forward progress to the frontend
        enqueue({ retrying: { attempt: rec.attempt, retries: rec.retries } })
      } else if (rec.kind === 'text') {
        if (sawToolActivity && answerMark) answerMark.value = true
        const delta = contentDelta(rec.text, lastSentContent)
        if (delta) {
          enqueue({ content: delta, answer: answerMark?.value ?? true })
        }
        lastSentContent = rec.text
      } else if (rec.kind === 'tool_block_start') {
        if (rec.name === 'task') {
          // Dispatching a sub-agent also counts as "getting to work": previously streamed content/reasoning is exploratory talk
          sawToolActivity = true
          if (answerMark) answerMark.value = false
          continue
        }
        // This turn has entered the "working" phase: the content/reasoning streamed so far is
        // exploratory talk, retract the answer mark
        sawToolActivity = true
        if (answerMark) answerMark.value = false
        // A new model output round starts: tools haven't started executing, resume the building-arguments keep-alive
        if (toolsStarted) toolsStarted.value = false
        toolBlocks.set(rec.index, { id: rec.id, name: rec.name })
        lastProgressAt = Date.now()
        enqueue({
          tool: { name: rec.name, input: {}, output: '', status: 'preparing', id: rec.id }
        })
      } else if (rec.kind === 'tool_args') {
        // The system has started executing (model message ended, all arguments generated): stop
        // sending the "building arguments" keep-alive, otherwise it revives completed tool cards
        // (ghost "building arguments…", user report: do not block)
        if (toolsStarted?.value) continue
        // Tool argument deltas: throttle to 500ms, refresh status only, not content
        const now = Date.now()
        if (now - lastProgressAt < 500) continue
        lastProgressAt = now
        const info = toolBlocks.get(rec.index)
        if (!info || info.name === 'task') continue
        enqueue({
          tool: {
            name: info.name,
            input: {},
            output: '',
            status: 'preparing',
            id: info.id
          }
        })
      }
    }
  } catch (err) {
    if ((err as Error)?.name !== 'AbortError') {
      logger.error('Stream message error:', err)
    }
  } finally {
    silenceWatchdog.dispose()
    markDone()
  }
}

// ============================================================================
// Tool call stream producer: executing → completed
// ============================================================================

export async function produceToolCalls(
  run: RuntimeStream,
  signal: AbortSignal | undefined,
  enqueue: EnqueueFn,
  markDone: MarkDoneFn,
  safeGetOutput: SafeGetOutputFn,
  /** Shared flag with produceMessages: set to true when this tool starts executing (model message
   *  ended, arguments fully generated; the message producer uses it to stop the "building
   *  arguments" keep-alive) */
  toolsStarted?: { value: boolean },
  /** Current topic id: result details are stored in per-topic directories (cleaned up together when the topic is deleted) */
  topicId?: number,
  /** In-turn steering: drain callback for pending messages (disabled when not configured) */
  drainInjections?: DrainInjectionsFn,
  /** Shared "does this segment belong to the final answer" flag (see produceMessages): retracted as soon as a tool starts executing */
  answerMark?: { value: boolean }
): Promise<void> {
  const drainInjectionsInto = createInjectionDrainer(toolsStarted, drainInjections)
  try {
    for await (const call of run.toolCalls as AsyncIterable<ToolCallRecord>) {
      if (signal?.aborted) break
      // Model message ended, system starts executing: stop the message stream's building-arguments
      // keep-alive (anti ghost card)
      if (toolsStarted) toolsStarted.value = true
      // This turn is already doing work: previously streamed content/reasoning is not this turn's
      // answer, retract the mark
      if (answerMark) answerMark.value = false
      const input = call.input as Record<string, unknown>
      // The task tool is the agent dispatcher: convert it into subAgent events so the frontend
      // only sees agent blocks
      if (call.name === 'task') {
        const saName =
          (typeof input?.subagent_type === 'string' && input.subagent_type) || 'subAgent'
        const taskDesc = (typeof input?.description === 'string' && input.description) || ''
        const causeId = call.callId
        // Background mode (background=true): no started/completed activity block; after a successful
        // start emit a lightweight "dispatched" event (name + brief description + session id), with
        // agent content/results collected in the top bar list
        if (input?.background === true) {
          const raw = await safeGetOutput(call)
          const output = typeof raw === 'string' ? raw : JSON.stringify(raw)
          const idMatch = /subagent_id=([A-Za-z0-9-]+)/.exec(output)
          enqueue({
            subAgent: {
              name: saName,
              causeId,
              status: 'dispatched',
              taskDescription: taskDesc,
              subagentId: idMatch?.[1]
            }
          })
          continue
        }
        // executing → emit the started agent event (with task description)
        enqueue({
          subAgent: { name: saName, causeId, status: 'started', taskDescription: taskDesc }
        })
        await sleep(100)
        if (signal?.aborted) break
        const raw = await safeGetOutput(call)
        const output = typeof raw === 'string' ? raw : JSON.stringify(raw)
        // completed → emit the completed agent event
        enqueue({
          subAgent: {
            name: saName,
            causeId,
            status: 'completed',
            output,
            taskDescription: taskDesc
          }
        })
        continue
      }
      // Emit the "executing" state first (inputs trimmed per tool: the whole write_file body never enters IPC)
      enqueue({
        tool: {
          name: call.name,
          input: executingToolInput(call.name, input),
          output: '',
          status: 'executing',
          id: call.callId
        }
      })
      // Delay 100ms so the renderer has time to render the loading state
      await sleep(100)
      if (signal?.aborted) break
      // Then emit the "completed" state (result projection + details saved aside)
      enqueue({
        tool: await finishToolCall(topicId, call.name, input, call.callId, safeGetOutput, call)
      })
      // This tool has been emitted as completed: drain steering now, the cleanest boundary (covers
      // the window "after the last tool call, before the model produces any output"; later waits are
      // covered by the message stream's guarded drain)
      await drainInjectionsInto(true)
    }
  } catch (err) {
    if ((err as Error)?.name !== 'AbortError') {
      logger.error('Stream tool call error:', err)
    }
  } finally {
    markDone()
  }
}

// ============================================================================
// Sub-agent stream producer: running events (reasoning / content / tool)
// ============================================================================

/** Streaming group state for sub-agents (distinguishes repeated calls of same-named sub-agents by name + causeId) */
interface SubAgentGroupState {
  lastSentReasoning: string
  lastSentContent: string
  reasoningDelta: (tokenText: string, lastSent: string) => string | undefined
  contentDelta: (tokenText: string, lastSent: string) => string | undefined
  /** Sub-agent tool call block registry (index → tool name/id), used by the building-arguments keep-alive */
  toolBlocks: Map<number, { id?: string; name: string }>
  lastToolProgressAt: number
  /** A tool in this group has started executing: suppress late building-arguments keep-alives (anti revive of completed cards); reset by a new block_start */
  toolStarted: boolean
}

export async function produceSubAgents(
  run: RuntimeStream,
  signal: AbortSignal | undefined,
  enqueue: EnqueueFn,
  markDone: MarkDoneFn,
  safeGetOutput: SafeGetOutputFn,
  /** Current topic id: when a sub-agent calls built-in tools, result details are likewise stored per topic */
  topicId?: number,
  /** Shared "does this segment belong to the final answer" flag (see produceMessages): dispatching a sub-agent also counts as getting to work */
  answerMark?: { value: boolean }
): Promise<void> {
  const groups = new Map<string, SubAgentGroupState>()
  const silenceWatchdog = createSilenceWatchdog('subagent stream')
  try {
    for await (const rec of run.subagents as AsyncIterable<SubAgentRecord>) {
      if (signal?.aborted) break
      // The main agent delegated work to a sub-agent: previously streamed content/reasoning is
      // exploratory talk, retract the answer mark
      if (answerMark) answerMark.value = false
      silenceWatchdog.reset()
      const key = `${rec.name}:${rec.causeId ?? ''}`
      let group = groups.get(key)
      if (!group) {
        group = {
          lastSentReasoning: '',
          lastSentContent: '',
          reasoningDelta: makeDeltaComputer(),
          contentDelta: makeDeltaComputer(),
          toolBlocks: new Map(),
          lastToolProgressAt: 0,
          toolStarted: false
        }
        groups.set(key, group)
      }

      if (rec.kind === 'sub_start') {
        // The started lifecycle event is emitted by the task record in the toolCalls stream; skip it here
        continue
      } else if (rec.kind === 'sub_tool_block_start') {
        // Phase one: sub-agent tool name known → nested tool card "building arguments…" (same
        // two-phase display as the main agent)
        // A new model output round starts: reset the "tool already started executing" flag and resume
        // this round's building-arguments keep-alive
        group.toolStarted = false
        group.toolBlocks.set(rec.index, { id: rec.id, name: rec.toolName })
        group.lastToolProgressAt = Date.now()
        enqueue({
          subAgent: {
            name: rec.name,
            causeId: rec.causeId,
            status: 'running',
            tool: { name: rec.toolName, input: {}, output: '', status: 'preparing', id: rec.id }
          }
        })
      } else if (rec.kind === 'sub_tool_args') {
        // A tool in this group has started executing (model message ended): suppress all late
        // keep-alives to avoid reviving completed cards
        if (group.toolStarted) continue
        // Phase two: throttle argument deltas to 500ms, refresh status only, not content
        const now = Date.now()
        if (now - group.lastToolProgressAt < 500) continue
        group.lastToolProgressAt = now
        const info = group.toolBlocks.get(rec.index)
        if (!info) continue
        enqueue({
          subAgent: {
            name: rec.name,
            causeId: rec.causeId,
            status: 'running',
            tool: { name: info.name, input: {}, output: '', status: 'preparing', id: info.id }
          }
        })
      } else if (rec.kind === 'sub_reasoning') {
        const delta = group.reasoningDelta(rec.text, group.lastSentReasoning)
        if (delta) {
          enqueue({
            subAgent: {
              name: rec.name,
              causeId: rec.causeId,
              status: 'running',
              reasoning_content: delta
            }
          })
        }
        group.lastSentReasoning = rec.text
      } else if (rec.kind === 'sub_text') {
        const delta = group.contentDelta(rec.text, group.lastSentContent)
        if (delta) {
          enqueue({
            subAgent: { name: rec.name, causeId: rec.causeId, status: 'running', content: delta }
          })
        }
        group.lastSentContent = rec.text
      } else if (rec.kind === 'sub_tool_call') {
        const call = rec.tool
        const input = call.input as Record<string, unknown>
        // The system starts executing the sub-agent tool: stop this group's building-arguments
        // keep-alive (anti ghost card)
        group.toolStarted = true
        enqueue({
          subAgent: {
            name: rec.name,
            causeId: rec.causeId,
            status: 'running',
            tool: {
              name: call.name,
              input: executingToolInput(call.name, input),
              output: '',
              status: 'executing',
              id: call.callId
            }
          }
        })
        await sleep(100)
        if (signal?.aborted) break
        enqueue({
          subAgent: {
            name: rec.name,
            causeId: rec.causeId,
            status: 'running',
            tool: await finishToolCall(topicId, call.name, input, call.callId, safeGetOutput, call)
          }
        })
      } else if (rec.kind === 'sub_end') {
        // The content stream has ended; send the early completed immediately (the full output is
        // completed by the task record in the toolCalls stream)
        enqueue({
          subAgent: { name: rec.name, causeId: rec.causeId, status: 'completed' }
        })
      }
    }
  } catch (err) {
    if ((err as Error)?.name !== 'AbortError') {
      logger.error('Stream subAgent error:', err)
    }
  } finally {
    silenceWatchdog.dispose()
    markDone()
  }
}
