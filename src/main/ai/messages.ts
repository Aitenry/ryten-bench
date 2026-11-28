/**
 * In-house message model.
 *
 * Only the parts this project needs are implemented:
 * - Four message types: human / ai / system / tool (plus the streaming chunk AIMessageChunk);
 * - Model calls, tool calls, usage, and reasoning content (reasoning_content) all live on the
 *   message object, and their field names match the legacy implementation so upper layers
 *   (history / stream-records / usage) do not need to change how they consume them;
 * - Content can be either a string or an array of content blocks (multimodal images, tool
 *   results, etc.).
 *
 * When a new provider is added, it only needs to map its protocol payloads to the message shapes
 * here, without changing upper layers.
 */

/** Multimodal content block (text / images, etc.); fields keep the original provider protocol shape */
export interface MessageContentComplex {
  type?: string
  text?: string
  image_url?: string | { url?: string; [key: string]: unknown }
  [key: string]: unknown
}

/** Message content: plain text or an array of content blocks */
export type MessageContent = string | MessageContentComplex[]

/** Tool call (the complete form produced by the model) */
export interface ToolCall {
  name: string
  args: Record<string, unknown>
  id?: string
  type?: 'tool_call'
}

/** Tool call chunk (partial form during streamed parsing) */
export interface ToolCallChunk {
  /** Tool index within the same model reply (starts at 0) */
  index?: number
  name?: string
  id?: string
  /** Incremental fragment of the arguments JSON (unparsed raw string) */
  args?: string
}

/** Invalid tool call (keeps the raw text when the args cannot be parsed as JSON, for diagnostics) */
export interface InvalidToolCall {
  name?: string
  args?: string
  id?: string
  error?: string
}

/** Real usage reported by the model (field names match the legacy implementation) */
export type UsageMetadata = Record<string, unknown>

export interface BaseMessageFields {
  content?: MessageContent
  name?: string
  additional_kwargs?: Record<string, unknown>
  response_metadata?: Record<string, unknown>
  id?: string
}

/** Message base class: fields and text extraction shared by all messages */
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

  /** Message type (human / ai / system / tool) */
  abstract get type(): string

  /** Type getter kept for compatibility (upper layers check `_getType()` in several places) */
  _getType(): string {
    return this.type
  }

  /** Plain-text portion of the content (concatenates text blocks for block arrays) */
  get text(): string {
    return contentToText(this.content)
  }
}

/** User message */
export class HumanMessage extends BaseMessage {
  get type(): string {
    return 'human'
  }
}

/** System message */
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

/** Model reply message */
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
      // Legacy tool call ids may be missing: supply a stable id so tool results can be matched
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
 * Streaming chunk.
 *
 * Text / reasoning content are delivered incrementally; tool calls are delivered incrementally via
 * `tool_call_chunks` (same shape as the legacy implementation, and the upper-layer
 * stream-records.ts consumes that field directly).
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
  /** Tool name corresponding to the tool result (required by protocols such as Gemini) */
  tool_name?: string
  status?: 'success' | 'error'
}

/** Tool result message */
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

/** Get a string id (avoids extra dependencies) */
function randomId(): string {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10)
}

/** Content → plain text (only text blocks are joined for block arrays) */
export function contentToText(content: MessageContent | undefined | null): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('')
}

/** Content → content block array (string content is wrapped into a single text block) */
export function contentToBlocks(
  content: MessageContent | undefined | null
): MessageContentComplex[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  return Array.isArray(content) ? content : []
}

/** Whether this is an AI message (used for streamed record filtering) */
export function isAIMessage(message: unknown): message is AIMessage {
  return (
    message instanceof AIMessage ||
    (typeof message === 'object' && message !== null && (message as BaseMessage).type === 'ai')
  )
}

/** Whether this is a tool message */
export function isToolMessage(message: unknown): message is ToolMessage {
  return (
    message instanceof ToolMessage ||
    (typeof message === 'object' && message !== null && (message as BaseMessage).type === 'tool')
  )
}

/**
 * Parse the MIME type and base64 data from a data URL (required by protocols that send images inline).
 * Returns null for non-data URLs (http/https links); the caller decides how to handle them.
 */
export function parseDataUrl(url: string): { mimeType: string; data: string } | null {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url)
  if (!match) return null
  return {
    mimeType: match[1] || 'application/octet-stream',
    data: match[2] ? match[3] : Buffer.from(decodeURIComponent(match[3])).toString('base64')
  }
}
