/**
 * Pure helpers for "open this file with a system app" (no electron, unit-testable).
 *
 * The Windows side is driven by a PowerShell registry scan (the same approach as
 * `open-in-app-detect.ts`): the scan returns *raw* command strings and exe names, and this module
 * normalizes them into `{ exe, label }` entries. Command strings look like:
 *
 *   "C:\Program Files\Photos\Photos.exe" "%1"
 *   C:\Windows\system32\SnippingTool.exe /clip
 *   rundll32.exe shell32.dll,OpenAs_RunDLL %1
 *
 * Only real executables are accepted; shell verbs (rundll32, dllhost) are skipped so the menu never
 * offers an app that would fail to open the file.
 */
export interface FileOpenApp {
  /** Absolute executable path (also used as the menu id) */
  exe: string
  /** Display label from the app's file description, falling back to its file name */
  label: string
}

/** Shell hosts that take a verb instead of a file argument — not "apps that open this file" */
const HOST_EXES = new Set(['rundll32.exe', 'dllhost.exe', 'cmd.exe', 'powershell.exe', 'wscript.exe'])

/**
 * Parse the executable out of a shell `open` command string.
 *
 * Quoted paths are taken verbatim (they may contain spaces); unquoted ones end at the first space.
 * Returns null when the string does not start with an executable.
 */
export function parseCommandExe(command: unknown): string | null {
  if (typeof command !== 'string') return null
  const trimmed = command.trim()
  if (!trimmed) return null
  const quoted = /^"([^"]+\.exe)"/i.exec(trimmed)
  const candidate = quoted
    ? quoted[1]
    : /^([^\s"]+\.exe)\b/i.exec(trimmed)?.[1] ?? null
  if (!candidate) return null
  if (HOST_EXES.has(candidate.split(/[\\/]/).pop()?.toLowerCase() ?? '')) return null
  return candidate
}

/** Normalize the registry scan output into deduplicated apps (invalid rows are dropped) */
export function normalizeFileOpenApps(raw: unknown): FileOpenApp[] {
  const rows = Array.isArray(raw) ? raw : raw ? [raw] : []
  const byExe = new Map<string, FileOpenApp>()
  for (const row of rows as Array<Record<string, unknown>>) {
    const exe = typeof row?.exe === 'string' ? row.exe.trim() : ''
    if (!exe) continue
    if (HOST_EXES.has(exe.split(/[\\/]/).pop()?.toLowerCase() ?? '')) continue
    if (byExe.has(exe.toLowerCase())) continue
    const label =
      typeof row?.label === 'string' && row.label.trim()
        ? row.label.trim()
        : (exe.split(/[\\/]/).pop() ?? exe).replace(/\.exe$/i, '')
    byExe.set(exe.toLowerCase(), { exe, label })
  }
  return [...byExe.values()]
}
