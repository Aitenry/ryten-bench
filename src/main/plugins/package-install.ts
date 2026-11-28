import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import logger from 'electron-log'
import JSZip from 'jszip'
import { externalPluginsRoot, findExternalPlugin, invalidateInstalledPluginIds } from './scanner'
import { readExternalManifest } from './lifecycle'
import { clearInstallRemoved } from './store'

/**
 * **Plugin package install kernel**: an already-staged "package directory" -> `userData/plugins/<id>/`.
 *
 * Three install sources share it, so validation, overwrite and cleanup semantics exist only once:
 * - packages downloaded from the plugin center (see `../lattice/hub.ts`);
 * - local zip archives (user-made zips, see `local-install.ts`);
 * - local folders (build output directories `dist/<id>`, same as above).
 *
 * "Package directory" = a directory containing `plugin.json` (extracted from a zip, or picked
 * directly by the user). Conventions and validation:
 * - `plugin.json` must have complete fields (`isValidManifest`);
 * - the files pointed to by `entry.main` / `entry.renderer` must really be in the package (a
 *   package missing entries is useless even if installed);
 * - on upgrade (same id already installed) delete files that only existed in the old version, to
 *   avoid mixing old hashed chunks with the new entry.
 */

/** Install result (the panel uses it to say "installed / upgraded"; tooling asserts on it) */
export interface InstalledPackageInfo {
  id: string
  name: string
  version: string
  /** true = overwrote an existing install with the same id */
  upgraded: boolean
  /** Final destination directory (userData/plugins/<id>) */
  dest: string
  /** Number of files copied this time */
  files: number
}

/** Noise entries produced by archivers (macOS / Windows / editors), silently ignored */
const NOISE_NAMES: ReadonlySet<string> = new Set([
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  '__MACOSX'
])

function isNoise(relPath: string): boolean {
  return relPath
    .split('/')
    .filter((seg) => seg.length > 0)
    .some((seg) => NOISE_NAMES.has(seg))
}

/**
 * Extract a zip to a temp directory (**lenient**: subdirectories and the extra top-level prefix of
 * "compress the whole folder" are allowed).
 *
 * Difference from the old implementation (introduced with local install): the old one required
 * "flat, no `/` at all", while the zip a user gets from Windows' right-click "compress whole
 * folder" always has a top-level directory name - the most common local packaging form - and was
 * rejected as "invalid path" under the old rule, leaving the user with no idea what they did
 * wrong. Now: strip the single top-level prefix, ignore noise entries, allow subdirectories, but
 * **still reject** absolute paths and `..` (path traversal is a security issue and must not be
 * relaxed for convenience).
 */
export async function extractZipToTemp(zipPath: string): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ryten-plugin-'))
  const zip = await JSZip.loadAsync(fs.readFileSync(zipPath))

  const entries: { rel: string; file: JSZip.JSZipObject }[] = []
  for (const [rawName, file] of Object.entries(zip.files)) {
    if (file.dir) continue
    // Archivers may write backslashes; normalize to forward slashes before validating
    const name = rawName.replace(/\\/g, '/')
    if (isNoise(name)) continue
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
      fs.rmSync(dir, { recursive: true, force: true })
      throw new Error(`插件包里有非法路径（绝对路径）：${rawName}`)
    }
    const segs = name.split('/').filter((s) => s.length > 0)
    if (segs.some((s) => s === '..')) {
      fs.rmSync(dir, { recursive: true, force: true })
      throw new Error(`插件包里有非法路径（不允许 ..）：${rawName}`)
    }
    if (segs.length === 0) continue
    entries.push({ rel: segs.join('/'), file })
  }
  if (entries.length === 0) {
    fs.rmSync(dir, { recursive: true, force: true })
    throw new Error('插件压缩包是空的（没有任何文件）')
  }

  // "Compress the whole folder" packages: all files share one top-level directory name and there
  // is no plugin.json at the root -> strip that level
  const tops = new Set(entries.map((e) => e.rel.split('/')[0]))
  const hasRootManifest = entries.some((e) => e.rel === 'plugin.json')
  const prefix = !hasRootManifest && tops.size === 1 ? `${[...tops][0]}/` : ''

  try {
    for (const { rel, file } of entries) {
      const stripped = prefix && rel.startsWith(prefix) ? rel.slice(prefix.length) : rel
      if (stripped === '') continue
      const target = path.join(dir, stripped)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, await file.async('nodebuffer'))
    }
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true })
    throw err
  }
  return dir
}

