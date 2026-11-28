import * as fs from 'fs'
import * as path from 'path'
import { STORAGE_LABELS, type StorageKind } from './types'

/**
 * Storage directory migration (used when the user changes the "memory / plugins / skills" location).
 *
 * There is a single design goal: **never lose data**. Therefore:
 * - target is an empty directory → `rename` the whole root at once (atomic on the same disk; across
 *   disks it automatically degrades to "copy then delete");
 * - target already has content → merge entry by entry: entries missing from the target are moved over,
 *   on a name clash **the target copy is kept**, and the source file is renamed to
 *   `<name>.migrated-<timestamp>` and left in the target (nothing is overwritten);
 * - the source directory is deleted only once it is truly empty; entries that cannot be moved stay
 *   where they are and are reported truthfully as errors/warnings.
 *
 * The module deliberately does not import electron / electron-log: offline tooling can exercise real
 * file operations directly.
 */

export type StorageMigrationSkip = 'same-path' | 'source-missing' | 'empty-source'

export interface StorageMigrationResult {
  kind: StorageKind
  /** Resolved absolute paths (`..` / relative segments are normalized) */
  from: string
  to: string
  /** Top-level entry names (the plugin workshop uses this to show "N existing plugins were moved too") */
  moved: string[]
  /** Relative paths archived because the target already had the same name (`<name>.migrated-<timestamp>`) */
  conflicts: string[]
  /**
   * Non-fatal issues such as failing to clean up the old directory after a completed move (the data
   * is already in the target, so this does not affect use)
   */
  warnings: string[]
  skipped: StorageMigrationSkip | null
}

