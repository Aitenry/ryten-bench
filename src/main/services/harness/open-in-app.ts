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

/** Result of opening a workspace directory (same as the workshop's: no throw on failure; the UI shows the raw error) */
export interface OpenInAppResult {
  ok: boolean
  error?: string
}

/** Uninstall-registry scan cache (60s; whether an app is installed does not change twice in a second) */
let windowsCache: { at: number; entries: WindowsInstallEntry[] } | null = null
/** The scan currently running: concurrent detections share one PowerShell (do not start a second process) */
let windowsPending: Promise<WindowsInstallEntry[]> | null = null
/** Final detection result cache (as above) */
let detectedCache: { at: number; apps: DetectedApp[] } | null = null
/** The detection currently running: as above */
let detectedPending: Promise<DetectedApp[]> | null = null
const CACHE_TTL_MS = 60_000

/**
 * Windows: read all three uninstall registries into JSON in a single PowerShell call (more robust
 * than parsing individual reg queries).
 *
 * Two cautions:
 * - PowerShell **statements must be separated by `;` (or a newline)**. An earlier version joined
 *   them with spaces, so `$paths = @(...) $items = ...` was parsed as "extra tokens" and raised a
 *   ParserError — detection fell back to PATH and did not break, but the log filled with errors;
 * - the in-progress scan must be shareable by concurrent calls: several detections arrive at once
 *   when the sidebar mounts, and each must not start its own PowerShell.
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

/** Linux: `which <cmd>` → absolute path (not found / not executable both count as absent) */
async function whichCommand(command: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('which', [command], { timeout: 5_000 })
    const path = String(stdout).trim()
    return path && existsSync(path) ? path : null
  } catch {
    return null
  }
}

/** Linux: ids of installed flatpak apps (no flatpak installed means none) */
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

/** Real implementations of the detection dependencies (detection logic itself lives in open-in-app-detect.ts, which does not touch electron and is unit-testable) */
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
 * Derive which file to take the icon from, based on the detection result:
 * - the file manager has no executable path, so take Explorer / Finder's own icon per platform;
 * - macOS apps are `.app` bundles (`open -a <app>`); the icon comes from the bundle;
 * - otherwise it is the launcher executable itself (a Windows exe icon, a Linux binary);
 * - flatpak only exposes a command name, so the app's icon cannot be resolved and the UI uses a
 *   generic icon.
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
 * Get the app's real icon (user request, 2026-11-26: why not use the system app icon).
 *
 * Uses Electron's `app.getFileIcon`: Windows extracts the icon embedded in the exe, macOS extracts
 * the .app icon — both are the system-provided one, so nothing is hand-drawn. The result becomes a
 * 32×32 PNG data URL for the renderer to use in an `<img>`; when one item cannot be resolved it
 * stays empty and the UI falls back to a generic icon (a single icon failure must not take out the
 * whole submenu).
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

/** Attach icons to detection results (concurrently; any failure only affects its own item) */
async function attachIcons(apps: DetectedApp[]): Promise<DetectedApp[]> {
  return await Promise.all(
    apps.map(async (target) => {
      const icon = await iconForApp(target)
      return icon ? { ...target, icon } : target
    })
  )
}

/** Detect targets available on this machine (cache + concurrent deduplication) */
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

/** Submenu data (no launch command; the copy the UI sees) */
export async function listOpenInAppTargets(): Promise<OpenInAppTarget[]> {
  const apps = await detectTargets()
  return apps.map((app) => ({ id: app.id, label: app.label, icon: app.icon }))
}

/**
 * Open a directory in the given app.
 *
 * The system file manager goes through `shell.openPath` (same for Windows Explorer / macOS Finder /
 * Linux file managers); other apps receive the directory as the last "open this project" argument,
 * and the process is detached so this returns immediately without waiting for it to exit.
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
