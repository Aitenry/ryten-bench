import * as fs from 'fs'
import * as path from 'path'

/**
 * Workshop directory conventions and **path safety** (single source of truth).
 *
 * ```
 * <userData>/plugin-workshop/
 *   drafts/<id>/         draft source (the only edit surface for the assistant)
 *   dist/<id>/           build output (= installable plugin package, structurally identical to
 *                        the packages published from the plugin center)
 *   reports/<id>.json    latest verification report (read by both the panel and the tools)
 *   exports/<id>-<v>.zip exported distributable archive
 * ```
 *
 * Three invariants:
 * 1. **The draft id is the plugin id**: directory name = `plugin.json.id` = the installed
 *    `userData/plugins/<id>`. Only when all three agree do the existing
 *    uninstall/upgrade/reinstall semantics hold as they are (the scanner requires the directory
 *    name to match the id);
 * 2. **Every externally supplied path goes through `normalizeDraftRel`**: the tools' `path`
 *    argument comes from the model, so `../` escapes must be blocked here (not left to the
 *    caller's discipline);
 * 3. **The root is configurable** (`configureWorkshopRoot`): the service itself does not
 *    import electron, so the offline harness can drive the full
 *    generate -> build -> verify -> publish pipeline against a temporary directory.
 */

/** Workshop root (empty string when not configured = workshop unavailable, see `isWorkshopReady`) */
let root = ''

/**
 * Configure the workshop root directory (the main process injects it via
 * `app.getPath('userData')` in the plugin install effect; the offline harness injects a
 * temporary directory). An empty string disables the workshop (tools/channels then return a
 * readable error instead of crashing).
 */
export function configureWorkshopRoot(dir: string | null | undefined): void {
  root = typeof dir === 'string' ? dir : ''
}

/** Whether the workshop is wired up (while unwired every action returns a readable error) */
export function isWorkshopReady(): boolean {
  return root !== ''
}

/** Workshop root (throws when unwired — callers should check `isWorkshopReady()` first) */
export function workshopRoot(): string {
  if (!root) throw new Error('插件工坊尚未接线（未注入工坊根目录）')
  return root
}

export function distRoot(): string {
  return path.join(workshopRoot(), 'dist')
}

export function reportsRoot(): string {
  return path.join(workshopRoot(), 'reports')
}

export function exportsRoot(): string {
  return path.join(workshopRoot(), 'exports')
}

/**
 * **Backup directory** used before overwriting a draft:
 * `<userData>/plugin-workshop/backups/<id>-<timestamp>/`.
 *
 * Why it is needed: `plugin_draft create --overwrite` targets a source directory the user
 * picked (it can be in git, opened in an editor), so a bare `rm -rf` would delete work that
 * may not be committed yet. Copy the whole thing here before overwriting, leaving at least one
 * way back; keep only the most recent few so it does not grow without bound.
 */
export function backupsRoot(): string {
  return path.join(workshopRoot(), 'backups')
}

/**
 * Legacy drafts directory (before each draft had its own workspace directory, all source lived
 * under `<userData>/plugin-workshop/drafts/`).
 *
 * Now used only for **migration**: when the user configures the plugin storage path for the
 * first time, drafts already here are moved over; nothing is ever written here afterwards.
 */
export function legacyDraftsRoot(): string {
  return path.join(workshopRoot(), 'drafts')
}

// ---------- Plugin storage path (preset by default, user can change) ----------

/**
 * User-configured **plugin storage path** (the source root for all plugins).
 *
 * On first launch `storage/layout.ts` presets it to `<install dir>/data/plugins` (falling back
 * to `<userData>/data/plugins` when the install directory is not writable), so the workshop is
 * usable out of the box; the user can later point it at any writable directory, and existing
 * plugin sources are migrated over when the location changes (see `storage/migration.ts`).
 * When unconfigured (the user cleared it), the workshop can neither list nor create drafts.
 *
 * On-disk convention: one subdirectory per plugin `<pluginsPath>/<plugin id>/`;
 * **the root directory itself is never deleted** (deleting a plugin only removes its own
 * subdirectory).
 */
let pluginsRoot = ''

/** Configure the plugin storage path (pass an empty string when unconfigured) */
export function configurePluginsRoot(dir: string | null | undefined): void {
  pluginsRoot = typeof dir === 'string' && dir.trim() !== '' ? path.resolve(dir) : ''
}

/** Current plugin storage path (empty string when unconfigured) */
export function pluginsRootPath(): string {
  return pluginsRoot
}

/** Whether the plugin storage path is configured (all draft actions are rejected otherwise) */
export function hasPluginsRoot(): boolean {
  return pluginsRoot !== ''
}

/** Get the plugin storage path (throws a readable error when unconfigured; the UI prompts folder selection from it) */
export function requirePluginsRoot(): string {
  if (!pluginsRoot) {
    throw new Error(
      '还没有配置「插件存放路径」：先在 设置 → 助手 → 插件工坊 里选一个文件夹，所有插件都会放在它下面'
    )
  }
  return pluginsRoot
}

/** Source directory of a plugin: `<plugin storage path>/<plugin id>/` */
export function draftDir(id: string): string {
  return path.join(requirePluginsRoot(), assertDraftId(id))
}

