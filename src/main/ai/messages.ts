/**
 * 自研消息模型（替代 `@langchain/core/messages`）。
 *
 * 只实现本项目需要的部分：
 * - 四种消息：human / ai / system / tool（外加流式增量块 AIMessageChunk）；
 * - 模型调用、工具调用、用量、推理内容（reasoning_content）都挂在消息对象上，
 *   字段名与旧 LangChain 实现保持一致，避免上层（history / stream-records / usage）
 *   改写消费方式；
 * - 内容既可以是字符串，也可以是内容块数组（多模态图片、工具结果等）。
 *
 * 以后新增供应商时，只要能把自己的协议报文映射到这里的消息形态，就不必改上层。
 */

/** 多模态内容块（文本 / 图片等），字段随供应商协议保留原始形状 */
export interface MessageContentComplex {
  type?: string
  text?: string
  image_url?: string | { url?: string; [key: string]: unknown }
  [key: string]: unknown
}

/** 消息内容：纯文本或内容块数组 */
export type MessageContent = string | MessageContentComplex[]

/** 工具调用（模型产出的完整形态） */
export interface ToolCall {
  name: string
  args: Record<string, unknown>
  id?: string
  type?: 'tool_call'
}

/** 工具调用增量块（流式解析中的半成品） */
export interface ToolCallChunk {
  /** 同一条模型回复内的工具序号（从 0 开始） */
  index?: number
  name?: string
  id?: string
  /** 参数 JSON 的增量片段（未解析的原始字符串） */
  args?: string
}

/** 非法工具调用（参数无法解析成 JSON 时保留原文，供上层排查） */
export interface InvalidToolCall {
  name?: string
  args?: string
  id?: string
  error?: string
}

/** 模型回传的真实用量（字段名与旧实现一致） */
export type UsageMetadata = Record<string, unknown>

export interface BaseMessageFields {
  content?: MessageContent
  name?: string
  additional_kwargs?: Record<string, unknown>
  response_metadata?: Record<string, unknown>
  id?: string
}

/** 消息基类：所有消息共享的字段与文本提取逻辑 */
export abstract class BaseMessage {
  content: MessageContent
  name?: string
  additional_kwargs: Record<string, unknown>
  response_metadata: Record<string, unknown>
  id?: string

  constructor(fields: string | BaseMessageFields = '') {
    const normalized: BaseMessageFields = typeof fields === 'string' ? { content: fields } : fields
    this.content = normalized.content ?? ''
    this.name = normalized.name
    this.additional_kwargs = normalized.additional_kwargs ?? {}
    this.response_metadata = normalized.response_metadata ?? {}
    this.id = normalized.id
  }

  /** 消息类型（human / ai / system / tool） */
  abstract get type(): string

  /** 兼容旧 LangChain 的取类型方法（上层多处按 `_getType()` 判断） */
  _getType(): string {
    return this.type
  }

  /** 内容里的纯文本部分（内容块数组时拼接 text 块） */
  get text(): string {
    return contentToText(this.content)
  }
}

/** 用户消息 */
export class HumanMessage extends BaseMessage {
  get type(): string {
    return 'human'
  }
}

/** 系统消息 */
export class SystemMessage extends BaseMessage {
  get type(): string {
    return 'system'
  }
}

export interface AIMessageFields extends BaseMessageFields {
  tool_calls?: ToolCall[]
  invalid_tool_calls?: InvalidToolCall[]
  usage_metadata?: UsageMetadata
}

/** 模型回复消息 */
export class AIMessage extends BaseMessage {
  tool_calls: ToolCall[]
  invalid_tool_calls: InvalidToolCall[]
  usage_metadata?: UsageMetadata

  constructor(fields: string | AIMessageFields = '') {
    if (typeof fields === 'string') {
      super(fields)
      this.tool_calls = []
      this.invalid_tool_calls = []
      return
    }
    super(fields)
    this.tool_calls = (fields.tool_calls ?? []).map((call) => ({
      name: call.name,
      args: call.args ?? {},
      // 旧实现的工具调用 id 可能缺失：这里补一个稳定 id，工具结果才能对得上
      id: call.id ?? `call_${randomId()}`,
      type: 'tool_call'
    }))
    this.invalid_tool_calls = fields.invalid_tool_calls ?? []
    this.usage_metadata = fields.usage_metadata
  }

  get type(): string {
    return 'ai'
  }
}

export interface AIMessageChunkFields extends AIMessageFields {
  tool_call_chunks?: ToolCallChunk[]
}

/**
 * 流式增量块。
 *
 * 文本 / 推理内容按增量下发；工具调用按 `tool_call_chunks` 增量下发（与旧实现同形，
 * 上层 stream-records.ts 直接消费该字段）。
 */
export class AIMessageChunk extends AIMessage {
  tool_call_chunks: ToolCallChunk[]

  constructor(fields: string | AIMessageChunkFields = '') {
    super(fields)
    this.tool_call_chunks = typeof fields === 'string' ? [] : (fields.tool_call_chunks ?? [])
  }

  get type(): string {
    return 'ai'
  }
}

export interface ToolMessageFields extends BaseMessageFields {
  tool_call_id: string
  /** 工具结果对应的工具名（Gemini 等协议需要） */
  tool_name?: string
  status?: 'success' | 'error'
}

/** 工具结果消息 */
export class ToolMessage extends BaseMessage {
  tool_call_id: string
  tool_name?: string
  status?: 'success' | 'error'

  constructor(fields: string | ToolMessageFields) {
    if (typeof fields === 'string') {
      super(fields)
      this.tool_call_id = ''
      return
    }
    super(fields)
    this.tool_call_id = fields.tool_call_id ?? ''
    this.tool_name = fields.tool_name
    this.status = fields.status
  }

  get type(): string {
    return 'tool'
  }
}

/** 取字符串 id（避免引入额外依赖） */
function randomId(): string {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10)
}

/** 内容 → 纯文本（内容块数组时只拼 text 块） */
export function contentToText(content: MessageContent | undefined | null): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('')
}

/** 内容 → 内容块数组（字符串内容包装成单个 text 块） */
export function contentToBlocks(
  content: MessageContent | undefined | null
): MessageContentComplex[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  return Array.isArray(content) ? content : []
}

/** 是否为 AI 消息（流式记录过滤用） */
export function isAIMessage(message: unknown): message is AIMessage {
  return (
    message instanceof AIMessage ||
    (typeof message === 'object' && message !== null && (message as BaseMessage).type === 'ai')
  )
}

/** 是否为工具消息 */
export function isToolMessage(message: unknown): message is ToolMessage {
  return (
    message instanceof ToolMessage ||
    (typeof message === 'object' && message !== null && (message as BaseMessage).type === 'tool')
  )
}

/**
 * 从 data URL 中解析 MIME 与 base64 数据（图片直传协议时需要）。
 * 非 data URL（http/https 链接）返回 null，由调用方决定如何处理。
 */
export function parseDataUrl(url: string): { mimeType: string; data: string } | null {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url)
  if (!match) return null
  return {
    mimeType: match[1] || 'application/octet-stream',
    data: match[2] ? match[3] : Buffer.from(decodeURIComponent(match[3])).toString('base64')
  }
}
