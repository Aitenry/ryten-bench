import * as fs from 'fs'
import * as path from 'path'
import { BrowserWindow } from 'electron'
import { eq, inArray } from 'drizzle-orm'
import logger from 'electron-log'
import { safeSend } from '../../../../main/safe-send'
import { withOrm } from '../../../../main/database/orm'
import { file_change } from '../../../../main/database/schema'
import {
  getFileChange,
  insertFileChange,
  listFileChanges,
  listPendingChanges,
  markChangesStatus,
  obsoleteChangesAfter,
  type FileChangeRow
} from '../db/mapper/file-change'
import { changeStats, looksBinary } from './line-diff'

/**
 * 文件改动史（「模型改了什么、能不能回溯」的唯一入口）。
 *
 * 为什么要有它：模型对工作区的每一次落盘在此之前都是**不可见的**——磁盘内容变了，
 * 编辑器里的页签还是旧的，用户既看不到 diff，也没法把某次改动退回去。
 *
 * 三条硬约束（来自用户原话「每一次修改的内容都要有 diff，可追溯、可回溯」）：
 * 1. **可追溯**：每次改动落一行 DB（谁改的、哪个工具、哪个会话、什么时候、+N −M），
 *    正文快照另存磁盘，库里只留元信息与统计；
 * 2. **可回溯**：撤销 = 把改动前的快照写回磁盘；撤销某次改动会一并作废它之后的改动
 *    （「回到那次改动之前」的语义，不做三方合并）；
 * 3. **不打扰**：内容没变不记录；二进制/超大文件只记元信息（`has_before=false`），
 *    界面上如实显示「无法回溯」，不假装能撤销。
 *
 * 快照落在 userData 而不是工作区：工作区挂载为虚拟 '/'，写进去会污染用户项目，
 * 也会出现在模型自己的 ls/glob 结果里（与 tool-output-store 同一考虑）。
 */

/** 单侧快照的字符上限：超过就只记元信息 */
const MAX_SNAPSHOT_CHARS = 1_200_000
/** 快照文件总数上限（超出按修改时间淘汰最旧的，并把对应行的 has_* 置 0） */
const MAX_SNAPSHOT_FILES = 3000
/** 判定「这次磁盘变化是刚记过的工具写入」的时间窗（毫秒） */
const RECENT_WRITE_WINDOW_MS = 4000

/**
 * 主进程 → 渲染层的事件通道（只有发送方，没有 ipcMain 处理器）。
 *
 * 通道名一律 `plugin:harness:<原扁平名>`：本文件随 harness 插件迁到
 * `src/plugins/harness/main/workspace/`（改动审查属「AI 助手」），事件通道必须在插件的
 * install 里 `ctx.registerEvent` 声明才会进 preload 白名单（见 main/index.ts）。
 */
export const WORKSPACE_CHANGE_RECORDED = 'plugin:harness:workspace-change-recorded'
export const WORKSPACE_CHANGES_UPDATED = 'plugin:harness:workspace-changes-updated'
/** 本文件声明的事件通道清单（install 里交给 ctx.registerEvent） */
export const WORKSPACE_FILE_HISTORY_EVENT_CHANNELS: string[] = [
  WORKSPACE_CHANGE_RECORDED,
  WORKSPACE_CHANGES_UPDATED
]

let historyRoot = ''

/** 配置快照根目录（插件 install 时调用；传空串 = 停用快照，全部功能降级为「无快照」） */
export function configureFileHistory(dir: string): void {
  historyRoot = dir
}

/** 渲染进程消费的改动视图（preload 直接复用这个类型） */
export interface FileChangeView {
  id: number
  /** 绝对路径（页签键、资源管理器高亮都用它） */
  path: string
  /** 工作区相对路径（展示 + 归属判断） */
  relPath: string
  kind: FileChangeRow['kind']
  source: FileChangeRow['source']
  status: FileChangeRow['status']
  topicId: number | null
  callId: string | null
  added: number
  removed: number
  beforeBytes: number
  afterBytes: number
  hasBefore: boolean
  hasAfter: boolean
  /**
   * 这次改动**有没有可比对的正文**（差异视图能不能画出东西）。
   *
   * 用户 2026-09-23 报的「有些文件明明没有改变，页面却显示改变，打开之后没有任何 diff」
   * 就是这一类：命令执行期间被文件监听捕获的记录**没有前置快照**（`has_before=false`），
   * 于是它在资源管理器里带着待审查徽标，点开却只有一句「无法回溯」——看起来就是
   * 「说改了、却没有任何差异」。这种记录降级为**只记账、不进待审查入口**。
   */
  reviewable: boolean
  createdAt: string | null
  reviewedAt: string | null
}

