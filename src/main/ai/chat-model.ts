/**
 * Self-contained ChatModel base class.
 *
 * Design notes:
 * - `invoke()` is the only entry point: internally it **always uses streaming HTTP**, handing
 *   incremental chunks to `onModelChunk` (injected by graph during graph execution, driving
 *   token-by-token rendering in the frontend) while aggregating the final `AIMessage`;
 * - `bindTools()` returns a lightweight wrapper instead of mutating the original instance: the
 *   main agent / sub-agents / parallel workflows often bind different tool sets to the same model
 *   instance at the same time, and mutating the instance would leak state between them;
 * - **no internal retries**: the retry budget is decided centrally by harness/model-recovery (the
 *   previous implementation's 6 silent resends were one of the root causes of "still retrying
 *   after an error").
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

/** Options for a single model call (graph execution also passes configurable / signal / streaming callbacks) */
export type ModelCallOptions = {
  signal?: AbortSignal
  configurable?: Record<string, unknown>
  /** Incremental chunk callback: injected by graph, used for `streamMode: ['messages']` streaming output */
  onModelChunk?: (chunk: AIMessageChunk) => void
  [key: string]: unknown
}

/** Internal output of one model call (each provider only needs to assemble this) */
export interface ModelResultParts {
  content: string
  reasoning?: string
  toolCalls: ToolCall[]
  invalidToolCalls?: InvalidToolCall[]
  usage?: UsageMetadata
  responseMetadata?: Record<string, unknown>
}

/** ChatModel abstract base class */
export abstract class BaseChatModel {
  /** Model name (for logging / usage records; the previous implementation read it as model / modelName) */
  abstract readonly model: string

  get modelName(): string {
    return this.model
  }

  /** Provider protocol name (for logging / troubleshooting) */
  get provider(): string {
    return 'unknown'
  }

  /** Implemented by subclasses: run one model call with the given tool set */
  protected abstract _generate(
    messages: BaseMessage[],
    tools: StructuredToolInterface[],
    options: ModelCallOptions
  ): Promise<AIMessage>

  /** Public entry point: accepts a string prompt or a message array */
  async invoke(input: string | BaseMessage[], options?: ModelCallOptions): Promise<AIMessage> {
    const messages = typeof input === 'string' ? [new HumanMessage(input)] : input
    const opts = options ?? {}
    opts.signal?.throwIfAborted()
    return await this._generate(messages, [], opts)
  }

  /** Internal entry point: called by the bindTools wrapper layer (fixed tool set) */
  async invokeWithTools(
    messages: BaseMessage[],
    tools: StructuredToolInterface[],
    options?: ModelCallOptions
  ): Promise<AIMessage> {
    const opts = options ?? {}
    opts.signal?.throwIfAborted()
    return await this._generate(messages, tools, opts)
  }

  /** Bind tools: returns a new instance, leaving the original untouched (safe for multiple callers binding different tool sets concurrently) */
  bindTools(tools: StructuredToolInterface[]): BaseChatModel {
    return new BoundToolsChatModel(this, tools)
  }
}

/** Model wrapper layer with a fixed bound tool set */
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

/** Tool argument JSON parsing: returns error on failure (the original text is kept for troubleshooting) */
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

/** Snapshot of a failed attempt (usually streaming), used to present the diagnostics of both attempts together */
export interface FallbackSnapshot {
  raw?: string
  reasoningOnly?: boolean
  finishReason?: string
}

/** Empty-response guard context (provider / model / known status code / content-type) */
export interface EmptyResponseGuardContext {
  provider: string
  model: string
  /** Status code parsed from the provider error payload (passed to model-recovery for classification when available) */
  status?: number
  contentType?: string
  /** Snapshot of the previous attempt (usually streaming); used to present both attempts' payloads together */
  previous?: FallbackSnapshot
}

/** Whether the message has usable output (text or tool calls); reasoning content doesn't count as a final answer */
export function hasMeaningfulOutput(message: AIMessage): boolean {
  return contentToText(message.content).trim().length > 0 || message.tool_calls.length > 0
}

/** Streaming aggregator: the provider feeds protocol increments in, and it produces the final AIMessage */
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
   * Record raw response fragments (for empty-response diagnostics).
   *
   * Only the first 600 characters and the last 300 are kept: gateway error pages / rate-limit
   * payloads are usually short (the head is the whole text), while for long streaming responses
   * the last few events are often the most valuable when something goes wrong. Memory never grows
   * without bound.
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

  /** Raw response fragment for empty-response errors (head + tail) */
  get rawSnippet(): string | undefined {
    const head = this.rawHead.trim()
    if (!head) return undefined
    const tail = this.rawTail.trim()
    if (!tail || head.includes(tail)) return head
    return `${head} …[end of stream]… ${tail}`
  }

  /** Append a text increment */
  text(delta: string | undefined): void {
    if (!delta) return
    this.textParts.push(delta)
    this.sink?.(new AIMessageChunk({ content: delta }))
  }

  /** Append a reasoning (thinking / reasoning) increment */
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
   * Append a tool-call increment.
   * - `name` / `id` usually only appear in the first chunk;
   * - `args` is a raw fragment of the argument JSON (split across chunks when streaming).
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

  /** Merge usage (the protocol usually provides it only in the final chunk) */
  usage(usage: UsageMetadata | undefined): void {
    if (!usage || Object.keys(usage).length === 0) return
    this.usageMetadata = { ...(this.usageMetadata ?? {}), ...usage }
  }

  /** Merge response metadata (finish_reason / model, etc.) */
  metadata(patch: Record<string, unknown> | undefined): void {
    if (!patch) return
    this.responseMetadata = { ...this.responseMetadata, ...patch }
  }

  /** Aggregate the result: parse tool arguments and assemble the final AIMessage */
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
   * Aggregate the result and throw a readable error when there is no usable output at all.
   *
   * This is the single exit for all providers: when an HTTP 200 delivers an empty stream / an
   * error page / a payload containing only usage, it won't silently return an empty message (the
   * upper layer would only show "the model returned no content"); instead it throws
   * `ModelEmptyResponseError` carrying the provider, model, finish_reason and the raw response
   * fragment, so the user can see exactly what the service returned.
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

  /** Whether there is reasoning content (for empty-response diagnostics) */
  get hasReasoning(): boolean {
    return this.reasoningParts.length > 0
  }

  /** Recorded finish_reason (may not have been received yet) */
  get finishReason(): string | undefined {
    const value = this.responseMetadata.finish_reason
    return typeof value === 'string' ? value : undefined
  }

  /** Snapshot used by the non-streaming fallback */
  fallbackSnapshot(): FallbackSnapshot {
    return {
      raw: this.rawSnippet,
      reasoningOnly: this.hasReasoning,
      finishReason: this.finishReason
    }
  }

  /** Text produced so far (for fallback display on exceptions) */
  get textSoFar(): string {
    return this.textParts.join('')
  }
}

/** Build a complete AIMessage from protocol payloads (non-streaming path / test doubles) */
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
