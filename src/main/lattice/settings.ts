import { app } from 'electron'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import logger from 'electron-log'

/**
 * 插件中心设置（`userData/lattice-settings.json`）。
 *
 * 基址优先级（高 → 低）：
 * 1. 环境变量 `RB_LATTICE_URL`（离线工装 / 内网部署用；设置项改了也不生效）；
 * 2. 用户设置（`lattice:set-base-url` 写入本文件）；
 * 3. 默认 `http://127.0.0.1:8080`（dev 节点）。
 *
 * 文件里还存**设备指纹**：平台登录要求 `device_fp` 稳定标识一台机器（`fingerprint_required=true`），
 * 指纹一旦生成就跟着安装走，不随退出登录变化——否则每次登录都会在平台多注册一个设备。
 * 用随机值而不是机器属性哈希：机器属性会随改主机名/换用户而变，随机值只需持久即可。
 */

/** 未配置时的默认基址：dev 平台节点 */
export const DEFAULT_LATTICE_BASE_URL = 'http://127.0.0.1:8080'

const SETTINGS_FILE = 'lattice-settings.json'

interface LatticeSettingsFile {
  /** 用户设置的基址（规范化后，无末尾斜杠） */
  baseUrl?: string
  /** 本机设备指纹（`sha256:<hex>`，持久不变） */
  deviceFp?: string
  /**
   * 缺失插件自动补齐开关（默认 **开启**）。
   *
   * 开启时每次 pull 会把「平台有安装记录、本机没有插件包」的插件自动重新安装
   * （换机/重装/用户手动删目录后的恢复）；关闭时只在同步结果 `pending` 里列出待安装项。
   */
  autoInstallMissing?: boolean
}

let cached: LatticeSettingsFile | null = null

function settingsPath(): string {
  return path.join(app.getPath('userData'), SETTINGS_FILE)
}

/** 读文件（缺文件/坏文件都退回空设置，并补上设备指纹） */
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
      // 显式 false 才关闭；未写过/非法值都按默认 true 处理（默认开启，换机恢复不需要用户配置）
      if (obj.autoInstallMissing === false) parsed.autoInstallMissing = false
      else if (obj.autoInstallMissing === true) parsed.autoInstallMissing = true
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code
    if (code !== 'ENOENT')
      logger.warn('[Lattice] Failed to read lattice-settings.json, using default settings:', err)
  }
  // 首次运行：生成并持久化设备指纹（登录必须带，且要跨会话稳定）
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
      // 清理临时文件失败无意义
    }
  }
}

/**
 * 规范化基址：只接受 http/https，丢掉末尾斜杠与查询串/哈希。
 *
 * 支持带路径前缀（反代把节点挂在 `/lattice` 下），但路径里的多余斜杠会收敛掉。
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
  // 远程节点必须走 https：登录密码与 refresh token 会发往这个基址，明文 http 等于裸奔。
  // 本机调试（localhost / 127.0.0.1 / ::1）保留 http 白名单。
  const host = url.hostname.toLowerCase()
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
  if (url.protocol === 'http:' && !loopback) {
    throw new Error(`插件中心地址必须是 https://（本机调试可用 http://localhost）：${trimmed}`)
  }
  const pathname = url.pathname.replace(/\/+$/, '')
  return `${url.protocol}//${url.host}${pathname}`
}

/** 环境变量覆盖值（非法值告警并忽略，不让一个拼错的环境变量把插件中心彻底打死） */
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

/** 基址是否被环境变量锁定（设置项改了也不生效） */
export function isLatticeBaseUrlLockedByEnv(): boolean {
  return envBaseUrl() !== null
}

/** 当前生效的基址 */
export function getLatticeBaseUrl(): string {
  const fromEnv = envBaseUrl()
  if (fromEnv) return fromEnv
  return readSettings().baseUrl ?? DEFAULT_LATTICE_BASE_URL
}

/**
 * 持久化用户设置的基址（返回规范化后的值）。
 *
 * 环境变量存在时不覆盖生效值：这里仍写文件（用户改设置的操作不该丢），
 * 但 `getLatticeBaseUrl()` 会继续返回 env 值；IPC 层会把这个差异告知渲染层。
 */
export function setLatticeBaseUrl(input: string): string {
  const normalized = normalizeLatticeBaseUrl(input)
  writeSettings({ ...readSettings(), baseUrl: normalized })
  logger.info(`[Lattice] Plugin hub URL set: ${normalized}`)
  return normalized
}

/** 本机设备指纹（持久；登录 body 的 `device_fp`） */
export function getLatticeDeviceFingerprint(): string {
  return readSettings().deviceFp as string
}

/**
 * 「缺失插件自动补齐」开关（默认 **开启**）。
 *
 * 默认开启的理由：换机/重装后用户没有任何本地状态，必须自动补齐安装记录里指向的插件才谈得上
 * 「数据同步」；失败会在同步详情里逐条可见（不静默），用户也可以在插件中心把它关掉。
 */
export function getLatticeAutoInstallMissing(): boolean {
  return readSettings().autoInstallMissing !== false
}

/** 持久化自动补齐开关（返回落盘后的值） */
export function setLatticeAutoInstallMissing(enabled: boolean): boolean {
  const next = Boolean(enabled)
  writeSettings({ ...readSettings(), autoInstallMissing: next })
  logger.info(`[Lattice] Automatic restore of missing plugins ${next ? 'enabled' : 'disabled'}`)
  return next
}

/** 本机设备名（登录 body 的 `device_name`；平台侧按字符串存，取主机名即可） */
export function getLatticeDeviceName(): string {
  const host = os.hostname().trim() || 'unknown-host'
  return `RytenBench@${host}`.slice(0, 64)
}
