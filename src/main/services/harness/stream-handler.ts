import { BaseMessage } from '../../ai/messages'
import logger from 'electron-log'
import { mainFormat, mainMessages } from '../../i18n'
import { HarnessOptions, StructuredMessage, HistoryCompaction } from './types'
import { Runtime } from '../../runtime/harness/runtime'
import { planModeStore } from '../../runtime/harness/plan-mode'
import { teamModeStore } from '../../runtime/harness/team-mode'
import { buildHumanMessage } from './message-builder'
import type { UploadedFileRef } from './message-builder'
import type { ModelUsageRecord } from '../../runtime/harness/usage'
import { produceMessages, produceToolCalls, produceSubAgents } from './stream-producers'

/** HarnessService dependencies needed for stream processing (avoids circular imports) */
export interface StreamDeps {
  /** Create the runtime (in-house agent runtime) */
  createRuntime(): Runtime

  /** Load history context (including this turn's summary compaction info and compaction start/retry callbacks; signal is threaded through to summary compaction calls) */
  loadContextMessages(
    topicId: number,
    onCompactionStart?: () => void,
    contextBudget?: number,
    signal?: AbortSignal,
    onCompactionRetry?: (attempt: number, retries: number) => void,
    turnSource?: string,
    /** Current model context window (tokens): used when compaction pressure is judged by real token count */
    contextWindow?: number
  ): Promise<{ messages: BaseMessage[]; compaction?: HistoryCompaction }>

  /** Copy uploaded files into the agent workspace and return virtual path references */
  copyUploadedFiles(
    docs?: { fileName: string; filePath: string }[]
  ): Promise<UploadedFileRef[] | undefined>

  /** Real model usage for this turn (called after the stream ends and persistence has been decided; empty array on the first call if the model returned none) */
  onUsage?(records: ModelUsageRecord[]): void
}

/**
 * Send a message and stream the content back
 * @param deps HarnessService runtime and history loading methods
 * @param message User input
 * @param options Optional config (includes topicId for loading history)
 * @returns Async generator yielding StructuredMessage
 */
