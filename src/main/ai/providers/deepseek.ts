/** DeepSeek（OpenAI 兼容；baseURL 缺省 https://api.deepseek.com） */
import { ChatOpenAI, OpenAICompatibleFields } from './openai'

export class ChatDeepSeek extends ChatOpenAI {
  constructor(fields: OpenAICompatibleFields) {
    super(fields)
  }

  protected get defaultBaseURL(): string {
    return 'https://api.deepseek.com'
  }

  protected get apiKeyEnvNames(): string[] {
    return ['DEEPSEEK_API_KEY']
  }

  get provider(): string {
    return 'deepseek'
  }
}
