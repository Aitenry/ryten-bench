import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import logger from 'electron-log'
import JSZip from 'jszip'
import { externalPluginsRoot, findExternalPlugin, invalidateInstalledPluginIds } from './scanner'
import { readExternalManifest } from './lifecycle'
import { isBundledPluginId } from './host'

/**
 * **插件包安装内核**：一个已经落盘的「包目录」→ `userData/plugins/<id>/`。
 *
 * 三条安装来源共用它，保证校验、覆盖、清理的语义只有一份：
 * - 从插件中心下载的包（见 `../lattice/hub.ts`）；
 * - 从本地压缩包（用户自己打的 zip，见 `local-install.ts`）；
 * - 从本地文件夹（构建产物目录 `dist/<id>`，同上）。
 *
 * 「包目录」= 含 `plugin.json` 的目录（压缩包解压出来的、或用户直接选的）。
 * 约定与校验：
 * - `plugin.json` 必须字段齐备（`isValidManifest`），且 `builtin !== true`
 *   （随应用分发的内置插件不走这条路，见 `readExternalManifest`）；
 * - id 不能撞内置插件 id（否则会覆盖应用自带的包，卸载/重装链路会错乱）；
 * - `entry.main` / `entry.renderer` 指向的文件必须真的在包里（缺入口的包装了也白装）；
 * - 升级（同 id 已装）时删掉旧版本里多出来的文件，避免旧哈希 chunk 与新入口混装。
 */

/** 安装结果（面板据此提示「已安装 / 已升级」，工装据此断言） */
export interface InstalledPackageInfo {
  id: string
  name: string
  version: string
  /** true = 覆盖了同 id 的既有安装 */
  upgraded: boolean
  /** 最终落地的目录（userData/plugins/<id>） */
  dest: string
  /** 本次拷进去的文件数 */
  files: number
}

/** 压缩工具产出的噪音条目（macOS / Windows / 编辑器），静默忽略 */
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
 * 解压 zip 到临时目录（**宽松**：允许子目录与「压缩整个文件夹」多出来的一层前缀）。
 *
 * 与旧实现的区别（本地安装功能引入）：旧实现要求「平铺、无任何 `/`」，而用户在
 * Windows 上右键「压缩整个文件夹」得到的 zip 顶层一定带一层目录名——那是最常见的
 * 本地打包方式，按旧口径会被判成「非法路径」，用户完全不知道自己做错了什么。
 * 现在：剥掉唯一的顶层前缀、忽略噪音条目、允许子目录，但**仍然拒绝**绝对路径与 `..`
 * （目录穿越是安全问题，不能因为好用而放松）。
 */
export async function extractZipToTemp(zipPath: string): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ryten-plugin-'))
  const zip = await JSZip.loadAsync(fs.readFileSync(zipPath))

  const entries: { rel: string; file: JSZip.JSZipObject }[] = []
  for (const [rawName, file] of Object.entries(zip.files)) {
    if (file.dir) continue
    // 压缩工具可能写反斜杠；统一成正斜杠再判定
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

  // 「压缩整个文件夹」的包：所有文件共享同一个顶层目录名、且根目录没有 plugin.json → 剥掉这一层
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

/** 目录下所有文件的相对路径（posix 分隔符），用于「升级时删掉旧版本多出来的文件」 */
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
 * 把用户选的目录解析成「包目录」。
 *
 * 允许两种选法：直接选插件包目录（含 `plugin.json`），或选它上一级（例如 `dist/`，
 * 里面只有一个插件包时自动下钻一层）。带源码的仓库目录会给出明确提示——源码要先构建。
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
 * 安装（或升级）一个已经落盘的插件包目录。
 *
 * @param sourceDir 含 `plugin.json` 的目录
 * @param opts.expectId 期望的 id（从索引安装时用：索引说装 A，包里却是 B → 拒绝）
 */
export function installPackageDir(
  sourceDir: string,
  opts: { expectId?: string } = {}
): InstalledPackageInfo {
  const manifest = readExternalManifest(sourceDir)
  if (opts.expectId && manifest.id !== opts.expectId) {
    throw new Error(`插件包清单 id 与索引不一致：索引 ${opts.expectId}，包内 ${manifest.id}`)
  }
  if (isBundledPluginId(manifest.id)) {
    throw new Error(
      `'${manifest.id}' 是随应用分发的内置插件 id，不能用本地/仓库安装覆盖（请用面板里的「安装」重装内置插件）`
    )
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
  // 升级：旧版本里多出来的文件（主要是旧哈希的 chunk）删掉，避免新旧混装
  if (upgraded) {
    const incoming = new Set(files)
    for (const rel of listFilesRel(dest)) {
      if (!incoming.has(rel)) fs.rmSync(path.join(dest, rel), { force: true })
    }
  }
  invalidateInstalledPluginIds()
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
