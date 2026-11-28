import {
  Annotation,
  END,
  START,
  StateGraph,
  type CompiledStateGraph,
  type LangGraphRunnableConfig
} from '../../ai/graph'
import { BaseChatModel } from '../../ai/chat-model'
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type MessageContentComplex
} from '../../ai/messages'
import type { StructuredToolInterface } from '../../ai/tools'
import logger from 'electron-log'
import type { RuntimeRecord, ToolCallRecord } from './types'
// Single source of truth for the interjection payload is ../types (the IPC layer and the graph share one type, avoiding structural drift)
import type { AgentInjection } from '../../services/harness/types'
import { formatOutput } from './fs-backend'
import { isToolMediaResult, type ToolImage } from './image-tool'
import type { SpillStore } from './spill'
import { invokeWithModelRecovery } from './model-recovery'
// Loop guard: detects only whether the same arguments keep producing the same result; no cumulative count that would penalize iterative workflows
import { RepeatGuard, repeatGuardMessage } from './repeat-guard'
// Standalone streaming-record conversion module (directly testable from scripts): imported here and re-exported for compatibility
import { pushMessageRecords, pushRecord, type StreamMessageLike } from './stream-records'
import { extractUsageMetadata, type ModelUsageRecord } from './usage'
import { mainFormat } from '../../i18n'
import { getAgentToolTexts } from '../../i18n/tool-results-agent'
import { getFsToolTexts } from '../../i18n/tool-results-fs'

export { pushMessageRecords, pushRecord }

/** Get the current model name (ChatModel implementations expose different fields; try each, and leave it empty for the caller to fill in) */
function resolveModelName(model: BaseChatModel): string | undefined {
  const candidate = model as unknown as { model?: unknown; modelName?: unknown }
  if (typeof candidate.model === 'string' && candidate.model) return candidate.model
  if (typeof candidate.modelName === 'string' && candidate.modelName) return candidate.modelName
  return undefined
}

export type { StreamMessageLike }

/**
 * Agent graph.
 *
 * Graph structure (explicit and auditable):
 *   START -> model (LLM with tools bound) -> tool calls? -> tools (custom tool node) -> model
 *                                        └ no tool calls -> END
 *
 * Tool nodes push tool_call records through a closure-shared RecordQueue (output is a Promise),
 * driving the frontend executing -> completed states; AbortSignal is checked between calls and
 * throws to stop the run.
 */

/** Graph state: message list (append reducer) */
export const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (left, right) => left.concat(right),
    default: () => []
  })
})

export type AgentStateType = typeof AgentState

/** Tool-node context fields: mark record ownership in the subagent graph */
export interface SubAgentToolContext {
  name: string
  causeId: string
}

/** Mutable queue reference: the graph is built per request, the queue is created and injected at stream time */
export interface QueueRef {
  current?: {
    push(record: RuntimeRecord): void
  }
}

export interface BuildGraphOptions {
  model: BaseChatModel
  tools: StructuredToolInterface[]
  systemPrompt: string
  /** Record-queue reference (current is injected when streaming; undefined for non-streaming invoke) */
  queue?: QueueRef
  /** Subagent context (subagent graph only; not set for the main agent graph) */
  subagentCtx?: SubAgentToolContext
  /** Tool-result spill store (overlong output saved to a file plus a preview/locator; when unset, keeps plain truncation) */
  spill?: SpillStore
  /** Usage collection: push one real usage_metadata entry after each successful model call (skip when not reported) */
  usageSink?: { push(record: ModelUsageRecord): void }
  /** Total tool-call cap (the model-level "tool call rounds"; defaults to MAX_TOOL_CALLS) */
  maxToolCalls?: number
  /**
   * Drain callback for pending interjections: called once before each tool node runs.
   * Returns the user interjections to merge into model context (already taken from the queue);
   * null when there are none.
   */
  drainInjections?: () => Promise<AgentInjection[] | null>
}

/**
 * Build the in-turn interjection handler: drain pending interjections and turn them into human
 * messages the model can read.
 *
 * There are two call sites and both are required (measured 2026-09-20: hooking only the tool node
 * misses the case where no tool runs for a whole turn):
 * - **Before each model-node call** (main path): every model invocation is a chance to read
 *   interjections; for example an interjection during a long answer is read by the next model
 *   call without waiting for a tool;
 * - **Before each tool node runs** (supplementary): the current tool results are ready and the
 *   model is about to continue, so injecting here takes effect on the model call right after the
 *   tool result; the injected HumanMessage comes after the ToolMessage, so OpenAI's requirement
 *   that tool results follow tool_calls immediately is not violated.
 *
 * Draining is "take on consume" (takeInjections on the queue side); both call sites share one
 * closure instance, so each interjection is taken and injected exactly once.
 * Returns null when nothing is pending; the caller keeps its original return value at zero cost.
 */
