import * as fs from 'fs'
import * as path from 'path'
import type {
  WorkshopCssMode,
  WorkshopDraftMeta,
  WorkshopTemplate
} from '../../shared/harness/workshop'
import {
  assertDraftId,
  backupsRoot,
  distDir,
  draftDir,
  draftExists,
  ensureDir,
  reportPath,
  requirePluginsRoot,
  writeJson
} from './paths'
import { TEMPLATE_INFOS, renderTemplate } from './templates'
import { listDraftFiles, readDraftMeta } from './store'
import { releaseWorkshopDir, resumeWorkshopDirs } from './dir-release'

/**
 * Generate a draft from a template (the workshop's entry action).
 *
 * Design tradeoffs:
 * - **Overwriting an existing draft is denied by default**: the assistant calling create
 *   repeatedly in the same topic is common behaviour, and silently wiping code it just wrote is
 *   the worst failure mode; retrying requires an explicit `overwrite: true`;
 * - **Back up everything before overwriting**: the draft directory is the user's own source (it
 *   can be in git, opened in an editor), so a bare `rm -rf` could delete uncommitted work. Copy
 *   the old directory to `<userData>/plugin-workshop/backups/<id>-<timestamp>/` (keeping only
 *   the latest 3) before rebuilding;
 * - **Writes are atomic**: write to a staging directory on the same volume first, then rename it
 *   into place. A failure midway (disk full / no write permission / file in use) never leaves a
 *   half-written draft — the old directory is restored as-is as well;
 * - The host module allowlist in `WORKSHOP.md` comes from **runtime injection** (`hostMainKeys` /
 *   `hostUiKeys`), so a stale list is never emitted (when the host adds a new bridge key, the
 *   next generated draft can use it);
 * - The file list is returned right after generation, so the assistant can decide which file to
 *   read before editing.
 */

export interface CreateDraftOptions {
  id: string
  title?: string
  template?: WorkshopTemplate
  description?: string
  css?: WorkshopCssMode
  overwrite?: boolean
  /** `@host/main/**` keys available to the host main process */
  hostMainKeys?: string[]
  /** `@host/renderer/**`, `@host/vendor/**` keys available to the host renderer */
  hostUiKeys?: string[]
}

export interface CreateDraftResult {
  meta: WorkshopDraftMeta
  /** Generated file relative paths (sorted) */
  files: string[]
  /** Whether an old draft was overwritten */
  overwritten: boolean
  /** Backup directory of the old draft when overwritten (undefined otherwise) */
  backupDir?: string
  dir: string
}

/** Whether the template is valid (invalid input lists the available values so the model cannot guess); default = `full` (all content) */
export function normalizeTemplate(value: unknown): WorkshopTemplate {
  const known = TEMPLATE_INFOS.map((t) => t.template)
  if (typeof value !== 'string' || value === '') return 'full'
  if (!known.includes(value as WorkshopTemplate)) {
    throw new Error(`模板 '${value}' 不存在：可用 ${known.join(' / ')}`)
  }
  return value as WorkshopTemplate
}

/** Timestamp in backup directory names (UTC, sortable, free of Windows-invalid characters; a random suffix avoids collisions within the same millisecond) */
function backupStamp(): string {
  const iso = new Date().toISOString().replace(/[:.]/g, '-')
  return `${iso}-${Math.random().toString(36).slice(2, 6)}`
}

/** Keep only the latest `keep` backups for this plugin (old ones are deleted entirely so the backup directory stays bounded) */
function pruneBackups(id: string, keep = 3): void {
  const root = backupsRoot()
  let entries: string[] = []
  try {
    entries = fs.readdirSync(root)
  } catch {
    return
  }
  const mine = entries
    .filter((name) => name.startsWith(`${id}-`))
    .sort()
    .reverse()
  for (const name of mine.slice(keep)) {
    try {
      fs.rmSync(path.join(root, name), { recursive: true, force: true })
    } catch {
      // If it cannot be deleted, leave it: extra backups are not a problem
    }
  }
}

