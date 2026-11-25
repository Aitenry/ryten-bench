import { join } from 'path'

/**
 * 「在应用中打开」的应用探测（纯函数 + 依赖注入，不碰 electron）。
 *
 * 三个平台各有一套「这个应用在不在」的判断：
 * - **Windows**：先读卸载登记（覆盖装在 `D:\Program Files` 这类非标准目录的 JetBrains），
 *   再看 PATH（VS Code / JetBrains 安装器会把 `bin` 加进去），最后试常见安装路径；
 * - **macOS**：`/Applications` 与 `~/Applications` 下的 `.app`（Toolbox 装的会以符号链接出现在
 *   后者；社区版、Insiders 这些名字也一并列上），启动用 `open -a <app> <dir>`；
 * - **Linux**：PATH 上的启动命令、JetBrains Toolbox 的 `~/.local/share/JetBrains/Toolbox/scripts/`、
 *   `/snap/bin/`，最后按 flatpak 应用 id 走 `flatpak run`。
 *
 * 探测逻辑放在这里、依赖从外面注入（`exists` / `readdir` / `which` / `flatpakApps` / `windowsEntries`），
 * 是为了能在任意平台上用假依赖跑单测（本机是 Windows，跑不了真的 macOS/Linux）。
 */

/** 系统文件管理器的固定 id（不参与安装探测，永远排第一） */
export const EXPLORER_ID = 'explorer'

/** 一个「在应用中打开」目标（渲染层只拿 id + 文案 + 图标） */
export interface OpenInAppTarget {
  id: string
  label: string
  /** 系统里那个应用的真实图标（PNG data URL）；取不到时界面退回通用图标 */
  icon?: string
}

/** 探测出来的目标：带启动方式（不发给渲染层） */
export interface DetectedApp extends OpenInAppTarget {
  /** 直接 spawn 的可执行文件 / 启动器；缺省 = 系统默认程序（文件管理器） */
  command?: string
  /** 目录前的前缀参数（macOS 的 `open -a <app>`、Linux 的 `flatpak run <id>`） */
  commandArgs?: string[]
}

/** Windows 卸载登记里的一行 */
export interface WindowsInstallEntry {
  displayName: string
  displayIcon: string
  installLocation: string
}

/** 应用定义：三端各写各的识别方式，缺的项就跳过 */
export interface AppDefinition {
  id: string
  label: string
  /** Windows：卸载登记里的 DisplayName 匹配规则 */
  windowsPattern?: RegExp
  /** Windows：可执行文件名（PATH / 安装目录里找它） */
  windowsExe?: string
  /** Windows：常见安装位置（`*` 只匹配一层目录名） */
  windowsPaths?: string[]
  /** macOS：`/Applications`、`~/Applications` 下可能的 .app 名（含社区版 / Insiders） */
  macApps?: string[]
  /** Linux：PATH / Toolbox 脚本 / snap 里的启动命令（按顺序试） */
  linuxCommands?: string[]
  /** Linux：flatpak 应用 id（按顺序试） */
  flatpakIds?: string[]
}

/** 探测依赖（真实现由 open-in-app.ts 提供；测试里换成假实现） */
export interface DetectDeps {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  /** 文件管理器的文案（各平台叫法不同，由主进程 i18n 给） */
  explorerLabel: string
  exists: (path: string) => boolean
  readdir: (dir: string) => string[]
  /** 命令在 PATH 上的绝对路径；找不到返回 null */
  which: (command: string) => Promise<string | null>
  /** flatpak 已装应用 id；没装 flatpak 返回空数组 */
  flatpakApps: () => Promise<string[]>
  /** Windows 卸载登记（读失败返回空数组） */
  windowsEntries: () => Promise<WindowsInstallEntry[]>
}

/**
 * 支持的编辑器清单（顺序即菜单顺序：先 JetBrains 全家桶，再 VS Code / Cursor）。
 *
 * 只收「把目录当项目打开」这一种用法明确的应用：IDEA 系（`idea64.exe <dir>` / `open -a` / `idea <dir>`）、
 * VS Code 系（`Code.exe <dir>` / `code <dir>`）。GitHub Desktop 这类「打开仓库/仓库管理器」的应用
 * 不在这里——它要的是 git 仓库且各平台入口不同，硬塞进「打开工作区」只会点出个空窗口。
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

/** JetBrains Toolbox 在 Linux 上的启动脚本目录（相对 home） */
const LINUX_TOOLBOX_SCRIPTS = join('.local', 'share', 'JetBrains', 'Toolbox', 'scripts')

/** 展开 `%VAR%` 与 `~/`，`*` 只匹配一层目录名 */
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

/** 卸载登记的 DisplayIcon → 可执行文件路径（去掉引号与末尾的 `,0` 图标序号） */
function iconToExe(icon: string | undefined): string | null {
  if (!icon) return null
  const cleaned = icon
    .trim()
    .replace(/^"|"$/g, '')
    .replace(/,\s*-?\d+\s*$/, '')
    .trim()
  return /\.exe$/i.test(cleaned) ? cleaned : null
}

/** Windows：卸载登记 → PATH → 常见安装路径 */
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

/** macOS：`/Applications`、`~/Applications` 与旧版 Toolbox 的 `~/Applications/JetBrains Toolbox` */
export function resolveMacApp(def: AppDefinition, deps: DetectDeps): string | null {
  const roots = ['/Applications']
  const home = deps.env.HOME
  if (home) {
    // Toolbox 默认把 .app 的符号链接放在 ~/Applications；旧版本放在子目录里，一并认
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

/** Linux：PATH → Toolbox 启动脚本 → snap → flatpak */
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
 * 探测本机可用的「在应用中打开」目标：系统文件管理器永远在第一位，其余按本机安装情况。
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
      // `open -a <app> <dir>`：把目录交给这个应用打开（JetBrains / VS Code 都认目录参数）
      if (app) {
        apps.push({ id: def.id, label: def.label, command: 'open', commandArgs: ['-a', app] })
      }
    }
    return apps
  }

  // 其余平台（Linux / 其它类 Unix）走命令 + flatpak
  const flatpaks = await deps.flatpakApps()
  for (const def of APP_DEFINITIONS) {
    const target = await resolveLinuxApp(def, flatpaks, deps)
    if (target) apps.push({ id: def.id, label: def.label, ...target })
  }
  return apps
}
