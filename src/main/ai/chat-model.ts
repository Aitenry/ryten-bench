/**
 * 自研 ChatModel 基类（替代 `@langchain/core/language_models/chat_models`）。
 *
 * 设计要点：
 * - `invoke()` 是唯一入口：内部**总是走流式 HTTP**，一边把增量块交给 `onModelChunk`
 *   （图执行时由 graph 注入，驱动前端逐 token 渲染），一边聚合出最终 `AIMessage`；
 * - `bindTools()` 返回一个轻量包装而不是修改原实例：主代理 / 子代理 / 并行工作流
 *   常常同时用同一个模型实例绑定不同工具集，改实例会互相串味；
 * - **不做任何内部重试**：重试预算统一由 harness/model-recovery 决定（旧实现里
 *   LangChain 的 6 次静默重发是「报错后还在重试」的根因之一）。
 */
import {
  AIMessage,
  AIMessageChunk,
  BaseMessage,
  contentToText,
  HumanMessage,
  InvalidToolCall,
  ToolCall,
  UsageMetadata
} from './messages'
import { ModelEmptyResponseError } from './http'
import type { StructuredToolInterface } from './tools'

/** 单次模型调用的选项（图执行时还会带上 configurable / signal / 流式回调） */
export type ModelCallOptions = {
  signal?: AbortSignal
  configurable?: Record<string, unknown>
  /** 增量块回调：由 graph 注入，用于 `streamMode: ['messages']` 的流式输出 */
  onModelChunk?: (chunk: AIMessageChunk) => void
  [key: string]: unknown
}

/** 一次模型调用的内部产出（各家供应商只需拼这个） */
export interface ModelResultParts {
  content: string
  reasoning?: string
  toolCalls: ToolCall[]
  invalidToolCalls?: InvalidToolCall[]
  usage?: UsageMetadata
  responseMetadata?: Record<string, unknown>
}

/** ChatModel 抽象基类 */
export abstract class BaseChatModel {
  /** 模型名（供日志 / 用量记录使用；旧实现按 model / modelName 读取） */
  abstract readonly model: string

  get modelName(): string {
    return this.model
  }

  /** 供应商协议名（日志 / 排查用） */
  get provider(): string {
    return 'unknown'
  }

  /** 子类实现：带指定工具集执行一次模型调用 */
  protected abstract _generate(
    messages: BaseMessage[],
    tools: StructuredToolInterface[],
    options: ModelCallOptions
  ): Promise<AIMessage>

  /** 公开入口：允许字符串提示词或消息数组 */
  async invoke(input: string | BaseMessage[], options?: ModelCallOptions): Promise<AIMessage> {
    const messages = typeof input === 'string' ? [new HumanMessage(input)] : input
    const opts = options ?? {}
    opts.signal?.throwIfAborted()
    return await this._generate(messages, [], opts)
  }

  /** 内部入口：由 bindTools 包装层调用（固定工具集） */
  async invokeWithTools(
    messages: BaseMessage[],
    tools: StructuredToolInterface[],
    options?: ModelCallOptions
  ): Promise<AIMessage> {
    const opts = options ?? {}
    opts.signal?.throwIfAborted()
    return await this._generate(messages, tools, opts)
  }

  /** 绑定工具：返回新实例，原实例不变（多个调用方并发绑定不同工具集是安全的） */
  bindTools(tools: StructuredToolInterface[]): BaseChatModel {
    return new BoundToolsChatModel(this, tools)
  }
}

/** 绑定了固定工具集的模型包装层 */
class BoundToolsChatModel extends BaseChatModel {
  constructor(
    private readonly base: BaseChatModel,
    private readonly tools: StructuredToolInterface[]
  ) {
    super()
  }

  get model(): string {
    return this.base.model
  }

  get provider(): string {
    return this.base.provider
  }

  protected _generate(
    messages: BaseMessage[],
    _tools: StructuredToolInterface[],
    options: ModelCallOptions
  ): Promise<AIMessage> {
    return this.base.invokeWithTools(messages, this.tools, options)
  }

  bindTools(tools: StructuredToolInterface[]): BaseChatModel {
    return new BoundToolsChatModel(this.base, tools)
  }
}

