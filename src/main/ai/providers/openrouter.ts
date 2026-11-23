/**
 * OpenRouter（OpenAI 兼容；baseURL 缺省 https://openrouter.ai/api/v1）。
 *
 * 额外支持站点归属头（`siteUrl` → HTTP-Referer、`siteName` → X-Title），
 * 以及 OpenRouter 的 `reasoning` / `reasoning_effort` 参数（由 modelKwargs 透传）。
 */
import { ChatOpenAI, OpenAICompatibleFields } from './openai'

export interface OpenRouterFields extends OpenAICompatibleFields {
  /** 站点 URL（OpenRouter 排行榜归属） */
  siteUrl?: string
  /** 站点名称（OpenRouter 排行榜归属） */
  siteName?: string
}

export class ChatOpenRouter extends ChatOpenAI {
  private readonly siteUrl?: string
  private readonly siteName?: string

  constructor(fields: OpenRouterFields) {
    super(fields)
    this.siteUrl = fields.siteUrl
    this.siteName = fields.siteName
  }

  protected get defaultBaseURL(): string {
    return 'https://openrouter.ai/api/v1'
  }

  protected get apiKeyEnvNames(): string[] {
    return ['OPENROUTER_API_KEY']
  }

  protected extraHeaders(): Record<string, string> {
    const headers: Record<string, string> = {}
    if (this.siteUrl) headers['HTTP-Referer'] = this.siteUrl
    if (this.siteName) headers['X-Title'] = this.siteName
    return headers
  }

  get provider(): string {
    return 'openrouter'
  }
}
