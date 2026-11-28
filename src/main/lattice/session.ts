import { app, safeStorage } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import logger from 'electron-log'
import { getLatticeBaseUrl } from './settings'
import { normalizeLatticeAvatar, type LatticeUser } from './types'

/**
 * Lattice session (`userData/lattice-session.json`).
 *
 * Storage policy:
 * - **access token stays in memory only**: short-lived (900s platform TTL), persisting it serves no
 *   purpose and only widens the leak surface;
 * - **refresh token is persisted**: encrypted with the system keychain via `safeStorage` and stored
 *   as base64; when unavailable (Linux without keyring / early startup) it falls back to plaintext
 *   with a **warn**, an acceptable degradation in development;
 * - `user` / `role` / `deviceId` / the `baseUrl` at login are cached too: a cold start with only a
 *   refresh token lights up the account area from the cache first, then corrects it via `/v1/me`
 *   (the platform already supplies `username`/`display_name`, so `/v1/users/{id}` is not needed).
 *
 * A base URL change invalidates the session: tokens are issued by a specific node, so refreshing
 * an old token after switching servers only yields 401; `loadLatticeSession()` discards the
 * session when the baseUrl recorded in the file differs from the effective one.
 */

const SESSION_FILE = 'lattice-session.json'
const SESSION_VERSION = 1

/** On-disk shape (only the refresh token needs encryption; the other fields are not sensitive) */
interface StoredLatticeSession {
  version: number
  /**
   * true = `refreshToken` is base64 of the safeStorage ciphertext; false = plaintext (safeStorage
   * unavailable)
   */
  encrypted: boolean
  refreshToken: string
  /** Base URL in effect at login; differing from the current one -> session invalid */
  baseUrl?: string
  user?: LatticeUser | null
  role?: string | null
  deviceId?: string | null
  savedAt?: number
}

/** In-memory session */
interface SessionState {
  loaded: boolean
  accessToken: string | null
  /** Access token expiry (ms timestamp) */
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
 * Session epoch: incremented on every login / logout.
 *
 * Purpose: refresh is an async network request whose response may arrive after the user has
 * already logged out (or even switched accounts). Without an epoch check, a late
 * `applyLatticeRefresh` would write the new refresh token back into memory and recreate
 * `lattice-session.json` - the user clicked logout but comes back logged in after a restart (the
 * rotated token is still valid). `client.ts` compares the epoch once the request returns: on
 * mismatch it drops the response and does not write the session.
 */
let sessionEpoch = 0

/** Current session epoch (compared before a refresh response is applied) */
export function getLatticeSessionEpoch(): number {
  return sessionEpoch
}

function sessionPath(): string {
  return path.join(app.getPath('userData'), SESSION_FILE)
}

/** Platform user object -> minimal session identity (fields may come from login/refresh/me) */
function normalizeUser(raw: unknown): LatticeUser | null {
  if (typeof raw !== 'object' || raw === null) return null
  const obj = raw as Record<string, unknown>
  const id =
    typeof obj.id === 'string' ? obj.id : typeof obj.user_id === 'string' ? obj.user_id : ''
  const username = typeof obj.username === 'string' ? obj.username : ''
  if (!id && !username) return null
  const displayName = typeof obj.display_name === 'string' ? obj.display_name : null
  // The persisted user has no avatar (old main process/platform) -> null (UI falls back to
  // initials), no error
  return {
    id,
    username,
    display_name: displayName,
    avatar: normalizeLatticeAvatar(obj.avatar) ?? null
  }
}

/**
 * Merges a new platform identity into the session cache:
 * - keep the old id/username when missing (compatibility cases such as `/v1/me` returning only
 *   user_id);
 * - `display_name` uses `??` (null means "keep the old value", preserving the existing rule);
 * - `avatar` distinguishes undefined (old platform lacks the field -> keep the cache) from null
 *   (explicitly no avatar -> clear).
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

/**
 * Whether encryption/decryption is available (on Linux it depends on keyring; falls back to
 * plaintext)
 */
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

/**
 * Deletes the session file (only warns on failure: once the in-memory state is cleared the feature
 * is already unusable)
 */
function removeSessionFile(): void {
  try {
    fs.rmSync(sessionPath(), { force: true })
  } catch (err) {
    logger.warn('[Lattice] Failed to delete lattice-session.json:', err)
  }
}

/** Clears the in-memory session */
function resetState(): void {
  state.accessToken = null
  state.expiresAt = null
  state.refreshToken = null
  state.user = null
  state.role = null
  state.deviceId = null
}

/**
 * Restores the session from disk (idempotent; called once at startup). Returns whether a refresh
 * token was restored
 */
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

