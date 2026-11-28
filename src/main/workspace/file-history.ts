import * as fs from 'fs'
import * as path from 'path'
import { BrowserWindow } from 'electron'
import { eq, inArray } from 'drizzle-orm'
import logger from 'electron-log'
import { safeSend } from '../safe-send'
import { withOrm } from '../database/orm'
import { file_change } from '../database/schema'
import {
  getFileChange,
  insertFileChange,
  listFileChanges,
  listPendingChanges,
  markChangesStatus,
  obsoleteChangesAfter,
  type FileChangeRow
} from '../database/mapper/harness/file-change'
import { changeStats, looksBinary } from './line-diff'

/**
 * File change history (the single entry point for "what did the model change, can it be
 * traced and rolled back").
 *
 * Why it exists: before this, every write the model made to the workspace was **invisible** —
 * the disk content changed, the editor tab still showed the old text, and the user could see
 * neither a diff nor a way to revert a change.
 *
 * Three hard constraints (from the user's own words: "every change must have a diff, it must
 * be traceable and revertible"):
 * 1. **Traceable**: every change writes one DB row (who, which tool, which session, when,
 *    +N −M); the text snapshots are stored on disk and only metadata and stats stay in the DB;
 * 2. **Revertible**: undo = write the pre-change snapshot back to disk; reverting a change
 *    also invalidates the changes after it (semantics of "go back to before that change",
 *    no three-way merge);
 * 3. **Unobtrusive**: no record when the content is unchanged; binary/oversized files record
 *    metadata only (`has_before=false`) and the UI honestly shows "cannot revert" instead of
 *    pretending.
 *
 * Snapshots live in userData rather than the workspace: the workspace is mounted as a virtual
 * '/', writing there would pollute the user's project and would also show up in the model's own
 * ls/glob results (the same consideration as tool-output-store).
 */

/** Per-side snapshot character limit: beyond this only metadata is recorded */
const MAX_SNAPSHOT_CHARS = 1_200_000
/** Total snapshot file limit (oldest by mtime are evicted, and their rows get has_* set to 0) */
const MAX_SNAPSHOT_FILES = 3000
/** Time window (ms) for deciding "this disk change is a tool write just recorded" */
const RECENT_WRITE_WINDOW_MS = 4000

/**
 * Main process → renderer event channels (send-only, no ipcMain handlers).
 *
 * Channel names are always `harness:<original flat name>` (change review belongs to the "AI
 * assistant"); the renderer subscribes through the preload system bridge, so no whitelist
 * registration is needed.
 */
export const WORKSPACE_CHANGE_RECORDED = 'harness:workspace-change-recorded'
export const WORKSPACE_CHANGES_UPDATED = 'harness:workspace-changes-updated'

let historyRoot = ''

/** Configure the snapshot root directory (called on plugin install; empty string = snapshots disabled, all features fall back to "no snapshot") */
export function configureFileHistory(dir: string): void {
  historyRoot = dir
}

/** Change view consumed by the renderer (preload reuses this type directly) */
export interface FileChangeView {
  id: number
  /** Absolute path (used as the tab key and for explorer highlighting) */
  path: string
  /** Workspace-relative path (for display + ownership checks) */
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
   * Whether this change has **comparable content** (i.e. the diff view can render something).
   *
   * This is the class of bug the user reported on 2026-09-23: "some files clearly did not
   * change, yet the page says they changed and opening them shows no diff" — records captured
   * by the file watcher during command execution have **no preceding snapshot**
   * (`has_before=false`), so they carry a pending-review badge in the explorer but open to
   * just "cannot revert" — appearing to say "it changed" while showing no diff. Such records
   * are downgraded to **bookkeeping only, excluded from the review queue**.
   */
  reviewable: boolean
  createdAt: string | null
  reviewedAt: string | null
}

/** Content before and after a change (the missing side is null: file before creation, file after deletion) */
export interface FileChangeContent {
  before: string | null
  after: string | null
}

/** Input for recording one change */
export interface RecordFileChangeInput {
  workspaceId: number
  /** Workspace root directory (used to compute the relative path) */
  workspaceRoot: string
  /** Absolute file path */
  realPath: string
  /** Content before the change; null means the file did not exist before */
  before: string | null
  /** Content after the change; null means the file no longer exists (deleted) */
  after: string | null
  /**
   * Change kind. Inferred from existence before/after when omitted; changes captured by the
   * file watcher have no preceding snapshot and must pass kind explicitly, otherwise a
   * "modify" would be misjudged as a "create".
   */
  kind?: FileChangeRow['kind']
  source: FileChangeRow['source']
  /** Initial review status; defaults to pending (model changes wait for user review by default) */
  status?: FileChangeRow['status']
  topicId?: number | null
  callId?: string | null
  note?: string | null
  /**
   * Precomputed diff size (optional).
   *
   * The tool write path (fs-backend) already has the before/after content in hand, and **the
   * card needs the same numbers**, so it computes once and passes them in and they are not
   * recomputed here; callers that do not pass them (file watcher, review save) compute via
   * `changeStats`, with exactly the same definition.
   */
  stats?: { added: number; removed: number }
}

/** Recently tool-written files (path → timestamp); lets the file watcher dedupe so one write is not recorded twice */
const recentlyWritten = new Map<string, number>()

