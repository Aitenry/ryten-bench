import type { BaseMessage } from '@langchain/core/messages'
import { AIMessage } from '@langchain/core/messages'
import { GraphRecursionError } from '@langchain/langgraph'
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
 * RecordQueue — 运行时事件队列（按流分流）
 *
 * 图执行（后台任务）把 RuntimeRecord 推入队列；push 时按 kind 路由到
 * messages / toolCalls / subagents 三个独立缓冲，每条记录恰好属于一个流，
 * 三个消费迭代器互不干扰（对应现有 producer 的三路并发模型）。
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

  /** 关闭全部子队列；可携带错误（图执行失败时由迭代器抛出） */
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

  /** 消息流迭代器 */
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

  /** 工具调用流迭代器 */
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

  /** 子代理流迭代器 */
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

/** 图执行配置 */
export interface GraphRunOptions {
  /** 递归上限（工程常量，远宽于工具护栏；触顶时优雅收尾） */
  recursionLimit: number
  signal?: AbortSignal
  /** 透传给工具节点的 configurable（如 turnSource / goalRound，供执行期权限校验） */
  configurable?: Record<string, unknown>
}

/** 工具调用轮次耗尽时的收尾提示（推送为文本记录，而非让整条流报错） */
export const RECURSION_STOP_NOTE = '\n(Tool call round limit reached; stopped automatically)'

/** 判断是否为 LangGraph 递归上限错误（instanceof 兜底 name 检查） */
function isRecursionError(err: unknown): boolean {
  return err instanceof GraphRecursionError || (err as Error)?.name === 'GraphRecursionError'
}

/**
 * 判断 chunk 是否来自子代理子图（嵌套在主图 tools 节点内执行）。
 *
 * LangGraph 的 streamMode ['messages'] 通过 CallbackManager 收集模型事件，
 * 子代理子图在主图 tools 节点内运行时，其模型调用事件会经 AsyncLocalStorage
 * 传播的 callbacks 冒泡到主图 stream（metadata 的 langgraph_checkpoint_ns
 * 形如 "tools:xxx"）。若不过滤，子智能体的 token 流会被当作主智能体文本
 * 推入主消息流，导致前端「主智能体内容 = 子智能体内容」的重复显示。
 */
function isSubgraphChunk(meta: unknown): boolean {
  if (typeof meta !== 'object' || meta === null) return false
  const ns = (meta as Record<string, unknown>).langgraph_checkpoint_ns
  if (typeof ns !== 'string' || !ns) return false
  // 主图 model 节点的 ns 形如 "model:xxx"；tools 节点内嵌套子图的 ns 形如 "tools:xxx"
  return !ns.startsWith('model:')
}

/**
 * 启动图流式执行并返回三路流适配器。
 * 图执行在后台进行（错误会关闭队列并由迭代器抛出）；AbortSignal 可随时取消。
 * queue 由调用方创建并注入（Runtime 需在建图前把队列注入 QueueRef，工具节点才能推送记录）。
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

  // 后台消费 LangGraph 的 messages 模式流，转换为统一记录。
  // 注意：messages 模式迭代元素为 [mode, [message, metadata]] 元组（payload 是二层结构）。
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
        // 过滤子代理子图冒泡的 chunk（其内容已由子代理子图独立流式转发为 sub_* 记录）
        if (isSubgraphChunk(payload[1])) continue
        pushMessageRecords(payload[0], queue, seenIndexes)
      }
      queue.close()
    } catch (err) {
      if (options.signal?.aborted) {
        logger.info('[Graph] 流已中止（用户取消或渲染进程失效）')
        queue.close()
        return
      }
      const error = err instanceof Error ? err : new Error(String(err))
      // 工具调用轮次耗尽：优雅收尾而非报错（保留已生成的部分内容，前端正常结束）
      if (isRecursionError(error)) {
        logger.warn('[Graph] 工具调用轮次已达上限，自动停止:', error.message)
        queue.push({ kind: 'text', text: RECURSION_STOP_NOTE })
        queue.close()
        return
      }
      logger.error('[Graph] 流式执行失败:', error)
      streamResult.error = error
      queue.close(error)
    }
  })()

  return streamResult
}

/**
 * 非流式执行：直接返回最终消息列表（sendMessage 路径）。
 * 递归上限触顶时返回收尾提示消息，而非向上抛错。
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
      logger.warn('[Graph] 工具调用轮次已达上限（非流式），返回收尾提示:', error.message)
      return [new AIMessage({ content: RECURSION_STOP_NOTE.trim() })]
    }
    throw err
  }
}
