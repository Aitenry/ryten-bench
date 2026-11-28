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
 * Default storage layout: **seed the three memory / plugins / skills storage directories under the
 * software install directory**.
 *
 * ```
 * <install dir>/data/
 *   memory/     memory root (scoped further by workspace-<id> / plugin-<id> / chat)
 *   plugins/    plugin storage path (plugin workshop drafts + sources downloaded from the plugin center)
 *   skills/     skills root (every subdirectory containing SKILL.md is one skill)
 * ```
 *
 * Cross-platform behavior:
 * - Windows: install dir = the directory containing the exe (`D:\Software\RytenBench` can sit right next to it);
 * - Linux: AppImage uses the directory containing the `.AppImage` file, deb uses the executable's directory;
 * - macOS: `.app` is a signed bundle, **never write inside it**; use `userData/data` directly
 *   (`~/Library/Application Support/...`);
 * - when the install directory is not writable (Program Files / /opt / read-only disk), fall back to `userData/data`.
 *
 * Note this `<userData>` is already **separated per environment** (rules in `src/main/environment/`):
 * development uses `<appData>/ryten-bench-dev` and packaged uses `<appData>/ryten-bench`,
 * so the "install directory not writable → fall back to userData" path never collides across the two.
 *
 * These paths are written into the settings only on **first** assembly (the `storageDefaultsApplied`
 * marker). If the user later clears a path (= disables that capability) or moves it elsewhere, later
 * starts will not put the default back; when moved elsewhere, `./migration.ts` migrates the data.
 */

export const DATA_DIR_NAME = 'data'

/**
 * Where the storage root lives: the `data` next to the install directory, or `data` under the user
 * data directory
 */
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
  /** Development app root (repository root) / provided by electron when packaged */
  appPath: string
  /** `process.execPath` */
  execPath: string
  /** Real file path of the Linux AppImage (`process.env.APPIMAGE`) */
  appImagePath?: string
}

export interface StorageLayoutOptions extends InstallDirOptions {
  userDataDir: string
  /**
   * false = use `<userData>/data` directly.
   *
   * Normal installs and development both prefer "the data next to the install directory"; only when
   * automation isolates itself with `--user-data-dir` is this explicitly turned off (otherwise a test
   * run would move the dev machine's repository `data/` around as if it were real data).
   */
  useInstallDirectory?: boolean
}

/** Platform-specific path implementation: tooling can verify macOS / Linux path rules on Windows */
function pathFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix
}

/**
 * Resolve the "software install directory".
 *
 * In development use `app.getAppPath()` (the repository root); otherwise use the executable location —
 * `app.getAppPath()` **must not** be used: when packaged it points at `resources/app.asar`, so the data
 * directory would end up next to the asar.
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
 * Find a **writable** data root in priority order and make sure all three subdirectories exist.
 *
 * Candidates: `<install dir>/data` → `<userData>/data`. The packaged macOS app skips the install
 * directory candidate (nothing should be written inside `.app`). Each candidate gets a real write
 * probe — `existsSync` alone would miss "the directory exists, but the current user cannot write it".
 *
 * @returns the usable layout; null when neither candidate is writable (the app keeps working, these
 * three capabilities are just not enabled)
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

/**
 * Create the directory + actually write a probe file + create the three subdirectories; any failing
 * step makes this candidate unusable
 */
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

/**
 * The main process only reads/writes the `harness` key at startup; tests can inject an in-memory
 * implementation
 */
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
    // Automation (test/probe-*.mjs) isolates itself with `--user-data-dir=...`; such processes must not
    // touch the install directory, otherwise a single tooling run could move the dev machine's
    // repository data/ into a temp directory (the check is shared with environment).
    useInstallDirectory: !hasUserDataDirOverride(process.argv, app.commandLine)
  }
}

/**
 * Legacy key migration: older versions stored this AI assistant configuration under `chat`; after the
 * module rename everything uses `harness`.
 *
 * Note that this `'chat'` is a **historical key name** and must not follow the module rename; changing
 * it would make already-saved skill directories / workspace paths / memory directories unreadable for
 * existing users. Repeated calls are idempotent.
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
 * Assemble the default storage layout on first launch (call it **before** `initPluginHost()` so the
 * workshop can read pluginsPath when loading).
 *
 * Only "missing" paths are filled in: memory/skill directories an existing user already configured are
 * kept as-is; once the marker is written, clearing some path later is not auto-filled again.
 *
 * @returns the layout actually prepared this time; null when none is needed / possible
 */
export function bootstrapStorageLayout(
  store: SettingsStoreLike = settingsStore as unknown as SettingsStoreLike,
  options: StorageLayoutOptions = discoverStorageLayoutOptions()
): StorageLayout | null {
  try {
    migrateLegacyHarnessSettingsKey(store)
    const current = readHarnessSettings(store)

    // One-time assembly already done: respect whatever the user cleared / moved afterwards
    if (current.storageDefaultsApplied) return null

    const missing = STORAGE_KINDS.filter((kind) => !storagePathOf(current, kind))
    if (missing.length === 0) {
      store.set('harness', { ...current, storageDefaultsApplied: true })
      logger.info('[Storage] Storage paths already configured; default layout not needed')
      return null
    }

    const layout = resolveStorageLayout(options)
    if (!layout) {
      // Do not write the marker: try again next start (the install directory may be temporarily
      // read-only / the disk may not be mounted yet)
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
