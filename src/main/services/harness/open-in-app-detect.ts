import { join } from 'path'

/**
 * App detection for "open in app" (pure functions + dependency injection, no electron).
 *
 * Each of the three platforms has its own way of deciding whether an app exists:
 * - **Windows**: read the uninstall registry first (covers JetBrains installed in non-standard
 *   directories such as `D:\Program Files`), then PATH (VS Code / JetBrains installers add `bin`
 *   to it), and finally try common install paths;
 * - **macOS**: `.app` bundles under `/Applications` and `~/Applications` (Toolbox installs show up
 *   as symlinks in the latter; community and Insiders names are listed too), launched with
 *   `open -a <app> <dir>`;
 * - **Linux**: launch commands on PATH, JetBrains Toolbox's
 *   `~/.local/share/JetBrains/Toolbox/scripts/`, `/snap/bin/`, and finally `flatpak run` by
 *   flatpak app id.
 *
 * Detection lives here with dependencies injected from outside (`exists` / `readdir` / `which` /
 * `flatpakApps` / `windowsEntries`) so unit tests can run with fake dependencies on any platform
 * (the dev machine is Windows, so real macOS/Linux cannot be exercised).
 */

/** Fixed id of the system file manager (not part of install detection; always first) */
export const EXPLORER_ID = 'explorer'

/** One "open in app" target (the renderer only gets id + label + icon) */
export interface OpenInAppTarget {
  id: string
  label: string
  /** Real icon of that app (PNG data URL); the UI falls back to a generic icon if unavailable */
  icon?: string
}

/** A detected target: carries the launch method (not sent to the renderer) */
export interface DetectedApp extends OpenInAppTarget {
  /** Executable / launcher to spawn directly; when absent = system default program (file manager) */
  command?: string
  /** Prefix args placed before the directory (macOS `open -a <app>`, Linux `flatpak run <id>`) */
  commandArgs?: string[]
}

/** One row from the Windows uninstall registry */
export interface WindowsInstallEntry {
  displayName: string
  displayIcon: string
  installLocation: string
}

/** App definition: each platform declares its own detection method; missing entries are skipped */
export interface AppDefinition {
  id: string
  label: string
  /** Windows: DisplayName matching rule in the uninstall registry */
  windowsPattern?: RegExp
  /** Windows: executable file name (looked up on PATH / in the install directory) */
  windowsExe?: string
  /** Windows: common install locations (`*` matches one directory level only) */
  windowsPaths?: string[]
  /** macOS: possible .app names under `/Applications`, `~/Applications` (incl. community / Insiders) */
  macApps?: string[]
  /** Linux: launch commands on PATH / Toolbox scripts / snap (tried in order) */
  linuxCommands?: string[]
  /** Linux: flatpak app ids (tried in order) */
  flatpakIds?: string[]
}

/** Detection dependencies (real implementations come from open-in-app.ts; tests swap in fakes) */
export interface DetectDeps {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  /** File manager label (named differently per platform; provided by main-process i18n) */
  explorerLabel: string
  exists: (path: string) => boolean
  readdir: (dir: string) => string[]
  /** Absolute path of the command on PATH; null when not found */
  which: (command: string) => Promise<string | null>
  /** Ids of installed flatpak apps; empty array when flatpak is not installed */
  flatpakApps: () => Promise<string[]>
  /** Windows uninstall registry (empty array when reading fails) */
  windowsEntries: () => Promise<WindowsInstallEntry[]>
}

/**
 * Supported editor list (order = menu order: the JetBrains family first, then VS Code / Cursor).
 *
 * Only apps whose "open a directory as a project" usage is unambiguous are included: the IDEA
 * family (`idea64.exe <dir>` / `open -a` / `idea <dir>`) and the VS Code family
 * (`Code.exe <dir>` / `code <dir>`). Apps like GitHub Desktop that "open a repo / repo manager"
 * are not here — they want a git repository and differ per platform, so forcing them into "open
 * workspace" would only pop up an empty window.
 */