/** 改动前后正文（不存在的一侧为 null：新增前的文件、删除后的文件） */
export interface FileChangeContent {
  before: string | null
  after: string | null
}

/** 记录一次改动的入参 */
export interface RecordFileChangeInput {
  workspaceId: number
  /** 工作区根目录（用于算相对路径） */
  workspaceRoot: string
  /** 文件绝对路径 */
  realPath: string
  /** 改动前正文；null 表示改动前该文件不存在 */
  before: string | null
  /** 改动后正文；null 表示改动后该文件不存在（被删除） */
  after: string | null
  /**
   * 改动类型。缺省按前后是否存在推断；
   * 文件监听捕获的变化拿不到前置快照，必须显式给 kind，否则「修改」会被误判成「新建」。
   */
  kind?: FileChangeRow['kind']
  source: FileChangeRow['source']
  /** 初始审查状态；缺省 pending（模型的改动默认等用户审查） */
  status?: FileChangeRow['status']
  topicId?: number | null
  callId?: string | null
  note?: string | null
  /**
   * 已经算好的差异规模（可选）。
   *
   * 工具写入路径（fs-backend）手上正好有改动前后正文，并且**卡片也要用同一份数字**，
   * 于是它算一次后传进来，这里不再重算；不传的调用方（文件监听、审查落盘）按
   * `changeStats` 现算，口径完全一致。
   */
  stats?: { added: number; removed: number }
}

/** 最近由工具写入过的文件（路径 → 时间戳），供文件监听去重，避免同一次写入记两遍 */
const recentlyWritten = new Map<string, number>()

/** 标记「这个路径刚被工具写过」（recordFileChange 内部自动调用） */
export function markPathWritten(realPath: string): void {
  recentlyWritten.set(realPath, Date.now())
  if (recentlyWritten.size > 500) {
    const cutoff = Date.now() - RECENT_WRITE_WINDOW_MS
    for (const [key, ts] of recentlyWritten) {
      if (ts < cutoff) recentlyWritten.delete(key)
    }
  }
}

/** 该路径是否刚被工具写过（文件监听据此跳过，避免重复记录 / 重复刷新） */
export function isRecentlyWritten(realPath: string): boolean {
  const ts = recentlyWritten.get(realPath)
  if (ts === undefined) return false
  if (Date.now() - ts > RECENT_WRITE_WINDOW_MS) {
    recentlyWritten.delete(realPath)
    return false
  }
  return true
}

/**
 * 这次改动能不能在差异视图里画出东西（= 值不值得进「待审查」）。
 *
 * 判定口径（宁可少提示，也不要提示一个点开什么都没有的徽标）：
 * - 有改动前快照 → 能画（write_file / edit_file / review 的常规情形）；
 * - 没有改动前快照，但**是新建**（before 本来就不存在）→ 能画（整份内容都是新增）；
 * - 删除 → 有 after 也能画；
 * - 其余（命令执行期间被监听捕获、快照被清理、二进制/超大文件没存快照）→ **不能画**：
 *   这类记录仍然入库可追溯，但不再污染待审查入口，也不再让资源管理器显示虚假徽标。
 */
function isReviewable(row: FileChangeRow): boolean {
  if (row.has_before === 1 && row.has_after === 1) return true
  if (row.kind === 'create' && row.has_after === 1) return true
  if (row.kind === 'delete' && row.has_before === 1) return true
  return false
}

/** row → 视图 */
export function toFileChangeView(row: FileChangeRow): FileChangeView {
  return {
    id: row.id,
    path: row.path,
    relPath: row.rel_path,
    kind: row.kind,
    source: row.source,
    status: row.status,
    topicId: row.topic_id ?? null,
    callId: row.call_id ?? null,
    added: row.added,
    removed: row.removed,
    beforeBytes: row.before_bytes,
    afterBytes: row.after_bytes,
    hasBefore: row.has_before === 1,
    hasAfter: row.has_after === 1,
    reviewable: isReviewable(row),
    createdAt: row.created_at ?? null,
    reviewedAt: row.reviewed_at ?? null
  }
}

/** 广播给所有窗口（渲染进程据此刷新页签内容、差异视图与资源管理器徽标） */
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) safeSend(win.webContents, channel, payload)
  }
}

function snapshotFile(id: number): string {
  return path.join(historyRoot, `${id}.json`)
}

