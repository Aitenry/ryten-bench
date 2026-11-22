import { createHash } from 'crypto'
import * as http from 'http'
import * as https from 'https'
import logger from 'electron-log'
import { getLatticeBaseUrl, getLatticeDeviceFingerprint, getLatticeDeviceName } from './settings'
import * as session from './session'
import { normalizeLatticeAvatar, type LatticeMeResult, type LatticeUser } from './types'

/**
 * Lattice 平台 HTTP 客户端（用户面 `/v1/*`）。
 *
 * 约定：
 * - **401 单飞刷新**：任一请求拿到 401 时，若本地已有 refresh token，则只有一个刷新请求在飞，
 *   其余请求等它；刷新成功后**重试原请求一次**。刷新被服务端拒绝（401/403/409）→ 清会话并
 *   广播未登录；网络失败/5xx 不清会话（离线启动不该把用户登出）。
 * - **错误归一化**：平台错误体 `{code,message,details,trace_id}` → `LatticeApiError`，渲染层
 *   拿到的是可读的 `message`（平台原文），排障用 `details` / `traceId`。
 * - 普通 JSON 请求走全局 `fetch`；插件包**上传**走 node `http(s)`：平台要求 `Content-Length`，
 *   且我们需要按块上报真实字节进度（`fetch` + Buffer 只能一次到头）。
 */

/** 普通 JSON 请求超时 */
const REQUEST_TIMEOUT_MS = 20_000
/** 插件包上传/下载超时（20MiB 在慢网络下可能超过 1min） */
const TRANSFER_TIMEOUT_MS = 180_000

/** 平台错误体（字段名沿用平台返回） */
interface PlatformErrorBody {
  code?: unknown
  message?: unknown
  details?: unknown
  trace_id?: unknown
}

/** 归一化后的平台错误（渲染层只需要 message；其余供日志/排障） */
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

/** 任意错误 → 给渲染层看的可读文本（不抛错） */
export function latticeErrorMessage(err: unknown): string {
  if (err instanceof LatticeApiError) return err.message
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return String(err)
}

/**
 * 是否「凭证失效」类错误。
 *
 * 只有这两类：刷新被服务端拒绝（AUTH_FAIL/401）、以及本地压根没有 refresh token（AUTH_REQUIRED）。
 * 网络错误（NETWORK/TIMEOUT）**不算**——离线时 token 仍可能有效。
 */
export function isLatticeAuthError(err: unknown): boolean {
  if (!(err instanceof LatticeApiError)) return false
  return err.code === 'AUTH_FAIL' || err.code === 'AUTH_REQUIRED'
}

/** 凭证失效时通知外层（lattice/index.ts 注册：清 lastError + 广播未登录） */
let authLostHandler: (() => void) | null = null

export function setLatticeAuthLostHandler(handler: (() => void) | null): void {
  authLostHandler = handler
}

/** 清会话并构造/抛出「需要重新登录」错误；同时通知外层广播 */
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

// ---------- URL / 错误构造 ----------

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
    // 非 JSON 错误体（网关 HTML 等）：用状态码兜底
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
    // 读错误体失败就只剩状态码
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

// ---------- 底层 fetch（带超时与错误归一化） ----------

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

// ---------- 认证 / 会话 ----------

interface ApiAccessTokenResponse {
  access_jwt?: unknown
  access_token?: unknown
  refresh_token?: unknown
  expires_in?: unknown
  user?: unknown
  device?: { id?: unknown; fingerprint?: unknown } | null
}

/** 平台用户对象 → 共享 LatticeUser（兼容 login/refresh/me 三种形状） */
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
    // 旧平台不返回 avatar → 省略字段（undefined），保留会话里已有值；新平台 null = 无头像
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
 * 刷新 access token（**单飞**；轮换式 refresh，旧 token 立即失效，成功必须同步落盘）。
 *
 * 失败语义：服务端拒绝（401/403/409，含 refresh 重放）→ 清会话 + 广播未登录；
 * 网络错误/5xx/429 → 保留会话（token 可能仍有效，重启后再试）。
 */
