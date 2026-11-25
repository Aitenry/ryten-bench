import { execFile, spawn } from 'child_process'
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import { app as electronApp, shell } from 'electron'
import logger from 'electron-log'
import { mainMessages } from '../../i18n'
import {
  detectApps,
  EXPLORER_ID,
  type DetectedApp,
  type DetectDeps,
  type OpenInAppTarget,
  type WindowsInstallEntry
} from './open-in-app-detect'

const execFileAsync = promisify(execFile)

export type { OpenInAppTarget } from './open-in-app-detect'

/** 打开工作区目录的结果（与工坊那套一致：失败不抛错，界面把 error 原文显示出来） */
export interface OpenInAppResult {
  ok: boolean
  error?: string
}

/** 卸载登记扫描结果缓存（60s；应用装没装不会在一秒内变两次） */
let windowsCache: { at: number; entries: WindowsInstallEntry[] } | null = null
/** 正在跑的那次扫描：并发的探测共用一次 PowerShell（不要再起第二个进程） */
let windowsPending: Promise<WindowsInstallEntry[]> | null = null
/** 最终探测结果缓存（同上） */
let detectedCache: { at: number; apps: DetectedApp[] } | null = null
/** 正在跑的那次探测：同上 */
let detectedPending: Promise<DetectedApp[]> | null = null
const CACHE_TTL_MS = 60_000

/**
 * Windows：一次 PowerShell 把三处卸载登记读成 JSON（比逐个 reg query 解析稳）。
 *
 * 两句注意：
 * - PowerShell 的**语句之间必须有 `;`（或换行）**。早先按空格拼接，`$paths = @(...) $items = ...`
 *   会被解析成「多余 token」直接报 ParserError——探测退回 PATH 兜底才没翻车，但日志里刷了一串错；
 * - 扫描中的这次要能被并发调用共用：侧栏挂载时会有好几次探测同时进来，不能每个都起一个 PowerShell。
 */
async function readWindowsInstallEntries(): Promise<WindowsInstallEntry[]> {
  if (windowsCache && Date.now() - windowsCache.at < CACHE_TTL_MS) return windowsCache.entries
  if (!windowsPending) {
    windowsPending = scanWindowsInstallEntries().finally(() => {
      windowsPending = null
    })
  }
  return windowsPending
}

async function scanWindowsInstallEntries(): Promise<WindowsInstallEntry[]> {
  const script = [
    "$paths = @('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
      "'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
      "'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')",
    '$items = @(Get-ItemProperty $paths -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName } | Select-Object DisplayName, DisplayIcon, InstallLocation)',
    'ConvertTo-Json -InputObject $items -Compress'
  ].join('; ')
  try {
    const { stdout } = await execFileAsync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 20_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }
    )
    const parsed = JSON.parse(String(stdout).trim() || '[]')
    const list = Array.isArray(parsed) ? parsed : [parsed]
    const entries: WindowsInstallEntry[] = list
      .map((item: Record<string, unknown>) => ({
        displayName: String(item.DisplayName ?? ''),
        displayIcon: String(item.DisplayIcon ?? ''),
        installLocation: String(item.InstallLocation ?? '')
      }))
      .filter((item) => item.displayName)
    windowsCache = { at: Date.now(), entries }
    return entries
  } catch (error) {
    logger.warn('[OpenInApp] Failed to read Windows uninstall registry:', error)
    windowsCache = { at: Date.now(), entries: [] }
    return []
  }
}

/** Linux：`which <cmd>` → 绝对路径（找不到 / 不可执行都算没有） */
async function whichCommand(command: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('which', [command], { timeout: 5_000 })
    const path = String(stdout).trim()
    return path && existsSync(path) ? path : null
  } catch {
    return null
  }
}

