/**
 * OpenRouter (OpenAI-compatible; baseURL defaults to https://openrouter.ai/api/v1).
 *
 * Additionally supports site attribution headers (`siteUrl` → HTTP-Referer, `siteName` → X-Title),
 * plus OpenRouter's `reasoning` / `reasoning_effort` parameters (passed through via modelKwargs).
 */
import { ChatOpenAI, OpenAICompatibleFields } from './openai'

export interface OpenRouterFields extends OpenAICompatibleFields {
  /** Site URL (OpenRouter leaderboard attribution) */
  siteUrl?: string
  /** Site name (OpenRouter leaderboard attribution) */
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
