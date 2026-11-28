/**
 * Obtains OAuth tokens for Google service accounts / ADC (Application Default Credentials).
 *
 * Only the two credential types a desktop app realistically encounters are implemented:
 * - `service_account`: a JWT Bearer assertion is exchanged for an access_token (the common
 *   GOOGLE_APPLICATION_CREDENTIALS form);
 * - `authorized_user`: gcloud default credentials (refresh_token exchanged for access_token).
 *
 * Results are cached by credential fingerprint until 60 seconds before expiry (so each Vertex
 * model call does not need a fresh token).
 */
import { createHash, createSign } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { httpRequest, modelConfigError, safeReadText } from '../http'

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform'

/** Service account credential */
export interface ServiceAccountCredential {
  type: 'service_account'
  project_id?: string
  client_email: string
  private_key: string
  token_uri?: string
}

/** gcloud user credential */
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

/** Credential fingerprint (cache key) */
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

/** Get an access_token (cached) */
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

/** Service account: sign a JWT assertion → exchange it at token_uri for an access_token */
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

/** gcloud user credential: exchange refresh_token for access_token */
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

/** Default gcloud ADC file location */
function defaultAdcPath(): string {
  if (process.platform === 'win32' && process.env.APPDATA) {
    return join(process.env.APPDATA, 'gcloud', 'application_default_credentials.json')
  }
  return join(homedir(), '.config', 'gcloud', 'application_default_credentials.json')
}

/** Read and identify a credential file (returns null if missing / invalid) */
export async function readCredentialFile(path: string): Promise<GoogleCredential | null> {
  try {
    const text = await readFile(path, 'utf-8')
    return parseCredential(JSON.parse(text))
  } catch {
    return null
  }
}

/** Parse a credential object (distinguishes service_account / authorized_user) */
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
 * Resolve the credential used by Vertex:
 * 1. The explicitly passed credentials / authOptions.credentials object;
 * 2. The file pointed to by GOOGLE_APPLICATION_CREDENTIALS;
 * 3. The default gcloud ADC file.
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
