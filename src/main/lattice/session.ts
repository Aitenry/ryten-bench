import { app, safeStorage } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import logger from 'electron-log'
import { getLatticeBaseUrl } from './settings'
import { normalizeLatticeAvatar, type LatticeUser } from './types'

/**
 * Lattice 会话（`userData/lattice-session.json`）。
 *
 * 存储口径（契约 §4）：
 * - **access token 只在内存**：短寿命（平台 TTL 900s），落盘没有意义，反而扩大泄露面；
 * - **refresh token 持久化**：有 `safeStorage` 时用系统钥匙串加密后存 base64；不可用时
 *   （Linux 缺 keyring / 启动早期）退回明文并 **warn**，开发环境下这是可接受的降级；
 * - 同时缓存 `user` / `role` / `deviceId` / 登录时的 `baseUrl`：
 *   冷启动只有 refresh token 时先用缓存把账号区点亮，再用 `/v1/me` 校正（平台 v0.14 已补
 *   `username`/`display_name`，不必再查 `/v1/users/{id}`）。
 *
 * 基址变化会让会话失效：token 是某个节点签发的，换服务器后拿旧 token 去刷新只会 401；
 * `loadLatticeSession()` 发现文件里记的 baseUrl 与当前生效基址不一致时直接丢弃会话。
 */

const SESSION_FILE = 'lattice-session.json'
const SESSION_VERSION = 1

/** 落盘形状（只有 refresh token 需要加密，其余字段非敏感） */
interface StoredLatticeSession {
  version: number
  /** true = `refreshToken` 是 safeStorage 密文的 base64；false = 明文（safeStorage 不可用） */
  encrypted: boolean
  refreshToken: string
  /** 登录时生效的基址；与当前基址不同 → 会话作废 */
  baseUrl?: string
  user?: LatticeUser | null
  role?: string | null
  deviceId?: string | null
  savedAt?: number
}

/** 内存态会话 */
interface SessionState {
  loaded: boolean
  accessToken: string | null
  /** access token 过期时间（毫秒时间戳） */
  expiresAt: number | null
  refreshToken: string | null
  user: LatticeUser | null
  role: string | null
  deviceId: string | null
}

const state: SessionState = {
  loaded: false,
  accessToken: null,
  expiresAt: null,
  refreshToken: null,
  user: null,
  role: null,
  deviceId: null
}

/**
 * 会话代际：每次「登录 / 退出」自增。
 *
 * 用途：refresh 是异步网络请求，响应可能在用户已经退出登录（甚至换了账号）之后才回来。
 * 没有代际校验时，迟到的 `applyLatticeRefresh` 会把新的 refresh token 写回内存并重建
 * `lattice-session.json`——用户明明点了退出，重启后又变回已登录（轮换后的 token 仍有效）。
 * `client.ts` 在请求返回后比对代际：不一致就丢弃响应，不写会话。
 */
let sessionEpoch = 0

/** 当前会话代际（refresh 响应落地前比对） */
export function getLatticeSessionEpoch(): number {
  return sessionEpoch
}

function sessionPath(): string {
  return path.join(app.getPath('userData'), SESSION_FILE)
}

/** 平台用户对象 → 会话里的最小身份（字段可能来自 login/refresh/me 三处之一） */
function normalizeUser(raw: unknown): LatticeUser | null {
  if (typeof raw !== 'object' || raw === null) return null
  const obj = raw as Record<string, unknown>
  const id =
    typeof obj.id === 'string' ? obj.id : typeof obj.user_id === 'string' ? obj.user_id : ''
  const username = typeof obj.username === 'string' ? obj.username : ''
  if (!id && !username) return null
  const displayName = typeof obj.display_name === 'string' ? obj.display_name : null
  // 落盘的 user 里没有 avatar（旧主进程/旧平台）→ null（界面回退首字母），不报错
  return {
    id,
    username,
    display_name: displayName,
    avatar: normalizeLatticeAvatar(obj.avatar) ?? null
  }
}

/**
 * 合并「新的平台身份」到会话缓存：
 * - id/username 缺失时保留旧值（`/v1/me` 早期只有 user_id 等兼容场景）；
 * - `display_name` 用 `??`（null 视为「沿用旧值」，保持原有口径）；
 * - `avatar` 区分 undefined（旧平台没这个字段 → 保留缓存）与 null（明确无头像 → 清空）。
 */
