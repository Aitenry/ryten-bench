import { createHash } from 'crypto'
import * as http from 'http'
import * as https from 'https'
import logger from 'electron-log'
import { getLatticeBaseUrl, getLatticeDeviceFingerprint, getLatticeDeviceName } from './settings'
import * as session from './session'
import { normalizeLatticeAvatar, type LatticeMeResult, type LatticeUser } from './types'

/**
 * Lattice platform HTTP client (user-facing `/v1/*`).
 *
 * Conventions:
 * - **Single-flight 401 refresh**: when any request gets a 401 and a refresh token exists locally,
 *   only one refresh request is in flight and the others wait for it; after a successful refresh
 *   the original request is **retried once**. A refresh rejected by the server (401/403/409) clears
 *   the session and broadcasts logged-out; a network failure/5xx does not clear the session (an
 *   offline start should not log the user out).
 * - **Error normalization**: the platform error body `{code,message,details,trace_id}` becomes a
 *   `LatticeApiError`; the renderer gets a readable `message` (the platform's original text), with
 *   `details` / `traceId` kept for troubleshooting.
 * - Plain JSON requests use the global `fetch`; plugin package **uploads** use node `http(s)`: the
 *   platform requires `Content-Length`, and we need real byte progress reported per chunk
 *   (`fetch` + Buffer can only report it at the end).
 */

/** Timeout for plain JSON requests */
const REQUEST_TIMEOUT_MS = 20_000
/** Timeout for plugin package upload/download (20MiB can exceed 1min on a slow network) */
const TRANSFER_TIMEOUT_MS = 180_000

/** Platform error body (field names follow the platform response) */
interface PlatformErrorBody {
  code?: unknown
  message?: unknown
  details?: unknown
  trace_id?: unknown
}

/** Normalized platform error (the renderer only needs message; the rest is for logs/troubleshooting) */
export class LatticeApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: unknown
  readonly traceId?: string

  constructor(
    message: string,
    options: { status?: number; code?: string; details?: unknown; traceId?: string } = {}
  ) {
    super(message)
    this.name = 'LatticeApiError'
    this.status = options.status ?? 0
    this.code = options.code ?? 'UNKNOWN'
    this.details = options.details
    this.traceId = options.traceId
  }
}

/** Any error → readable text for the renderer (never throws) */
export function latticeErrorMessage(err: unknown): string {
  if (err instanceof LatticeApiError) return err.message
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return String(err)
}

/**
 * Whether the error means "credentials are no longer valid".
 *
 * Only two cases: the refresh was rejected by the server (AUTH_FAIL/401), or there is no local
 * refresh token at all (AUTH_REQUIRED). Network errors (NETWORK/TIMEOUT) do **not** count — tokens
 * may still be valid while offline.
 */
export function isLatticeAuthError(err: unknown): boolean {
  if (!(err instanceof LatticeApiError)) return false
  return err.code === 'AUTH_FAIL' || err.code === 'AUTH_REQUIRED'
}

/** Notified when credentials are lost (registered in lattice/index.ts: clear lastError + broadcast logged-out) */
let authLostHandler: (() => void) | null = null

export function setLatticeAuthLostHandler(handler: (() => void) | null): void {
  authLostHandler = handler
}

/** Clear the session, build/throw a "login required" error, and notify the outer layer to broadcast */
function notifyAuthLost(message: string): LatticeApiError {
  session.clearLatticeSession()
  logger.warn(`[Lattice] Login state lost: ${message}`)
  try {
    authLostHandler?.()
  } catch (err) {
    logger.warn('[Lattice] auth-lost callback error:', err)
  }
  return new LatticeApiError(message, { status: 401, code: 'AUTH_FAIL' })
}

// ---------- URL / error construction ----------

