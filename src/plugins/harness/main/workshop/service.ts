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
import { distDir, draftDir, draftRootOf, isWorkshopReady, reportPath, setDraftRoot } from './paths'
import { attachWorkingDir, detachWorkingDir, type WorkingDirResult } from './working-dir'
import {
  deleteDraft as removeDraftDir,
  deleteDraftFile,
  draftExists,
  listDraftFiles,
  listDraftIds,
  readDraftFile,
  readDraftManifest,
  readDraftMeta,
  writeDraftFile
} from './store'
import { hasBuild, isBuildStale, workshopHostOrNull, type WorkshopHost } from './host'
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
  ready: boolean
  root: string
  drafts: number
}

/** 工坊当前状态（面板标题栏与工具失败提示） */
export function workshopState(): WorkshopServiceState {
  const host = workshopHostOrNull()
  return {
    ready: isWorkshopReady(),
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
    workingDir: draftRootOf(id) ?? undefined,
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
    dir: draftDir(id),
    css: readDraftMeta(id)?.css ?? 'auto'
  }
}

/** 新建草稿（宿主模块白名单在生成时注入 WORKSHOP.md） */
export function createDraftFromTemplate(opts: CreateDraftOptions): ReturnType<typeof createDraft> {
  const host = workshopHostOrNull()
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
 * 删整份草稿（含产物与报告）。
 *
 * 草稿被指到用户自己的工作目录时**只解除登记**，不动那个目录里的任何文件
 * （可能有 .git / README / 用户自己的改动）——返回值里如实报出没动过的目录。
 */
export function removeDraft(id: string): { removedDir: boolean; externalDir?: string } {
  const result = removeDraftDir(id)
  setDraftRoot(id, null)
  for (const target of [distDir(id), reportPath(id)]) {
    try {
      fs.rmSync(target, { recursive: true, force: true })
    } catch {
      // 不存在就算了
    }
  }
  return result
}

/** 给草稿指定工作目录（源码落到用户自己的目录里；空目录会被搬过去） */
export function setWorkingDir(id: string, dir: string): WorkingDirResult {
  if (!draftExists(id)) throw new Error(`草稿 '${id}' 不存在（先 plugin_draft create）`)
  return attachWorkingDir(id, dir)
}

/** 把源码搬回工坊的默认目录（不想再用自定义目录时） */
export function resetWorkingDir(id: string): WorkingDirResult {
  if (!draftExists(id)) throw new Error(`草稿 '${id}' 不存在`)
  return detachWorkingDir(id)
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