/** 工具参数 JSON 解析：失败时返回 error（保留原文供排查） */
function parseToolArguments(raw: string): {
  args: Record<string, unknown>
  error?: string
} {
  const text = raw.trim()
  if (!text) return { args: {} }
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { args: parsed as Record<string, unknown> }
    }
    return { args: {}, error: 'tool arguments must be a JSON object' }
  } catch (err) {
    return { args: {}, error: (err as Error).message }
  }
}

/** 一次已失败尝试（通常是流式）的现场快照，用于把两次尝试的诊断合并展示 */
export interface FallbackSnapshot {
  raw?: string
  reasoningOnly?: boolean
  finishReason?: string
}

/** 空响应守卫上下文（供应商 / 模型 / 已知状态码 / content-type） */
export interface EmptyResponseGuardContext {
  provider: string
  model: string
  /** 从供应商错误报文解析出的状态码（有就带给 model-recovery 做分类） */
  status?: number
  contentType?: string
  /** 前一次尝试（通常是流式）的现场；用于把两次尝试的报文一起展示 */
  previous?: FallbackSnapshot
}

/** 消息是否含有可用输出（正文或工具调用）；推理内容不算最终答复 */
export function hasMeaningfulOutput(message: AIMessage): boolean {
  return contentToText(message.content).trim().length > 0 || message.tool_calls.length > 0
}

/** 流式聚合器：供应商把协议增量喂进来，最终产出 AIMessage */
export class ModelStreamCollector {
  private textParts: string[] = []
  private reasoningParts: string[] = []
  private readonly toolCalls = new Map<number, { id?: string; name: string; argsText: string }>()
  private usageMetadata?: UsageMetadata
  private responseMetadata: Record<string, unknown> = {}
  private rawHead = ''
  private rawTail = ''
  private readonly sink?: (chunk: AIMessageChunk) => void

  constructor(sink?: (chunk: AIMessageChunk) => void) {
    this.sink = sink
  }

  /**
   * 记录原始响应片段（诊断空响应用）。
   *
   * 只保留头部 600 字符 + 尾部 300 字符：网关错误页/限流报文通常很短（头部即全文），
   * 而长流式响应出问题时最有价值的往往是最后几个事件。不会无限积累内存。
   */
  recordRaw(raw: unknown): void {
    const text =
      typeof raw === 'string'
        ? raw
        : (() => {
            try {
              return JSON.stringify(raw)
            } catch {
              return String(raw)
            }
          })()
    if (!text) return
    if (this.rawHead.length < 600) {
      this.rawHead += text.slice(0, 600 - this.rawHead.length)
    }
    this.rawTail = text.length > 300 ? text.slice(-300) : text
  }

  /** 供空响应错误使用的原始响应片段（头部 + 尾部） */
  get rawSnippet(): string | undefined {
    const head = this.rawHead.trim()
    if (!head) return undefined
    const tail = this.rawTail.trim()
    if (!tail || head.includes(tail)) return head
    return `${head} …[end of stream]… ${tail}`
  }

  /** 追加文本增量 */
  text(delta: string | undefined): void {
    if (!delta) return
    this.textParts.push(delta)
    this.sink?.(new AIMessageChunk({ content: delta }))
  }

  /** 追加推理（thinking / reasoning）增量 */
  reasoning(delta: string | undefined): void {
    if (!delta) return
    this.reasoningParts.push(delta)
    this.sink?.(
      new AIMessageChunk({
        content: '',
        additional_kwargs: { reasoning_content: delta }
      })
    )
  }

  /**
   * 追加工具调用增量。
   * - `name` / `id` 通常只在首块出现；
   * - `args` 是参数 JSON 的原始片段（流式时会被拆成多块）。
   */
  toolDelta(index: number, patch: { id?: string; name?: string; args?: string }): void {
    const current = this.toolCalls.get(index) ?? { name: '', argsText: '' }
    if (patch.id) current.id = patch.id
    if (patch.name) current.name = patch.name
    if (patch.args) current.argsText += patch.args
    this.toolCalls.set(index, current)
    this.sink?.(
      new AIMessageChunk({
        content: '',
        tool_call_chunks: [
          {
            index,
            id: patch.id,
            name: patch.name,
            args: patch.args
          }
        ]
      })
    )
  }

