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

/**
 * 工坊门面：AI 工具（`main/tools/workshop.ts`）与设置页（`main/ipc/workshop.ts`）
 * 都只调这里，不直接碰 build/verify/install 的细节。
 *
 * 这一层负责**把宿主状态拼进草稿视图**（是否已构建、是否已安装、最近验收结论）——
 * 面板与模型都需要「这个草稿现在是什么状态」这一个答案。
 */

export interface WorkshopServiceState {
  /** 工坊接线是否就绪（AI 助手插件装载着） */
  ready: boolean
  /**
   * 是否已配置**插件存放路径**（首次启动已按安装目录预置，用户清空后为 false）。
   * 未配置时草稿列表为空、新建会被拒，界面据此引导用户去选文件夹。
   */
  configured: boolean
  /** 用户配置的插件存放路径（未配置时为空字符串） */
  pluginsPath: string
  /** 工坊内部根目录（会话产物/报告/导出；**不在界面上展示**） */
  root: string
  drafts: number
}

/** 工坊当前状态（面板与工具失败提示） */
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

/** 每条草稿的摘要（含宿主侧的安装/启用/最近验收状态） */
export function listDraftSummaries(): WorkshopDraftSummary[] {
  const host = workshopHostOrNull()
  return listDraftIds().map((id) => summarize(id, host))
}

/** 单条摘要 */
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
   * 展示名：工坊草稿的 `workshop.json` 标题优先；没有（例如从插件中心下载的源码包）
   * 就用 `plugin.json` 的 `name`；两者都没有才退回 id。
   *
   * 之前只看 `workshop.json`，从插件中心安装的源码在侧栏会显示成 `personal-ledger`
   * 这种 id（用户 2026-11-23：「安装源码的内容，显示的为什么是 id，而不是名称」）。
   */
  const manifestName =
    typeof manifest?.name === 'string' && manifest.name.trim() !== '' ? manifest.name.trim() : ''
  return {
    id,
    title: meta?.title ?? (manifestName || id),
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

/** 草稿详情（文件树 + 清单 + 目录） */
export function draftDetail(id: string): WorkshopDraftDetail {
  const summary = draftSummary(id)
  return {
    ...summary,
    files: listDraftFiles(id),
    manifest: readDraftManifest(id),
    css: readDraftMeta(id)?.css ?? 'auto'
  }
}

/** 新建草稿（宿主模块白名单在生成时注入 WORKSHOP.md） */
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

/** 读草稿文件 */
export function readFile(id: string, rel: string): string {
  return readDraftFile(id, rel)
}

/** 写草稿文件 */
export function writeFile(
  id: string,
  rel: string,
  content: string
): ReturnType<typeof writeDraftFile> {
  if (!draftExists(id)) throw new Error(`草稿 '${id}' 不存在（先 plugin_draft create）`)
  return writeDraftFile(id, rel, content)
}

/** 删草稿文件 */
export function removeFile(id: string, rel: string): void {
  deleteDraftFile(id, rel)
}

/**
 * 重命名插件（改的是**展示名**）。
 *
 * 两处一起改：草稿元数据 `workshop.json` 的 `title`（工坊列表与侧栏显示的是它）与清单
 * `plugin.json` 的 `name`（应用里「插件管理」/菜单显示的是它）——只改一处会出现
 * 「侧栏叫新名字、装进应用还是旧名字」。
 *
 * **不动目录名与 id**：id 同时是目录名、`plugin.json.id` 与 IPC 命名空间 `plugin:<id>:*`，
 * 改它等于换一个插件（那是「新建一个 + 删掉旧的」，不是重命名）。
 * 改完产物比源码旧（要进行里生效需重新构建/安装），这是既有的 `staleBuild` 口径。
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
    // 清单是生成出来的 JSON：整体重写（保持 2 空格缩进，与模板生成的一致）
    writeDraftFile(id, 'plugin.json', JSON.stringify({ ...manifest, name: clean }, null, 2) + '\n')
  }
  return draftSummary(id)
}

/**
 * 删整份草稿（含产物与报告）。
 *
 * 只删 `<插件存放路径>/<id>/` 这一个子目录 + 它的产物与报告；
 * **插件存放路径本身永远不动**（那是用户在设置里选的文件夹，里面可能还有别的东西）。
 */
export function removeDraft(id: string): { removedDir: boolean } {
  const result = removeDraftDir(id)
  for (const target of [distDir(id), reportPath(id)]) {
    try {
      fs.rmSync(target, { recursive: true, force: true })
    } catch {
      // 不存在就算了
    }
  }
  return result
}

/**
 * 配置**插件存放路径**（用户在设置里选的文件夹）。
 *
 * 四件事，顺序有意义：① 校验目录（存在、是目录、不在工坊内部目录里）；
 * ② **把旧路径里的插件源码迁到新路径**（用户主动改存储地址 = 数据跟着走，
 * 见 `storage/migration.ts`；同名文件保留目标那份、旧文件另存 `*.migrated-*`）；
 * ③ 落进设置（由宿主注入的 `setPluginsRoot` 持久化）；④ 把旧版草稿搬过来
 * （早期版本把源码放在 `<userData>/plugin-workshop/drafts/`，配置之后自然迁移，用户不用管）。
 */
export function adoptPluginsRoot(dir: string): {
  dir: string
  moved: string[]
  /** 改地址前的插件根（供调用方把旧插件工作区行改到新根下） */
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

  // 先迁移旧路径的数据：迁移失败就抛错，设置保持旧值（不会出现「设置换了、源码没搬」）
  const previous = pluginsRootPath()
  const changed = Boolean(previous) && !isSamePath(previous, target)
  const migrated = changed ? migrateStorageDirectory('plugins', previous, target).moved : []
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
 * 旧版草稿目录里的草稿搬到新的插件存放路径（同名子目录已存在就跳过，绝不覆盖）。
 *
 * 除了 `adoptPluginsRoot`，启动装配时也会调一次：现在 `pluginsPath` 由安装目录自动预置，
 * 老用户不会再经过「第一次手动选路径」这一步，但 `userData/plugin-workshop/drafts/`
 * 里的历史草稿仍要跟着进新默认路径。
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
      // 跨盘搬迁失败就跳过（用户自己拷过去即可，不影响其余草稿）
    }
  }
  return moved
}

