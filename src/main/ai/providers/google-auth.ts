/**
 * Google 服务账号 / ADC（Application Default Credentials）OAuth 取 token。
 *
 * 只实现桌面应用实际会遇到的两种凭据：
 * - `service_account`：JWT Bearer 断言换 access_token（GOOGLE_APPLICATION_CREDENTIALS 常见形态）；
 * - `authorized_user`：gcloud 默认凭据（refresh_token 换 access_token）。
 *
 * 结果按凭据指纹缓存到过期前 60 秒（Vertex 每次模型调用不必重新换票）。
 */
import { createHash, createSign } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { httpRequest, modelConfigError, safeReadText } from '../http'

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform'

/** 服务账号凭据 */
export interface ServiceAccountCredential {
  type: 'service_account'
  project_id?: string
  client_email: string
  private_key: string
  token_uri?: string
}

/** gcloud 用户凭据 */
export interface AuthorizedUserCredential {
  type: 'authorized_user'
  client_id: string
  client_secret: string
  refresh_token: string
}

export type GoogleCredential = ServiceAccountCredential | AuthorizedUserCredential

interface CachedToken {
  token: string
  expiresAt: number
}

const tokenCache = new Map<string, CachedToken>()

/** 凭据指纹（缓存键） */
function fingerprint(credential: GoogleCredential): string {
  const seed =
    credential.type === 'service_account'
      ? `${credential.client_email}:${credential.private_key.slice(0, 64)}`
      : `${credential.client_id}:${credential.refresh_token.slice(0, 32)}`
  return createHash('sha256').update(seed).digest('hex')
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/** 取 access_token（带缓存） */
export async function getGoogleAccessToken(credential: GoogleCredential): Promise<string> {
  const key = fingerprint(credential)
  const cached = tokenCache.get(key)
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token

  const token =
    credential.type === 'service_account'
      ? await fetchServiceAccountToken(credential)
      : await fetchAuthorizedUserToken(credential)
  tokenCache.set(key, token)
  return token.token
}

/** 服务账号：签 JWT 断言 → token_uri 换 access_token */
async function fetchServiceAccountToken(
  credential: ServiceAccountCredential
): Promise<CachedToken> {
  const tokenUri = credential.token_uri || 'https://oauth2.googleapis.com/token'
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'RS256', typ: 'JWT' }
  const claims = {
    iss: credential.client_email,
    scope: CLOUD_PLATFORM_SCOPE,
    aud: tokenUri,
    iat: now,
    exp: now + 3600
  }
  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claims))}`
  const signer = createSign('RSA-SHA256')
  signer.update(unsigned)
  const signature = signer.sign(credential.private_key)
  const assertion = `${unsigned}.${base64Url(signature)}`

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion
  })
  const response = await httpRequest(tokenUri, {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  })
  const payload = JSON.parse(await safeReadText(response)) as {
    access_token?: string
    expires_in?: number
  }
  if (!payload.access_token) {
    throw modelConfigError('Google service account token exchange returned no access_token')
  }
  return {
    token: payload.access_token,
    expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000
  }
}

/** gcloud 用户凭据：refresh_token 换 access_token */
async function fetchAuthorizedUserToken(
  credential: AuthorizedUserCredential
): Promise<CachedToken> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: credential.client_id,
    client_secret: credential.client_secret,
    refresh_token: credential.refresh_token
  })
  const response = await httpRequest('https://oauth2.googleapis.com/token', {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  })
  const payload = JSON.parse(await safeReadText(response)) as {
    access_token?: string
    expires_in?: number
  }
  if (!payload.access_token) {
    throw modelConfigError('Google ADC refresh returned no access_token')
  }
  return {
    token: payload.access_token,
    expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000
  }
}

/** gcloud 默认 ADC 文件位置 */
function defaultAdcPath(): string {
  if (process.platform === 'win32' && process.env.APPDATA) {
    return join(process.env.APPDATA, 'gcloud', 'application_default_credentials.json')
  }
  return join(homedir(), '.config', 'gcloud', 'application_default_credentials.json')
}

/** 读取并识别凭据文件（不存在 / 非法返回 null） */
export async function readCredentialFile(path: string): Promise<GoogleCredential | null> {
  try {
    const text = await readFile(path, 'utf-8')
    return parseCredential(JSON.parse(text))
  } catch {
    return null
  }
}

/** 解析凭据对象（区分 service_account / authorized_user） */
export function parseCredential(raw: unknown): GoogleCredential | null {
  if (!raw || typeof raw !== 'object') return null
  const candidate = raw as Record<string, unknown>
  const type = candidate.type
  if (type === 'service_account' || (candidate.client_email && candidate.private_key)) {
    if (typeof candidate.client_email !== 'string' || typeof candidate.private_key !== 'string') {
      return null
    }
    return {
      type: 'service_account',
      project_id: typeof candidate.project_id === 'string' ? candidate.project_id : undefined,
      client_email: candidate.client_email,
      private_key: candidate.private_key,
      token_uri: typeof candidate.token_uri === 'string' ? candidate.token_uri : undefined
    }
  }
  if (
    type === 'authorized_user' ||
    (candidate.client_id && candidate.client_secret && candidate.refresh_token)
  ) {
    if (
      typeof candidate.client_id !== 'string' ||
      typeof candidate.client_secret !== 'string' ||
      typeof candidate.refresh_token !== 'string'
    ) {
      return null
    }
    return {
      type: 'authorized_user',
      client_id: candidate.client_id,
      client_secret: candidate.client_secret,
      refresh_token: candidate.refresh_token
    }
  }
  return null
}

/**
 * 解析 Vertex 使用的凭据：
 * 1. 显式传入的 credentials / authOptions.credentials 对象；
 * 2. GOOGLE_APPLICATION_CREDENTIALS 指向的文件；
 * 3. gcloud 默认 ADC 文件。
 */
export async function resolveGoogleCredential(options: {
  credentials?: unknown
  credentialsPath?: string
}): Promise<GoogleCredential | null> {
  if (options.credentials) {
    const parsed = parseCredential(options.credentials)
    if (parsed) return parsed
  }
  const explicitPath = options.credentialsPath || process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (explicitPath) {
    const fromFile = await readCredentialFile(explicitPath)
    if (fromFile) return fromFile
  }
  return await readCredentialFile(defaultAdcPath())
}
