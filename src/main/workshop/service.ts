import * as fs from 'fs'
import * as path from 'path'
import type {
  WorkshopBuildInfo,
  WorkshopDraftDetail,
  WorkshopDraftMeta,
  WorkshopDraftSummary,
  WorkshopPublishGate,
  WorkshopPublishResult,
  WorkshopReport,
  WorkshopTemplate
} from '../../shared/harness/workshop'
import { isSamePath, migrateStorageDirectory } from '../storage/migration'
import { buildDraft, type BuildDraftOptions } from './build'
import { createDraft, type CreateDraftOptions } from './scaffold'
import {
  configurePluginsRoot,
  distDir,
  draftDir,
  hasPluginsRoot,
  isWorkshopReady,
  legacyDraftsRoot,
  pluginsRootPath,
  reportPath
} from './paths'
import {
  deleteDraft as removeDraftDir,
  deleteDraftFile,
  draftExists,
  listDraftFiles,
  listDraftIds,
  patchDraftMeta,
  readDraftFile,
  readDraftManifest,
  readDraftMeta,
  writeDraftFile
} from './store'
import {
  hasBuild,
  isBuildStale,
  currentSourceHash,
  workshopHost,
  workshopHostOrNull,
  type WorkshopHost
} from './host'
import { publishDraft, disableDraft, enableDraft, unpublishDraft, exportDraft } from './install'
import { readReport, verifyDraft, type VerifyOptions } from './verify'
import { releaseWorkshopDir } from './dir-release'

/**
 * Workshop facade: the AI tools (`main/tools/workshop.ts`) and the settings page
 * (`main/ipc/workshop.ts`) only call in here and never touch build/verify/install details
 * directly.
 *
 * This layer is responsible for **folding host state into the draft view** (built or not,
 * installed or not, latest verification verdict) — both the panel and the model need one answer
 * to "what state is this draft in now".
 */

export interface WorkshopServiceState {
  /** Whether the workshop is wired up (the AI assistant plugin is loaded) */
  ready: boolean
  /**
   * Whether the **plugin storage path** is configured (preset from the install directory on
   * first launch; false after the user clears it). When unconfigured the draft list is empty and
   * creation is rejected, and the UI prompts the user to pick a folder from it.
   */
  configured: boolean
  /** User-configured plugin storage path (empty string when unconfigured) */
  pluginsPath: string
  /** Workshop internal root directory (session artifacts/reports/exports; **not shown in the UI**) */
  root: string
  drafts: number
}

/** Current workshop state (used by the panel and in tool failure messages) */
export function workshopState(): WorkshopServiceState {
  const host = workshopHostOrNull()
  return {
    ready: isWorkshopReady(),
    configured: hasPluginsRoot(),
    pluginsPath: pluginsRootPath(),
    root: host?.root ?? '',
    drafts: isWorkshopReady() ? listDraftIds().length : 0
  }
}

/** Summary of each draft (including host-side installed/enabled/latest verification state) */
export function listDraftSummaries(): WorkshopDraftSummary[] {
  const host = workshopHostOrNull()
  return listDraftIds().map((id) => summarize(id, host))
}

/** Summary of a single draft */
export function draftSummary(id: string): WorkshopDraftSummary {
  return summarize(id, workshopHostOrNull())
}

