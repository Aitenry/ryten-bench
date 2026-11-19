import * as fs from 'fs'
import * as path from 'path'
import type {
  WorkshopBuildInfo,
  WorkshopDraftDetail,
  WorkshopDraftMeta,
  WorkshopDraftSummary,
  WorkshopPublishResult,
  WorkshopReport,
  WorkshopTemplate
} from '../../shared/workshop'
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
import { hasBuild, isBuildStale, workshopHost, workshopHostOrNull, type WorkshopHost } from './host'
import { publishDraft, disableDraft, unpublishDraft, exportDraft } from './install'
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
   * 是否已配置**插件存放路径**（用户设置；没有默认值）。
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
  return {
    id,
    title: meta?.title ?? id,
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
  if (host?.isBundledPlugin(opts.id)) {
    throw new Error(`'${opts.id}' 是随应用分发的内置插件 id，换一个名字（例如 'my-${opts.id}'）`)
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
 * 三件事，顺序有意义：① 校验目录（存在、是目录、不在工坊内部目录里）；
 * ② 落进设置（由宿主注入的 `setPluginsRoot` 持久化）；③ 把旧版草稿搬过来
 * （早期版本把源码放在 `<userData>/plugin-workshop/drafts/`，配置之后自然迁移，用户不用管）。
 */
export function adoptPluginsRoot(dir: string): { dir: string; moved: string[] } {
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

  const moved = migrateLegacyDrafts(target)
  host.setPluginsRoot(target)
  configurePluginsRoot(target)
  return { dir: target, moved }
}

/** 旧版草稿目录里的草稿搬到新的插件存放路径（同名子目录已存在就跳过，绝不覆盖） */
function migrateLegacyDrafts(target: string): string[] {
  const legacy = legacyDraftsRoot()
  if (!fs.existsSync(legacy)) return []
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

/** 发布（安装 + 启用 + 安装后渲染层复验；复验失败会自动回滚并抛错） */
export async function publish(id: string): Promise<WorkshopPublishResult> {
  return await publishDraft(id)
}

/** 停用（保留目录与数据） */
export function disable(id: string): void {
  disableDraft(id)
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