/** Path comparison semantics: case-insensitive on Windows; an empty config value only equals another empty value */
export function isSamePath(a: string, b: string): boolean {
  const left = typeof a === 'string' ? a.trim() : ''
  const right = typeof b === 'string' ? b.trim() : ''
  if (left === '' || right === '') return left === right
  const normalize = (value: string): string => {
    const resolved = path.resolve(value)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  return normalize(left) === normalize(right)
}

/**
 * Whether `child` is inside `parent` (equal paths do not count as "inside").
 *
 * Nested old/new directories must be blocked before migrating: otherwise moving a parent into its
 * child recurses into itself, or writes back into the parent after the child was moved away — at
 * best producing garbage, at worst losing data.
 */
export function isPathInside(child: string, parent: string): boolean {
  const c = typeof child === 'string' ? child.trim() : ''
  const p = typeof parent === 'string' ? parent.trim() : ''
  if (!c || !p) return false
  const normalize = (value: string): string => {
    const resolved = path.resolve(value)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  const normalizedChild = normalize(c)
  const normalizedParent = normalize(p)
  return normalizedChild.startsWith(
    normalizedParent.endsWith(path.sep) ? normalizedParent : normalizedParent + path.sep
  )
}

/**
 * Migrate the contents of one storage directory to a new directory.
 *
 * @throws target is not a directory / the old and new directories nest into each other / a file
 * operation fails (errors are rethrown so the caller can decide whether to save the settings)
 */
export function migrateStorageDirectory(
  kind: StorageKind,
  fromRaw: string,
  toRaw: string
): StorageMigrationResult {
  if (
    typeof fromRaw !== 'string' ||
    fromRaw.trim() === '' ||
    typeof toRaw !== 'string' ||
    toRaw.trim() === ''
  ) {
    throw new Error(`${STORAGE_LABELS[kind]}存储目录不能为空`)
  }

  const from = path.resolve(fromRaw)
  const to = path.resolve(toRaw)
  const result: StorageMigrationResult = {
    kind,
    from,
    to,
    moved: [],
    conflicts: [],
    warnings: [],
    skipped: null
  }

  if (isSamePath(from, to)) {
    return { ...result, skipped: 'same-path' }
  }
  if (path.dirname(from) === from || path.dirname(to) === to) {
    throw new Error(
      `${STORAGE_LABELS[kind]}存储目录不能是磁盘根目录：${path.dirname(from) === from ? from : to}`
    )
  }
  if (isPathInside(to, from) || isPathInside(from, to)) {
    throw new Error(
      `${STORAGE_LABELS[kind]}存储的新旧目录不能互相包含：${from} → ${to}（请选一个独立的文件夹）`
    )
  }

  const fromStat = lstatOrNull(from)
  if (!fromStat) {
    ensureTargetDirectory(kind, to)
    return { ...result, skipped: 'source-missing' }
  }
  if (!fromStat.isDirectory()) {
    throw new Error(`${STORAGE_LABELS[kind]}存储路径不是文件夹：${from}`)
  }

  ensureTargetDirectory(kind, to)
  const entries = fs.readdirSync(from)
  if (entries.length === 0) {
    removeEmptyDirectory(from)
    return { ...result, skipped: 'empty-source' }
  }

  // The most common and safest path: the new directory is empty → move the whole root over
  // (an atomic rename on the same disk)
  if (isEmptyDirectory(to)) {
    const movedWholeRoot = tryReplaceEmptyDirectory(from, to, result.warnings)
    if (movedWholeRoot) {
      return { ...result, moved: entries }
    }
  }
  // tryReplaceEmptyDirectory restores the empty target when it fails; retry here in case that restore
  // failed, so the per-entry move below always has an existing target parent
  ensureTargetDirectory(kind, to)

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  for (const name of entries) {
    const source = path.join(from, name)
    const target = path.join(to, name)
    const targetStat = lstatOrNull(target)
    if (!targetStat) {
      moveEntry(source, target, result.warnings)
      result.moved.push(name)
      continue
    }

    const sourceStat = lstatOrNull(source)
    if (sourceStat?.isDirectory() && targetStat.isDirectory()) {
      const merged = mergeDirectory(source, target, name, stamp)
      if (merged.moved > 0) result.moved.push(name)
      result.conflicts.push(...merged.conflicts)
      result.warnings.push(...merged.warnings)
      removeEmptyDirectory(source)
      continue
    }

    // Same name but not "both are directories": keep the target copy and store the source under
    // another name, never overwriting files the user may already have put in the new directory.
    const conflict = uniqueConflictPath(target, stamp)
    moveEntry(source, conflict, result.warnings)
    result.moved.push(name)
    result.conflicts.push(name)
  }

  removeEmptyDirectory(from)
  return result
}

// ---------- Internal implementation ----------

function lstatOrNull(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

function isEmptyDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory() && fs.readdirSync(target).length === 0
  } catch {
    return false
  }
}

function removeEmptyDirectory(target: string): void {
  try {
    fs.rmdirSync(target)
  } catch {
    // Entries still not moved / directory already gone: leave as-is, a later retry handles it
  }
}

function ensureTargetDirectory(kind: StorageKind, target: string): void {
  const stat = lstatOrNull(target)
  if (stat) {
    if (!stat.isDirectory()) {
      throw new Error(`${STORAGE_LABELS[kind]}存储的目标路径不是文件夹：${target}`)
    }
    return
  }
  fs.mkdirSync(target, { recursive: true })
}

/**
 * Empty target directory → try to replace the whole root.
 *
 * @returns true = moved successfully; false = nothing moved (the target was recreated as an empty
 * directory) and the caller continues merging entry by entry.
 */
function tryReplaceEmptyDirectory(from: string, to: string, warnings: string[]): boolean {
  try {
    // rename cannot reliably replace an "existing empty directory" (it just fails on Windows), so
    // remove it first
    fs.rmdirSync(to)
  } catch {
    return false
  }

  try {
    fs.renameSync(from, to)
    return true
  } catch (err) {
    // rename failed: restore the empty target first so the caller never sees a "target missing" state
    try {
      fs.mkdirSync(to, { recursive: true })
    } catch {
      // Continue into the later branches even if the restore fails: the real error is what matters
    }
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') return false

    // Cross-device (EXDEV): copy the whole tree, then delete the source directory. If the copy fails,
    // clear the partial output and restore the empty target.
    try {
      fs.cpSync(from, to, {
        recursive: true,
        preserveTimestamps: true,
        force: false,
        errorOnExist: true
      })
    } catch (copyErr) {
      try {
        fs.rmSync(to, { recursive: true, force: true })
        fs.mkdirSync(to, { recursive: true })
      } catch {
        // A cleanup failure does not mask the copy error
      }
      throw copyErr
    }
    removeTreeAfterCopy(from, warnings)
    return true
  }
}

function moveEntry(from: string, to: string, warnings: string[]): void {
  try {
    fs.renameSync(from, to)
    return
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
  }

  try {
    fs.cpSync(from, to, {
      recursive: true,
      preserveTimestamps: true,
      force: false,
      errorOnExist: true
    })
  } catch (err) {
    // Copy failed: remove the possibly half-written target, leaving the source directory untouched
    try {
      fs.rmSync(to, { recursive: true, force: true })
    } catch {
      // A cleanup failure does not mask the copy error
    }
    throw err
  }
  removeTreeAfterCopy(from, warnings)
}

/**
 * Deleting the source after a successful copy: a move only counts once it is fully deleted; if
 * deletion fails, only warn (the target already has the complete data)
 */
function removeTreeAfterCopy(source: string, warnings: string[]): void {
  try {
    fs.rmSync(source, { recursive: true, force: true })
  } catch (err) {
    warnings.push(
      `数据已复制到新位置，但旧目录清理失败（可手动删除）：${source}（${(err as Error).message}）`
    )
  }
}

interface MergeResult {
  moved: number
  conflicts: string[]
  warnings: string[]
}

function mergeDirectory(
  fromDir: string,
  toDir: string,
  relative: string,
  stamp: string
): MergeResult {
  const result: MergeResult = { moved: 0, conflicts: [], warnings: [] }
  for (const entry of fs.readdirSync(fromDir, { withFileTypes: true })) {
    const source = path.join(fromDir, entry.name)
    const target = path.join(toDir, entry.name)
    const targetStat = lstatOrNull(target)

    if (!targetStat) {
      moveEntry(source, target, result.warnings)
      result.moved += 1
      continue
    }

    if (entry.isDirectory() && targetStat.isDirectory()) {
      const merged = mergeDirectory(source, target, path.join(relative, entry.name), stamp)
      result.moved += merged.moved
      result.conflicts.push(...merged.conflicts)
      result.warnings.push(...merged.warnings)
      removeEmptyDirectory(source)
      continue
    }

    const conflict = uniqueConflictPath(target, stamp)
    moveEntry(source, conflict, result.warnings)
    result.moved += 1
    result.conflicts.push(path.join(relative, entry.name))
  }
  return result
}

/** Archive name for a name clash: `plugin.json` → `plugin.json.migrated-<timestamp>` */
function uniqueConflictPath(target: string, stamp: string): string {
  let index = 0
  while (true) {
    const suffix = index === 0 ? `.migrated-${stamp}` : `.migrated-${stamp}-${index}`
    const candidate = `${target}${suffix}`
    if (!lstatOrNull(candidate)) return candidate
    index += 1
  }
}