/** 写快照；返回是否真的写成功（未配置目录 / 写失败都算没写） */
async function writeSnapshot(id: number, content: FileChangeContent): Promise<boolean> {
  if (!historyRoot) return false
  try {
    await fs.promises.mkdir(historyRoot, { recursive: true })
    await fs.promises.writeFile(snapshotFile(id), JSON.stringify(content), 'utf-8')
    return true
  } catch (err) {
    logger.warn('[FileHistory] 快照写入失败:', err)
    return false
  }
}

/** 快照总量控制：超出上限时按修改时间淘汰最旧的，并把对应行标记为「快照已清理」 */
async function pruneSnapshots(): Promise<void> {
  if (!historyRoot) return
  try {
    const names = await fs.promises.readdir(historyRoot)
    const jsonNames = names.filter((n) => n.endsWith('.json'))
    if (jsonNames.length <= MAX_SNAPSHOT_FILES) return
    const stats = await Promise.all(
      jsonNames.map(async (name) => {
        const full = path.join(historyRoot, name)
        const st = await fs.promises.stat(full).catch(() => null)
        return { name, full, mtime: st?.mtimeMs ?? 0 }
      })
    )
    stats.sort((a, b) => a.mtime - b.mtime)
    const drop = stats.slice(0, stats.length - MAX_SNAPSHOT_FILES)
    const droppedIds: number[] = []
    for (const item of drop) {
      const id = Number(item.name.replace(/\.json$/, ''))
      await fs.promises.unlink(item.full).catch(() => undefined)
      if (Number.isFinite(id)) droppedIds.push(id)
    }
    if (droppedIds.length > 0) {
      logger.info(`[FileHistory] 清理过期快照 ${droppedIds.length} 份`)
      await clearSnapshotFlags(droppedIds)
    }
  } catch (err) {
    logger.warn('[FileHistory] 快照清理失败:', err)
  }
}

/** 把快照已被清理的改动记录标记为「没有可回溯快照」 */
async function clearSnapshotFlags(ids: number[]): Promise<void> {
  if (ids.length === 0) return
  try {
    await withOrm('clearSnapshotFlags', async (db) => {
      await db
        .update(file_change)
        .set({ has_before: 0, has_after: 0 })
        .where(inArray(file_change.id, ids))
    })
  } catch (err) {
    logger.warn('[FileHistory] 快照标记清理失败:', err)
  }
}

/** 相对工作区根的 POSIX 风格路径 */
function toRelPath(workspaceRoot: string, realPath: string): string {
  const rel = path.relative(workspaceRoot, realPath)
  return rel.split(path.sep).join('/')
}

/**
 * 记录一次文件改动。
 *
 * - 内容未变（before === after）直接返回 null，不产生噪音记录；
 * - 二进制 / 超大文件只记元信息（has_before / has_after 置 false）；
 * - 记录成功后向渲染进程广播 `workspace-change-recorded`。
 */
export async function recordFileChange(
  input: RecordFileChangeInput
): Promise<FileChangeView | null> {
  const { before, after } = input
  if (before !== null && after !== null && before === after) return null

  const kind: FileChangeRow['kind'] =
    input.kind ??
    (before === null && after !== null ? 'create' : after === null ? 'delete' : 'modify')

  const beforeText = before ?? ''
  const afterText = after ?? ''
  const beforeBytes = Buffer.byteLength(beforeText, 'utf-8')
  const afterBytes = Buffer.byteLength(afterText, 'utf-8')
  // 口径唯一：新建/删除/修改三种语义都在 changeStats 里（调用方已算过就直接用）
  const stats = input.stats ?? changeStats(before, after)

  const snapshotable = (text: string | null): boolean =>
    text !== null && text.length <= MAX_SNAPSHOT_CHARS && !looksBinary(text)

  const wantBefore = kind !== 'create' && snapshotable(before)
  const wantAfter = kind !== 'delete' && snapshotable(after)

  let row: FileChangeRow
  try {
    row = await insertFileChange({
      workspace_id: input.workspaceId,
      path: input.realPath,
      rel_path: toRelPath(input.workspaceRoot, input.realPath),
      kind,
      source: input.source,
      status: input.status ?? 'pending',
      topic_id: input.topicId ?? null,
      call_id: input.callId ?? null,
      has_before: false,
      has_after: false,
      added: stats.added,
      removed: stats.removed,
      before_bytes: beforeBytes,
      after_bytes: afterBytes,
      note: input.note ?? null
    })
  } catch (err) {
    logger.error('[FileHistory] 改动记录写入失败:', err)
    return null
  }

  markPathWritten(input.realPath)

  const wrote = await writeSnapshot(row.id, {
    before: wantBefore ? before : null,
    after: wantAfter ? after : null
  })
  let view = toFileChangeView(row)
  if (wrote) {
    try {
      await withOrm('markFileChangeSnapshot', async (db) => {
        await db
          .update(file_change)
          .set({ has_before: wantBefore ? 1 : 0, has_after: wantAfter ? 1 : 0 })
          .where(eq(file_change.id, row.id))
      })
      view = { ...view, hasBefore: wantBefore, hasAfter: wantAfter }
    } catch (err) {
      logger.warn('[FileHistory] 快照标记写入失败:', err)
    }
  }

  void pruneSnapshots()
  broadcast(WORKSPACE_CHANGE_RECORDED, view)
  return view
}

