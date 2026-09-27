import * as fs from 'fs'
import * as path from 'path'
import type {
  WorkshopDraftFile,
  WorkshopDraftMeta,
  WorkshopTemplate,
  WorkshopCssMode
} from '../../shared/workshop'
import {
  draftDir,
  draftExists,
  draftsRoot,
  normalizeDraftRel,
  readJson,
  resolveInDraft,
  writeJson
} from './paths'

/**
 * 草稿存储：`drafts/<id>/` 下的读写、列举、删除。
 *
 * 三条边界（都由本文件负责，调用方不需要重复判断）：
 * - **路径**：一切相对路径过 `normalizeDraftRel`（挡 `..`/绝对路径）；
 * - **体积**：单文件 512KB、整份草稿 200 个文件 / 5MB —— 助手一次写坏一个巨型文件时
 *   要立刻得到一个可读的拒绝，而不是把磁盘写满（也防止把整个产物 base64 塞进某个草稿文件）；
 * - **扩展名白名单**：草稿里只允许源码/样式/文本类文件（`.ts/.tsx/.js/.jsx/.mjs/.cjs/.json/.css/.md/.svg/.txt`），
 *   二进制与可执行文件一律拒绝（插件产物只由构建生成）。
 */

/** 草稿里允许出现的文件扩展名 */
const ALLOWED_EXT: ReadonlySet<string> = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.css',
  '.md',
  '.svg',
  '.txt'
])

/** 单个文件体积上限 */
export const MAX_FILE_BYTES = 512 * 1024
/** 整份草稿的文件数 / 总体积上限 */
export const MAX_FILES = 200
export const MAX_TOTAL_BYTES = 5 * 1024 * 1024

/** 列举时跳过的目录（产物、依赖、VCS） */
const SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git', 'dist', '.cache'])

/** 草稿元数据的默认值（缺 workshop.json 时用目录名兜底） */
function defaultMeta(id: string): WorkshopDraftMeta {
  const now = Date.now()
  return {
    id,
    title: id,
    template: 'minimal',
    css: 'auto',
    createdAt: now,
    updatedAt: now
  }
}

/** 读草稿元数据（不存在返回 null） */
export function readDraftMeta(id: string): WorkshopDraftMeta | null {
  const raw = readJson<Partial<WorkshopDraftMeta>>(path.join(draftDir(id), 'workshop.json'))
  if (!raw || typeof raw !== 'object') return null
  const base = defaultMeta(id)
  return {
    ...base,
    ...raw,
    id,
    title: typeof raw.title === 'string' && raw.title ? raw.title : base.title,
    template: (typeof raw.template === 'string' ? raw.template : base.template) as WorkshopTemplate,
    css: (typeof raw.css === 'string' ? raw.css : base.css) as WorkshopCssMode,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : base.createdAt,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : base.updatedAt
  }
}

/** 写草稿元数据 */
export function writeDraftMeta(meta: WorkshopDraftMeta): void {
  writeJson(path.join(draftDir(meta.id), 'workshop.json'), meta)
}

/** 局部更新草稿元数据（自动刷新 updatedAt） */
export function patchDraftMeta(id: string, patch: Partial<WorkshopDraftMeta>): WorkshopDraftMeta {
  const base = readDraftMeta(id) ?? defaultMeta(id)
  const next: WorkshopDraftMeta = { ...base, ...patch, id, updatedAt: Date.now() }
  writeDraftMeta(next)
  return next
}

/** 列举全部草稿 id（按目录扫描，读不到 workshop.json 但有 plugin.json 的也算） */
export function listDraftIds(): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(draftsRoot(), { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isDirectory() && draftExists(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, 'en'))
}

/** 校验扩展名（写文件时用；读/列举不校验，历史文件也要能读出来） */
export function assertAllowedExt(rel: string): void {
  const ext = path.extname(rel).toLowerCase()
  if (!ALLOWED_EXT.has(ext)) {
    throw new Error(
      `草稿里不允许写 ${ext || '（无扩展名）'} 文件：只支持 ${[...ALLOWED_EXT].join(' / ')}`
    )
  }
}

/**
 * 列举草稿内的文件（posix 相对路径，已按路径排序）。
 *
 * 跳过 `node_modules` / `.git` / `dist`：它们不是源码，列进文件树只会干扰模型与用户。
 */