export function createDraft(opts: CreateDraftOptions): CreateDraftResult {
  const id = assertDraftId(opts.id)
  const template = normalizeTemplate(opts.template)
  const overwritten = draftExists(id)
  if (overwritten && !opts.overwrite) {
    throw new Error(
      `草稿 '${id}' 已存在（要继续改它请用 read/write 动作；确实要按模板重来请传 overwrite=true）`
    )
  }

  // Source lives under the user-configured plugin storage path (draftDir throws a readable error
  // when unconfigured, and the UI prompts configuration from it)
  const dir = draftDir(id)
  const root = requirePluginsRoot()
  ensureDir(root)

  const title = typeof opts.title === 'string' && opts.title.trim() ? opts.title.trim() : id
  const files = renderTemplate(template, {
    id,
    title,
    description: typeof opts.description === 'string' ? opts.description.trim() : '',
    hostMainKeys: opts.hostMainKeys ?? [],
    hostUiKeys: opts.hostUiKeys ?? []
  })

  const now = Date.now()
  const meta: WorkshopDraftMeta = {
    id,
    title,
    template,
    description: typeof opts.description === 'string' ? opts.description.trim() : undefined,
    css: opts.css === 'file' || opts.css === 'off' ? opts.css : 'auto',
    createdAt: readDraftMeta(id)?.createdAt ?? now,
    updatedAt: now
  }

  // 1) Back up before overwriting: copy everything into the workshop's own backups/ (leaving the
  // user's other files in that directory alone)
  //
  // The check is "does the directory exist" rather than draftExists: a leftover directory holding
  // only a README and no plugin.json must not be silently replaced by rename either (on Windows
  // renaming onto an existing directory fails).
  const existingDir = fs.existsSync(dir)
  let backupDir: string | undefined
  if (existingDir) {
    backupDir = path.join(backupsRoot(), `${id}-${backupStamp()}`)
    ensureDir(backupsRoot())
    fs.cpSync(dir, backupDir, { recursive: true, force: true })
    // When overwriting, the old directory may be watched by the workspace (plugin mode has its source open): drop the watch before deleting
    const release = releaseWorkshopDir(dir)
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } finally {
      release?.()
    }
    pruneBackups(id)
  }

  // 2) Write to staging first, then rename into place: a failure midway never leaves a half draft
  const staging = path.join(root, `.${id}.staging-${process.pid}-${now}`)
  try {
    fs.mkdirSync(staging, { recursive: true })
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(staging, rel)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, content, 'utf-8')
    }
    writeJson(path.join(staging, 'workshop.json'), meta)
    fs.renameSync(staging, dir)
    // On overwrite the watch on the old directory was dropped during the delete phase (the
    // directory did not exist then): the new directory is in place, so re-align
    resumeWorkshopDirs()
  } catch (err) {
    try {
      fs.rmSync(staging, { recursive: true, force: true })
    } catch {
      // Ignore: staging is itself a temporary directory that is never listed (invalid id -> draftExists is false)
    }
    // If overwriting failed, put the backup back so the user is at least back to the pre-action state
    if (existingDir && backupDir && !fs.existsSync(dir)) {
      try {
        fs.renameSync(backupDir, dir)
      } catch {
        // Restore failed: include the backup path in the error so the user can still recover manually
        throw new Error(
          `重建草稿 '${id}' 失败，且旧目录恢复到原位也失败；` +
            `旧源码在备份目录里：${backupDir}。原始错误：${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
    throw err
  }

  /**
   * Overwrite means a different source tree: the old build output and the old verification
   * report no longer correspond to the current draft and must be cleared together.
   *
   * If not cleared: `hasBuild` stays true and the panel's export/install would pick up the
   * package built from the previous source (the fingerprint stops `plugin_publish install`, but
   * not `export` or a direct install from the panel).
   */
  if (overwritten) {
    for (const target of [distDir(id), reportPath(id)]) {
      try {
        fs.rmSync(target, { recursive: true, force: true })
      } catch {
        // Not deleting it does not block the rebuild: fingerprint/report checks still catch it (at worst one extra "verify again first")
      }
    }
  }

  return {
    meta,
    files: listDraftFiles(id).map((f) => f.path),
    overwritten,
    backupDir,
    dir
  }
}