export async function* runStream(
  deps: StreamDeps,
  message: string,
  options?: HarnessOptions
): AsyncGenerator<StructuredMessage> {
  // Fix: previously JSON.stringify(options) wrote full image base64 into the log (several MB per
  // entry, including user screenshot content) and signal is not serializable — log key fields only
  logger.info(
    `[Harness] Stream options: topicId=${options?.topicId ?? 'none'}, images=${options?.images?.length ?? 0}, documents=${options?.documents?.length ?? 0}`
  )
  const signal = options?.signal

  try {
    // Plan mode is persisted per topic: the Runtime's prompt / tool list are assembled
    // synchronously, so backfill the flags into the in-memory cache first, ensuring the first turn
    // after process start also carries the correct mode.
    if (options?.topicId) {
      await planModeStore.ensure(options.topicId)
      await teamModeStore.ensure(options.topicId)
    }
    const runtime = deps.createRuntime()

    // The first chunk carries the hot memory injected for this turn; the frontend shows
    // "injected memory" at the top of the AI message
    const injection = runtime.memoryInjection
    if (injection) {
      yield { memoryInjected: injection }
    }

    const uploadedRefs = await deps.copyUploadedFiles(options?.documents)
    const userMessage = buildHumanMessage(message, options?.images, uploadedRefs)
    const context = options?.topicId
      ? await deps.loadContextMessages(
          options.topicId,
          options?.onCompactionStart,
          options?.contextBudget,
          signal,
          options?.onCompactionRetry,
          options?.turnMeta?.source,
          options?.contextWindow
        )
      : undefined
    const contextMessages = context?.messages ?? []
    logger.info(
      `[Harness] Passing ${contextMessages.length} context messages + 1 user message to runtime (topicId=${options?.topicId})`
    )
    if (contextMessages.length > 0) {
      logger.info(
        `[Harness] Context roles: ${contextMessages.map((m) => m._getType()).join(' → ')}`
      )
    }
    // Early conversation of this turn was compacted into a checkpoint: emit it before the body
    // stream starts; the frontend shows a compaction card at the top of the AI message
    if (context?.compaction) {
      yield { historyCompacted: context.compaction }
    }

    // Graph execution (automatic retries of model requests happen as in-place retries of a single
    // LLM call in the graph's model node — see agent.ts callModel: a failure retries only that one
    // request; executed tools and already-streamed content are all kept, the whole turn never reruns)
    const run = runtime.stream(
      [...contextMessages, userMessage],
      signal,
      options?.topicId,
      options?.turnMeta,
      // In-turn steering: drain user steering messages at tool node boundaries and merge them into
      // the model context (disabled when not configured)
      options?.drainInjections
    )

    // Use a queue to stream messages and tool calls concurrently
    const queue: StructuredMessage[] = []
    let waiting: (() => void) | null = null
    let producersAlive = 3
    // Count only real output (content/reasoning/tools/sub-agents); transitional signals such as
    // retry progress are excluded, so "retries exhausted with no content ever produced" still
    // takes the zero-output failure-text path
    let emittedCount = 0

    const enqueue = (item: StructuredMessage): void => {
      if (item.content || item.reasoning_content || item.tool || item.subAgent) emittedCount++
      queue.push(item)
      if (waiting) {
        waiting()
        waiting = null
      }
    }

    const markDone = (): void => {
      producersAlive--
      if (waiting) {
        waiting()
        waiting = null
      }
    }

    /** Safely get tool call output, catching rejections triggered by abort */
    const safeGetOutput = async (call: { output: unknown }): Promise<unknown> => {
      try {
        return await call.output
      } catch (err) {
        if (signal?.aborted) {
          const abortErr = new Error('Tool call aborted')
          abortErr.name = 'AbortError'
          throw abortErr
        }
        throw err
      }
    }

    // Shared flag: after tool execution starts (model message ends), the message producer stops the
    // "building arguments" keep-alive to prevent completed tool cards from being revived (user
    // report: do not block); reset when a new model output round starts
    const toolsStarted = { value: false }

    // Shared flag: "does this segment belong to this turn's final answer" (protocol-level source of
    // truth). Defaults to true while content streams; flips to false (retracted) as soon as
    // tool/sub-agent activity appears, and is set back to true for the body of a new model output
    // round — the last segment left is this turn's answer. The renderer places the answer outside
    // the task collapse based on this, no longer guessing from its own loading state (see
    // answer-boundary.ts).
    const answerMark = { value: true }

    // Start the three producers
    const msgProducer = produceMessages(
      run,
      signal,
      enqueue,
      markDone,
      toolsStarted,
      // In-turn steering: the message stream drains pending steering messages at the segment
      // boundary where this round's tools have all been emitted
      options?.drainInjections,
      answerMark
    ).catch(() => {})
    const toolProducer = produceToolCalls(
      run,
      signal,
      enqueue,
      markDone,
      safeGetOutput,
      toolsStarted,
      options?.topicId,
      // Drain once after each tool call is emitted as completed (the window where tools haven't
      // started executing is covered by the message stream's guarded drain)
      options?.drainInjections,
      answerMark
    ).catch(() => {})
    const subAgentProducer = produceSubAgents(
      run,
      signal,
      enqueue,
      markDone,
      safeGetOutput,
      options?.topicId,
      answerMark
    ).catch(() => {})

    // Main consumer loop: take from the queue and yield
    while (producersAlive > 0 || queue.length > 0) {
      if (signal?.aborted) {
        break
      }
      if (queue.length > 0) {
        yield queue.shift()!
      } else if (producersAlive > 0) {
        await new Promise<void>((resolve) => {
          waiting = resolve
        })
      }
    }

    // Wait for all producers to finish (catching potential errors)
    await Promise.allSettled([msgProducer, toolProducer, subAgentProducer])

    // Forward graph execution failures (reached only when the model node's in-place retry / fallback
    // model have both failed):
    // - zero output: emit the failure text directly;
    // - some output already emitted: emit the streamError marker; the IPC layer forwards the error
    //   event and skips persistence
    if (run.error && !signal?.aborted) {
      if (emittedCount === 0) {
        logger.error('[Harness] Runtime failed with no output:', run.error)
        yield {
          content: mainFormat(mainMessages().error.responseFailed, { reason: run.error.message })
        }
      } else {
        logger.error('[Harness] Runtime failed after partial output:', run.error)
        yield { streamError: { message: run.error.message } }
      }
    } else if (emittedCount === 0 && !signal?.aborted) {
      logger.warn('[Harness] Runtime produced no output (no error info)')
      const m = mainMessages().error
      yield { content: mainFormat(m.responseFailed, { reason: m.emptyModelResponse }) }
    }

    // Real usage for this turn: handed to the caller (IPC layer) to write into
    // harness_dialogue_usage after the assistant message is persisted
    deps.onUsage?.(runtime.usage)
  } catch (error) {
    logger.error('Error in sendMessageStream:', error)
    yield {
      content: mainFormat(mainMessages().error.responseFailed, { reason: String(error) })
    }
  }
}
