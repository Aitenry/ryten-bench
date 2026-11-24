import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import logger from 'electron-log'
import { settingsStore } from '../context'
import { hasUserDataDirOverride } from '../environment/resolve'
import type { HarnessSettings } from '../types/settings'
import {
  STORAGE_DIR_NAMES,
  STORAGE_KINDS,
  STORAGE_LABELS,
  STORAGE_SETTING_KEYS,
  storagePathOf,
  type StorageKind
} from './types'

/**
 * 默认存储布局：**按软件安装目录预置**记忆 / 插件 / 技能三个存储目录。
 *
 * ```
 * <安装目录>/data/
 *   memory/     记忆根（其下再按 workspace-<id> / plugin-<id> / chat 分作用域）
 *   plugins/    插件存放路径（插件工坊草稿 + 插件中心下载的源码）
 *   skills/     技能根（每个含 SKILL.md 的子目录即一个技能）
 * ```
 *
 * 跨平台口径：
 * - Windows：安装目录 = exe 所在目录（`D:\Software\RytenBench` 这种可直接落在旁边）；
 * - Linux：AppImage 用 `.AppImage` 文件所在目录，deb 用可执行文件所在目录；
 * - macOS：`.app` 是签名包，**不往包里写**，直接用 `userData/data`（`~/Library/Application Support/...`）；
 * - 安装目录不可写（Program Files / /opt / 只读盘）时自动退回 `userData/data`。
 *
 * 注意这里的 `<userData>` 已经是**按环境分开的**（规则见 `src/main/environment/`）：
 * 开发态是 `<appData>/ryten-bench-dev`、打包态是 `<appData>/ryten-bench`，
 * 所以「安装目录不可写 → 退回 userData」这条兜底在两套环境里也不会互相踩。
 *
 * 这些路径只在**首次**装配时写入设置（`storageDefaultsApplied` 标记）。
 * 用户之后把某个路径清空（= 停用该能力）或改到别处，后续启动不会再把默认值塞回去；
 * 改到别处时由 `./migration.ts` 把数据迁过去。
 */

export const DATA_DIR_NAME = 'data'

/** 存储根落在哪里：安装目录旁的 `data`，或用户数据目录下的 `data` */
export type StorageLayoutSource = 'install' | 'userData'

export interface StorageLayout {
  installDir: string
  dataRoot: string
  source: StorageLayoutSource
  dirs: Record<StorageKind, string>
}

export interface InstallDirOptions {
  platform: NodeJS.Platform
  packaged: boolean
  /** 开发态的应用根（仓库根）/ 打包态由 electron 给出 */
  appPath: string
  /** `process.execPath` */
  execPath: string
  /** Linux AppImage 的真实文件路径（`process.env.APPIMAGE`） */
  appImagePath?: string
}

export interface StorageLayoutOptions extends InstallDirOptions {
  userDataDir: string
  /**
   * false = 直接使用 `<userData>/data`。
   *
   * 正常安装/开发都优先「安装目录旁的 data」；只有自动化用 `--user-data-dir` 做了隔离时
   * 才显式关掉（否则跑测试会把开发机仓库里的 `data/` 当真数据搬走）。
   */
  useInstallDirectory?: boolean
}

/** 平台对应的 path 实现：工装能在 Windows 上验证 macOS / Linux 的路径规则 */
function pathFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix
}

/**
 * 解析「软件安装目录」。
 *
 * 开发态用 `app.getAppPath()`（仓库根），否则用可执行文件位置——**不能用**
 * `app.getAppPath()`：打包后它指向 `resources/app.asar`，数据目录会落进 asar 旁边。
 */
export function resolveInstallDirectory(options: InstallDirOptions): string {
  const p = pathFor(options.platform)
  if (!options.packaged) return p.resolve(options.appPath)

  if (options.platform === 'darwin') {
    // .../RytenBench.app/Contents/MacOS/RytenBench → .../RytenBench.app
    const macOsDir = p.dirname(p.resolve(options.execPath))
    const contentsDir = p.dirname(macOsDir)
    return p.basename(contentsDir) === 'Contents' ? p.dirname(contentsDir) : macOsDir
  }

  if (options.platform === 'linux' && options.appImagePath) {
    return p.dirname(p.resolve(options.appImagePath))
  }

  return p.dirname(p.resolve(options.execPath))
}

/**
 * 按优先级找到一个**可写**的数据根，并确保三个子目录都建好。
 *
 * 候选：`<安装目录>/data` → `<userData>/data`。macOS 打包态跳过安装目录候选
 * （`.app` 内部不应写入）。候选目录会做一次真实写入探测——只看 `existsSync`
 * 会漏掉「目录在、但当前用户没权限写」的情况。
 *
 * @returns 可用的布局；两个候选都不可写时返回 null（应用继续可用，只是这三项不启用）
 */
export function resolveStorageLayout(options: StorageLayoutOptions): StorageLayout | null {
  let installDir: string
  try {
    installDir = resolveInstallDirectory(options)
  } catch {
    installDir = path.resolve(options.userDataDir)
  }

  const candidates: Array<{ root: string; source: StorageLayoutSource }> = []
  if (
    options.useInstallDirectory !== false &&
    !(options.platform === 'darwin' && options.packaged)
  ) {
    candidates.push({ root: path.join(installDir, DATA_DIR_NAME), source: 'install' })
  }
  candidates.push({ root: path.join(options.userDataDir, DATA_DIR_NAME), source: 'userData' })

  let userDataRoot = ''
  for (const candidate of candidates) {
    const root = path.resolve(candidate.root)
    if (userDataRoot && sameFsPath(root, userDataRoot)) continue
    if (candidate.source === 'userData') userDataRoot = root
    if (!prepareDataRoot(root)) continue
    return {
      installDir,
      dataRoot: root,
      source: candidate.source,
      dirs: buildDirs(root)
    }
  }
  return null
}

