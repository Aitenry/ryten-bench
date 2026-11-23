import * as fs from 'fs'
import * as path from 'path'
import { STORAGE_LABELS, type StorageKind } from './types'

/**
 * 存储目录搬迁（用户主动改「记忆 / 插件 / 技能」地址时用）。
 *
 * 设计目标只有一条：**不丢数据**。因此：
 * - 目标是空目录 → 整根目录一次 `rename`（同盘原子、跨盘自动降级为「复制后删除」）；
 * - 目标已有内容 → 逐个条目合并：目标里没有的搬过去，同名的**保留目标那份**，
 *   源文件改名成 `<name>.migrated-<时间戳>` 一起留在目标里（谁都没被覆盖）；
 * - 源目录只在真的搬空后才删；搬不动的条目留在原处并如实报错/告警。
 *
 * 模块刻意不 import electron / electron-log：离线工装可以直接跑真实文件操作。
 */

export type StorageMigrationSkip = 'same-path' | 'source-missing' | 'empty-source'

export interface StorageMigrationResult {
  kind: StorageKind
  /** 解析后的绝对路径（`..` / 相对路径都已归一） */
  from: string
  to: string
  /** 顶层条目名（插件工坊用它显示「N 个已有插件也搬了过去」） */
  moved: string[]
  /** 因目标已存在同名文件而留档的相对路径（`<name>.migrated-<时间戳>`） */
  conflicts: string[]
  /** 搬迁完成但清理旧目录失败等非致命问题（数据已在目标里，不影响使用） */
  warnings: string[]
  skipped: StorageMigrationSkip | null
}

/** 路径比较口径：Windows 大小写不敏感；空的配置值只与空值相等 */
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
 * `child` 是否在 `parent` 里面（相等不算「里面」）。
 *
 * 搬迁前必须挡住「新旧目录互相嵌套」：否则把父目录搬进子目录会自我递归，
 * 或在子目录被搬走后又回头写父目录，轻则产生垃圾，重则把数据搬丢。
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
 * 把一个存储目录的内容迁移到新目录。
 *
 * @throws 目标不是目录 / 新旧目录互相嵌套 / 文件操作失败（错误原样抛出，调用方决定是否保存设置）
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

  // 最常见也最安全的一条：新目录是空的 → 整根搬过去（同盘 rename 原子完成）
  if (isEmptyDirectory(to)) {
    const movedWholeRoot = tryReplaceEmptyDirectory(from, to, result.warnings)
    if (movedWholeRoot) {
      return { ...result, moved: entries }
    }
  }
  // tryReplaceEmptyDirectory 在失败时会恢复空目标；恢复失败时这里再兜一次，
  // 保证下面逐项 move 的目标父目录一定存在。
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

    // 同名但不是「两边都是目录」：目标那份保留，源文件另存一份，
    // 绝不覆盖用户可能已经放进新目录的文件。
    const conflict = uniqueConflictPath(target, stamp)
    moveEntry(source, conflict, result.warnings)
    result.moved.push(name)
    result.conflicts.push(name)
  }

  removeEmptyDirectory(from)
  return result
}

// ---------- 内部实现 ----------

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
    // 还有没搬走的条目 / 目录已不在：保持原样，交给下一次重试
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
 * 目标空目录 → 尝试整根替换。
 *
 * @returns true = 已成功搬完；false = 没搬（目标被重建为空目录），调用方继续逐项合并。
 */
function tryReplaceEmptyDirectory(from: string, to: string, warnings: string[]): boolean {
  try {
    // rename 不能可靠地覆盖「已存在的空目录」（Windows 直接失败），先摘掉它
    fs.rmdirSync(to)
  } catch {
    return false
  }

  try {
    fs.renameSync(from, to)
    return true
  } catch (err) {
    // rename 失败：先把目标空目录恢复回来，避免调用方看到一个「目标不存在」的状态
    try {
      fs.mkdirSync(to, { recursive: true })
    } catch {
      // 恢复失败也继续走后面的分支：真正的错误以原因为准
    }
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') return false

    // 跨盘（EXDEV）：整树复制后再删源目录。复制失败时清掉半成品并恢复空目标。
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
        // 清理失败不掩盖复制错误
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
    // 复制失败：删掉可能写了一半的目标，源目录保持原样
    try {
      fs.rmSync(to, { recursive: true, force: true })
    } catch {
      // 清理失败不掩盖复制错误
    }
    throw err
  }
  removeTreeAfterCopy(from, warnings)
}

/** 复制成功后的删源：删干净才算「搬」；删不掉只告警（目标里已有完整数据） */
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

/** 同名冲突的留档名：`plugin.json` → `plugin.json.migrated-<时间戳>` */
function uniqueConflictPath(target: string, stamp: string): string {
  let index = 0
  while (true) {
    const suffix = index === 0 ? `.migrated-${stamp}` : `.migrated-${stamp}-${index}`
    const candidate = `${target}${suffix}`
    if (!lstatOrNull(candidate)) return candidate
    index += 1
  }
}
