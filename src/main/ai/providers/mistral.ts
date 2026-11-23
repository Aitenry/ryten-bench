/**
 * Mistral（OpenAI 兼容，但工具调用 id 必须是 9 位字母数字）。
 *
 * baseURL 走 `serverURL` 字段（旧实现同名），缺省 https://api.mistral.ai/v1。
 */
import { ChatOpenAI, OpenAICompatibleFields } from './openai'
import { toMistralMessages } from './converters'
import type { BaseMessage } from '../messages'

export interface MistralFields extends OpenAICompatibleFields {
  /** 旧实现字段名：自定义服务地址 */
  serverURL?: string
}

export class ChatMistralAI extends ChatOpenAI {
  constructor(fields: MistralFields) {
    // 旧实现的 serverURL 是「服务根」，SDK 自己拼 /v1/chat/completions；
    // 这里两种写法都接：已经带 /v1 的直接用，否则补上 /v1 再交给基类拼 /chat/completions。
    const serverURL = fields.serverURL ?? fields.baseURL ?? fields.baseUrl
    const normalizedBase = serverURL
      ? /(^|\/)v1($|\/)/.test(serverURL)
        ? serverURL
        : `${serverURL.replace(/\/+$/, '')}/v1`
      : undefined
    super({
      // Mistral 不支持 stream_options（部分版本会 400），用量在最后一个 chunk 里按需读取
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
