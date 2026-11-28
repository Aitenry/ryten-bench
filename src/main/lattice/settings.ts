import { app } from 'electron'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import logger from 'electron-log'

/**
 * Plugin hub settings (`userData/lattice-settings.json`).
 *
 * Base URL priority (high -> low):
 * 1. Environment variable `RB_LATTICE_URL` (for offline tooling / intranet deployments; changes to
 *    the setting do not take effect);
 * 2. User setting (written to this file by `lattice:set-base-url`);
 * 3. Default `http://127.0.0.1:8080` (dev node).
 *
 * The file also stores a **device fingerprint**: platform login requires a stable `device_fp` that
 * identifies a machine (`fingerprint_required=true`). Once generated, the fingerprint follows the
 * installation and does not change on logout - otherwise every login would register an extra
 * device on the platform. A random value is used instead of a hash of machine attributes: machine
 * attributes change with the hostname/user, while a random value only needs to be persistent.
 */

/** Default base URL when unconfigured: dev platform node */
export const DEFAULT_LATTICE_BASE_URL = 'http://127.0.0.1:8080'

const SETTINGS_FILE = 'lattice-settings.json'

interface LatticeSettingsFile {
  /** User-configured base URL (normalized, no trailing slash) */
  baseUrl?: string
  /** Local device fingerprint (`sha256:<hex>`, persistent) */
  deviceFp?: string
  /**
   * Auto-restore toggle for missing plugins (**enabled** by default).
   *
   * When enabled, every pull reinstalls plugins that have an install record on the platform but no
   * local package (recovery after a machine change / reinstall / manual directory deletion). When
   * disabled, pending installs are only listed in the sync result's `pending`.
   */
  autoInstallMissing?: boolean
}

let cached: LatticeSettingsFile | null = null

function settingsPath(): string {
  return path.join(app.getPath('userData'), SETTINGS_FILE)
}

/**
 * Reads the file (missing/broken file falls back to empty settings, then fills in the fingerprint)
 */
function readSettings(): LatticeSettingsFile {
  if (cached) return cached
  const parsed: LatticeSettingsFile = {}
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf-8')) as unknown
    if (typeof raw === 'object' && raw !== null) {
      const obj = raw as Record<string, unknown>
      if (typeof obj.baseUrl === 'string' && obj.baseUrl.trim() !== '') {
        try {
          parsed.baseUrl = normalizeLatticeBaseUrl(obj.baseUrl)
        } catch (err) {
          logger.warn(`[Lattice] Invalid base URL in settings, ignoring: ${obj.baseUrl}`, err)
        }
      }
      if (typeof obj.deviceFp === 'string' && obj.deviceFp.trim() !== '') {
        parsed.deviceFp = obj.deviceFp
      }
      // Only an explicit false disables it; unwritten/invalid values default to true (enabled by
      // default; machine-change recovery needs no setup)
      if (obj.autoInstallMissing === false) parsed.autoInstallMissing = false
      else if (obj.autoInstallMissing === true) parsed.autoInstallMissing = true
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code
    if (code !== 'ENOENT')
      logger.warn('[Lattice] Failed to read lattice-settings.json, using default settings:', err)
  }
  // First run: generate and persist the device fingerprint (required for login, stable across
  // sessions)
  if (!parsed.deviceFp) {
    parsed.deviceFp = `sha256:${crypto.randomBytes(24).toString('hex')}`
    writeSettings(parsed)
  }
  cached = parsed
  return cached
}

function writeSettings(next: LatticeSettingsFile): void {
  cached = next
  const file = settingsPath()
  const tmp = `${file}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf-8')
    fs.renameSync(tmp, file)
  } catch (err) {
    logger.warn('[Lattice] Failed to write lattice-settings.json:', err)
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      // Failing to clean up the temp file is not worth reporting
    }
  }
}

/**
 * Normalizes the base URL: only http/https are accepted; trailing slashes, query string and hash
 * are dropped.
 *
 * A path prefix is supported (a reverse proxy may mount the node under `/lattice`), but redundant
 * slashes in the path are collapsed.
 */
export function normalizeLatticeBaseUrl(input: string): string {
  const trimmed = String(input ?? '').trim()
  if (trimmed === '') throw new Error('插件中心地址不能为空')
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error(`插件中心地址不合法（需要 http:// 或 https:// 开头）：${trimmed}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`插件中心地址只支持 http/https：${trimmed}`)
  }
  // Remote nodes must use https: the login password and refresh token are sent to this base URL,
  // so plaintext http is wide open. Local debugging (localhost / 127.0.0.1 / ::1) is allowlisted
  // for http.
  const host = url.hostname.toLowerCase()
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
  if (url.protocol === 'http:' && !loopback) {
    throw new Error(`插件中心地址必须是 https://（本机调试可用 http://localhost）：${trimmed}`)
  }
  const pathname = url.pathname.replace(/\/+$/, '')
  return `${url.protocol}//${url.host}${pathname}`
}

/**
 * Environment variable override (invalid values are warned about and ignored so a typo cannot
 * kill the hub)
 */
function envBaseUrl(): string | null {
  const raw = process.env.RB_LATTICE_URL
  if (!raw || raw.trim() === '') return null
  try {
    return normalizeLatticeBaseUrl(raw)
  } catch (err) {
    logger.warn('[Lattice] Invalid RB_LATTICE_URL environment variable, ignoring:', err)
    return null
  }
}

/**
 * Whether the base URL is locked by an environment variable (setting changes do not take effect)
 */
export function isLatticeBaseUrlLockedByEnv(): boolean {
  return envBaseUrl() !== null
}

/** Currently effective base URL */
export function getLatticeBaseUrl(): string {
  const fromEnv = envBaseUrl()
  if (fromEnv) return fromEnv
  return readSettings().baseUrl ?? DEFAULT_LATTICE_BASE_URL
}

/**
 * Persists the user-configured base URL (returns the normalized value).
 *
 * The effective value is not overridden while the environment variable is set: the file is still
 * written (a user's setting change should not be lost), but `getLatticeBaseUrl()` keeps returning
 * the env value; the IPC layer surfaces the difference to the renderer.
 */
export function setLatticeBaseUrl(input: string): string {
  const normalized = normalizeLatticeBaseUrl(input)
  writeSettings({ ...readSettings(), baseUrl: normalized })
  logger.info(`[Lattice] Plugin hub URL set: ${normalized}`)
  return normalized
}

/** Local device fingerprint (persistent; `device_fp` in the login body) */
export function getLatticeDeviceFingerprint(): string {
  return readSettings().deviceFp as string
}

/**
 * "Auto-restore missing plugins" toggle (**enabled** by default).
 *
 * Why enabled by default: after a machine change or reinstall the user has no local state, so the
 * plugins referenced by install records must be restored automatically before "data sync" even
 * makes sense. Failures are listed individually in the sync details (not silent), and the user can
 * turn this off in the plugin hub.
 */
export function getLatticeAutoInstallMissing(): boolean {
  return readSettings().autoInstallMissing !== false
}

/** Persists the auto-restore toggle (returns the stored value) */
export function setLatticeAutoInstallMissing(enabled: boolean): boolean {
  const next = Boolean(enabled)
  writeSettings({ ...readSettings(), autoInstallMissing: next })
  logger.info(`[Lattice] Automatic restore of missing plugins ${next ? 'enabled' : 'disabled'}`)
  return next
}

/** Local device name (`device_name` in the login body; the platform stores it as a string) */
export function getLatticeDeviceName(): string {
  const host = os.hostname().trim() || 'unknown-host'
  return `RytenBench@${host}`.slice(0, 64)
}