  // Base URL changed: the old token belongs to another node; discard it
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

/** Session snapshot (for status broadcasts; contains no token) */
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

/** Whether the access token is still usable (treat as expired 30s early to avoid racing expiry) */
export function isLatticeAccessTokenFresh(skewMs = 30_000): boolean {
  if (!state.accessToken) return false
  if (state.expiresAt === null) return true
  return Date.now() < state.expiresAt - skewMs
}

/** Persists a successful login (memory + file; access token stays in memory) */
export function applyLatticeLogin(data: {
  accessToken: string
  refreshToken: string
  expiresIn: number
  user: LatticeUser
  role?: string | null
  deviceId?: string | null
}): void {
  // A new login = a new session epoch: a late refresh response for the previous account must not
  // be written
  sessionEpoch += 1
  state.accessToken = data.accessToken
  state.expiresAt = Number.isFinite(data.expiresIn) ? Date.now() + data.expiresIn * 1000 : null
  state.refreshToken = data.refreshToken
  state.user = mergeUser(null, data.user)
  state.role = typeof data.role === 'string' ? data.role : null
  state.deviceId = data.deviceId ?? null
  persistLatticeSession()
}

/**
 * Session update after a successful refresh (rotating refresh: the old token dies immediately, so
 * the new one must be persisted)
 */
export function applyLatticeRefresh(data: {
  accessToken: string
  refreshToken: string
  expiresIn: number
  user?: LatticeUser | null
}): void {
  state.accessToken = data.accessToken
  state.expiresAt = Number.isFinite(data.expiresIn) ? Date.now() + data.expiresIn * 1000 : null
  state.refreshToken = data.refreshToken
  // A refresh response may omit avatar (old platform): merge keeps the cached avatar instead of
  // clearing it
  if (data.user) state.user = mergeUser(state.user, data.user)
  persistLatticeSession()
}

/**
 * Corrects the identity via `/v1/me` (fills in role / display_name / avatar; keeps the old
 * username when missing).
 *
 * `avatar` rule: the platform returning null means the user cleared the avatar -> clear it; an old
 * platform without the field (undefined) -> keep the cache, so one `/v1/me` does not delete a
 * still-usable avatar.
 */
export function updateLatticeIdentity(user: LatticeUser, role?: string | null): void {
  state.user = mergeUser(state.user, user)
  if (typeof role === 'string' && role !== '') state.role = role
  persistLatticeSession()
}

/**
 * Writes the refresh token and identity to disk (idempotent; deletes the file when there is no
 * refresh token)
 */
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
    // Tighten permissions: even with the refresh token encrypted by safeStorage, other accounts on
    // the same multi-user machine should not read the session file; on POSIX, 0600 allows only the
    // owner.
    try {
      fs.chmodSync(tmp, 0o600)
    } catch {
      // chmod may fail on Windows / read-only media: functionality is unaffected; tightening is
      // defense in depth
    }
    fs.renameSync(tmp, file)
  } catch (err) {
    logger.warn('[Lattice] Failed to write lattice-session.json:', err)
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      // Failing to clean up the temp file is not worth reporting
    }
  }
}

/** Logs out: clear memory + delete the file */
export function clearLatticeSession(): void {
  // Bump the epoch first: an in-flight refresh response will find itself stale and not write the
  // session back
  sessionEpoch += 1
  resetState()
  removeSessionFile()
}

/**
 * Discards the old session after a base URL change (returns whether the login state was actually
 * cleared)
 */
export function clearLatticeSessionIfBaseUrlChanged(previousBaseUrl: string): boolean {
  if (!state.refreshToken) return false
  if (previousBaseUrl === getLatticeBaseUrl()) return false
  clearLatticeSession()
  return true
}
