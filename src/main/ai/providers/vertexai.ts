/**
 * Google Vertex AI implementation (shares the payload format with Gemini, differing only in URL
 * and auth).
 *
 * Two access modes:
 * - **Express Mode**: an apiKey is configured → `https://aiplatform.googleapis.com/v1/publishers/google/models/<model>`;
 * - **Project mode**: no apiKey → a service account / gcloud ADC is exchanged for an OAuth token,
 *   requesting `https://<location>-aiplatform.googleapis.com/v1/projects/<project>/locations/<location>/publishers/google/models/<model>`.
 */
import { GoogleChatModelBase, GoogleFields } from './google'
import { getGoogleAccessToken, GoogleCredential, resolveGoogleCredential } from './google-auth'
import { modelConfigError } from '../http'

export interface VertexFields extends GoogleFields {
  model?: string
  /** GCP project (defaults to the value from credentials / GOOGLE_CLOUD_PROJECT) */
  projectId?: string
  /** Region (defaults to us-central1; `global` means the global endpoint) */
  location?: string
  /** Service account credential object */
  credentials?: unknown
  /** Equivalent to credentials (legacy field name) */
  authOptions?: { credentials?: unknown }
  credentialsPath?: string
}

/** Strip the `models/` prefix */
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

  /** Access token for project mode (getGoogleAccessToken caches it per credential until 60 seconds before expiry) */
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