  /** 合并用量（协议通常只在收尾块给出） */
  usage(usage: UsageMetadata | undefined): void {
    if (!usage || Object.keys(usage).length === 0) return
    this.usageMetadata = { ...(this.usageMetadata ?? {}), ...usage }
  }

  /** 合并响应元信息（finish_reason / model 等） */
  metadata(patch: Record<string, unknown> | undefined): void {
    if (!patch) return
    this.responseMetadata = { ...this.responseMetadata, ...patch }
  }

  /** 聚合结果：解析工具参数、拼出最终 AIMessage */
  finalize(): AIMessage {
    const toolCalls: ToolCall[] = []
    const invalidToolCalls: InvalidToolCall[] = []
    const entries = [...this.toolCalls.entries()].sort(([a], [b]) => a - b)
    for (const [, call] of entries) {
      if (!call.name) continue
      const parsed = parseToolArguments(call.argsText)
      if (parsed.error) {
        invalidToolCalls.push({
          id: call.id,
          name: call.name,
          args: call.argsText,
          error: parsed.error
        })
        continue
      }
      toolCalls.push({
        id: call.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
        name: call.name,
        args: parsed.args,
        type: 'tool_call'
      })
    }
    const reasoning = this.reasoningParts.join('')
    return new AIMessage({
      content: this.textParts.join(''),
      tool_calls: toolCalls,
      invalid_tool_calls: invalidToolCalls.length > 0 ? invalidToolCalls : undefined,
      usage_metadata: this.usageMetadata,
      response_metadata: this.responseMetadata,
      additional_kwargs: reasoning ? { reasoning_content: reasoning } : undefined
    })
  }

  /**
   * 聚合结果，并在「没有任何可用输出」时抛出可读错误。
   *
   * 这是所有供应商的统一出口：HTTP 200 却拿到空流 / 错误页 / 只有 usage 的报文时，
   * 不会静默返回一条空消息（上层只会显示「模型未返回任何内容」），而是带上供应商、
   * 模型、finish_reason 与原始响应片段抛 `ModelEmptyResponseError`，让用户能直接看到
   * 服务商到底返回了什么。
   */
  finalizeOrThrow(context: EmptyResponseGuardContext): AIMessage {
    const message = this.finalize()
    if (hasMeaningfulOutput(message)) return message
    const currentFinishReason =
      typeof this.responseMetadata.finish_reason === 'string'
        ? this.responseMetadata.finish_reason
        : undefined
    const rawParts: string[] = []
    if (context.previous?.raw) rawParts.push(`streaming attempt: ${context.previous.raw}`)
    if (this.rawSnippet) rawParts.push(`non-streaming attempt: ${this.rawSnippet}`)
    throw new ModelEmptyResponseError({
      provider: context.provider,
      model: context.model,
      status: context.status,
      contentType: context.contentType,
      finishReason: context.previous?.finishReason ?? currentFinishReason,
      raw: rawParts.length > 0 ? rawParts.join(' | ') : undefined,
      reasoningOnly: this.reasoningParts.length > 0 || context.previous?.reasoningOnly === true,
      invalidToolCalls: message.invalid_tool_calls.length
    })
  }

  /** 是否有推理内容（用于空响应诊断） */
  get hasReasoning(): boolean {
    return this.reasoningParts.length > 0
  }

  /** 已记录的 finish_reason（可能还没收到） */
  get finishReason(): string | undefined {
    const value = this.responseMetadata.finish_reason
    return typeof value === 'string' ? value : undefined
  }

  /** 供非流式兜底使用的现场快照 */
  fallbackSnapshot(): FallbackSnapshot {
    return {
      raw: this.rawSnippet,
      reasoningOnly: this.hasReasoning,
      finishReason: this.finishReason
    }
  }

  /** 已产出的文本（供异常时保底展示） */
  get textSoFar(): string {
    return this.textParts.join('')
  }
}

/** 由协议报文拼一个完整 AIMessage（非流式路径 / 测试替身用） */
export function buildAIMessage(parts: ModelResultParts): AIMessage {
  return new AIMessage({
    content: parts.content,
    tool_calls: parts.toolCalls,
    invalid_tool_calls: parts.invalidToolCalls,
    usage_metadata: parts.usage,
    response_metadata: parts.responseMetadata,
    additional_kwargs: parts.reasoning ? { reasoning_content: parts.reasoning } : undefined
  })
}