export async function refreshLatticeAccessToken(): Promise<string> {
  if (refreshInFlight) return refreshInFlight
  const refreshToken = session.getLatticeRefreshToken()
  if (!refreshToken) {
    throw notifyAuthLost('未登录插件中心，请先登录')
  }
  const task = (async (): Promise<string> => {
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

/** 取一个可用的 access token（过期/缺失时先刷新）；没有登录态抛 AUTH_REQUIRED */
export async function ensureLatticeAccessToken(): Promise<string> {
  if (session.isLatticeAccessTokenFresh()) return session.getLatticeAccessToken() as string
  return await refreshLatticeAccessToken()
}

/** 是否已登录（有 refresh token；access 可按需刷新） */
export function isLatticeLoggedIn(): boolean {
  return session.hasLatticeSession()
}

/**
 * 登录。失败抛 `LatticeApiError`（平台 message 原文）；成功后会补一次 `/v1/me` 拿角色。
 *
 * 注意：`login` 响应不含 `role`，`/v1/me` 才有（契约 §1 用户面字段）。
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
  // 补角色：失败不影响「已登录」这个事实（状态里 role 暂缺，同步不依赖它）
  let role: string | undefined
  try {
    const me = await fetchLatticeMe()
    role = me.role
  } catch (err) {
    logger.warn(`[Lattice] Failed to read /v1/me after login (role unavailable): ${latticeErrorMessage(err)}`)
  }
  return {
    user: session.getLatticeSessionSnapshot().user ?? user,
    ...(role ? { role } : {})
  }
}

/**
 * 退出登录：先尽力吊销服务端 refresh（`POST /v1/auth/logout` → 204），本地无条件清会话。
 */
export async function logoutLattice(): Promise<void> {
  if (session.hasLatticeSession()) {
    try {
      await latticeRequest('/v1/auth/logout', { method: 'POST' })
    } catch (err) {
      logger.warn(`[Lattice] Server logout failed (local login state will still be cleared): ${latticeErrorMessage(err)}`)
    }
  }
  session.clearLatticeSession()
  logger.info('[Lattice] Logged out')
}

interface ApiMeResponse {
  user_id?: unknown
  username?: unknown
  display_name?: unknown
  /** 个人头像（平台 v0.8 起；旧平台没有该字段 → undefined，保留会话缓存） */
  avatar?: unknown
  role?: unknown
}

/**
 * 当前用户（`GET /v1/me`）。平台 v0.14 起返回 `username`/`display_name`，
 * 因此冷启动只靠 refresh token 也能恢复账号区身份，不必再查 `/v1/users/{id}`。
 * 平台 v0.8（头像）起 `/v1/me` 也带 `avatar`；旧平台缺字段时保留会话缓存的头像，
 * 不把「旧版本没返回」误判成「用户清空了头像」。
 * 顺带把 role/身份写进会话缓存。
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

// ---------- 通用请求 ----------

export interface LatticeRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** JSON 请求体（自动带 Content-Type: application/json） */
  body?: unknown
  query?: Record<string, string | number | boolean | undefined>
  headers?: Record<string, string>
  /** 默认 true（带 Authorization，并在 401 时单飞刷新后重试一次） */
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
    // 凭证过期：单飞刷新后**重试一次**（刷新失败会抛 AUTH_FAIL 并清会话）
    await refreshLatticeAccessToken()
    return await sendLatticeRequest(pathname, options, 1)
  }
  return response
}

/** 通用 JSON 请求：非 2xx 抛 `LatticeApiError`；204/空响应返回 undefined */
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
 * 通用请求但返回原始 `Response`（**不**判定状态码）。
 *
 * 下载要用：`GET .../download` 期望 `302` + `Location`，需要自己读响应头；
 * 另外 401 重试已在 `sendLatticeRequest` 内处理。
 */
export async function latticeRequestResponse(
  pathname: string,
  options: LatticeRequestOptions = {}
): Promise<Response> {
  return await sendLatticeRequest(pathname, options, 0)
}

/**
 * 下载插件包（`GET .../download` 期望 302 → MinIO 预签名）。
 *
 * 走 node 全局 `fetch(redirect:'manual')`：实测 Node 22 / Electron 44 下能拿到 302 与
 * `Location`（浏览器语义里 manual 是 opaque-redirect，Node 的 undici 不是）。
 * 拿到预签名地址后**不带 Authorization** 再取一次——地址本身已带签名，把 JWT 漏给
 * 对象存储既无必要也容易触发双重认证冲突。
 * 兜底：若某环境下 manual 被自动跟随（直接 200），就按响应体收字节。
 *
 * 下载完成后按 `expectedSha256`（或响应头 `X-Content-SHA256`）校验，不一致直接报错。
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

// ---------- 上传（原始字节，带 Content-Length 与真实字节进度） ----------

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
    // 256KiB 一块顺序写：20MiB 上限下约 80 次回调，足够渲染层画平滑进度条
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
 * PUT 原始字节（插件包上传）：`http(s).request`，显式 `Content-Length`（平台必填头），
 * 按块上报进度；401 时刷新后重试一次。
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
  // 让进度条收尾到 100%（上传完成事件）
  onProgress?.(bytes.length, bytes.length)
  return result
}