export function distDir(id: string): string {
  return path.join(distRoot(), assertDraftId(id))
}

export function reportPath(id: string): string {
  return path.join(reportsRoot(), `${assertDraftId(id)}.json`)
}

/**
 * Plugin id rules (draft directory name = plugin id).
 *
 * Stricter than the `isValidManifest` regex: **lowercase kebab only**. The reason is that this
 * id is simultaneously a directory name, an IPC namespace (`plugin:<id>:*`) and an address
 * segment of `plugin://<id>/…`; mixing in uppercase or dots would split "two spellings of the
 * same plugin" across uninstall and routing. Built-in plugins (notes / harness) already have
 * this form.
 */
const DRAFT_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
/** Maximum length of a single segment (enough for both directory name and namespace) */
const DRAFT_ID_MAX = 40

/**
 * Host-reserved ids: `plugin://host/…` is the address of the renderer host UI bridge (see the
 * note in scanner.ts), so a plugin whose directory is called host can never reach its own
 * files — block it at **draft generation** time instead of waiting for a blank screen after
 * installation.
 */
export const RESERVED_DRAFT_IDS: ReadonlySet<string> = new Set(['host'])

/**
 * Windows reserved device names: `con` / `prn` / `aux` / `nul` / `com1..9` / `lpt1..9`.
 *
 * These names fully satisfy the kebab rule, but on Windows `mkdir('con')` fails (or is treated
 * as a device); since the plugin id is also the directory name they must be blocked here rather
 * than surfacing as a system error while creating the directory. Other platforms do not need
 * this, but "the same draft can be created anywhere" is simpler than branching per platform.
 */
const WINDOWS_DEVICE_NAMES: ReadonlySet<string> = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`)
])

/** Validate a draft id (throws a readable error when invalid) */
export function assertDraftId(id: unknown): string {
  if (typeof id !== 'string' || id === '') {
    throw new Error('草稿 id 不能为空')
  }
  if (id.length > DRAFT_ID_MAX) {
    throw new Error(`草稿 id 太长（${id.length} > ${DRAFT_ID_MAX}）：${id}`)
  }
  if (!DRAFT_ID_RE.test(id)) {
    throw new Error(
      `草稿 id '${id}' 不合法：只允许小写字母、数字与中划线（如 'pomodoro-timer'），且以字母开头`
    )
  }
  if (RESERVED_DRAFT_IDS.has(id)) {
    throw new Error(`草稿 id '${id}' 是宿主保留 id，请换一个名字`)
  }
  if (WINDOWS_DEVICE_NAMES.has(id)) {
    throw new Error(`草稿 id '${id}' 是 Windows 保留设备名，请换一个名字（例如 '${id}-app'）`)
  }
  return id
}

/**
 * Normalize a relative path inside a draft.
 *
 * Blocks three cases: absolute paths (`C:\…` / `/etc/…`), upward escapes (`..`) and empty
 * paths. Backslashes are unified to `/` because the model often writes
 * `renderer\plugin.tsx` out of Windows habit.
 */
export function normalizeDraftRel(rel: unknown): string {
  if (typeof rel !== 'string' || rel.trim() === '') {
    throw new Error('文件路径不能为空')
  }
  const unified = rel.replace(/\\/g, '/').trim()
  if (unified.startsWith('/') || /^[A-Za-z]:/.test(unified)) {
    throw new Error(`文件路径必须是草稿内的相对路径，不能是绝对路径：${rel}`)
  }
  const segments = unified.split('/').filter((s) => s !== '' && s !== '.')
  if (segments.length === 0) throw new Error(`文件路径不合法：${rel}`)
  for (const segment of segments) {
    if (segment === '..') {
      throw new Error(`文件路径不允许越出草稿目录：${rel}`)
    }
    if (segment.includes('\0')) throw new Error('文件路径含有非法字符')
  }
  return segments.join('/')
}

/** Resolve a draft-relative path to an absolute path (throws immediately on escape/invalid input) */
export function resolveInDraft(id: string, rel: unknown): string {
  return path.join(draftDir(id), normalizeDraftRel(rel))
}

/** Resolve an arbitrary relative path under a given root (same protection for exports/reports) */
export function resolveUnder(base: string, rel: unknown): string {
  const target = path.resolve(base, normalizeDraftRel(rel))
  const normalizedBase = path.resolve(base)
  if (target !== normalizedBase && !target.startsWith(normalizedBase + path.sep)) {
    throw new Error(`路径越界：${rel}`)
  }
  return target
}

/** Ensure the directory exists and return it */
export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Read JSON (returns null when missing/unparsable; the caller decides whether to report an error) */
export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T
  } catch {
    return null
  }
}

/** Write JSON (creates parent directories, trailing newline — consistent with other artifact files in the repo) */
export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf-8')
}

/** Whether the draft already exists (either workshop.json or plugin.json counts) */
export function draftExists(id: string): boolean {
  try {
    const dir = draftDir(id)
    return (
      fs.existsSync(path.join(dir, 'workshop.json')) || fs.existsSync(path.join(dir, 'plugin.json'))
    )
  } catch {
    return false
  }
}