function summarize(id: string, host: WorkshopHost | null): WorkshopDraftSummary {
  const meta = readDraftMeta(id)
  const manifest = readDraftManifest(id)
  const files = listDraftFiles(id)
  const built = hasBuild(id)
  const report = readReport(id)
  let distBytes: number | undefined
  if (built) {
    try {
      const outDir = distDir(id)
      distBytes = fs
        .readdirSync(outDir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .reduce((sum, entry) => sum + fs.statSync(path.join(outDir, entry.name)).size, 0)
    } catch {
      distBytes = undefined
    }
  }
  /**
   * Display name: the draft's `workshop.json` title takes priority; when it is absent (e.g. a
   * source package downloaded from the plugin center) use the `plugin.json` `name`; only when
   * both are missing fall back to the id.
   *
   * Previously only `workshop.json` was consulted, so source installed from the plugin center
   * showed up in the sidebar as an id like `personal-ledger` (user report 2026-11-23: "when I
   * install source code, why does it show the id instead of the name").
   *
   * Fixed again on 2026-11-25: early versions writing a file via `patchDraftMeta(id, {})` added a
   * workshop.json with `title: <id>` (see `defaultMeta` in store.ts), so the priority read here
   * picked up exactly the id and the manifest name was never used. **A title equal to the id
   * counts as "no title"**, so it keeps falling back to the manifest name; the plugin workspace
   * name also follows `draftSummary().title` back to the name.
   */
  const manifestName =
    typeof manifest?.name === 'string' && manifest.name.trim() !== '' ? manifest.name.trim() : ''
  const metaTitle = typeof meta?.title === 'string' ? meta.title.trim() : ''
  return {
    id,
    title: metaTitle && metaTitle !== id ? metaTitle : manifestName || id,
    template: (meta?.template ?? 'minimal') as WorkshopTemplate,
    version: typeof manifest?.version === 'string' ? manifest.version : '0.0.0',
    description:
      typeof manifest?.description === 'string' ? manifest.description : meta?.description,
    createdAt: meta?.createdAt ?? 0,
    updatedAt: meta?.updatedAt ?? 0,
    fileCount: files.length,
    built,
    builtAt: meta?.builtAt,
    installed: host ? host.isInstalled(id) : false,
    enabled: host ? host.isEnabled(id) : false,
    pluginsPath: pluginsRootPath() || undefined,
    dir: draftDir(id),
    lastReport: report
      ? {
          at: report.at,
          ok: report.ok,
          failed: report.checks.filter((c) => c.status === 'fail').length,
          total: report.checks.length
        }
      : undefined,
    distBytes
  }
}

/** Draft detail (file tree + manifest + directory) */
export function draftDetail(id: string): WorkshopDraftDetail {
  const summary = draftSummary(id)
  return {
    ...summary,
    files: listDraftFiles(id),
    manifest: readDraftManifest(id),
    css: readDraftMeta(id)?.css ?? 'auto'
  }
}

/** Create a new draft (the host module allowlist is injected into WORKSHOP.md at generation time) */
export function createDraftFromTemplate(opts: CreateDraftOptions): ReturnType<typeof createDraft> {
  const host = workshopHostOrNull()
  if (!hasPluginsRoot()) {
    throw new Error(
      '还没有配置「插件存放路径」：先在 设置 → 助手 → 插件工坊 里选一个文件夹（所有插件都放在它下面）'
    )
  }
  return createDraft({
    ...opts,
    hostMainKeys: host?.hostMainKeys() ?? [],
    hostUiKeys: host?.hostUiKeys() ?? []
  })
}

/** Read a draft file */
export function readFile(id: string, rel: string): string {
  return readDraftFile(id, rel)
}

/** Write a draft file */
export function writeFile(
  id: string,
  rel: string,
  content: string
): ReturnType<typeof writeDraftFile> {
  if (!draftExists(id)) throw new Error(`草稿 '${id}' 不存在（先 plugin_draft create）`)
  return writeDraftFile(id, rel, content)
}

/** Delete a draft file */
export function removeFile(id: string, rel: string): void {
  deleteDraftFile(id, rel)
}

/**
 * Rename a plugin (this changes the **display name**).
 *
 * Two places are changed together: the draft metadata `workshop.json` `title` (shown in the
 * workshop list and sidebar) and the manifest `plugin.json` `name` (shown in the app's plugin
 * management/menu) — changing only one leaves "the sidebar shows the new name while the installed
 * app still shows the old one".
 *
 * **The directory name and id are not touched**: the id is simultaneously the directory name,
 * `plugin.json.id` and the IPC namespace `plugin:<id>:*`, so changing it means a different plugin
 * (that is "create a new one + delete the old one", not a rename). After the rename the build
 * output is older than the source (a rebuild/install is needed for it to take effect), which is
 * the existing `staleBuild` notion.
 */
export function renameDraft(id: string, title: string): WorkshopDraftSummary {
  if (!draftExists(id)) throw new Error(`草稿 '${id}' 不存在`)
  const clean = typeof title === 'string' ? title.trim() : ''
  if (!clean) throw new Error('插件名称不能为空')
  if (clean.length > 60) throw new Error('插件名称最多 60 个字')
  if (clean === readDraftMeta(id)?.title) return draftSummary(id)

  patchDraftMeta(id, { title: clean })
  const manifest = readDraftManifest(id)
  if (manifest && typeof manifest === 'object') {
    // The manifest is generated JSON: rewrite it wholesale (keep 2-space indentation, matching template generation)
    writeDraftFile(id, 'plugin.json', JSON.stringify({ ...manifest, name: clean }, null, 2) + '\n')
  }
  return draftSummary(id)
}

/**
 * Delete a whole draft (including build output and report).
 *
 * Only the single subdirectory `<plugin storage path>/<id>/` plus its build output and report are
 * deleted; **the plugin storage path itself is never touched** (it is the folder the user picked
 * in settings, which may contain other things).
 */
export function removeDraft(id: string): { removedDir: boolean } {
  const result = removeDraftDir(id)
  for (const target of [distDir(id), reportPath(id)]) {
    try {
      fs.rmSync(target, { recursive: true, force: true })
    } catch {
      // Never mind if it does not exist
    }
  }
  return result
}

/**
 * Configure the **plugin storage path** (the folder the user picked in settings).
 *
 * Four things, in a meaningful order: 1) validate the directory (exists, is a directory, and is
 * not inside the workshop's own directory); 2) **migrate plugin sources from the old path to the
 * new one** (changing the storage location moves the data with it, see `storage/migration.ts`;
 * for same-named entries the target copy wins and the old file is saved as `*.migrated-*`);
 * 3) write it into settings (persisted by the host-injected `setPluginsRoot`); 4) move legacy
 * drafts over (early versions kept source under `<userData>/plugin-workshop/drafts/`; after
 * configuration they migrate automatically, so the user does not need to care).
 */
export function adoptPluginsRoot(dir: string): {
  dir: string
  moved: string[]
  /** Plugin root before the location change (so the caller can move old plugin workspace rows under the new root) */
  previousDir?: string
} {
  const host = workshopHost()
  const target = path.resolve(dir)
  const workshop = path.resolve(host.root)
  if (target === workshop || target.startsWith(workshop + path.sep)) {
    throw new Error('插件存放路径不能选在工坊自己的目录里（会话/产物/报告都在那儿）')
  }
  if (!fs.existsSync(target)) {
    fs.mkdirSync(target, { recursive: true })
  }
  if (!fs.statSync(target).isDirectory()) {
    throw new Error(`插件存放路径必须是文件夹：${target}`)
  }

  // Migrate the old path's data first: if migration fails, throw and keep the settings at the old
  // value (there is never a "settings moved but source did not")
  const previous = pluginsRootPath()
  const changed = Boolean(previous) && !isSamePath(previous, target)
  /**
   * Migration renames plugin directories under the old path: if one of them is being watched by a
   * workspace (plugin mode has its source open), Windows fails with EPERM. Drop the watch during
   * migration; the caller then remaps the active workspace path and triggers a workspace-changed,
   * so watching resumes naturally under the new root.
   */
  const release = changed ? releaseWorkshopDir(previous) : null
  let migrated: string[] = []
  try {
    if (changed) migrated = migrateStorageDirectory('plugins', previous, target).moved
  } finally {
    release?.()
  }
  const legacyMoved = migrateLegacyDrafts(target)

  host.setPluginsRoot(target)
  configurePluginsRoot(target)
  return {
    dir: target,
    moved: [...new Set([...migrated, ...legacyMoved])],
    ...(changed ? { previousDir: previous } : {})
  }
}

/**
 * Move drafts from the legacy drafts directory to the new plugin storage path (skip when a
 * same-named subdirectory already exists — never overwrite).
 *
 * Besides `adoptPluginsRoot` it is also called once during startup wiring: `pluginsPath` is now
 * preset automatically from the install directory, so existing users no longer go through a
 * "first manual path selection" step, but historical drafts under
 * `userData/plugin-workshop/drafts/` still need to follow into the new default path.
 */
export function migrateLegacyDrafts(target: string): string[] {
  const legacy = legacyDraftsRoot()
  if (!fs.existsSync(legacy)) return []
  fs.mkdirSync(target, { recursive: true })
  const moved: string[] = []
  for (const entry of fs.readdirSync(legacy, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const from = path.join(legacy, entry.name)
    const to = path.join(target, entry.name)
    if (fs.existsSync(to)) continue
    try {
      fs.renameSync(from, to)
      moved.push(entry.name)
    } catch {
      // Skip when migrating across volumes fails (the user can copy it over; other drafts are unaffected)
    }
  }
  return moved
}

/** Build (does not throw; diagnostics are in the return value) */
export async function build(id: string, opts: BuildDraftOptions = {}): Promise<WorkshopBuildInfo> {
  const result = await buildDraft(id, opts)
  return result.info
}

/** Verify (build + check battery) */
export async function verify(id: string, opts: VerifyOptions = {}): Promise<WorkshopReport> {
  return await verifyDraft(id, opts)
}

/** Latest verification report (null when there is none) */
export function lastReport(id: string): WorkshopReport | null {
  return readReport(id)
}

/**
 * Publish gate: does **the current source** have a passing verification report plus a build
 * output that corresponds to it?
 *
 * Three pieces of evidence must all match the current source; none may be missing:
 * - the verification report is `ok` (all fatal checks passed);
 * - the report's `sourceHash` = current source fingerprint (editing source after verification
 *   requires re-verification — rebuilding alone does not count);
 * - the build output's recorded `sourceHash` = current source fingerprint (editing source after
 *   the build means the output is stale).
 *
 * The reason for using fingerprints instead of mtime is in `fingerprint.ts`: the old approach
 * necessarily judged the build stale after the build wrote back `workshop.json`, which made
 * `plugin_publish install` always refuse to install (2026-11-23 incident).
 */
export function publishGate(id: string): WorkshopPublishGate {
  const report = readReport(id)
  if (!report) {
    return {
      ready: false,
      reason: 'no-report',
      detail:
        `拒绝安装：'${id}' 还没有一次通过的验收。先跑 plugin_verify（构建 + 全部检查，` +
        `含宿主安全的 safety.scan），全绿再安装——没验过的插件装上去大概率是「菜单不出现 / 调用报无处理器」。`
    }
  }
  if (!report.ok) {
    const fatal = report.checks.filter((c) => c.status === 'fail' && c.fatal)
    const problems = fatal
      .map((c) => `${c.id} ${c.title}${c.detail ? `：${c.detail}` : ''}`)
      .join('；')
    return {
      ready: false,
      reason: 'report-failed',
      detail:
        `拒绝安装：最近一次验收没有通过（致命项 ${fatal.length} 项失败` +
        `${problems ? `：${problems}` : ''}）。按报告里的建议改完，重新 plugin_verify。`
    }
  }
  if (!hasBuild(id)) {
    return {
      ready: false,
      reason: 'no-build',
      detail: `拒绝安装：草稿 '${id}' 还没有构建产物。先跑 plugin_build（或直接 plugin_verify，它会重新构建）。`
    }
  }

  let current: string
  try {
    current = currentSourceHash(id)
  } catch (err) {
    return {
      ready: false,
      reason: 'sources-changed',
      detail: `拒绝安装：读不到当前草稿源码（${(err as Error).message}）。先确认插件存放路径与草稿目录还在。`
    }
  }
  // Old (or hand-made) reports have no source fingerprint: they cannot prove they represent the
  // current source, so verify once more
  if (typeof report.sourceHash !== 'string' || report.sourceHash === '') {
    return {
      ready: false,
      reason: 'stale-report',
      detail:
        `拒绝安装：这份验收报告来自旧版本（没有源码指纹，无法确认它验的是当前源码）。` +
        `重新跑一次 plugin_verify 即可——第一次会慢一点，之后同源码的构建/发布都不再重复拦。`
    }
  }
  const built = readDraftMeta(id)?.sourceHash
  if (report.sourceHash !== current) {
    return {
      ready: false,
      reason: 'sources-changed',
      detail:
        `拒绝安装：验收之后源码又改过（报告的指纹与当前源码不一致）。` +
        `重新构建不算——没重新验收的新代码不许装，先 plugin_verify。`
    }
  }
  if (typeof built === 'string' && built !== current) {
    return {
      ready: false,
      reason: 'stale-build',
      detail:
        `拒绝安装：产物比源码旧（构建之后草稿又被改过）。先 plugin_verify` +
        `（它会重新构建并跑完整验收），再 plugin_publish install。`
    }
  }
  return { ready: true, detail: '' }
}

/** Publish (install + enable + post-install renderer re-check; a failed re-check rolls back automatically and throws) */
export async function publish(id: string): Promise<WorkshopPublishResult> {
  return await publishDraft(id)
}

/** Disable (keeps directory and data) */
export function disable(id: string): void {
  disableDraft(id)
}

/** Enable an installed plugin (runs the renderer re-check automatically; on failure it disables the plugin and throws) */
export function enable(id: string): ReturnType<typeof enableDraft> {
  return enableDraft(id)
}

/** Uninstall (delete plugin code, keep data) */
export function unpublish(id: string): void {
  unpublishDraft(id)
}

/** Export zip */
export function exportZip(id: string): ReturnType<typeof exportDraft> {
  return exportDraft(id)
}

/** Whether the draft is stale (build output behind the source) */
export function buildStale(id: string): boolean {
  return isBuildStale(id)
}

/** Draft metadata (the tools show template and css mode) */
export function metaOf(id: string): WorkshopDraftMeta | null {
  return readDraftMeta(id)
}

/** Draft directory (panel's "open directory") */
export function dirOf(id: string): string {
  return draftDir(id)
}

export { listDraftIds }
export type { WorkshopDraftMeta, WorkshopTemplate }