/** 构建（不抛错：诊断在返回值里） */
export async function build(id: string, opts: BuildDraftOptions = {}): Promise<WorkshopBuildInfo> {
  const result = await buildDraft(id, opts)
  return result.info
}

/** 验收（构建 + 检查电池） */
export async function verify(id: string, opts: VerifyOptions = {}): Promise<WorkshopReport> {
  return await verifyDraft(id, opts)
}

/** 最近一次验收报告（没有则 null） */
export function lastReport(id: string): WorkshopReport | null {
  return readReport(id)
}

/**
 * 发布闸门：**当前源码**是否有一份通过的验收报告 + 一份与之对应的产物。
 *
 * 三份证据必须同时对上当前源码，缺一不可：
 * - 验收报告 `ok`（致命项全过）；
 * - 报告里的 `sourceHash` = 当前源码指纹（验收后改过源码就得重验——只重新构建不算）；
 * - 产物记录的 `sourceHash` = 当前源码指纹（构建之后改过源码，产物就是旧的）。
 *
 * 用指纹而不是 mtime 的原因见 `fingerprint.ts`：旧口径在构建回写 `workshop.json`
 * 之后必然判「过期」，导致 `plugin_publish install` 永远拒绝安装（2026-11-23 事故）。
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
  // 旧版本（或手工造的）报告没有源码指纹：无法证明它代表当前源码，宁可多验一次
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

/** 发布（安装 + 启用 + 安装后渲染层复验；复验失败会自动回滚并抛错） */
export async function publish(id: string): Promise<WorkshopPublishResult> {
  return await publishDraft(id)
}

/** 停用（保留目录与数据） */
export function disable(id: string): void {
  disableDraft(id)
}

/** 启用一个已装好的插件（启用后自动做渲染层复验；失败会自动停用并抛错） */
export function enable(id: string): ReturnType<typeof enableDraft> {
  return enableDraft(id)
}

/** 卸载（删插件代码，数据保留） */
export function unpublish(id: string): void {
  unpublishDraft(id)
}

/** 导出 zip */
export function exportZip(id: string): ReturnType<typeof exportDraft> {
  return exportDraft(id)
}

/** 草稿是否已过期（产物落后于源码） */
export function buildStale(id: string): boolean {
  return isBuildStale(id)
}

/** 草稿元数据（工具里显示模板与 css 模式） */
export function metaOf(id: string): WorkshopDraftMeta | null {
  return readDraftMeta(id)
}

/** 草稿目录（面板「打开目录」） */
export function dirOf(id: string): string {
  return draftDir(id)
}

export { listDraftIds }
export type { WorkshopDraftMeta, WorkshopTemplate }