function mergeUser(previous: LatticeUser | null, next: LatticeUser): LatticeUser {
  const avatar = normalizeLatticeAvatar(next.avatar)
  return {
    id: next.id || previous?.id || '',
    username: next.username || previous?.username || '',
    display_name: next.display_name ?? previous?.display_name ?? null,
    avatar: avatar !== undefined ? avatar : (previous?.avatar ?? null)
  }
}

/** 是否可安全加解密（Linux 上取决于 keyring；不可用时降级明文） */
function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch (err) {
    logger.warn('[Lattice] Failed to check safeStorage availability:', err)
    return false
  }
}

function encryptRefreshToken(token: string): { value: string; encrypted: boolean } {
  if (encryptionAvailable()) {
    try {
      return { value: safeStorage.encryptString(token).toString('base64'), encrypted: true }
    } catch (err) {
      logger.warn(
        '[Lattice] safeStorage failed to encrypt refresh token, falling back to plaintext:',
        err
      )
    }
  } else {
    logger.warn(
      '[Lattice] safeStorage unavailable, refresh token will be saved as **plaintext** in userData/lattice-session.json (acceptable in development)'
    )
  }
  return { value: token, encrypted: false }
}

function decryptRefreshToken(stored: StoredLatticeSession): string | null {
  if (!stored.encrypted) return stored.refreshToken
  if (!encryptionAvailable()) {
    logger.warn(
      '[Lattice] safeStorage unavailable, cannot decrypt the saved refresh token (login required again)'
    )
    return null
  }
  try {
    return safeStorage.decryptString(Buffer.from(stored.refreshToken, 'base64'))
  } catch (err) {
    logger.warn(
      '[Lattice] Failed to decrypt refresh token (system keychain or user environment may have changed), login required:',
      err
    )
    return null
  }
}

/** 删除会话文件（失败只告警：内存态清掉后功能已经不可用，不该因此抛错） */
function removeSessionFile(): void {
  try {
    fs.rmSync(sessionPath(), { force: true })
  } catch (err) {
    logger.warn('[Lattice] Failed to delete lattice-session.json:', err)
  }
}

/** 清空内存态会话 */
function resetState(): void {
  state.accessToken = null
  state.expiresAt = null
  state.refreshToken = null
  state.user = null
  state.role = null
  state.deviceId = null
}

/** 从磁盘恢复会话（幂等；启动时调用一次）。返回是否恢复出 refresh token */
export function loadLatticeSession(): boolean {
  if (state.loaded) return state.refreshToken !== null
  state.loaded = true
  let stored: StoredLatticeSession
  try {
    const raw = JSON.parse(fs.readFileSync(sessionPath(), 'utf-8')) as unknown
    if (typeof raw !== 'object' || raw === null) throw new Error('会话文件格式非法')
    stored = raw as StoredLatticeSession
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code
    if (code !== 'ENOENT')
      logger.warn('[Lattice] Failed to read lattice-session.json, treating as logged out:', err)
    return false
  }

  if (stored.version !== SESSION_VERSION) {
    logger.info(
      `[Lattice] Session file version mismatch (${stored.version} != ${SESSION_VERSION}), ignoring`
    )
    removeSessionFile()
    return false
  }

  // 基址变了：旧 token 属于别的节点，直接丢弃
  const currentBaseUrl = getLatticeBaseUrl()
  if (stored.baseUrl && stored.baseUrl !== currentBaseUrl) {
    logger.info(
      `[Lattice] Plugin hub URL changed (${stored.baseUrl} -> ${currentBaseUrl}), discarding old login state`
    )
    removeSessionFile()
    return false
  }

  const refreshToken = decryptRefreshToken(stored)
  if (!refreshToken) {
    removeSessionFile()
    return false
  }

  state.refreshToken = refreshToken
  state.user = normalizeUser(stored.user)
  state.role = typeof stored.role === 'string' ? stored.role : null
  state.deviceId = typeof stored.deviceId === 'string' ? stored.deviceId : null
  logger.info(`[Lattice] Restored login state${state.user ? `: ${state.user.username}` : ''}`)
  return true
}

/** 会话快照（状态广播用；不含 token） */
export interface LatticeSessionSnapshot {
  loggedIn: boolean
  user: LatticeUser | null
  role: string | null
  expiresAt: number | null
  deviceId: string | null
}

export function getLatticeSessionSnapshot(): LatticeSessionSnapshot {
  return {
    loggedIn: state.refreshToken !== null,
    user: state.user,
    role: state.role,
    expiresAt: state.expiresAt,
    deviceId: state.deviceId
  }
}

export function hasLatticeSession(): boolean {
  return state.refreshToken !== null
}