function buildDirs(root: string): Record<StorageKind, string> {
  const dirs = {} as Record<StorageKind, string>
  for (const kind of STORAGE_KINDS) {
    dirs[kind] = path.join(root, STORAGE_DIR_NAMES[kind])
  }
  return dirs
}

function sameFsPath(a: string, b: string): boolean {
  const resolve = (value: string): string => {
    const resolved = path.resolve(value)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  return resolve(a) === resolve(b)
}

/** 建目录 + 真写一个探针文件 + 建三个子目录；任何一步失败都算这个候选不可用 */
function prepareDataRoot(root: string): boolean {
  try {
    fs.mkdirSync(root, { recursive: true })
    if (!fs.statSync(root).isDirectory()) return false

    const probe = path.join(root, `.write-probe-${process.pid}-${Date.now()}`)
    fs.writeFileSync(probe, '')
    fs.rmSync(probe, { force: true })

    for (const kind of STORAGE_KINDS) {
      const dir = path.join(root, STORAGE_DIR_NAMES[kind])
      fs.mkdirSync(dir, { recursive: true })
      if (!fs.statSync(dir).isDirectory()) return false
    }
    return true
  } catch {
    return false
  }
}

/** 主进程启动时只要读/写 `harness` 这一个键；测试可注入内存实现 */
export interface SettingsStoreLike {
  get(key: string): unknown
  set(key: string, value: unknown): void
  delete(key: string): void
}

export function discoverStorageLayoutOptions(): StorageLayoutOptions {
  return {
    platform: process.platform,
    packaged: app.isPackaged,
    appPath: app.getAppPath(),
    execPath: process.execPath,
    appImagePath: process.env.APPIMAGE,
    userDataDir: app.getPath('userData'),
    // 自动化（test/probe-*.mjs）都用 `--user-data-dir=...` 隔离；这类进程不该动安装目录，
    // 否则一次工装就可能把开发机仓库里的 data/ 搬到临时目录（判定逻辑与 environment 共用）。
    useInstallDirectory: !hasUserDataDirOverride(process.argv, app.commandLine)
  }
}

/**
 * 历史键迁移：旧版本把 AI 助手这段配置存在 `chat` 下，模块改名后统一用 `harness`。
 *
 * 注意这个 `'chat'` 是**历史键名**，不能跟着模块改名；改了就再也读不到老用户
 * 已经存好的技能目录 / 工作区路径 / 记忆目录。重复调用是幂等的。
 */
export function migrateLegacyHarnessSettingsKey(
  store: SettingsStoreLike = settingsStore as unknown as SettingsStoreLike
): void {
  const legacy = store.get('chat') as HarnessSettings | undefined
  if (legacy === undefined) return
  if (store.get('harness') === undefined) {
    store.set('harness', legacy)
  }
  store.delete('chat')
  logger.info('[Storage] Migrated legacy "chat" settings key to "harness"')
}

function readHarnessSettings(store: SettingsStoreLike): HarnessSettings {
  const raw = store.get('harness')
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return raw as HarnessSettings
}

/**
 * 首次启动装配默认存储布局（在 `initPluginHost()` **之前**调用，工坊装载时才能读到 pluginsPath）。
 *
 * 只补「缺失的」路径：老用户已经配好的记忆/技能目录会原样保留；
 * 一旦标记写入，之后用户主动清空某个路径也不会被自动回填。
 *
 * @returns 本次真正准备出来的布局；不需要/无法准备时 null
 */
export function bootstrapStorageLayout(
  store: SettingsStoreLike = settingsStore as unknown as SettingsStoreLike,
  options: StorageLayoutOptions = discoverStorageLayoutOptions()
): StorageLayout | null {
  try {
    migrateLegacyHarnessSettingsKey(store)
    const current = readHarnessSettings(store)

    // 已完成一次性装配：尊重用户后来清空 / 改到别处的选择
    if (current.storageDefaultsApplied) return null

    const missing = STORAGE_KINDS.filter((kind) => !storagePathOf(current, kind))
    if (missing.length === 0) {
      store.set('harness', { ...current, storageDefaultsApplied: true })
      logger.info('[Storage] Storage paths already configured; default layout not needed')
      return null
    }

    const layout = resolveStorageLayout(options)
    if (!layout) {
      // 不写标记：下次启动再试（可能是安装目录暂时只读 / 磁盘未挂载）
      logger.warn(
        `[Storage] No writable data directory (tried install directory and userData); ` +
          `${missing.map((kind) => STORAGE_LABELS[kind]).join(' / ')} storage stays disabled`
      )
      return null
    }

    const next: HarnessSettings = { ...current, storageDefaultsApplied: true }
    for (const kind of missing) {
      next[STORAGE_SETTING_KEYS[kind]] = layout.dirs[kind]
    }
    store.set('harness', next)
    logger.info(
      `[Storage] Default storage layout ready at ${layout.dataRoot} ` +
        `(source=${layout.source}, seeded=${missing.map((kind) => STORAGE_DIR_NAMES[kind]).join(',')})`
    )
    return layout
  } catch (err) {
    logger.warn('[Storage] Failed to initialize the default storage layout:', err)
    return null
  }
}