function buildLatticeUrl(
  pathname: string,
  query?: Record<string, string | number | boolean | undefined>
): string {
  const base = getLatticeBaseUrl()
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`
  const url = new URL(`${base}${path}`)
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === '') continue
      url.searchParams.set(key, String(value))
    }
  }
  return url.toString()
}

function apiErrorFromParts(status: number, text: string, context?: string): LatticeApiError {
  let body: PlatformErrorBody | null = null
  try {
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed === 'object' && parsed !== null) body = parsed as PlatformErrorBody
  } catch {
    // Non-JSON error body (gateway HTML, etc.): fall back to the status code
  }
  const serverMessage = typeof body?.message === 'string' ? body.message.trim() : ''
  const code = typeof body?.code === 'string' && body.code ? body.code : `HTTP_${status}`
  const message = serverMessage || `插件中心请求失败（HTTP ${status}）`
  return new LatticeApiError(context ? `${context}：${message}` : message, {
    status,
    code,
    details: body?.details,
    traceId: typeof body?.trace_id === 'string' ? body.trace_id : undefined
  })
}

async function apiErrorFromResponse(
  response: Response,
  context?: string
): Promise<LatticeApiError> {
  let text = ''
  try {
    text = await response.text()
  } catch {
    // If the error body cannot be read, only the status code remains
  }
  return apiErrorFromParts(response.status, text, context)
}

function toNetworkError(err: unknown, action: string): LatticeApiError {
  const cause =
    err instanceof Error
      ? err.cause instanceof Error
        ? err.cause.message
        : err.message
      : String(err)
  const baseUrl = getLatticeBaseUrl()
  if (err instanceof Error && err.name === 'AbortError') {
    return new LatticeApiError(`${action}超时（${baseUrl}）`, { code: 'TIMEOUT', details: cause })
  }
  if (cause.includes('上传超时')) {
    return new LatticeApiError(`${action}超时（${baseUrl}）`, { code: 'TIMEOUT', details: cause })
  }
  return new LatticeApiError(`${action}失败：无法连接插件中心 ${baseUrl}（${cause}）`, {
    code: 'NETWORK',
    details: cause
  })
}

// ---------- Low-level fetch (with timeout and error normalization) ----------

interface FetchOnceOptions {
  method: string
  url: string
  headers: Record<string, string>
  body?: RequestInit['body']
  redirect?: RequestInit['redirect']
  timeoutMs?: number
}

async function fetchOnce(options: FetchOnceOptions): Promise<Response> {
  const controller = new AbortController()
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(options.url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      redirect: options.redirect,
      signal: controller.signal
    })
  } catch (err) {
    throw toNetworkError(err, '请求插件中心')
  } finally {
    clearTimeout(timer)
  }
}

// ---------- Auth / session ----------

interface ApiAccessTokenResponse {
  access_jwt?: unknown
  access_token?: unknown
  refresh_token?: unknown
  expires_in?: unknown
  user?: unknown
  device?: { id?: unknown; fingerprint?: unknown } | null
}

/** Platform user object → shared LatticeUser (handles the login/refresh/me shapes) */
function normalizeApiUser(raw: unknown): LatticeUser | null {
  if (typeof raw !== 'object' || raw === null) return null
  const obj = raw as Record<string, unknown>
  const id =
    typeof obj.id === 'string' ? obj.id : typeof obj.user_id === 'string' ? obj.user_id : ''
  const username = typeof obj.username === 'string' ? obj.username : ''
  if (!id && !username) return null
  const avatar = normalizeLatticeAvatar(obj.avatar)
  return {
    id,
    username,
    display_name: typeof obj.display_name === 'string' ? obj.display_name : null,
    // Older platforms omit avatar → leave the field out (undefined) and keep the existing session value; null on newer platforms means no avatar
    ...(avatar !== undefined ? { avatar } : {})
  }
}

function readAccessToken(data: ApiAccessTokenResponse): string {
  if (typeof data.access_jwt === 'string' && data.access_jwt !== '') return data.access_jwt
  if (typeof data.access_token === 'string' && data.access_token !== '') return data.access_token
  return ''
}

let refreshInFlight: Promise<string> | null = null

/**
 * Refresh the access token (**single-flight**; rotating refresh, the old token is invalidated
 * immediately, so a success must be persisted synchronously).
 *
 * Failure semantics: server rejection (401/403/409, including refresh replay) → clear the session
 * and broadcast logged-out; network error/5xx/429 → keep the session (the token may still be valid,
 * retry after a restart).
 */
export async function refreshLatticeAccessToken(): Promise<string> {
  if (refreshInFlight) return refreshInFlight
  const refreshToken = session.getLatticeRefreshToken()
  if (!refreshToken) {
    /**
     * Not logged in is not the same as an expired login: do not go through `notifyAuthLost` (it
     * broadcasts "login expired" and triggers a data-space switch). After the user logs out, an
     * action from the plugin center should only get "please log in first".
     */
    throw new LatticeApiError('未登录插件中心，请先登录', { code: 'AUTH_REQUIRED' })
  }
  const task = (async (): Promise<string> => {
    // Session epoch at request time: the user may log out or switch accounts before the response
    // arrives, and a late refresh response must never write back the old session (especially the
    // rotated new refresh token).
    const epoch = session.getLatticeSessionEpoch()
    const response = await fetchOnce({
      method: 'POST',
      url: buildLatticeUrl('/v1/auth/refresh'),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
      timeoutMs: 15_000
    })
    if (!response.ok) {
      const apiError = await apiErrorFromResponse(response, '刷新登录态')
      if (response.status === 401 || response.status === 403 || response.status === 409) {
        throw notifyAuthLost(apiError.message)
      }
      throw apiError
    }
    const data = (await response.json()) as ApiAccessTokenResponse
    const accessToken = readAccessToken(data)
    if (!accessToken) {
      throw new LatticeApiError('刷新登录态失败：响应里没有 access token', { code: 'FORMAT' })
    }
    if (epoch !== session.getLatticeSessionEpoch() || !session.hasLatticeSession()) {
      logger.info(
        '[Lattice] Discarded a late refresh response (session changed while it was in flight)'
      )
      throw new LatticeApiError('登录状态已变更，本次刷新已取消', { code: 'AUTH_REQUIRED' })
    }
    session.applyLatticeRefresh({
      accessToken,
      refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : refreshToken,
      expiresIn: typeof data.expires_in === 'number' ? data.expires_in : 0,
      user: normalizeApiUser(data.user)
    })
    logger.info('[Lattice] Access token refreshed')
    return accessToken
  })()
  refreshInFlight = task
  try {
    return await task
  } finally {
    refreshInFlight = null
  }
}

/** Get a usable access token (refresh first if expired/missing); throws AUTH_REQUIRED when not logged in */
export async function ensureLatticeAccessToken(): Promise<string> {
  if (session.isLatticeAccessTokenFresh()) return session.getLatticeAccessToken() as string
  return await refreshLatticeAccessToken()
}

/** Whether logged in (a refresh token exists; access can be refreshed on demand) */
export function isLatticeLoggedIn(): boolean {
  return session.hasLatticeSession()
}

/**
 * Log in. Throws `LatticeApiError` on failure (the platform's original message); on success it
 * makes one extra `/v1/me` call to obtain the role.
 *
 * Note: the `login` response does not include `role`; only `/v1/me` has it.
 */
export async function loginLattice(
  username: string,
  password: string
): Promise<{ user: LatticeUser; role?: string }> {
  const account = username.trim()
  if (!account) throw new LatticeApiError('请输入账号', { code: 'INPUT' })
  if (password === '') throw new LatticeApiError('请输入密码', { code: 'INPUT' })

  const response = await fetchOnce({
    method: 'POST',
    url: buildLatticeUrl('/v1/auth/login'),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: account,
      password,
      device_name: getLatticeDeviceName(),
      device_fp: getLatticeDeviceFingerprint(),
      platform: process.platform
    }),
    timeoutMs: REQUEST_TIMEOUT_MS
  })
  if (!response.ok) throw await apiErrorFromResponse(response)
  const data = (await response.json()) as ApiAccessTokenResponse
  const accessToken = readAccessToken(data)
  const refreshToken = typeof data.refresh_token === 'string' ? data.refresh_token : ''
  if (!accessToken || !refreshToken) {
    throw new LatticeApiError('插件中心登录响应缺少 token', { code: 'FORMAT' })
  }
  const user = normalizeApiUser(data.user)
  if (!user) throw new LatticeApiError('插件中心登录响应缺少用户信息', { code: 'FORMAT' })
  session.applyLatticeLogin({
    accessToken,
    refreshToken,
    expiresIn: typeof data.expires_in === 'number' ? data.expires_in : 0,
    user,
    role: null,
    deviceId: typeof data.device?.id === 'string' ? data.device.id : null
  })
  logger.info(`[Lattice] Login succeeded: ${user.username}`)
  // Fetch the role: failure does not affect the fact that we are logged in (role is absent for now; sync does not depend on it)
  let role: string | undefined
  try {
    const me = await fetchLatticeMe()
    role = me.role
  } catch (err) {
    logger.warn(
      `[Lattice] Failed to read /v1/me after login (role unavailable): ${latticeErrorMessage(err)}`
    )
  }
  return {
    user: session.getLatticeSessionSnapshot().user ?? user,
    ...(role ? { role } : {})
  }
}

/**
 * Log out: best-effort revoke the server-side refresh (`POST /v1/auth/logout` → 204), then clear the
 * local session unconditionally.
 */
export async function logoutLattice(): Promise<void> {
  if (session.hasLatticeSession()) {
    try {
      await latticeRequest('/v1/auth/logout', { method: 'POST' })
    } catch (err) {
      logger.warn(
        `[Lattice] Server logout failed (local login state will still be cleared): ${latticeErrorMessage(err)}`
      )
    }
  }
  session.clearLatticeSession()
  logger.info('[Lattice] Logged out')
}

interface ApiMeResponse {
  user_id?: unknown
  username?: unknown
  display_name?: unknown
  /** Avatar (since platform v0.8; older platforms lack the field → undefined, keep the session cache) */
  avatar?: unknown
  role?: unknown
}

/**
 * Current user (`GET /v1/me`). Since platform v0.14 it returns `username`/`display_name`, so a cold
 * start can restore the account identity from the refresh token alone, without querying
 * `/v1/users/{id}` again. Since platform v0.8 (avatar) `/v1/me` also carries `avatar`; when an older
 * platform omits the field, keep the avatar cached in the session instead of mistaking "the old
 * version returned nothing" for "the user cleared the avatar".
 * Also caches the role/identity in the session.
 */
export async function fetchLatticeMe(): Promise<LatticeMeResult> {
  const raw = await latticeRequest<ApiMeResponse>('/v1/me')
  const avatar = normalizeLatticeAvatar(raw.avatar)
  const user: LatticeUser = {
    id: typeof raw.user_id === 'string' ? raw.user_id : '',
    username: typeof raw.username === 'string' ? raw.username : '',
    display_name: typeof raw.display_name === 'string' ? raw.display_name : null,
    ...(avatar !== undefined ? { avatar } : {})
  }
  const role = typeof raw.role === 'string' ? raw.role : ''
  session.updateLatticeIdentity(user, role || null)
  const snapshot = session.getLatticeSessionSnapshot()
  return { user: snapshot.user ?? user, role: snapshot.role ?? role }
}

// ---------- Generic requests ----------

export interface LatticeRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** JSON request body (adds Content-Type: application/json automatically) */
  body?: unknown
  query?: Record<string, string | number | boolean | undefined>
  headers?: Record<string, string>
  /** Defaults to true (sends Authorization and, on 401, refreshes single-flight then retries once) */
  auth?: boolean
  redirect?: RequestInit['redirect']
  timeoutMs?: number
}

async function sendLatticeRequest(
  pathname: string,
  options: LatticeRequestOptions,
  attempt: number
): Promise<Response> {
  const url = buildLatticeUrl(pathname, options.query)
  const headers: Record<string, string> = { ...(options.headers ?? {}) }
  let body: RequestInit['body']
  if (options.body !== undefined) {
    if (!headers['Content-Type']) headers['Content-Type'] = 'application/json'
    body = JSON.stringify(options.body)
  }
  const withAuth = options.auth !== false
  if (withAuth) {
    headers.Authorization = `Bearer ${await ensureLatticeAccessToken()}`
  }
  const response = await fetchOnce({
    method: options.method ?? 'GET',
    url,
    headers,
    body,
    redirect: options.redirect,
    timeoutMs: options.timeoutMs
  })
  if (response.status === 401 && withAuth && attempt === 0) {
    // Credentials expired: refresh single-flight and **retry once** (a failed refresh throws AUTH_FAIL and clears the session)
    await refreshLatticeAccessToken()
    return await sendLatticeRequest(pathname, options, 1)
  }
  return response
}

/** Generic JSON request: non-2xx throws `LatticeApiError`; 204/empty response returns undefined */
export async function latticeRequest<T>(
  pathname: string,
  options: LatticeRequestOptions = {}
): Promise<T> {
  const response = await sendLatticeRequest(pathname, options, 0)
  if (!response.ok) throw await apiErrorFromResponse(response)
  if (response.status === 204) return undefined as T
  const text = await response.text()
  if (text === '') return undefined as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw new LatticeApiError(`插件中心返回了非 JSON 响应（HTTP ${response.status}）`, {
      status: response.status,
      code: 'FORMAT'
    })
  }
}

/**
 * Generic request that returns the raw `Response` (**without** checking the status code).
 *
 * Needed for downloads: `GET .../download` is expected to return `302` + `Location`, so the
 * response headers must be read here; the 401 retry is already handled inside
 * `sendLatticeRequest`.
 */
export async function latticeRequestResponse(
  pathname: string,
  options: LatticeRequestOptions = {}
): Promise<Response> {
  return await sendLatticeRequest(pathname, options, 0)
}

/**
 * Download a plugin package (`GET .../download` is expected to return 302 → MinIO presigned URL).
 *
 * Uses node's global `fetch(redirect:'manual')`: in practice Node 22 / Electron 44 exposes the 302
 * and its `Location` (in browser semantics manual is opaque-redirect; Node's undici is not).
 * Once the presigned URL is obtained, fetch it again **without Authorization** — the URL is already
 * signed, and leaking the JWT to the object store is both unnecessary and prone to double-auth
 * conflicts.
 * Fallback: if manual is followed automatically in some environment (direct 200), read the bytes
 * from the response body.
 *
 * After the download, verify against `expectedSha256` (or the `X-Content-SHA256` response header)
 * and fail immediately on a mismatch.
 */
export async function downloadLatticeFile(
  pathname: string,
  options: { expectedSha256?: string } = {}
): Promise<{ bytes: Buffer; sha256?: string; viaRedirect: boolean }> {
  const response = await sendLatticeRequest(
    pathname,
    { redirect: 'manual', timeoutMs: TRANSFER_TIMEOUT_MS },
    0
  )
  let bytes: Buffer
  let viaRedirect = false
  let headerSha: string | null = null
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location')
    headerSha = response.headers.get('x-content-sha256')
    if (!location) {
      throw new LatticeApiError(`下载插件包失败：${response.status} 重定向响应里没有 Location`, {
        status: response.status,
        code: 'FORMAT'
      })
    }
    const target = new URL(location, getLatticeBaseUrl()).toString()
    const presigned = await fetchOnce({
      method: 'GET',
      url: target,
      headers: {},
      timeoutMs: TRANSFER_TIMEOUT_MS
    })
    if (!presigned.ok) throw await apiErrorFromResponse(presigned, '下载插件包')
    bytes = Buffer.from(await presigned.arrayBuffer())
    viaRedirect = true
  } else if (response.ok) {
    headerSha = response.headers.get('x-content-sha256')
    bytes = Buffer.from(await response.arrayBuffer())
  } else {
    throw await apiErrorFromResponse(response)
  }

  const expected = (options.expectedSha256 ?? headerSha ?? '').toLowerCase()
  if (expected) {
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== expected) {
      throw new LatticeApiError(
        `插件包校验失败（sha256 不一致）：期望 ${expected.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…`,
        { code: 'CHECKSUM' }
      )
    }
  }
  return { bytes, sha256: expected || undefined, viaRedirect }
}

// ---------- Upload (raw bytes, with Content-Length and real byte progress) ----------

interface NodeUploadResult {
  status: number
  text: string
}

function nodeUpload(
  url: string,
  bytes: Buffer,
  headers: Record<string, string>,
  onProgress?: (sent: number, total: number) => void
): Promise<NodeUploadResult> {
  return new Promise<NodeUploadResult>((resolve, reject) => {
    const target = new URL(url)
    const transport = target.protocol === 'https:' ? https : http
    let settled = false
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      fn()
    }
    const request = transport.request(
      target,
      {
        method: 'PUT',
        headers: { ...headers, 'Content-Length': String(bytes.length) }
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () =>
          settle(() =>
            resolve({
              status: response.statusCode ?? 0,
              text: Buffer.concat(chunks).toString('utf-8')
            })
          )
        )
        response.on('error', (err) => settle(() => reject(toNetworkError(err, '上传插件包'))))
      }
    )
    request.on('error', (err) => settle(() => reject(toNetworkError(err, '上传插件包'))))
    request.setTimeout(TRANSFER_TIMEOUT_MS, () => {
      request.destroy(new Error('上传超时'))
    })
    // Write sequentially in 256KiB chunks: about 80 callbacks for the 20MiB limit, enough for the renderer to draw a smooth progress bar
    const chunkSize = 256 * 1024
    let offset = 0
    const writeNext = (): void => {
      if (offset >= bytes.length) {
        request.end()
        return
      }
      const end = Math.min(offset + chunkSize, bytes.length)
      const chunk = bytes.subarray(offset, end)
      offset = end
      request.write(chunk, () => {
        onProgress?.(offset, bytes.length)
        writeNext()
      })
    }
    writeNext()
  })
}

/**
 * PUT raw bytes (plugin package upload): `http(s).request` with an explicit `Content-Length` (a
 * required header for the platform), reporting progress per chunk; refresh and retry once on 401.
 */
export async function uploadLatticeBytes(
  pathname: string,
  bytes: Buffer,
  headers: Record<string, string>,
  onProgress?: (sent: number, total: number) => void
): Promise<NodeUploadResult> {
  const run = async (attempt: number): Promise<NodeUploadResult> => {
    const token = await ensureLatticeAccessToken()
    const result = await nodeUpload(
      buildLatticeUrl(pathname),
      bytes,
      { ...headers, Authorization: `Bearer ${token}` },
      onProgress
    )
    if (result.status === 401 && attempt === 0) {
      await refreshLatticeAccessToken()
      return await run(1)
    }
    return result
  }
  const result = await run(0)
  if (result.status < 200 || result.status >= 300) {
    throw apiErrorFromParts(result.status, result.text)
  }
  // Drive the progress bar to 100% (upload finished event)
  onProgress?.(bytes.length, bytes.length)
  return result
}
