/** xAI（OpenAI 兼容；baseURL 缺省 https://api.x.ai/v1） */
import { ChatOpenAI, OpenAICompatibleFields } from './openai'

export class ChatXAI extends ChatOpenAI {
  constructor(fields: OpenAICompatibleFields) {
    super(fields)
  }

  protected get defaultBaseURL(): string {
    return 'https://api.x.ai/v1'
  }

  protected get apiKeyEnvNames(): string[] {
    return ['XAI_API_KEY']
  }

  get provider(): string {
    return 'xai'
  }
}
