import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { draftDir } from './paths'

/**
 * 草稿源码指纹：产物/验收报告「是不是当前这份源码的」的**唯一判据**。
 *
 * 为什么不能用 mtime（2026-11-23 用户事故的根因）：`buildDraft` 把产物写进
 * `dist/<id>/` 之后，`patchDraftMeta` 还要回写草稿里的 `workshop.json`
 * （`builtAt` / `updatedAt`）。这个文件永远比 `dist/<id>/plugin.json` 新，
 * 于是旧实现「草稿里最新 mtime > 产物 mtime = 过期」**每次构建完都立刻成立**：
 * `plugin_publish install` 永久报「产物比源码旧」，模型只能反复重试，
 * 最后被防循环护栏拦下，人只能手工把产物拷进插件目录（不符合生产流程）。
 *
 * 内容指纹没有这个顺序问题：只有**参与构建/验收的文件内容**真的变了，指纹才变。
 * 因此 `workshop.json`（工坊自己的时间戳/展示名）不参与指纹；它的 `css` 模式
 * 会影响产物，单独拼进指纹前缀。
 *
 * 收录范围刻意只含「能影响产物或验收结论」的扩展名：
 * 改 `WORKSHOP.md` 这类纯文档不该让插件变成「需要重新构建」。
 */

/** 参与指纹的文件扩展名（构建输入 + 冒烟用例） */
const SOURCE_EXT: ReadonlySet<string> = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.css',
  '.svg'
])

/** 不参与构建的目录（产物、依赖、VCS、编辑器缓存、工坊备份） */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  '.cache',
  'backups'
])

/** 收集草稿内参与构建的文件（posix 相对路径，稳定排序） */
function buildInputs(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string, prefix: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      // 点开头的一律跳过：.git/.vscode/.DS_Store 不是插件源码（.vscode/settings.json
      // 扩展名是 .json，不跳过会让人改一下编辑器配置就「产物过期」）
      if (entry.name.startsWith('.')) continue
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(full, rel)
        continue
      }
      if (!entry.isFile()) continue
      // 工坊元数据由工坊自己维护（每次构建后都会写），不是构建输入
      if (rel === 'workshop.json') continue
      if (!SOURCE_EXT.has(path.extname(entry.name).toLowerCase())) continue
      out.push(rel)
    }
  }
  walk(root, '')
  return out.sort((a, b) => a.localeCompare(b, 'en'))
}

/**
 * 计算草稿源码指纹（`sha256`，稳定、跨平台、与 mtime 无关）。
 *
 * 前缀带算法版本与 css 模式：`workshop.json` 里 `css` 从 `auto` 改到 `file`
 * 也会改变产物，必须让指纹跟着变；元数据结构或收录范围将来调整时递增 `v1`。
 *
 * 读文件失败会抛错：调用方（构建/验收/发布闸门）要么把它当致命错误，
 * 要么自己兜底——不能悄悄返回一个「看起来相同」的指纹。
 */
export function draftSourceHash(id: string, cssMode: string): string {
  const root = draftDir(id)
  const hash = createHash('sha256')
  hash.update(`rb-workshop-source-v1\ncss=${cssMode}\n`)
  for (const rel of buildInputs(root)) {
    const content = fs.readFileSync(path.join(root, ...rel.split('/')))
    hash.update(rel)
    hash.update('\0')
    hash.update(String(content.byteLength))
    hash.update('\0')
    hash.update(content)
    hash.update('\n')
  }
  return hash.digest('hex')
}