/** Relative paths of all files under a directory (posix separators), used to "delete files that only existed in the old version on upgrade" */
function listFilesRel(dir: string, prefix = ''): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (isNoise(rel)) continue
      out.push(...listFilesRel(path.join(dir, entry.name), rel))
    } else if (entry.isFile() && !isNoise(rel)) {
      out.push(rel)
    }
  }
  return out
}

/**
 * Resolve the directory picked by the user into a "package directory".
 *
 * Two selection forms are allowed: pick the plugin package directory directly (containing
 * `plugin.json`), or pick its parent (e.g. `dist/`, descending one level automatically when it
 * contains exactly one plugin package). A source repository directory gets an explicit message -
 * source must be built first.
 */
export function resolvePackageRoot(dir: string): string {
  if (fs.existsSync(path.join(dir, 'plugin.json'))) return dir
  const children = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !isNoise(e.name))
  const withManifest = children.filter((e) => fs.existsSync(path.join(dir, e.name, 'plugin.json')))
  if (withManifest.length === 1) return path.join(dir, withManifest[0].name)
  if (withManifest.length > 1) {
    throw new Error(
      `选中的目录下有 ${withManifest.length} 个插件包（${withManifest
        .map((e) => e.name)
        .join(' / ')}）：请直接选择其中一个插件的目录`
    )
  }
  throw new Error(
    '选中的目录里没有 plugin.json：请选择插件**构建产物**目录（例如 dist/<id>）；' +
      '如果是源码目录，请先在插件源码里跑一次构建'
  )
}

/**
 * Install (or upgrade) an already-staged plugin package directory.
 *
 * @param sourceDir Directory containing `plugin.json`
 * @param opts.expectId Expected id (used when installing from an index: the index says install A
 * but the package is B -> reject)
 */
export function installPackageDir(
  sourceDir: string,
  opts: { expectId?: string } = {}
): InstalledPackageInfo {
  const manifest = readExternalManifest(sourceDir)
  if (opts.expectId && manifest.id !== opts.expectId) {
    throw new Error(`插件包清单 id 与索引不一致：索引 ${opts.expectId}，包内 ${manifest.id}`)
  }

  const files = listFilesRel(sourceDir)
  const mainEntry = manifest.entry?.main ?? ''
  const rendererEntry = manifest.entry?.renderer ?? ''
  if (!mainEntry || !rendererEntry) {
    throw new Error('plugin.json 的 entry 缺少 main / renderer：插件包必须带主进程与渲染层入口')
  }
  if (!files.includes(mainEntry)) {
    throw new Error(`插件包缺少主进程入口：${mainEntry}`)
  }
  if (!files.includes(rendererEntry)) {
    throw new Error(`插件包缺少渲染层入口：${rendererEntry}`)
  }

  const dest = path.join(externalPluginsRoot(), manifest.id)
  const upgraded = Boolean(findExternalPlugin(manifest.id))
  fs.mkdirSync(dest, { recursive: true })
  for (const rel of files) {
    const target = path.join(dest, rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(path.join(sourceDir, rel), target)
  }
  // Upgrade: delete files that only existed in the old version (mainly old-hash chunks), avoiding mixing old and new
  if (upgraded) {
    const incoming = new Set(files)
    for (const rel of listFilesRel(dest)) {
      if (!incoming.has(rel)) fs.rmSync(path.join(dest, rel), { force: true })
    }
  }
  invalidateInstalledPluginIds()
  // The user installed it again: clear the "explicitly uninstalled" mark, otherwise the plugin
  // center's new-machine auto-backfill keeps skipping it
  clearInstallRemoved(manifest.id)
  logger.info(
    `[Plugins] ${upgraded ? 'Upgraded' : 'Installed'} '${manifest.id}' v${manifest.version} (${files.length} files) -> ${dest}`
  )
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    upgraded,
    dest,
    files: files.length
  }
}
