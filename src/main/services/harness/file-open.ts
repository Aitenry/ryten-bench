/**
 * "Open with a system app" for workspace files (deliverables / run artifacts).
 *
 * Cross-platform behavior:
 * - **Windows**: the menu lists the apps registered for that file extension
 *   (`FileExts\<ext>\OpenWithList` + `OpenWithProgids` → `shell\open\command`), each with its real
 *   icon from the executable. Opening a specific app launches that exe with the file.
 * - **macOS / Linux**: only the system default is offered (via `shell.openPath`, which uses `open` /
 *   `xdg-open`);枚举 per-app lists on those platforms needs LaunchServices / .desktop MIME lookups
 *   that the UI does not need yet. The UI degrades to a single "default app" entry.
 *
 * Icons come from Electron's `app.getFileIcon` (the OS-provided icon, nothing hand-drawn), converted
 * to 32×32 PNG data URLs; a missing icon only affects that one row.
 */
import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs'
import { app as electronApp, shell } from 'electron'
import logger from 'electron-log'
import { normalizeFileOpenApps, type FileOpenApp } from './file-open-detect'

const execFileAsync = promisify(execFile)

/** One row in the "open with" menu */
export interface FileOpenTarget {
  /** `default` or `app:<absolute exe path>` */
  id: string
  label: string
  /** PNG data URL of the system icon */
  icon?: string
  kind: 'default' | 'app'
}

/** Per-extension app scan cache (60s: installs do not change twice in a second) */
const appCache = new Map<string, { at: number; apps: FileOpenApp[] }>()
const CACHE_TTL_MS = 60_000

/** Extract the extension used for the association lookup (`.` included, lower case) */
export function extensionOf(realPath: string): string {
  const base = realPath.replace(/\\/g, '/').split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot).toLowerCase() : ''
}

/**
 * Windows: read the apps registered for one extension.
 *
 * The registry holds exe names in `OpenWithList` and ProgIDs in `OpenWithProgids`; ProgIDs are
 * resolved through `shell\open\command`. Exe names that are not absolute are resolved through
 * `App Paths`, so the menu always ends up with launchable paths.
 */
async function scanWindowsApps(ext: string): Promise<FileOpenApp[]> {
  const cached = appCache.get(ext)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.apps

  const script = [
    `$ext = '${ext.replace(/'/g, "''")}'`,
    '$base = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\$ext"',
    '$items = @()',
    '$ow = Join-Path $base "OpenWithList"',
    'if (Test-Path $ow) {',
    '  $p = Get-ItemProperty $ow',
    '  $p.PSObject.Properties | Where-Object { $_.Name -notmatch "^(PS|MRUList)" } | ForEach-Object { $items += [string]$_.Value }',
    '}',
    '$prog = Join-Path $base "OpenWithProgids"',
    'if (Test-Path $prog) {',
    '  $p2 = Get-ItemProperty $prog',
    '  $p2.PSObject.Properties | Where-Object { $_.Name -notmatch "^PS" } | ForEach-Object {',
    '    $cmd = (Get-ItemProperty "Registry::HKEY_CLASSES_ROOT\\$($_.Name)\\shell\\open\\command" -ErrorAction SilentlyContinue)."(default)"',
    '    if ($cmd) { $items += [string]$cmd }',
    '  }',
    '}',
    '$out = @()',
    'foreach ($item in $items) {',
    '  $exe = $null',
    '  if ($item -match \'^"([^"]+\\.exe)"\') { $exe = $matches[1] }',
    '  elseif ($item -match \'"([^"]+\\.exe)"\') { $exe = $matches[1] }',
    '  elseif ($item -match \'([^\\s"]+\\.exe)\') { $exe = $matches[1] }',
    '  if (-not $exe) { continue }',
    // Registry values are often bare names ("msedge.exe"): resolve them through PATH first, then
    // the "App Paths" registrations (that is how Word/Edge/Typora become launchable paths).
    '  if (-not [IO.Path]::IsPathRooted($exe)) {',
    '    $cmd = Get-Command $exe -ErrorAction SilentlyContinue',
    '    if ($cmd -and $cmd.Source) { $exe = $cmd.Source }',
    '    else {',
    '      $appPath = (Get-ItemProperty "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\$exe" -ErrorAction SilentlyContinue)."(default)"',
    '      if ($appPath) { $exe = $appPath }',
    '    }',
    '  }',
    '  if (-not $exe -or -not (Test-Path $exe)) { continue }',
    '  $desc = $null',
    '  try { $desc = (Get-Item $exe).VersionInfo.FileDescription } catch {}',
    '  $label = if ($desc) { $desc } else { [IO.Path]::GetFileNameWithoutExtension($exe) }',
    '  $out += @{ exe = [string]$exe; label = [string]$label }',
    '}',
    '$out | ConvertTo-Json -Compress -Depth 3'
  ].join('\n')

  try {
    const { stdout } = await execFileAsync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 15_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }
    )
    const text = String(stdout).trim()
    const parsed: unknown = text ? JSON.parse(text) : []
    const apps = normalizeFileOpenApps(parsed)
    appCache.set(ext, { at: Date.now(), apps })
    return apps
  } catch (error) {
    logger.warn(`[FileOpen] Failed to scan Windows apps for "${ext}":`, error)
    appCache.set(ext, { at: Date.now(), apps: [] })
    return []
  }
}

