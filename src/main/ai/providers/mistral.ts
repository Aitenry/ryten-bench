/**
 * Mistral (OpenAI-compatible, but tool call ids must be 9 alphanumeric characters).
 *
 * baseURL comes from the `serverURL` field (legacy field name), defaulting to
 * https://api.mistral.ai/v1.
 */
import { ChatOpenAI, OpenAICompatibleFields } from './openai'
import { toMistralMessages } from './converters'
import type { BaseMessage } from '../messages'

export interface MistralFields extends OpenAICompatibleFields {
  /** Custom service address (legacy field name) */
  serverURL?: string
}

export class ChatMistralAI extends ChatOpenAI {
  constructor(fields: MistralFields) {
    // `serverURL` is a service root; the SDK itself appends /v1/chat/completions. Both forms are
    // accepted here: use it as-is when it already contains /v1, otherwise append /v1 and let the
    // base class append /chat/completions.
    const serverURL = fields.serverURL ?? fields.baseURL ?? fields.baseUrl
    const normalizedBase = serverURL
      ? /(^|\/)v1($|\/)/.test(serverURL)
        ? serverURL
        : `${serverURL.replace(/\/+$/, '')}/v1`
      : undefined
    super({
      // Mistral does not support stream_options (some versions return 400); usage is read from the last chunk as needed
      streamUsage: false,
      ...fields,
      ...(normalizedBase ? { baseURL: normalizedBase } : {})
    })
  }

  protected get defaultBaseURL(): string {
    return 'https://api.mistral.ai/v1'
  }

  protected get apiKeyEnvNames(): string[] {
    return ['MISTRAL_API_KEY']
  }

  protected convertMessages(messages: BaseMessage[]): Array<Record<string, unknown>> {
    return toMistralMessages(messages)
  }

  get provider(): string {
    return 'mistralai'
  }
}