export const APP_DEFINITIONS: AppDefinition[] = [
  {
    id: 'idea',
    label: 'IntelliJ IDEA',
    windowsPattern: /^IntelliJ IDEA/i,
    windowsExe: 'idea64.exe',
    windowsPaths: ['%ProgramFiles%/JetBrains/IntelliJ IDEA*/bin/idea64.exe'],
    macApps: ['IntelliJ IDEA.app', 'IntelliJ IDEA Ultimate.app', 'IntelliJ IDEA CE.app'],
    linuxCommands: ['idea', 'idea.sh'],
    flatpakIds: ['com.jetbrains.IntelliJ-IDEA-Ultimate', 'com.jetbrains.IntelliJ-IDEA-Community']
  },
  {
    id: 'pycharm',
    label: 'PyCharm',
    windowsPattern: /^PyCharm/i,
    windowsExe: 'pycharm64.exe',
    windowsPaths: ['%ProgramFiles%/JetBrains/PyCharm*/bin/pycharm64.exe'],
    macApps: ['PyCharm.app', 'PyCharm Professional.app', 'PyCharm CE.app'],
    linuxCommands: ['pycharm', 'pycharm.sh'],
    flatpakIds: ['com.jetbrains.PyCharm-Professional', 'com.jetbrains.PyCharm-Community']
  },
  {
    id: 'webstorm',
    label: 'WebStorm',
    windowsPattern: /^WebStorm/i,
    windowsExe: 'webstorm64.exe',
    windowsPaths: ['%ProgramFiles%/JetBrains/WebStorm*/bin/webstorm64.exe'],
    macApps: ['WebStorm.app'],
    linuxCommands: ['webstorm', 'webstorm.sh'],
    flatpakIds: ['com.jetbrains.WebStorm']
  },
  {
    id: 'goland',
    label: 'GoLand',
    windowsPattern: /^GoLand/i,
    windowsExe: 'goland64.exe',
    windowsPaths: ['%ProgramFiles%/JetBrains/GoLand*/bin/goland64.exe'],
    macApps: ['GoLand.app'],
    linuxCommands: ['goland', 'goland.sh'],
    flatpakIds: ['com.jetbrains.GoLand']
  },
  {
    id: 'datagrip',
    label: 'DataGrip',
    windowsPattern: /^DataGrip/i,
    windowsExe: 'datagrip64.exe',
    windowsPaths: ['%ProgramFiles%/JetBrains/DataGrip*/bin/datagrip64.exe'],
    macApps: ['DataGrip.app'],
    linuxCommands: ['datagrip', 'datagrip.sh'],
    flatpakIds: ['com.jetbrains.DataGrip']
  },
  {
    id: 'clion',
    label: 'CLion',
    windowsPattern: /^CLion/i,
    windowsExe: 'clion64.exe',
    windowsPaths: ['%ProgramFiles%/JetBrains/CLion*/bin/clion64.exe'],
    macApps: ['CLion.app'],
    linuxCommands: ['clion', 'clion.sh'],
    flatpakIds: ['com.jetbrains.CLion']
  },
  {
    id: 'vscode',
    label: 'Visual Studio Code',
    windowsPattern: /^Microsoft Visual Studio Code/i,
    windowsExe: 'Code.exe',
    windowsPaths: [
      '%LOCALAPPDATA%/Programs/Microsoft VS Code/Code.exe',
      '%ProgramFiles%/Microsoft VS Code/Code.exe'
    ],
    macApps: ['Visual Studio Code.app', 'Visual Studio Code - Insiders.app'],
    linuxCommands: ['code', 'code-insiders'],
    flatpakIds: ['com.visualstudio.code', 'com.visualstudio.code-oss']
  },
  {
    id: 'cursor',
    label: 'Cursor',
    windowsPattern: /^Cursor/i,
    windowsExe: 'Cursor.exe',
    windowsPaths: [
      '%LOCALAPPDATA%/Programs/cursor/Cursor.exe',
      '%LOCALAPPDATA%/Programs/Cursor/Cursor.exe'
    ],
    macApps: ['Cursor.app'],
    linuxCommands: ['cursor'],
    flatpakIds: []
  }
]

/** JetBrains Toolbox launch script directory on Linux (relative to home) */
const LINUX_TOOLBOX_SCRIPTS = join('.local', 'share', 'JetBrains', 'Toolbox', 'scripts')