/** Linux：flatpak 已装应用 id（没装 flatpak 就当没有） */
async function listFlatpakApps(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('flatpak', ['list', '--app', '--columns=application'], {
      timeout: 10_000
    })
    return String(stdout)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

/** 探测依赖的真实现（探测逻辑本身在 open-in-app-detect.ts，那边不碰 electron、可单测） */
function detectDeps(): DetectDeps {
  const messages = mainMessages().openInApp
  const explorerLabel =
    process.platform === 'darwin'
      ? messages.finder
      : process.platform === 'linux'
        ? messages.fileManager
        : messages.explorer
  return {
    platform: process.platform,
    env: process.env,
    explorerLabel,
    exists: (path) => existsSync(path),
    readdir: (dir) => {
      try {
        return readdirSync(dir)
      } catch {
        return []
      }
    },
    which: whichCommand,
    flatpakApps: listFlatpakApps,
    windowsEntries: readWindowsInstallEntries
  }
}

/**
 * 从探测结果推出「拿哪个文件的图标」：
 * - 文件管理器没有可执行路径，按平台取资源管理器 / 访达自己的图标；
 * - macOS 的应用是 `.app` 包（`open -a <app>`），图标从包上取；
 * - 其余就是启动器可执行文件本身（Windows 的 exe 图标、Linux 的二进制）；
 * - flatpak 只有一个命令名，取不到对应应用的图标，交给界面用通用图标。
 */
function iconSource(target: DetectedApp): string | undefined {
  if (target.id === EXPLORER_ID) {
    if (process.platform === 'win32') {
      const root = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
      return join(root, 'explorer.exe')
    }
    if (process.platform === 'darwin') return '/System/Library/CoreServices/Finder.app'
    return undefined
  }
  if (target.command === 'open' && target.commandArgs?.[0] === '-a') return target.commandArgs[1]
  if (target.command === 'flatpak') return undefined
  return target.command
}

/**
 * 取应用的真实图标（用户 2026-11-26：「为什么不使用系统应用的图标」）。
 *
 * 走 Electron 的 `app.getFileIcon`：Windows 抠 exe 里嵌的图标、macOS 抠 .app 的图标，
 * 都是系统给的那一份，不用我们手绘。结果转成 32×32 的 PNG data URL 交给渲染层当 `<img>`；
 * 某一项取不到就留空，界面退回通用图标（不能让一个图标失败把整个子菜单拖没）。
 */
async function iconForApp(target: DetectedApp): Promise<string | undefined> {
  const source = iconSource(target)
  if (!source) return undefined
  try {
    const image = await electronApp.getFileIcon(source, { size: 'normal' })
    if (image.isEmpty()) return undefined
    return image.resize({ width: 32, height: 32, quality: 'best' }).toDataURL()
  } catch (error) {
    logger.warn(`[OpenInApp] Failed to read icon for "${target.id}":`, error)
    return undefined
  }
}

/** 给探测结果补图标（并发取；任何一项失败只影响它自己） */
async function attachIcons(apps: DetectedApp[]): Promise<DetectedApp[]> {
  return await Promise.all(
    apps.map(async (target) => {
      const icon = await iconForApp(target)
      return icon ? { ...target, icon } : target
    })
  )
}

/** 探测本机可用的目标（缓存 + 并发去重） */
async function detectTargets(): Promise<DetectedApp[]> {
  if (detectedCache && Date.now() - detectedCache.at < CACHE_TTL_MS) return detectedCache.apps
  if (!detectedPending) {
    detectedPending = detectApps(detectDeps())
      .then(async (apps) => {
        const withIcons = await attachIcons(apps)
        detectedCache = { at: Date.now(), apps: withIcons }
        logger.info(
          `[OpenInApp] Detected ${withIcons.length} target(s): ${withIcons.map((app) => app.id).join(', ')}`
        )
        return withIcons
      })
      .finally(() => {
        detectedPending = null
      })
  }
  return detectedPending
}

/** 子菜单数据（不含启动命令，只给界面看的那份） */
export async function listOpenInAppTargets(): Promise<OpenInAppTarget[]> {
  const apps = await detectTargets()
  return apps.map((app) => ({ id: app.id, label: app.label, icon: app.icon }))
}

/**
 * 用指定应用打开一个目录。
 *
 * 系统文件管理器走 `shell.openPath`（Windows 资源管理器 / macOS 访达 / Linux 文件管理器都一样）；
 * 其余应用把目录当成「打开这个项目」的最后一个参数传进去，进程 detach 后立刻返回、不等它退出。
 */
export async function openPathInApp(dir: string, appId: string): Promise<OpenInAppResult> {
  const messages = mainMessages().openInApp
  if (appId === EXPLORER_ID) {
    const failure = await shell.openPath(dir)
    return failure ? { ok: false, error: failure } : { ok: true }
  }

  const target = (await detectTargets()).find((app) => app.id === appId)
  if (!target?.command) {
    return { ok: false, error: messages.notAvailable }
  }

  try {
    spawn(target.command, [...(target.commandArgs ?? []), dir], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    }).unref()
    return { ok: true }
  } catch (error) {
    logger.error(`[OpenInApp] Failed to open "${dir}" in ${appId}:`, error)
    return { ok: false, error: (error as Error).message }
  }
}
