/**
 * Payload conversion for the OpenAI-compatible protocol (shared by OpenAI / DeepSeek / xAI /
 * OpenRouter / Mistral / custom endpoints).
 *
 * This layer only converts the shape of messages / tools / usage and makes no provider decisions.
 */
import {
  BaseMessage,
  contentToBlocks,
  contentToText,
  MessageContentComplex,
  ToolCall
} from '../messages'
import { jsonSchemaOf, StructuredToolInterface } from '../tools'

/** function tool declaration for the OpenAI-compatible protocol */
export interface OpenAIToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/** Tool declaration: name/description/schema → OpenAI function tool */
export function toOpenAITools(tools: StructuredToolInterface[]): OpenAIToolDefinition[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description ?? '',
      parameters: jsonSchemaOf(tool)
    }
  }))
}

/** Content-block conversion for human messages (text + images) */
function humanContentToOpenAI(content: BaseMessage['content']): string | MessageContentComplex[] {
  if (typeof content === 'string') return content
  const blocks = contentToBlocks(content).map((block) => {
    if (block.type === 'image_url') {
      const imageUrl =
        typeof block.image_url === 'string'
          ? block.image_url
          : (block.image_url as { url?: string } | undefined)?.url
      return imageUrl ? { type: 'image_url', image_url: { url: imageUrl } } : null
    }
    if (block.type === 'text') return { type: 'text', text: block.text ?? '' }
    // Other blocks (file, etc.) pass through unchanged for compatibility with custom gateways
    return block
  })
  return blocks.filter((block): block is MessageContentComplex => block !== null)
}

/** AI message tool_calls → OpenAI tool_calls */
function aiToolCallsToOpenAI(toolCalls: ToolCall[]): Array<Record<string, unknown>> {
  return toolCalls.map((call) => ({
    id: call.id ?? '',
    type: 'function',
    function: {
      name: call.name,
      arguments: JSON.stringify(call.args ?? {})
    }
  }))
}

/** Message array → OpenAI chat.completions messages */
export function toOpenAIMessages(messages: BaseMessage[]): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = []
  for (const message of messages) {
    switch (message.type) {
      case 'system':
        result.push({ role: 'system', content: contentToText(message.content) })
        break
      case 'human':
        result.push({ role: 'user', content: humanContentToOpenAI(message.content) })
        break
      case 'ai': {
        const ai = message as BaseMessage & { tool_calls?: ToolCall[] }
        const toolCalls = ai.tool_calls ?? []
        const text = contentToText(message.content)
        if (toolCalls.length > 0) {
          result.push({
            role: 'assistant',
            content: text || null,
            tool_calls: aiToolCallsToOpenAI(toolCalls)
          })
        } else {
          result.push({ role: 'assistant', content: text })
        }
        break
      }
      case 'tool': {
        const toolMessage = message as BaseMessage & { tool_call_id?: string; tool_name?: string }
        const entry: Record<string, unknown> = {
          role: 'tool',
          content: contentToText(message.content),
          tool_call_id: toolMessage.tool_call_id ?? ''
        }
        if (toolMessage.tool_name) entry.name = toolMessage.tool_name
        result.push(entry)
        break
      }
      default:
        result.push({ role: 'user', content: contentToText(message.content) })
        break
    }
  }
  return result
}

/** Normalize usage fields (prompt_tokens/completion_tokens → input_tokens/output_tokens) */
export function normalizeUsage(
  usage: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!usage || typeof usage !== 'object') return undefined
  const input = pickNumber(usage, ['prompt_tokens', 'input_tokens', 'promptTokens', 'inputTokens'])
  const output = pickNumber(usage, [
    'completion_tokens',
    'output_tokens',
    'completionTokens',
    'outputTokens'
  ])
  const total = pickNumber(usage, ['total_tokens', 'totalTokens'])
  if (input == null && output == null && total == null) return undefined
  const result: Record<string, unknown> = {}
  if (input != null) result.input_tokens = input
  if (output != null) result.output_tokens = output
  result.total_tokens = total ?? (input ?? 0) + (output ?? 0)

  // Cache / reasoning details: same shape as the legacy implementation (the frontend usage panel
  // displays these keys)
  const inputDetails = (usage.prompt_tokens_details ?? usage.input_token_details) as
    Record<string, unknown> | undefined
  const cacheRead = pickNumber(inputDetails ?? {}, ['cached_tokens', 'cache_read', 'cacheRead'])
  const audioInput = pickNumber(inputDetails ?? {}, ['audio_tokens', 'audio'])
  const canonicalInput: Record<string, unknown> = {}
  if (cacheRead != null) canonicalInput.cache_read = cacheRead
  if (audioInput != null) canonicalInput.audio = audioInput
  if (Object.keys(canonicalInput).length > 0) result.input_token_details = canonicalInput

  const outputDetails = (usage.completion_tokens_details ?? usage.output_token_details) as
    Record<string, unknown> | undefined
  const reasoning = pickNumber(outputDetails ?? {}, ['reasoning_tokens', 'reasoning'])
  const audioOutput = pickNumber(outputDetails ?? {}, ['audio_tokens', 'audio'])
  const canonicalOutput: Record<string, unknown> = {}
  if (reasoning != null) canonicalOutput.reasoning = reasoning
  if (audioOutput != null) canonicalOutput.audio = audioOutput
  if (Object.keys(canonicalOutput).length > 0) result.output_token_details = canonicalOutput

  // Keep the original fields as well: the history panel / old data read these keys, so canonical
  // fields alone are not enough
  for (const key of [
    'prompt_tokens',
    'completion_tokens',
    'prompt_tokens_details',
    'completion_tokens_details',
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
    'reasoning_tokens'
  ]) {
    if (usage[key] !== undefined) result[key] = usage[key]
  }
  return result
}

function pickNumber(source: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

/** Mistral requires tool call ids to be exactly 9 alphanumeric chars; other shapes are stably mapped by the algorithm below */
export function mistralToolCallId(toolCallId: string): string {
  if (/^[a-zA-Z0-9]{9}$/.test(toolCallId)) return toolCallId
  const base62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
  let hash = 0
  for (let i = 0; i < toolCallId.length; i += 1) {
    hash = (hash << 5) - hash + toolCallId.charCodeAt(i)
    hash &= hash
  }
  let value = Math.abs(hash)
  const chars: string[] = []
  if (value === 0) chars.push(base62[0])
  while (value) {
    chars.push(base62[value % 62])
    value = Math.floor(value / 62)
  }
  const encoded = chars.reverse().join('')
  return encoded.length >= 9 ? encoded.slice(0, 9) : encoded.padStart(9, '0')
}

/** Mistral message conversion: same shape as OpenAI, but tool call ids must be normalized */
export function toMistralMessages(messages: BaseMessage[]): Array<Record<string, unknown>> {
  const converted = toOpenAIMessages(messages)
  for (const entry of converted) {
    if (Array.isArray(entry.tool_calls)) {
      for (const call of entry.tool_calls as Array<Record<string, unknown>>) {
        if (typeof call.id === 'string') call.id = mistralToolCallId(call.id)
      }
    }
    if (entry.role === 'tool' && typeof entry.tool_call_id === 'string') {
      entry.tool_call_id = mistralToolCallId(entry.tool_call_id)
    }
  }
  return converted
}