/** Expand `%VAR%` and `~/`; `*` matches one directory level only */
function expandCandidates(pattern: string, deps: DetectDeps): string[] {
  const expanded = pattern
    .replace(/%([^%]+)%/g, (_m, name: string) => deps.env[name] ?? `%${name}%`)
    .replace(/^~\//, `${deps.env.HOME ?? deps.env.USERPROFILE ?? ''}/`)
  const parts = expanded.split(/[/\\]/)
  let results = ['']
  for (const part of parts) {
    if (part === '') continue
    if (!part.includes('*')) {
      results = results.map((base) => (base ? join(base, part) : part))
      continue
    }
    const re = new RegExp(`^${part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
    const next: string[] = []
    for (const base of results) {
      const names = deps.readdir(base || '.')
      for (const name of names) {
        if (re.test(name)) next.push(join(base || '.', name))
      }
    }
    results = next
  }
  return results
}

/** Uninstall-registry DisplayIcon → executable path (strips quotes and the trailing `,0` icon index) */
function iconToExe(icon: string | undefined): string | null {
  if (!icon) return null
  const cleaned = icon
    .trim()
    .replace(/^"|"$/g, '')
    .replace(/,\s*-?\d+\s*$/, '')
    .trim()
  return /\.exe$/i.test(cleaned) ? cleaned : null
}

/** Windows: uninstall registry → PATH → common install paths */
function resolveWindowsExe(
  def: AppDefinition,
  entries: WindowsInstallEntry[],
  deps: DetectDeps
): string | null {
  const entry = def.windowsPattern
    ? entries.find((item) => def.windowsPattern!.test(item.displayName))
    : undefined
  if (entry) {
    const fromIcon = iconToExe(entry.displayIcon)
    if (fromIcon && deps.exists(fromIcon)) return fromIcon
    const location = entry.installLocation.replace(/^"|"$/g, '').trim()
    if (location && def.windowsExe) {
      for (const candidate of [
        join(location, 'bin', def.windowsExe),
        join(location, def.windowsExe)
      ]) {
        if (deps.exists(candidate)) return candidate
      }
    }
  }
  if (def.windowsExe) {
    for (const dir of (deps.env.PATH ?? '').split(';')) {
      if (!dir) continue
      const candidate = join(dir, def.windowsExe)
      if (deps.exists(candidate)) return candidate
    }
  }
  for (const pattern of def.windowsPaths ?? []) {
    for (const candidate of expandCandidates(pattern, deps)) {
      if (deps.exists(candidate)) return candidate
    }
  }
  return null
}

/** macOS: `/Applications`, `~/Applications`, and the old Toolbox's `~/Applications/JetBrains Toolbox` */
export function resolveMacApp(def: AppDefinition, deps: DetectDeps): string | null {
  const roots = ['/Applications']
  const home = deps.env.HOME
  if (home) {
    // Toolbox puts .app symlinks in ~/Applications by default; older versions use a subdirectory, recognized too
    roots.push(join(home, 'Applications'), join(home, 'Applications', 'JetBrains Toolbox'))
  }
  for (const name of def.macApps ?? []) {
    for (const root of roots) {
      const candidate = join(root, name)
      if (deps.exists(candidate)) return candidate
    }
  }
  return null
}

/** Linux: PATH → Toolbox launch scripts → snap → flatpak */
async function resolveLinuxApp(
  def: AppDefinition,
  flatpaks: string[],
  deps: DetectDeps
): Promise<{ command: string; commandArgs?: string[] } | null> {
  const home = deps.env.HOME
  for (const command of def.linuxCommands ?? []) {
    const onPath = await deps.which(command)
    if (onPath) return { command: onPath }
    if (home) {
      const toolbox = join(home, LINUX_TOOLBOX_SCRIPTS, command)
      if (deps.exists(toolbox)) return { command: toolbox }
    }
    const snap = join('/snap/bin', command)
    if (deps.exists(snap)) return { command: snap }
  }
  for (const id of def.flatpakIds ?? []) {
    if (flatpaks.includes(id)) return { command: 'flatpak', commandArgs: ['run', id] }
  }
  return null
}

/**
 * Detect the "open in app" targets available on this machine: the system file manager always comes
 * first, the rest depend on what is installed.
 */
export async function detectApps(deps: DetectDeps): Promise<DetectedApp[]> {
  const apps: DetectedApp[] = [{ id: EXPLORER_ID, label: deps.explorerLabel }]

  if (deps.platform === 'win32') {
    const entries = await deps.windowsEntries()
    for (const def of APP_DEFINITIONS) {
      const exe = resolveWindowsExe(def, entries, deps)
      if (exe) apps.push({ id: def.id, label: def.label, command: exe })
    }
    return apps
  }

  if (deps.platform === 'darwin') {
    for (const def of APP_DEFINITIONS) {
      const app = resolveMacApp(def, deps)
      // `open -a <app> <dir>`: hand the directory to this app (JetBrains / VS Code both accept a directory argument)
      if (app) {
        apps.push({ id: def.id, label: def.label, command: 'open', commandArgs: ['-a', app] })
      }
    }
    return apps
  }

  // Other platforms (Linux / other Unix-like) go through commands + flatpak
  const flatpaks = await deps.flatpakApps()
  for (const def of APP_DEFINITIONS) {
    const target = await resolveLinuxApp(def, flatpaks, deps)
    if (target) apps.push({ id: def.id, label: def.label, ...target })
  }
  return apps
}