export function listDraftFiles(id: string): WorkshopDraftFile[] {
  const root = draftDir(id)
  const out: WorkshopDraftFile[] = []
  const walk = (dir: string, prefix: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(full, rel)
        continue
      }
      if (!entry.isFile()) continue
      try {
        const stat = fs.statSync(full)
        out.push({ path: rel, size: stat.size, mtime: stat.mtimeMs })
      } catch {
        // 读不到 stat 的文件忽略（正在被删/权限问题）
      }
    }
  }
  if (fs.existsSync(root)) walk(root, '')
  return out.sort((a, b) => a.path.localeCompare(b.path, 'en'))
}

/** 读一个草稿文件（不存在抛可读错误） */
export function readDraftFile(id: string, rel: unknown): string {
  const abs = resolveInDraft(id, rel)
  if (!fs.existsSync(abs)) {
    throw new Error(`草稿 '${id}' 里没有文件 ${normalizeDraftRel(rel)}`)
  }
  const stat = fs.statSync(abs)
  if (!stat.isFile()) throw new Error(`${normalizeDraftRel(rel)} 不是文件`)
  if (stat.size > MAX_FILE_BYTES * 4) {
    throw new Error(`文件过大（${Math.round(stat.size / 1024)}KB），工坊不读超过 2MB 的文件`)
  }
  return fs.readFileSync(abs, 'utf-8')
}

/**
 * 写一个草稿文件（自动建目录）。
 *
 * @param opts.create 是否允许新建（默认允许）；`false` 时文件必须已存在（用于「只改不新建」的场景）
 */
export function writeDraftFile(
  id: string,
  rel: unknown,
  content: string,
  opts: { create?: boolean } = {}
): WorkshopDraftFile {
  const clean = normalizeDraftRel(rel)
  assertAllowedExt(clean)
  if (typeof content !== 'string') throw new Error('文件内容必须是字符串')
  const bytes = Buffer.byteLength(content, 'utf-8')
  if (bytes > MAX_FILE_BYTES) {
    throw new Error(
      `文件过大（${Math.round(bytes / 1024)}KB > ${MAX_FILE_BYTES / 1024}KB）：${clean}`
    )
  }
  const existing = listDraftFiles(id)
  if (existing.length >= MAX_FILES && !existing.some((f) => f.path === clean)) {
    throw new Error(`草稿文件数已达上限（${MAX_FILES}），请合并文件或删掉不用的`)
  }
  const total = existing.reduce((sum, f) => sum + f.size, 0)
  const previous = existing.find((f) => f.path === clean)?.size ?? 0
  if (total - previous + bytes > MAX_TOTAL_BYTES) {
    throw new Error(`草稿总体积超过上限（${MAX_TOTAL_BYTES / 1024 / 1024}MB），请精简代码`)
  }
  if (opts.create === false && !fs.existsSync(resolveInDraft(id, clean))) {
    throw new Error(`文件不存在：${clean}（需要新建请用 create 语义）`)
  }

  const abs = resolveInDraft(id, clean)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, 'utf-8')
  patchDraftMeta(id, {})
  const stat = fs.statSync(abs)
  return { path: clean, size: stat.size, mtime: stat.mtimeMs }
}

/** 删除草稿内的一个文件（不存在的报可读错误） */
export function deleteDraftFile(id: string, rel: unknown): void {
  const abs = resolveInDraft(id, rel)
  const clean = normalizeDraftRel(rel)
  if (clean === 'plugin.json' || clean === 'workshop.json') {
    throw new Error(`${clean} 是工坊的结构文件，不能删（删草稿请用 delete 动作）`)
  }
  if (!fs.existsSync(abs)) throw new Error(`文件不存在：${clean}`)
  fs.rmSync(abs, { recursive: true, force: true })
  patchDraftMeta(id, {})
}

/** 整份删除草稿目录（含产物与报告） */
export function deleteDraft(id: string): void {
  const dir = draftDir(id)
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
}

/** 读草稿清单原文（解析失败返回 null，由验收检查点名） */
export function readDraftManifest(id: string): Record<string, unknown> | null {
  const raw = readJson<Record<string, unknown>>(path.join(draftDir(id), 'plugin.json'))
  return raw && typeof raw === 'object' ? raw : null
}

/** 草稿是否已存在（供 create 判断「新建还是覆盖」） */
export { draftExists }