function createInterjectionHandler(
  drain?: () => Promise<AgentInjection[] | null>
): (() => Promise<{ messages: HumanMessage[] } | null>) | undefined {
  if (!drain) return undefined
  return async () => {
    const injected = await drain()
    if (!injected || injected.length === 0) return null
    logger.info(`[Agent] Interjections merged into model context (${injected.length} items)`)
    return {
      messages: injected.map(
        (item) =>
          new HumanMessage(
            `[The user interjected while you were working — take this into account and adjust immediately] ${item.text}`
          )
      )
    }
  }
}

/** Bind tools safely: models without tool support degrade to plain chat (component degrades instead of throwing) */
function bindToolsSafely(model: BaseChatModel, tools: StructuredToolInterface[]): BaseChatModel {
  if (tools.length === 0) return model
  try {
    const bound = model.bindTools?.(tools)
    return bound ? (bound as BaseChatModel) : model
  } catch (err) {
    logger.warn('[Agent] Model does not support tool calls, falling back to plain chat mode:', err)
    return model
  }
}

/**
 * Default total-tool-call guard (overridable via the model's "Advanced settings -> tool call
 * rounds"): the user can stop at any time with the Stop button; near the limit the model is
 * gently steered to wrap up so legitimate long tasks are not cut off abruptly.
 */
export const MAX_TOOL_CALLS = 200

/** Fallback lower bound: even a too-small configured value still allows some steps to run */
export const MIN_TOOL_CALLS = 10