/**
 * 某工作区待审查的改动（正序：最早的在最前，整文件回滚以它为准）。
 *
 * **只返回能画出差异的**（见 isReviewable）：命令执行期间被监听捕获、或快照缺失的记录
 * 仍然躺在库里可追溯，但不进这个列表——否则用户会看到「说改了、点开没有 diff」。
 */
export async function listWorkspacePendingChanges(workspaceId: number): Promise<FileChangeView[]> {
  const rows = await listPendingChanges(workspaceId)
  return rows.map(toFileChangeView).filter((view) => view.reviewable)
}

/** 单个文件的改动历史（倒序） */
export async function listFileChangeHistory(
  filePath: string,
  limit = 60
): Promise<FileChangeView[]> {
  const rows = await listFileChanges(filePath, limit)
  return rows.map(toFileChangeView)
}

/** 读取某次改动的前后正文（供差异视图） */
export async function readFileChangeContent(id: number): Promise<FileChangeContent | null> {
  const row = await getFileChange(id)
  if (!row) return null
  try {
    const raw = await fs.promises.readFile(snapshotFile(id), 'utf-8')
    const parsed = JSON.parse(raw) as FileChangeContent
    return { before: parsed.before ?? null, after: parsed.after ?? null }
  } catch {
    return { before: null, after: null }
  }
}

/** 审查：保留（不改磁盘，只把待审查标记清掉） */
export async function keepFileChanges(ids: number[]): Promise<number> {
  const count = await markChangesStatus(ids, 'kept')
  if (count > 0) broadcast(WORKSPACE_CHANGES_UPDATED, { ids, status: 'kept' })
  return count
}

/**
 * 审查：撤销某次改动（回到它之前的内容）。
 *
 * - 该次之后的同文件待审查改动一并失效（`obsolete`）；
 * - `create` 类改动撤销 = 删除文件；其余 = 把 before 写回磁盘；
 * - 返回撤销后的文件内容（null = 文件已不存在），渲染进程据此刷新页签。
 */
export async function revertFileChange(
  id: number
): Promise<{ path: string; content: string | null } | { error: string }> {
  const row = await getFileChange(id)
  if (!row) return { error: 'not-found' }
  const content = await readFileChangeContent(id)
  if (!content || (row.kind !== 'create' && content.before === null)) {
    return { error: 'no-snapshot' }
  }

  try {
    if (row.kind === 'create') {
      await fs.promises.rm(row.path, { force: true })
      markPathWritten(row.path)
    } else {
      await fs.promises.mkdir(path.dirname(row.path), { recursive: true })
      await fs.promises.writeFile(row.path, content.before ?? '', 'utf-8')
      markPathWritten(row.path)
    }
  } catch (err) {
    logger.error('[FileHistory] 撤销失败:', err)
    return { error: (err as Error).message }
  }

  await markChangesStatus([id], 'reverted')
  const obsolete = await obsoleteChangesAfter(row.path, id)
  broadcast(WORKSPACE_CHANGES_UPDATED, {
    ids: [id],
    status: 'reverted',
    path: row.path,
    obsolete
  })
  logger.info(`[FileHistory] 撤销改动 #${id}（${row.rel_path}），作废后续 ${obsolete} 条`)
  return { path: row.path, content: row.kind === 'create' ? null : (content.before ?? '') }
}

/** 记录一次「审查结果落盘」（用户在差异视图里取舍后保存，本身也是一次模型相关的改动） */
export async function recordReviewWrite(input: {
  workspaceId: number
  workspaceRoot: string
  realPath: string
  before: string | null
  after: string | null
  topicId?: number | null
  callId?: string | null
}): Promise<void> {
  await recordFileChange({ ...input, source: 'review' })
}
