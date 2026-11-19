import { BaseMessage } from '@langchain/core/messages'
import logger from 'electron-log'
import { mainFormat, mainMessages } from '../../../../main/i18n'
import { HarnessOptions, StructuredMessage, HistoryCompaction } from '../types'
import { Runtime } from '../runtime/runtime'
import { buildHumanMessage } from './message-builder'
import type { UploadedFileRef } from './message-builder'
import type { ModelUsageRecord } from '../runtime/usage'
import { produceMessages, produceToolCalls, produceSubAgents } from './stream-producers'

/** 流式处理所需的 HarnessService 依赖（避免循环引用） */
export interface StreamDeps {
  /** 创建运行时（LangChain/LangGraph） */
  createRuntime(): Runtime

  /** 加载历史上下文（含本轮摘要压缩信息与压缩开始/重试回调；signal 贯通到摘要压缩调用） */
  loadContextMessages(
    topicId: number,
    onCompactionStart?: () => void,
    contextBudget?: number,
    signal?: AbortSignal,
    onCompactionRetry?: (attempt: number, retries: number) => void,
    turnSource?: string
  ): Promise<{ messages: BaseMessage[]; compaction?: HistoryCompaction }>

  /** 将上传文件复制到 agent 工作区，返回虚拟路径引用 */
  copyUploadedFiles(
    docs?: { fileName: string; filePath: string }[]
  ): Promise<UploadedFileRef[] | undefined>

  /** 本轮模型真实用量（流结束、判定是否落库之后回调；模型未回传时为首次空数组） */
  onUsage?(records: ModelUsageRecord[]): void
}

/**
 * 发送消息并以流式方式返回内容
 * @param deps HarnessService 的运行时和历史加载方法
 * @param message 用户输入
 * @param options 可选配置（含 topicId 用于加载历史）
 * @returns 异步生成器，返回 StructuredMessage
 */
export async function* runStream(
  deps: StreamDeps,
  message: string,
  options?: HarnessOptions
): AsyncGenerator<StructuredMessage> {
  // 修复：此前 JSON.stringify(options) 会把图片 base64 整张写进日志（数 MB/条，含用户截图内容）
  // 且 signal 不可序列化——改为只记录关键字段
  logger.info(
    `[Harness] Stream options: topicId=${options?.topicId ?? 'none'}, images=${options?.images?.length ?? 0}, documents=${options?.documents?.length ?? 0}`
  )
  const signal = options?.signal

  try {
    const runtime = deps.createRuntime()

    // 首个 chunk 下发本轮注入的热记忆内容，前端在 AI 消息顶部显示「注入记忆」
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
          options?.turnMeta?.source
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
    // 本轮早期对话被压缩为 checkpoint：在正文流开始前下发，前端在 AI 消息顶部显示压缩卡片
    if (context?.compaction) {
      yield { historyCompacted: context.compaction }
    }

    // 图执行（模型请求的自动重试发生在图内 model 节点对单次 LLM 调用的原地重试上
    // ——见 agent.ts callModel：失败只重试那一次请求，已执行工具与已流出内容全部保留，不会整轮重跑）
    const run = runtime.stream(
      [...contextMessages, userMessage],
      signal,
      options?.topicId,
      options?.turnMeta,
      // 回合内插话（steering）：工具节点边界排空用户插话并并入模型上下文（未配置则关闭）
      options?.drainInjections
    )

    // 使用队列实现消息和工具调用的并发流式输出
    const queue: StructuredMessage[] = []
    let waiting: (() => void) | null = null
    let producersAlive = 3
    // 仅统计真实输出（正文/推理/工具/子代理）；重试进度等过渡信号不计入，
    // 使「重试耗尽且从未产出内容」仍走零输出失败文本路径
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

    /** 安全获取 tool call output，捕获 abort 触发的 rejection */
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

    // 共享标志：工具开始执行（模型消息结束）后，消息生产者停止「参数构建中」保活，
    // 防止已完成的工具卡被复活（用户报障：不要阻塞）；新一轮模型输出开始时重置
    const toolsStarted = { value: false }

    // 共享标志：「本段内容是否属于这一轮的最终答复」（协议层真源）。
    // 内容流出时默认为 true，一旦出现工具/子代理活动就翻 false（撤回），
    // 新一轮模型输出的正文重新打 true——最后留下的那一段才是这一轮的答复。
    // 渲染端据此把答复摆在任务折叠之外，不再靠自己的 loading 状态猜（见 answer-boundary.ts）。
    const answerMark = { value: true }

    // 启动三个生产者
    const msgProducer = produceMessages(
      run,
      signal,
      enqueue,
      markDone,
      toolsStarted,
      // 回合内插话：消息流在「本轮工具已完成下发」的段落边界排空待注入插话
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
      // 每条工具调用完成下发后也排空一次（工具尚未开始执行的窗口由消息流守卫排空兜底）
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

    // 主消费者循环：从队列中取出并 yield
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

    // 等待所有生产者完成（捕获潜在错误）
    await Promise.allSettled([msgProducer, toolProducer, subAgentProducer])

    // 图执行失败透传（model 节点内部自动重试/换模型兜底均已失效时才走到这里）：
    // - 零输出：直接下发失败文本；
    // - 已有输出：下发 streamError 标记，由 IPC 层转发错误事件并跳过落库
    if (run.error && !signal?.aborted) {
      if (emittedCount === 0) {
        logger.error('[Harness] 运行时执行失败，无任何输出:', run.error)
        yield {
          content: mainFormat(mainMessages().error.responseFailed, { reason: run.error.message })
        }
      } else {
        logger.error('[Harness] 运行时部分输出后失败:', run.error)
        yield { streamError: { message: run.error.message } }
      }
    } else if (emittedCount === 0 && !signal?.aborted) {
      logger.warn('[Harness] 运行时未产生任何输出（无错误信息）')
      const m = mainMessages().error
      yield { content: mainFormat(m.responseFailed, { reason: m.emptyModelResponse }) }
    }

    // 本轮真实用量：交给调用方（IPC 层）在助手消息落库后写入 harness_dialogue_usage
    deps.onUsage?.(runtime.usage)
  } catch (error) {
    logger.error('Error in sendMessageStream:', error)
    yield {
      content: mainFormat(mainMessages().error.responseFailed, { reason: String(error) })
    }
  }
}