/** Tool timeout error (carries the configured milliseconds; the message shown to the model is built from it) */
class ToolTimeoutError extends Error {
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super(`TOOL_TIMEOUT after ${timeoutMs}ms`)
    this.name = 'ToolTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

/**
 * Cooperative tool timeout: bounds only **host wait time**; it does not force-terminate I/O
 * inside the tool (the tool still observes the signal itself).
 *
 * The underlying promise may still settle after the timeout: attach an empty catch so an
 * unhandled rejection cannot reach the process level.
 */
function withToolTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined): Promise<T> {
  if (!timeoutMs || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      promise.catch(() => {})
      reject(new ToolTimeoutError(timeoutMs))
    }, timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

/** Soft-warning threshold: at 75% of the cap, steer the model to wrap up once (no blocking, a single hint) */
export const SOFT_TOOL_CALL_WARN_RATIO = 0.75

/** Tool-call dedup key: name + normalized arguments (used by the loop guard) */
function toolCallKey(name: string, args: unknown): string {
  let argsText = ''
  try {
    argsText = JSON.stringify(args ?? {})
  } catch {
    argsText = String(args ?? '')
  }
  return `${name}:${argsText}`
}

/**
 * Tools exempt from the spill policy: read/search tools bound their own output (read_file 20K
 * plus offset/limit, grep capped at 100 matches, etc.), so they are not spilled twice —
 * otherwise "read the spilled file -> spill it again" would nest indefinitely.
 */
const SPILL_EXEMPT_TOOLS = new Set(['read_file', 'grep', 'ls', 'glob'])

/** Create the tool runner: execute tool calls and push lifecycle records */
function createToolRunner(
  tools: StructuredToolInterface[],
  queue?: QueueRef,
  subagentCtx?: SubAgentToolContext,
  spill?: SpillStore,
  /** Total tool-call cap (model-level "tool call rounds", defaults to the built-in value) */
  maxToolCalls: number = MAX_TOOL_CALLS,
  /** In-turn interjections: merge pending interjections into model context before the tool node runs (disabled when unset) */
  interject?: () => Promise<{ messages: HumanMessage[] } | null>
) {
  const toolsByName = new Map(tools.map((t) => [t.name, t]))
  const callLimit = Math.max(MIN_TOOL_CALLS, Math.floor(maxToolCalls))
  const softWarnAt = Math.max(1, Math.floor(callLimit * SOFT_TOOL_CALL_WARN_RATIO))

  // Loop-guard state (one instance per graph run, no cross-request leakage):
  // - 3 **identical results** in a row for the same (tool, arguments), or 4 identical calls in a
  //   row -> block and tell the model to wrap up;
  // - The criterion is "is there progress", not "how many calls in total": plugin-workshop
  //   build/verify/publish legitimately repeat with the same arguments, and a cumulative count
  //   would block a valid next step after the model has fixed the code
  //   (2026-11-23 incident: publish denied -> two retries -> the third call was blocked).
  const repeatGuard = new RepeatGuard()
  // Total-call guard: gentle reminder once at the soft threshold; everything past callLimit is blocked
  let totalCalls = 0
  let warnedSoft = false

  return async (
    state: { messages: BaseMessage[] },
    config: LangGraphRunnableConfig
  ): Promise<{ messages: BaseMessage[] }> => {
    // In-turn interjections: after this tool run the model continues with these user messages
    // (they follow the tool results, so OpenAI's tool_calls -> tool-result ordering still holds)
    const interjected = interject ? await interject() : null
    const injectedMessages: BaseMessage[] = interjected?.messages ?? []

    const lastMessage = state.messages[state.messages.length - 1]
    const toolCalls = (lastMessage as AIMessage).tool_calls
    if (!toolCalls || toolCalls.length === 0) {
      return { messages: injectedMessages }
    }

    const push = queue?.current
    const outputs: BaseMessage[] = []
    /** Images produced by tools this round: merged into one user message after all tool results land */
    const imageOutputs: Array<{ tool: string; image: ToolImage }> = []

    /**
     * Tool calls in one model reply are batched by parallel safety.
     *
     * - Calls with `isConcurrencySafe(args) === true` join one safe batch and run in parallel;
     * - All other calls (file writes, command execution, unknown tools, guard-blocked calls) form
     *   a barrier: wait for the preceding safe batch, then run exclusively, so dependent
     *   read-modify-write sequences are not reordered by parallelism.
     *
     * Results are still written back in the order the model gave, so frontend cards,
     * tool_call_id pairing and the loop guard are unchanged.
     */
    interface PendingToolCall {
      name: string
      callId: string
      args: Record<string, unknown>
      tool: StructuredToolInterface
      key: string
    }
    let safeBatch: PendingToolCall[] = []

    /** Push a result without executing the tool (guard/cap/unknown tool) while keeping record order */
    const pushSkipped = (
      name: string,
      callId: string,
      args: Record<string, unknown>,
      message: string
    ): void => {
      outputs.push(new ToolMessage({ content: message, tool_call_id: callId }))
      if (push) {
        const record: ToolCallRecord = {
          kind: 'tool_call',
          name,
          input: args,
          callId,
          output: Promise.resolve(message)
        }
        pushRecord(push, record, subagentCtx)
      }
    }

    /** Dispatch one tool call: returns text output and images; the promise also drives frontend card state */
    const dispatch = (
      item: PendingToolCall
    ): Promise<{ output: string; media: ToolImage[] }> => {
      const media: ToolImage[] = []
      const outputPromise = (async () => {
        try {
          const result = await withToolTimeout(
            item.tool.invoke(item.args, {
              ...config,
              configurable: { ...(config.configurable ?? {}), toolCallId: item.callId }
            }),
            item.tool.timeoutMs
          )
          if (isToolMediaResult(result)) {
            media.push(...result.images)
            return result.text
          }
          // Spill policy: overlong output is saved to a spill file and the model gets a preview
          // plus a locator instead of a hard truncation. Read/search tools bound their own output
          // and are exempt (to avoid read loops); without spill, keep the plain truncation.
          const formatted = formatOutput(result)
          return spill && !SPILL_EXEMPT_TOOLS.has(item.name)
            ? spill.trySpill(formatted)
            : formatted
        } catch (err) {
          if (err instanceof ToolTimeoutError) {
            logger.warn(`[Agent] Tool ${item.name} timed out after ${err.timeoutMs}ms`)
            return mainFormat(getAgentToolTexts().agent.toolTimeout, {
              name: item.name,
              ms: err.timeoutMs
            })
          }
          const message = err instanceof Error ? err.message : String(err)
          logger.warn(`[Agent] Tool ${item.name} failed:`, err)
          return mainFormat(getAgentToolTexts().agent.toolFailed, { message })
        }
      })()
      if (push) {
        const record: ToolCallRecord = {
          kind: 'tool_call',
          name: item.name,
          input: item.args,
          callId: item.callId,
          output: outputPromise,
          // Images ship with the result: stream producers/persistence render cards from them and replay them in later turns
          images: outputPromise.then(() => media)
        }
        pushRecord(push, record, subagentCtx)
      }
      return outputPromise.then((output) => ({ output, media }))
    }

    /** Finish one call: record loop-guard signal and the model-visible result (strict call order) */
    const finish = (
      item: PendingToolCall,
      result: { output: string; media: ToolImage[] }
    ): void => {
      // Record what this call produced: the next same-argument call uses it to detect wasted work
      repeatGuard.record(item.key, result.output)
      outputs.push(new ToolMessage({ content: result.output, tool_call_id: item.callId }))
      for (const image of result.media) imageOutputs.push({ tool: item.name, image })
    }

    /** Run the current safe batch in parallel, then finish calls in order */
    const flushSafeBatch = async (): Promise<void> => {
      if (safeBatch.length === 0) return
      const batch = safeBatch
      safeBatch = []
      const results = await Promise.all(batch.map((item) => dispatch(item)))
      for (let index = 0; index < batch.length; index++) {
        finish(batch[index], results[index])
      }
    }

    for (const call of toolCalls) {
      if (config.signal?.aborted) {
        const err = new Error('Tool call aborted')
        err.name = 'AbortError'
        throw err
      }

      // Fallback: some providers omit name / id
      const name = call.name ?? 'tool'
      const callId = call.id ?? `call_${Math.random().toString(36).slice(2, 10)}`
      const args = (call.args ?? {}) as Record<string, unknown>
      const tool = toolsByName.get(name)

      // Soft warning: steer wrap-up once near the cap (later calls are not blocked, so long tasks are not cut short)
      totalCalls++
      if (!warnedSoft && totalCalls >= softWarnAt) {
        warnedSoft = true
        await flushSafeBatch()
        pushSkipped(
          name,
          callId,
          args,
          `You have used ${totalCalls} tool calls in this conversation, which is a long task. If not essential, wrap up now and answer with the information you already have.`
        )
        continue
      }

      // Total-call guard: past the limit all calls are blocked and the model is told to answer directly
      if (totalCalls > callLimit) {
        await flushSafeBatch()
        pushSkipped(
          name,
          callId,
          args,
          `This conversation has reached its total limit of ${callLimit} tool calls (the tool call round cap). Stop calling tools now and answer directly with the information you already have.`
        )
        continue
      }

      // Loop guard: only repeated same-result same-argument calls count as a loop; skip the call and tell the model to wrap up
      const key = toolCallKey(name, args)
      const verdict = repeatGuard.check(key)
      if (verdict.blocked) {
        await flushSafeBatch()
        pushSkipped(name, callId, args, repeatGuardMessage(name, verdict))
        continue
      }

      if (!tool) {
        await flushSafeBatch()
        pushSkipped(
          name,
          callId,
          args,
          `The tool "${name}" does not exist or is not enabled. Available tools: ${[...toolsByName.keys()].join(', ')}`
        )
        continue
      }

      const item: PendingToolCall = { name, callId, args, tool, key }
      if (tool.isConcurrencySafe?.(args) === true) {
        safeBatch.push(item)
        continue
      }
      // Exclusive call: wait for the safe batch, then run alone (acts as a barrier)
      await flushSafeBatch()
      finish(item, await dispatch(item))
    }

    // Finish the final safe batch
    await flushSafeBatch()

    // Images from tools are appended after all tool messages of this turn: this keeps tool_calls
    // pairing intact and ensures the next model request can see them (image messages are
    // themselves part of the model-visible input).
    if (imageOutputs.length > 0) {
      const tr = getFsToolTexts()
      const content: MessageContentComplex[] = [
        {
          type: 'text',
          text: imageOutputs
            .map(({ tool, image }) =>
              mainFormat(tr.readImage.attached, { tool, path: image.path })
            )
            .join('\n')
        }
      ]
      for (const { image } of imageOutputs) {
        content.push({ type: 'image_url', image_url: { url: image.dataUrl } })
      }
      outputs.push(new HumanMessage({ content }))
    }

    return { messages: [...outputs, ...injectedMessages] }
  }
}

/** Build the compiled agent graph */
export function buildAgentGraph(options: BuildGraphOptions): CompiledAgentGraph {
  const { model, tools, systemPrompt } = options
  const queue = options.queue
  const subagentCtx = options.subagentCtx
  const spill = options.spill

  // Mutable model binding: after automatic retries are exhausted the user can switch models in
  // the ask dialog, and the new model continues with the same tools bound
  let modelWithTools = bindToolsSafely(model, tools)
  // Only one interjection handler instance is created, shared by the model and tool nodes
  // (take-on-consume on the queue side, so nothing is injected twice)
  const interject = createInterjectionHandler(options.drainInjections)
  const runTools = createToolRunner(
    tools,
    queue,
    subagentCtx,
    spill,
    options.maxToolCalls,
    interject
  )

  async function callModel(
    state: { messages: BaseMessage[] },
    config: LangGraphRunnableConfig
  ): Promise<{ messages: BaseMessage[] }> {
    // Merge pending interjections before the model call: this is the **main path** for
    // interjections — one added during a long answer is read by the next model call without
    // waiting for a tool node (measured 2026-09-20: hooking only tool nodes misses long answers
    // where no tool is called).
    const injected = interject ? await interject() : null
    const injectedMessages: BaseMessage[] = injected?.messages ?? []
    const contextMessages = [...state.messages, ...injectedMessages]
    const messages = [new SystemMessage(systemPrompt), ...contextMessages]
    const configurable = (config.configurable ?? {}) as Record<string, unknown>
    const topicId = typeof configurable.topicId === 'number' ? configurable.topicId : 0
    const turnSource =
      typeof configurable.turnSource === 'string' ? configurable.turnSource : 'user'
    // In-place automatic retry plus model-switch fallback for one LLM request: a failure does not
    // re-run the whole turn — executed tool results and message history stay intact in graph
    // state, and only the failed request is re-issued. The failure class decides whether to retry
    // (permanent errors such as "model does not support image input" fail immediately; see
    // model-recovery.ts). The subagent subgraph reuses callModel and retries in place too, but
    // pushes no progress records and shows no model-switch prompt.
    const response = await invokeWithModelRecovery({
      label: '[Agent]',
      ctx: { topicId, turnSource, signal: config.signal, askEnabled: !subagentCtx },
      call: () => modelWithTools.invoke(messages, config),
      // Main agent graph: push retry progress into the record queue (frontend shows a "retrying (N/2)" row)
      onRetry: (attempt, retries) => {
        if (!subagentCtx && queue?.current) {
          queue.current.push({ kind: 'retry_attempt', attempt, retries })
        }
      },
      onSwitch: (next) => {
        modelWithTools = bindToolsSafely(next, tools)
      }
    })
    // Real usage: usage_metadata reported by the model (the tool loop makes several calls; collect each and sum on persist)
    const usage = extractUsageMetadata(response)
    if (usage && options.usageSink) {
      options.usageSink.push({
        usage,
        model: resolveModelName(modelWithTools),
        subagent: Boolean(subagentCtx)
      })
    }
    // Injected interjections must be written back into graph state, otherwise they are visible
    // only in this call and lost on the next step: return order = interjections (human messages)
    // -> model reply, so "user interjection -> assistant response" stays in order in the history.
    return { messages: [...injectedMessages, response] }
  }

  async function callTools(
    state: { messages: BaseMessage[] },
    config: LangGraphRunnableConfig
  ): Promise<{ messages: BaseMessage[] }> {
    return await runTools(state, config)
  }

  function shouldContinue(state: { messages: BaseMessage[] }): string {
    const last = state.messages[state.messages.length - 1]
    if (last && (last as AIMessage).tool_calls && (last as AIMessage).tool_calls!.length > 0) {
      return 'tools'
    }
    return END
  }

  return new StateGraph(AgentState)
    .addNode('model', callModel)
    .addNode('tools', callTools)
    .addEdge(START, 'model')
    .addConditionalEdges('model', shouldContinue)
    .addEdge('tools', 'model')
    .compile()
}

/** Build graph input */
export function buildGraphInput(messages: BaseMessage[]): { messages: BaseMessage[] } {
  return { messages: [...messages] }
}

/** Type of the compiled agent graph (avoids depending on graph-engine generics directly) */
export type CompiledAgentGraph = CompiledStateGraph<
  { messages: BaseMessage[] },
  { messages?: BaseMessage[] }
>
