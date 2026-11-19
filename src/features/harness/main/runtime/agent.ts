import {
  Annotation,
  CompiledStateGraph,
  END,
  START,
  StateGraph,
  type LangGraphRunnableConfig,
  type OverwriteValue
} from '@langchain/langgraph'
import { BaseChatModel } from '@langchain/core/language_models/chat_models'
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage
} from '@langchain/core/messages'
import type { StructuredToolInterface } from '@langchain/core/tools'
import logger from 'electron-log'
import type { RuntimeRecord, ToolCallRecord } from './types'
// 插话注入载荷的单一真源在 ../types（IPC 层与图共用同一个类型，避免结构漂移）
import type { AgentInjection } from '../types'
import { formatOutput } from './fs-backend'
import type { SpillStore } from './spill'
import { invokeWithModelRecovery } from './model-recovery'
// 流式记录转换独立模块（可被测试脚本直接验证）：此处导入并兼容性重导出
import { pushMessageRecords, pushRecord, type StreamMessageLike } from './stream-records'
import { extractUsageMetadata, type ModelUsageRecord } from './usage'
import { mainFormat } from '../../../../main/i18n'
import { getAgentToolTexts } from '../../../../main/i18n/tool-results-agent'

export { pushMessageRecords, pushRecord }

/** 取当前模型的名称（LangChain 各家字段不同，兜一遍；取不到就留空由调用方补） */
function resolveModelName(model: BaseChatModel): string | undefined {
  const candidate = model as unknown as { model?: unknown; modelName?: unknown }
  if (typeof candidate.model === 'string' && candidate.model) return candidate.model
  if (typeof candidate.modelName === 'string' && candidate.modelName) return candidate.modelName
  return undefined
}

export type { StreamMessageLike }

/**
 * LangGraph Agent 图 — 替代 deepagents createDeepAgent
 *
 * 图结构（显式可审计）：
 *   START → model（LLM，绑定工具）→ 有工具调用 ? tools（自定义工具节点）→ model
 *                                       └ 无工具调用 → END
 *
 * 工具节点通过闭包共享的 RecordQueue 推送 tool_call 记录（output 为 Promise），
 * 驱动前端 executing → completed 状态；AbortSignal 在中途检查并抛错终止。
 */

/** 图状态：消息列表（追加式 reducer） */
export const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (left, right) => left.concat(right),
    default: () => []
  })
})

export type AgentStateType = typeof AgentState

/** 工具节点上下文字段：在子代理图中标记记录归属 */
export interface SubAgentToolContext {
  name: string
  causeId: string
}

/** 可变队列引用：图在请求级构建，队列在 stream 时创建并注入 */
export interface QueueRef {
  current?: {
    push(record: RuntimeRecord): void
  }
}

export interface BuildGraphOptions {
  model: BaseChatModel
  tools: StructuredToolInterface[]
  systemPrompt: string
  /** 记录队列引用（流式时注入 current；非流式 invoke 为 undefined） */
  queue?: QueueRef
  /** 子代理上下文（子代理图专用；主代理图不设置） */
  subagentCtx?: SubAgentToolContext
  /** 工具结果溢出存储（超长输出保存为文件 + 返回预览/定位符；未配置则保持截断行为） */
  spill?: SpillStore
  /** 用量采集：每次模型调用成功后就地推入一条真实 usage_metadata（未回传则不推） */
  usageSink?: { push(record: ModelUsageRecord): void }
  /** 工具调用总次数上限（模型级「工具调用轮数」；缺省用工程默认值 MAX_TOOL_CALLS） */
  maxToolCalls?: number
  /**
   * 待注入插话的排空回调：每个工具节点执行前调用一次。
   * 返回待并入模型上下文的用户插话（已从队列取出）；无插话返回 null。
   */
  drainInjections?: () => Promise<AgentInjection[] | null>
}

