import * as fs from 'fs'
import * as path from 'path'
import type {
  WorkshopDraftFile,
  WorkshopDraftMeta,
  WorkshopTemplate,
  WorkshopCssMode
} from '../../shared/harness/workshop'
import {
  draftDir,
  draftExists,
  hasPluginsRoot,
  normalizeDraftRel,
  readJson,
  requirePluginsRoot,
  resolveInDraft,
  writeJson
} from './paths'
import { releaseWorkshopDir } from './dir-release'

/**
 * Draft storage: read/write, list and delete under `drafts/<id>/`.
 *
 * Three boundaries (all owned by this file; callers need not re-check):
 * - **Paths**: every relative path goes through `normalizeDraftRel` (blocks `..`/absolute paths);
 * - **Size**: 512KB per file, 200 files / 5MB per draft — one huge broken file written by the
 *   assistant must fail fast with a readable rejection rather than fill the disk (this also
 *   prevents stuffing an entire base64 build output into a draft file);
 * - **Extension allowlist**: drafts may contain only source/style/text files
 *   (`.ts/.tsx/.js/.jsx/.mjs/.cjs/.json/.css/.md/.svg/.txt`); binaries and executables are always
 *   rejected (plugin output is produced by the build only).
 */

/** File extensions allowed in a draft */
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

/** Maximum size of a single file */
export const MAX_FILE_BYTES = 512 * 1024
/** File count / total size limits for a whole draft */
export const MAX_FILES = 200
export const MAX_TOTAL_BYTES = 5 * 1024 * 1024

/** Directories skipped when listing (build output, dependencies, VCS) */
const SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git', 'dist', '.cache'])

/**
 * Get the display name from `plugin.json` (returns an empty string when absent/empty).
 *
 * A downloaded source package (the plugin center's "source code" download) usually has only
 * plugin.json and no workshop.json: the display name must then come from the manifest's name,
 * not from the directory name (the plugin id).
 */
function manifestTitle(id: string): string {
  const manifest = readDraftManifest(id)
  return typeof manifest?.name === 'string' ? manifest.name.trim() : ''
}

/**
 * Default draft metadata (when workshop.json is missing, fall back to the **manifest name**, then
 * to the directory name).
 *
 * Only used by `patchDraftMeta` to seed the data when there is no workshop.json: writing the id
 * here would make the first file written through the workshop create a workshop.json with
 * `title: <id>`, after which the sidebar/plugin workspace would forever show the id (user report
 * 2026-11-25: "the plugin workspace name is still the id").
 */
function defaultMeta(id: string): WorkshopDraftMeta {
  const now = Date.now()
  return {
    id,
    title: manifestTitle(id) || id,
    template: 'minimal',
    css: 'auto',
    createdAt: now,
    updatedAt: now
  }
}

/** Read draft metadata (returns null when missing) */
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

/** Write draft metadata */
export function writeDraftMeta(meta: WorkshopDraftMeta): void {
  writeJson(path.join(draftDir(meta.id), 'workshop.json'), meta)
}

/** Partially update draft metadata (refreshes updatedAt automatically) */
export function patchDraftMeta(id: string, patch: Partial<WorkshopDraftMeta>): WorkshopDraftMeta {
  const base = readDraftMeta(id) ?? defaultMeta(id)
  const next: WorkshopDraftMeta = { ...base, ...patch, id, updatedAt: Date.now() }
  writeDraftMeta(next)
  return next
}

/**
 * List all draft ids: every subdirectory under `<plugin storage path>/`.
 *
 * Returns an empty array when the storage path is not configured (the UI prompts the user to
 * pick a folder from it) — it does not throw, because listing is a normal state while
 * unconfigured; only actions like **create/build** require configuration.
 */
export function listDraftIds(): string[] {
  if (!hasPluginsRoot()) return []
  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(requirePluginsRoot(), { withFileTypes: true })
  } catch {
    // The directory does not exist yet (the user just picked an empty folder / it was moved away): treat it as no drafts
    return []
  }
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        // Names starting with `.` are temporary/hidden directories (scaffold staging, editor directories), not drafts
        !entry.name.startsWith('.') &&
        draftExists(entry.name)
    )
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en'))
}

/** Validate the extension (used when writing; reads/listing skip validation so historical files stay readable) */
export function assertAllowedExt(rel: string): void {
  const ext = path.extname(rel).toLowerCase()
  if (!ALLOWED_EXT.has(ext)) {
    throw new Error(
      `草稿里不允许写 ${ext || '（无扩展名）'} 文件：只支持 ${[...ALLOWED_EXT].join(' / ')}`
    )
  }
}

/**
 * List the files in a draft (posix relative paths, sorted by path).
 *
 * Skips `node_modules` / `.git` / `dist`: they are not source, and including them in the file
 * tree only distracts the model and the user.
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
        // Ignore files whose stat cannot be read (being deleted / permission issues)
      }
    }
  }
  if (fs.existsSync(root)) walk(root, '')
  return out.sort((a, b) => a.path.localeCompare(b.path, 'en'))
}

/** Read a draft file (throws a readable error when missing) */
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
 * Write a draft file (creates directories automatically).
 *
 * @param opts.create whether creation is allowed (allowed by default); when `false` the file must
 * already exist (for "modify only, never create" flows)
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

/** Delete a file in a draft (reports a readable error when it does not exist) */
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

/**
 * Delete the whole draft directory (`<plugin storage path>/<id>/`).
 *
 * Only this plugin's subdirectory is deleted; **the root directory itself is never touched** (it
 * is the folder the user picked in settings, which may contain other things).
 *
 * @returns `removedDir` = whether the directory was actually removed (false when the storage path
 * is unconfigured)
 */
export function deleteDraft(id: string): { removedDir: boolean } {
  if (!hasPluginsRoot()) return { removedDir: false }
  const dir = draftDir(id)
  if (fs.existsSync(dir)) {
    // When plugin mode has its source open the directory is being watched: a plain rm on Windows fails with EPERM, so drop the watch first
    const release = releaseWorkshopDir(dir)
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } finally {
      release?.()
    }
  }
  return { removedDir: true }
}

/** Read the raw draft manifest (returns null when unparsable; the verification checks call it out) */
export function readDraftManifest(id: string): Record<string, unknown> | null {
  const raw = readJson<Record<string, unknown>>(path.join(draftDir(id), 'plugin.json'))
  return raw && typeof raw === 'object' ? raw : null
}

/** Whether the draft already exists (used by create to decide new vs. overwrite) */
export { draftExists }