export function getLatticeAccessToken(): string | null {
  return state.accessToken
}

export function getLatticeRefreshToken(): string | null {
  return state.refreshToken
}

export function getLatticeExpiresAt(): number | null {
  return state.expiresAt
}

export function getLatticeDeviceId(): string | null {
  return state.deviceId
}

/** access token 是否还可直接用（提前 30s 视为过期，避免请求发出时恰好过期） */
export function isLatticeAccessTokenFresh(skewMs = 30_000): boolean {
  if (!state.accessToken) return false
  if (state.expiresAt === null) return true
  return Date.now() < state.expiresAt - skewMs
}

/** 登录成功的会话落地（内存 + 文件；access 只在内存） */
export function applyLatticeLogin(data: {
  accessToken: string
  refreshToken: string
  expiresIn: number
  user: LatticeUser
  role?: string | null
  deviceId?: string | null
}): void {
  // 新的登录 = 新会话代际：之前那次账号的 refresh 响应即使迟到，也不能再写进来
  sessionEpoch += 1
  state.accessToken = data.accessToken
  state.expiresAt = Number.isFinite(data.expiresIn) ? Date.now() + data.expiresIn * 1000 : null
  state.refreshToken = data.refreshToken
  state.user = mergeUser(null, data.user)
  state.role = typeof data.role === 'string' ? data.role : null
  state.deviceId = data.deviceId ?? null
  persistLatticeSession()
}

/** 刷新成功后的会话更新（轮换式 refresh：旧 token 立即失效，必须同步落盘新值） */
export function applyLatticeRefresh(data: {
  accessToken: string
  refreshToken: string
  expiresIn: number
  user?: LatticeUser | null
}): void {
  state.accessToken = data.accessToken
  state.expiresAt = Number.isFinite(data.expiresIn) ? Date.now() + data.expiresIn * 1000 : null
  state.refreshToken = data.refreshToken
  // refresh 响应可能不带 avatar（旧平台）：merge 保留缓存头像，不误清空
  if (data.user) state.user = mergeUser(state.user, data.user)
  persistLatticeSession()
}

/**
 * 用 `/v1/me` 校正身份（补 role / display_name / avatar；username 缺失时保留原值）。
 *
 * `avatar` 口径：平台返回 null = 用户已清空头像 → 清空；旧平台没有该字段
 * （undefined）= 保留缓存，避免一次 `/v1/me` 把还能用的头像误删。
 */
export function updateLatticeIdentity(user: LatticeUser, role?: string | null): void {
  state.user = mergeUser(state.user, user)
  if (typeof role === 'string' && role !== '') state.role = role
  persistLatticeSession()
}

/** 把 refresh token 与身份写盘（幂等；无 refresh token 时删除文件） */
export function persistLatticeSession(): void {
  if (!state.refreshToken) {
    removeSessionFile()
    return
  }
  const { value, encrypted } = encryptRefreshToken(state.refreshToken)
  const stored: StoredLatticeSession = {
    version: SESSION_VERSION,
    encrypted,
    refreshToken: value,
    baseUrl: getLatticeBaseUrl(),
    user: state.user,
    role: state.role,
    deviceId: state.deviceId,
    savedAt: Date.now()
  }
  const file = sessionPath()
  const tmp = `${file}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, `${JSON.stringify(stored, null, 2)}\n`, 'utf-8')
    // 收紧权限（安全审计 S20）：refresh token 即使被 safeStorage 加密，在多用户机器上
    // 也不该让同机其它账户读到会话文件；POSIX 下 0600 只允许本人读写。
    try {
      fs.chmodSync(tmp, 0o600)
    } catch {
      // Windows / 只读介质上 chmod 可能失败：不影响功能，权限收紧只是纵深防御
    }
    fs.renameSync(tmp, file)
  } catch (err) {
    logger.warn('[Lattice] Failed to write lattice-session.json:', err)
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      // 清理临时文件失败无意义
    }
  }
}

/** 退出登录：清内存 + 删文件 */
export function clearLatticeSession(): void {
  // 代际先自增：正在飞的 refresh 响应回来时会发现自己已经过期，不会把会话写回来
  sessionEpoch += 1
  resetState()
  removeSessionFile()
}

/** 基址变化后丢弃旧会话（返回是否真的清掉了登录态） */
export function clearLatticeSessionIfBaseUrlChanged(previousBaseUrl: string): boolean {
  if (!state.refreshToken) return false
  if (previousBaseUrl === getLatticeBaseUrl()) return false
  clearLatticeSession()
  return true
}