/** Mark "this path was just written by a tool" (called automatically inside recordFileChange) */
export function markPathWritten(realPath: string): void {
  recentlyWritten.set(realPath, Date.now())
  if (recentlyWritten.size > 500) {
    const cutoff = Date.now() - RECENT_WRITE_WINDOW_MS
    for (const [key, ts] of recentlyWritten) {
      if (ts < cutoff) recentlyWritten.delete(key)
    }
  }
}

/** Whether this path was just written by a tool (the file watcher skips it to avoid duplicate records / refreshes) */
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
 * Whether this change can render something in the diff view (= whether it deserves the
 * "pending review" queue).
 *
 * Criterion (prefer fewer prompts over a badge that opens to nothing):
 * - Has a before snapshot → renderable (the normal write_file / edit_file / review case);
 * - No before snapshot but the file **was created** (before never existed) → renderable
 *   (the whole content is an addition);
 * - Deletion → renderable when there is after content;
 * - Everything else (captured by the watcher during command execution, snapshot pruned,
 *   binary/oversized file had no snapshot) → **not renderable**: such records are still
 *   stored for traceability, but no longer pollute the review queue or show a fake badge in
 *   the explorer.
 */
function isReviewable(row: FileChangeRow): boolean {
  if (row.has_before === 1 && row.has_after === 1) return true
  if (row.kind === 'create' && row.has_after === 1) return true
  if (row.kind === 'delete' && row.has_before === 1) return true
  return false
}

/** row → view */
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

/** Broadcast to all windows (renderers refresh tab content, diff views and explorer badges from it) */
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) safeSend(win.webContents, channel, payload)
  }
}

function snapshotFile(id: number): string {
  return path.join(historyRoot, `${id}.json`)
}

/** Write a snapshot; returns whether it actually succeeded (unconfigured directory / write failure both count as not written) */
async function writeSnapshot(id: number, content: FileChangeContent): Promise<boolean> {
  if (!historyRoot) return false
  try {
    await fs.promises.mkdir(historyRoot, { recursive: true })
    await fs.promises.writeFile(snapshotFile(id), JSON.stringify(content), 'utf-8')
    return true
  } catch (err) {
    logger.warn('[FileHistory] Failed to write snapshot:', err)
    return false
  }
}

/** Snapshot total size control: beyond the limit, evict the oldest by mtime and mark their rows as "snapshot pruned" */
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
      logger.info(`[FileHistory] Pruned ${droppedIds.length} expired snapshot(s)`)
      await clearSnapshotFlags(droppedIds)
    }
  } catch (err) {
    logger.warn('[FileHistory] Failed to prune snapshots:', err)
  }
}

/** Mark change records whose snapshots were pruned as "no revertible snapshot" */
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
    logger.warn('[FileHistory] Failed to clear snapshot flags:', err)
  }
}

/** POSIX-style path relative to the workspace root */
function toRelPath(workspaceRoot: string, realPath: string): string {
  const rel = path.relative(workspaceRoot, realPath)
  return rel.split(path.sep).join('/')
}

/**
 * Record one file change.
 *
 * - Unchanged content (before === after) returns null immediately, producing no noise record;
 * - Binary / oversized files record metadata only (has_before / has_after set to false);
 * - On success, broadcast `workspace-change-recorded` to the renderer.
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
  // Single source of truth: create/delete/modify semantics all live in changeStats (reuse it when the caller already computed)
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
    logger.error('[FileHistory] Failed to write change record:', err)
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
      logger.warn('[FileHistory] Failed to write snapshot flags:', err)
    }
  }

  void pruneSnapshots()
  broadcast(WORKSPACE_CHANGE_RECORDED, view)
  return view
}

/**
 * Pending-review changes of one workspace (ascending: earliest first, which is the reference
 * for whole-file rollback).
 *
 * **Only changes that can render a diff are returned** (see isReviewable): records captured by
 * the watcher during command execution or missing snapshots are still stored for traceability
 * but are excluded from this list — otherwise the user would see "it says changed, but opening
 * it shows no diff".
 */
export async function listWorkspacePendingChanges(workspaceId: number): Promise<FileChangeView[]> {
  const rows = await listPendingChanges(workspaceId)
  return rows.map(toFileChangeView).filter((view) => view.reviewable)
}

/** Change history of a single file (newest first) */
export async function listFileChangeHistory(
  filePath: string,
  limit = 60
): Promise<FileChangeView[]> {
  const rows = await listFileChanges(filePath, limit)
  return rows.map(toFileChangeView)
}

/** Read the before/after content of one change (for the diff view) */
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

/** Review: keep (no disk change, only clear the pending-review flag) */
export async function keepFileChanges(ids: number[]): Promise<number> {
  const count = await markChangesStatus(ids, 'kept')
  if (count > 0) broadcast(WORKSPACE_CHANGES_UPDATED, { ids, status: 'kept' })
  return count
}

/**
 * Review: revert one change (back to the content before it).
 *
 * - Later pending-review changes to the same file are invalidated too (`obsolete`);
 * - Reverting a `create` change = delete the file; otherwise = write `before` back to disk;
 * - Returns the file content after reverting (null = the file no longer exists), which the
 *   renderer uses to refresh the tab.
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
    logger.error('[FileHistory] Failed to revert:', err)
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
  logger.info(`[FileHistory] Reverted change #${id} (${row.rel_path}), invalidated ${obsolete} later change(s)`)
  return { path: row.path, content: row.kind === 'create' ? null : (content.before ?? '') }
}

/** Record a "review result write" (the user's choices in the diff view, which is itself a model-related change) */
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