/** System icon of a path (exe or the file itself) as a 32×32 PNG data URL */
async function iconOf(source: string): Promise<string | undefined> {
  try {
    const image = await electronApp.getFileIcon(source, { size: 'normal' })
    if (image.isEmpty()) return undefined
    return image.resize({ width: 32, height: 32, quality: 'best' }).toDataURL()
  } catch {
    return undefined
  }
}

/** Whether the path is an existing regular file (guards before touching the OS) */
export function isRegularFile(realPath: string): boolean {
  try {
    return fs.statSync(realPath).isFile()
  } catch {
    return false
  }
}

/**
 * Targets for one file: the system default first, then (Windows) the apps registered for this
 * extension. The caller has already resolved and boundary-checked the real path.
 */
export async function listFileOpenTargets(realPath: string): Promise<FileOpenTarget[]> {
  const targets: FileOpenTarget[] = [
    {
      id: 'default',
      label: 'default',
      kind: 'default',
      icon: await iconOf(realPath)
    }
  ]
  if (process.platform !== 'win32') return targets

  const apps = await scanWindowsApps(extensionOf(realPath))
  const icons = await Promise.all(apps.map((app) => iconOf(app.exe)))
  apps.forEach((app, index) => {
    targets.push({
      id: `app:${app.exe}`,
      label: app.label,
      kind: 'app',
      icon: icons[index]
    })
  })
  return targets
}

/**
 * Open the file with the requested target.
 *
 * `default` goes through `shell.openPath` (the OS association: Windows default program, macOS
 * `open`, Linux `xdg-open`); `app:<exe>` launches that executable with the file as its argument
 * (Windows only, since only Windows has an app list).
 */
export async function openFileWithTarget(
  realPath: string,
  targetId: string
): Promise<{ ok: boolean; error?: string }> {
  if (!isRegularFile(realPath)) return { ok: false, error: 'missing' }
  if (targetId === 'default') {
    const failure = await shell.openPath(realPath)
    return failure ? { ok: false, error: failure } : { ok: true }
  }
  if (!targetId.startsWith('app:')) return { ok: false, error: 'unknown-target' }
  if (process.platform !== 'win32') return { ok: false, error: 'unsupported' }
  const exe = targetId.slice('app:'.length)
  if (!exe || !fs.existsSync(exe)) return { ok: false, error: 'app-missing' }
  try {
    const child = spawn(exe, [realPath], { detached: true, stdio: 'ignore', windowsHide: false })
    child.unref()
    return { ok: true }
  } catch (error) {
    logger.warn('[FileOpen] Failed to launch app:', error)
    return { ok: false, error: (error as Error).message }
  }
}