/**
 * 生成「回合内插话」处理器：把待注入的插话取出并转成模型可读的人类消息。
 *
 * 调用点有两处，缺一不可（2026-09-20 实测教训：只有工具节点会漏掉「整轮不调用工具」的情形）：
 * - **模型节点调用前**（主路径）：模型每被调用一次就是一次「能读到插话」的机会。
 *   例如长回答途中插话——下一次模型调用即可读到，无需等工具；
 * - **工具节点执行前**（补充）：本次工具结果已就绪、模型即将开始下一步，
 *   此时注入可让插话紧跟工具结果之后的模型调用生效，且注入的 HumanMessage
 *   排在 ToolMessage 之后，OpenAI「tool_calls 后必须紧跟工具结果」的约束不受影响。
 *
 * 排空是"取出即消费"（队列侧 takeInjections），两个调用点共用同一个闭包实例，
 * 因此同一条插话只会被取出一次、只注入一次。
 * 无插话时返回 null，调用方保持原有返回值，零开销。
 */
function createInterjectionHandler(
  drain?: () => Promise<AgentInjection[] | null>
): (() => Promise<{ messages: HumanMessage[] } | null>) | undefined {
  if (!drain) return undefined
  return async () => {
    const injected = await drain()
    if (!injected || injected.length === 0) return null
    logger.info(`[Agent] 插话已并入模型上下文（${injected.length} 条）`)
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

/** 安全绑定工具：不支持工具调用的模型退化为纯对话（组件降级而非报错） */
function bindToolsSafely(model: BaseChatModel, tools: StructuredToolInterface[]): BaseChatModel {
  if (tools.length === 0) return model
  try {
    const bound = model.bindTools?.(tools)
    return bound ? (bound as BaseChatModel) : model
  } catch (err) {
    logger.warn('[Agent] 模型不支持工具调用，退化为纯对话模式:', err)
    return model
  }
}

/**
 * 工程内部工具调用总次数护栏的默认值（模型「高级配置 → 工具调用轮数」可覆盖）：
 * 用户可随时通过「停止」按钮终止；接近上限时先温和引导收尾，避免合法长任务被生硬截断。
 */
export const MAX_TOOL_CALLS = 200

/** 兜底下限：模型设置里填了过小的值也不至于一步都跑不完 */
export const MIN_TOOL_CALLS = 10

/** 渐进提醒阈值：累计调用达到上限的 75% 时引导模型收尾一次（不拦截，仅提示一次） */
export const SOFT_TOOL_CALL_WARN_RATIO = 0.75

/** 工具调用去重键：名称 + 规范化参数（用于防循环护栏） */
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
 * 溢出策略豁免工具集：文件读取/搜索工具自带输出边界（read_file 20K + offset/limit、
 * grep 100 条匹配上限等），不再二次溢出——否则「读溢出文件 → 再次溢出」会无限套娃
 * （参考 dsh-spill-policy 对 read 类工具的豁免）。
 */
const SPILL_EXEMPT_TOOLS = new Set(['read_file', 'grep', 'ls', 'glob'])

/** 创建工具执行器：执行工具调用并推送生命周期记录 */
function createToolRunner(
  tools: StructuredToolInterface[],
  queue?: QueueRef,
  subagentCtx?: SubAgentToolContext,
  spill?: SpillStore,
  /** 工具调用总次数上限（模型级「工具调用轮数」，缺省用工程默认值） */
  maxToolCalls: number = MAX_TOOL_CALLS,
  /** 回合内插话：工具节点执行前把待注入的插话并入模型上下文（未配置则不启用） */
  interject?: () => Promise<{ messages: HumanMessage[] } | null>
) {
  const toolsByName = new Map(tools.map((t) => [t.name, t]))
  const callLimit = Math.max(MIN_TOOL_CALLS, Math.floor(maxToolCalls))
  const softWarnAt = Math.max(1, Math.floor(callLimit * SOFT_TOOL_CALL_WARN_RATIO))

  // 防循环护栏状态（每次图执行为一个实例，无跨请求泄漏）：
  // - 同一 (工具, 参数) 累计调用 >= 3 次，或连续重复 >= 2 次 → 拦截并提示模型收尾，
  //   避免模型卡死在重复调用中烧光递归预算（GraphRecursionError）。
  const callCounts = new Map<string, number>()
  let prevCallKey: string | undefined
  // 总调用次数护栏：累计达到渐进阈值时温和提醒一次；超过 callLimit 后一律拦截
  let totalCalls = 0
  let warnedSoft = false

  return async (
    state: { messages: BaseMessage[] },
    config: LangGraphRunnableConfig
  ): Promise<{ messages: BaseMessage[] }> => {
    // 回合内插话：本次工具执行完，模型下一步就会带着这些用户消息继续
    //（排在工具结果之后，OpenAI 的「tool_calls 后必须紧跟工具结果」约束不受影响）
    const interjected = interject ? await interject() : null
    const injectedMessages: BaseMessage[] = interjected?.messages ?? []

    const lastMessage = state.messages[state.messages.length - 1]
    const toolCalls = (lastMessage as AIMessage).tool_calls
    if (!toolCalls || toolCalls.length === 0) {
      return { messages: injectedMessages }
    }

    const push = queue?.current
    const outputs: BaseMessage[] = []
    for (const call of toolCalls) {
      if (config.signal?.aborted) {
        const err = new Error('Tool call aborted')
        err.name = 'AbortError'
        throw err
      }

      // 兜底：部分 provider 可能缺 name / id
      const name = call.name ?? 'tool'
      const callId = call.id ?? `call_${Math.random().toString(36).slice(2, 10)}`
      const tool = toolsByName.get(name)

      // 渐进提醒：接近上限时引导收尾一次（不拦截后续调用，避免合法长任务被生硬截断）
      totalCalls++
      if (!warnedSoft && totalCalls >= softWarnAt) {
        warnedSoft = true
        const msg = `You have used ${totalCalls} tool calls in this conversation, which is a long task. If not essential, wrap up now and answer with the information you already have.`
        outputs.push(new ToolMessage({ content: msg, tool_call_id: callId }))
        if (push) {
          const record: ToolCallRecord = {
            kind: 'tool_call',
            name,
            input: call.args,
            callId,
            output: Promise.resolve(msg)
          }
          pushRecord(push, record, subagentCtx)
        }
        continue
      }

      // 总次数护栏：累计调用超过限额后一律拦截，指示模型直接回答
      if (totalCalls > callLimit) {
        const msg = `This conversation has reached its total limit of ${callLimit} tool calls (the tool call round cap). Stop calling tools now and answer directly with the information you already have.`
        outputs.push(new ToolMessage({ content: msg, tool_call_id: callId }))
        if (push) {
          const record: ToolCallRecord = {
            kind: 'tool_call',
            name,
            input: call.args,
            callId,
            output: Promise.resolve(msg)
          }
          pushRecord(push, record, subagentCtx)
        }
        continue
      }

      // 防循环护栏：识别重复调用（相同工具 + 完全相同参数），不执行并指示模型收尾
      const key = toolCallKey(name, call.args)
      const count = (callCounts.get(key) ?? 0) + 1
      callCounts.set(key, count)
      const isLoop = key === prevCallKey ? count >= 2 : count >= 3
      prevCallKey = key
      if (isLoop) {
        const msg = `The tool "${name}" has already been called ${count} times with exactly the same arguments. Stop repeating this call and answer directly with the information you already have.`
        outputs.push(new ToolMessage({ content: msg, tool_call_id: callId }))
        if (push) {
          const record: ToolCallRecord = {
            kind: 'tool_call',
            name,
            input: call.args,
            callId,
            output: Promise.resolve(msg)
          }
          pushRecord(push, record, subagentCtx)
        }
        continue
      }

      if (!tool) {
        const msg = `The tool "${name}" does not exist or is not enabled. Available tools: ${[...toolsByName.keys()].join(', ')}`
        outputs.push(new ToolMessage({ content: msg, tool_call_id: callId }))
        if (push) {
          const record: ToolCallRecord = {
            kind: 'tool_call',
            name,
            input: call.args,
            callId,
            output: Promise.resolve(msg)
          }
          pushRecord(push, record, subagentCtx)
        }
        continue
      }

      // 工具执行异步进行；output Promise 驱动前端 executing → completed
      const outputPromise = (async () => {
        try {
          const result = await tool.invoke(call.args, {
            ...config,
            configurable: { ...(config.configurable ?? {}), toolCallId: callId }
          })
          // 溢出策略：超长输出保存为溢出文件，模型拿到「预览 + 定位符」而非硬截断。
          // 文件读取/搜索工具自带边界，豁免溢出（防 read 循环）；spill 未配置时保持原有截断行为
          const formatted = formatOutput(result)
          return spill && !SPILL_EXEMPT_TOOLS.has(name) ? spill.trySpill(formatted) : formatted
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          logger.warn(`[Agent] 工具 ${name} 执行失败:`, err)
          return mainFormat(getAgentToolTexts().agent.toolFailed, { message })
        }
      })()

      if (push) {
        const record: ToolCallRecord = {
          kind: 'tool_call',
          name,
          input: call.args,
          callId,
          output: outputPromise
        }
        pushRecord(push, record, subagentCtx)
      }

      const output = await outputPromise
      outputs.push(new ToolMessage({ content: output, tool_call_id: callId }))
    }

    return { messages: [...outputs, ...injectedMessages] }
  }
}

/** 构建编译后的 Agent 图 */
export function buildAgentGraph(
  options: BuildGraphOptions
): CompiledStateGraph<
  { messages: BaseMessage[] },
  { messages?: BaseMessage[] | OverwriteValue<BaseMessage[]> | undefined },
  'model' | 'tools' | typeof START
> {
  const { model, tools, systemPrompt } = options
  const queue = options.queue
  const subagentCtx = options.subagentCtx
  const spill = options.spill

  // 可变模型绑定：自动重试耗尽后用户可在提问弹窗里切换模型，切换后绑定同一批工具继续
  let modelWithTools = bindToolsSafely(model, tools)
  // 插话处理器只建一个实例，模型节点与工具节点共用（队列侧"取出即消费"，不会重复注入）
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
    // 模型调用前先并进待注入的插话：这是插话生效的**主路径**——
    // 长回答途中插话时，下一次模型调用就能读到，不必等工具节点
    //（2026-09-20 实测：只挂工具节点会漏掉「整轮不调用工具」的长回答）
    const injected = interject ? await interject() : null
    const injectedMessages: BaseMessage[] = injected?.messages ?? []
    const contextMessages = [...state.messages, ...injectedMessages]
    const messages = [new SystemMessage(systemPrompt), ...contextMessages]
    const configurable = (config.configurable ?? {}) as Record<string, unknown>
    const topicId = typeof configurable.topicId === 'number' ? configurable.topicId : 0
    const turnSource =
      typeof configurable.turnSource === 'string' ? configurable.turnSource : 'user'
    // 单次 LLM 请求的原地自动重试 + 换模型兜底：失败不整轮重跑——已执行的工具结果与消息历史
    // 都在图状态里原样保留，这里只把失败的这一次请求重新发出。是否重试由失败分类决定
    //（永久性错误如「模型不支持图片输入」直接报错，不再重试；见 model-recovery.ts）。
    // 子代理子图复用同一 callModel，同样原地重试，但不推送进度记录/不弹换模型提问。
    const response = await invokeWithModelRecovery({
      label: '[Agent]',
      ctx: { topicId, turnSource, signal: config.signal, askEnabled: !subagentCtx },
      call: () => modelWithTools.invoke(messages, config),
      // 主代理图：把重试进度推入记录队列（前端展示「正在重试（第 N/2 次）」过渡行）
      onRetry: (attempt, retries) => {
        if (!subagentCtx && queue?.current) {
          queue.current.push({ kind: 'retry_attempt', attempt, retries })
        }
      },
      onSwitch: (next) => {
        modelWithTools = bindToolsSafely(next, tools)
      }
    })
    // 真实用量：模型回传的 usage_metadata（工具循环会多次调用，逐次采集，落库时累加）
    const usage = extractUsageMetadata(response)
    if (usage && options.usageSink) {
      options.usageSink.push({
        usage,
        model: resolveModelName(modelWithTools),
        subagent: Boolean(subagentCtx)
      })
    }
    // 注入的插话必须一起写回图状态，否则它只在这一调用里可见、下一步就丢了：
    // 返回顺序 = 插话（人类消息）→ 模型回复，保证「用户插话 → 助手回应」在历史里顺序正确
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

/** 构造图输入 */
export function buildGraphInput(messages: BaseMessage[]): { messages: BaseMessage[] } {
  return { messages: [...messages] }
}

/** 编译后 Agent 图的类型（避免直接依赖 LangGraph 泛型参数） */
export type CompiledAgentGraph = ReturnType<typeof buildAgentGraph>
