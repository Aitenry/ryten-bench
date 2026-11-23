/**
 * Google Vertex AI 实现（与 Gemini 共用报文，只换 URL 与鉴权）。
 *
 * 两种接入方式（与旧实现保持一致）：
 * - **Express Mode**：配置了 apiKey → `https://aiplatform.googleapis.com/v1/publishers/google/models/<model>`；
 * - **项目模式**：未配置 apiKey → 服务账号 / gcloud ADC 换 OAuth token，
 *   请求 `https://<location>-aiplatform.googleapis.com/v1/projects/<project>/locations/<location>/publishers/google/models/<model>`。
 */
import { GoogleChatModelBase, GoogleFields } from './google'
import { getGoogleAccessToken, GoogleCredential, resolveGoogleCredential } from './google-auth'
import { modelConfigError } from '../http'

export interface VertexFields extends GoogleFields {
  model?: string
  /** GCP 项目（缺省读凭据 / GOOGLE_CLOUD_PROJECT） */
  projectId?: string
  /** 区域（缺省 us-central1；`global` 表示全球端点） */
  location?: string
  /** 服务账号凭据对象 */
  credentials?: unknown
  /** 旧实现字段名：与 credentials 等价 */
  authOptions?: { credentials?: unknown }
  credentialsPath?: string
}

/** 去掉 `models/` 前缀 */
function bareModelName(model: string): string {
  return model.replace(/^models\//, '')
}

export class ChatVertexAI extends GoogleChatModelBase {
  private readonly apiKey?: string
  private readonly projectId?: string
  private readonly location: string
  private readonly credential: Promise<GoogleCredential | null>
  private readonly baseUrl?: string

  constructor(fields: VertexFields) {
    if (!fields?.model) throw new Error('ChatVertexAI requires a "model" field')
    super(fields.model, fields)
    this.apiKey = fields.apiKey ?? process.env.GOOGLE_API_KEY
    this.projectId =
      fields.projectId ?? process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GOOGLE_PROJECT_ID
    this.location =
      fields.location ??
      process.env.GOOGLE_CLOUD_REGION ??
      process.env.VERTEX_LOCATION ??
      'us-central1'
    this.baseUrl = fields.baseUrl ?? fields.baseURL
    this.credential = resolveGoogleCredential({
      credentials: fields.credentials ?? fields.authOptions?.credentials,
      credentialsPath: fields.credentialsPath
    })
  }

  get provider(): string {
    return 'vertexai'
  }

  /** 项目模式的 access token（getGoogleAccessToken 内部按凭据缓存到过期前 60 秒） */
  private async accessTokenValue(): Promise<string> {
    const credential = await this.credential
    if (!credential) {
      throw modelConfigError(
        'Vertex AI credentials not found. Provide a service account JSON, set GOOGLE_APPLICATION_CREDENTIALS, run `gcloud auth application-default login`, or configure an API key (Express Mode).'
      )
    }
    return await getGoogleAccessToken(credential)
  }

  private async projectIdValue(): Promise<string> {
    if (this.projectId) return this.projectId
    const credential = await this.credential
    if (credential && credential.type === 'service_account' && credential.project_id) {
      return credential.project_id
    }
    throw modelConfigError(
      'Vertex AI project id not found. Set "projectId" in the provider settings, or set GOOGLE_CLOUD_PROJECT.'
    )
  }

  private endpointHost(): string {
    if (this.baseUrl) return this.baseUrl.replace(/\/+$/, '')
    if (this.location === 'global') return 'https://aiplatform.googleapis.com'
    return `https://${this.location}-aiplatform.googleapis.com`
  }

  protected async buildRequestUrl(streaming: boolean): Promise<string> {
    const model = bareModelName(this.model)
    const method = streaming ? 'streamGenerateContent' : 'generateContent'
    const query = streaming ? '?alt=sse' : ''
    if (this.apiKey) {
      const key = `key=${encodeURIComponent(this.apiKey)}`
      return `${this.endpointHost()}/v1/publishers/google/models/${model}:${method}?${streaming ? `alt=sse&${key}` : key}`
    }
    const project = await this.projectIdValue()
    return (
      `${this.endpointHost()}/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(this.location)}` +
      `/publishers/google/models/${model}:${method}${query}`
    )
  }

  protected async buildRequestHeaders(): Promise<Record<string, string>> {
    if (this.apiKey) return {}
    const token = await this.accessTokenValue()
    return { authorization: `Bearer ${token}` }
  }
}
