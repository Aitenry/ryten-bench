import type { BaseMessage } from '../../ai/messages'
import { AIMessage } from '../../ai/messages'
import { GraphRecursionError } from '../../ai/graph'
import logger from 'electron-log'
import { pushMessageRecords, type CompiledAgentGraph, type StreamMessageLike } from './agent'
import type {
  MessageRecord,
  RuntimeRecord,
  RuntimeStream,
  SubAgentRecord,
  ToolCallRecord
} from './types'

/**
 * RecordQueue — runtime event queue (split by stream)
 *
 * Graph execution (a background task) pushes RuntimeRecords into the queue; on push each record is
 * routed by kind into one of three independent buffers — messages / toolCalls / subagents. Every
 * record belongs to exactly one stream, and the three consumer iterators never interfere with each
 * other (mirroring the producer's existing three-way concurrency model).
 */
export class RecordQueue {
  private readonly messages: MessageRecord[] = []
  private readonly toolCalls: ToolCallRecord[] = []
  private readonly subagents: SubAgentRecord[] = []
  private readonly waiters = {
    messages: [] as Array<() => void>,
    toolCalls: [] as Array<() => void>,
    subagents: [] as Array<() => void>
  }
  private readonly closed = {
    messages: false,
    toolCalls: false,
    subagents: false
  }
  private error?: Error

  push(record: RuntimeRecord): void {
    if (record.kind === 'tool_call') {
      if (this.closed.toolCalls) return
      this.toolCalls.push(record)
      this.waiters.toolCalls.shift()?.()
      return
    }
    if (
      record.kind === 'sub_start' ||
      record.kind === 'sub_reasoning' ||
      record.kind === 'sub_text' ||
      record.kind === 'sub_tool_call' ||
      record.kind === 'sub_tool_block_start' ||
      record.kind === 'sub_tool_args' ||
      record.kind === 'sub_end'
    ) {
      if (this.closed.subagents) return
      this.subagents.push(record)
      this.waiters.subagents.shift()?.()
      return
    }
    if (this.closed.messages) return
    this.messages.push(record)
    this.waiters.messages.shift()?.()
  }

  /** Close all sub-queues; an optional error is thrown by the iterators when graph execution fails */
  close(err?: Error): void {
    if (err) this.error = err
    for (const key of ['messages', 'toolCalls', 'subagents'] as const) {
      if (this.closed[key]) continue
      this.closed[key] = true
      while (this.waiters[key].length > 0) {
        this.waiters[key].shift()?.()
      }
    }
  }

  /** Message stream iterator */
  async *iterateMessages(): AsyncGenerator<MessageRecord> {
    while (true) {
      if (this.messages.length > 0) {
        yield this.messages.shift()!
        continue
      }
      if (this.closed.messages) {
        if (this.error) throw this.error
        return
      }
      await new Promise<void>((resolve) => this.waiters.messages.push(resolve))
    }
  }

  /** Tool call stream iterator */
  async *iterateToolCalls(): AsyncGenerator<ToolCallRecord> {
    while (true) {
      if (this.toolCalls.length > 0) {
        yield this.toolCalls.shift()!
        continue
      }
      if (this.closed.toolCalls) {
        if (this.error) throw this.error
        return
      }
      await new Promise<void>((resolve) => this.waiters.toolCalls.push(resolve))
    }
  }

  /** Subagent stream iterator */
  async *iterateSubAgents(): AsyncGenerator<SubAgentRecord> {
    while (true) {
      if (this.subagents.length > 0) {
        yield this.subagents.shift()!
        continue
      }
      if (this.closed.subagents) {
        if (this.error) throw this.error
        return
      }
      await new Promise<void>((resolve) => this.waiters.subagents.push(resolve))
    }
  }
}

/** Graph execution options */
export interface GraphRunOptions {
  /** Recursion limit (an engineering constant, far wider than the tool guards; wrap up gracefully when hit) */
  recursionLimit: number
  signal?: AbortSignal
  /** configurable passed through to tool nodes (e.g. turnSource / goalRound, for execution-time permission checks) */
  configurable?: Record<string, unknown>
}

/** Wrap-up note when tool call rounds are exhausted (pushed as a text record instead of failing the whole stream) */
export const RECURSION_STOP_NOTE = '\n(Tool call round limit reached; stopped automatically)'

/** Whether the error is a recursion-limit error (instanceof check, with a name fallback) */
function isRecursionError(err: unknown): boolean {
  return err instanceof GraphRecursionError || (err as Error)?.name === 'GraphRecursionError'
}

/**
 * Whether a chunk comes from a subagent subgraph (running nested inside the main graph's tools node).
 *
 * The messages stream mode collects model events through the CallbackManager; when a subagent
 * subgraph runs inside the main graph's tools node, its model-call events bubble up to the main
 * graph stream through AsyncLocalStorage-propagated callbacks (the metadata's
 * langgraph_checkpoint_ns looks like "tools:xxx"). Without filtering, the subagent's token stream
 * would be pushed into the main message stream as main-agent text, so the frontend would show the
 * subagent content duplicated as the main agent content.
 */
function isSubgraphChunk(meta: unknown): boolean {
  if (typeof meta !== 'object' || meta === null) return false
  const ns = (meta as Record<string, unknown>).langgraph_checkpoint_ns
  if (typeof ns !== 'string' || !ns) return false
  // The main graph's model node has an ns like "model:xxx"; a subgraph nested in the tools node has
  // an ns like "tools:xxx"
  return !ns.startsWith('model:')
}

/**
 * Start streaming graph execution and return the three-stream adapter.
 * Graph execution runs in the background (errors close the queue and are thrown by the iterators);
 * the AbortSignal can cancel it at any time. The queue is created and injected by the caller
 * (Runtime must inject the queue into QueueRef before building the graph so tool nodes can push
 * records).
 */
export function startGraphStream(
  graph: CompiledAgentGraph,
  input: { messages: BaseMessage[] },
  options: GraphRunOptions,
  queue: RecordQueue
): RuntimeStream {
  const seenIndexes = new Set<number>()
  const streamResult: RuntimeStream = {
    messages: queue.iterateMessages(),
    toolCalls: queue.iterateToolCalls(),
    subagents: queue.iterateSubAgents()
  }

  // Consume the messages-mode stream in the background and convert it into unified records.
  // Note: each element of the messages-mode stream is a [mode, [message, metadata]] tuple (the
  // payload is a two-level structure).
  void (async () => {
    try {
      const stream = await graph.stream(input, {
        streamMode: ['messages'] as const,
        recursionLimit: options.recursionLimit,
        signal: options.signal,
        configurable: options.configurable
      })
      for await (const item of stream) {
        const [mode, payload] = item as readonly [string, [StreamMessageLike, unknown]]
        if (mode !== 'messages') continue
        if (options.signal?.aborted) break
        // Drop chunks bubbling up from subagent subgraphs (their content is already streamed
        // separately as sub_* records)
        if (isSubgraphChunk(payload[1])) continue
        pushMessageRecords(payload[0], queue, seenIndexes)
      }
      queue.close()
    } catch (err) {
      if (options.signal?.aborted) {
        logger.info('[Graph] Stream aborted (user cancelled or renderer process failed)')
        queue.close()
        return
      }
      const error = err instanceof Error ? err : new Error(String(err))
      // Tool call rounds exhausted: wrap up gracefully instead of throwing (keep the partial content
      // already generated; the frontend ends normally)
      if (isRecursionError(error)) {
        logger.warn('[Graph] Tool call limit reached, stopping automatically:', error.message)
        queue.push({ kind: 'text', text: RECURSION_STOP_NOTE })
        queue.close()
        return
      }
      logger.error('[Graph] Streaming execution failed:', error)
      streamResult.error = error
      queue.close(error)
    }
  })()

  return streamResult
}

/**
 * Non-streaming execution: return the final message list directly (the sendMessage path).
 * When the recursion limit is hit, return a wrap-up note message instead of throwing.
 */
export async function invokeGraph(
  graph: CompiledAgentGraph,
  input: { messages: BaseMessage[] },
  options: GraphRunOptions
): Promise<BaseMessage[]> {
  try {
    const result = await graph.invoke(input, {
      recursionLimit: options.recursionLimit,
      signal: options.signal,
      configurable: options.configurable
    })
    const state = result as { messages?: BaseMessage[] }
    return state.messages ?? []
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err))
    if (isRecursionError(error)) {
      logger.warn('[Graph] Tool call limit reached (non-streaming), returning close-out hint:', error.message)
      return [new AIMessage({ content: RECURSION_STOP_NOTE.trim() })]
    }
    throw err
  }
}
