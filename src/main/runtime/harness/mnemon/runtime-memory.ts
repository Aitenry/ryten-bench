import * as fs from 'fs'
import * as path from 'path'
import logger from 'electron-log'
import { mainFormat, mainPlural, mainToolMessages } from '../../../i18n'
import {
  RUNTIME_ENTRY_DELIMITER,
  RUNTIME_ENTRY_MAX_BYTES,
  RUNTIME_MEMORY_LIMITS,
  RUNTIME_MEMORY_VERSION,
  type RuntimeMemoryEntry,
  type RuntimeMemoryImportance,
  type RuntimeMemoryMutation,
  type RuntimeMemoryMutationResult,
  type RuntimeMemorySnapshot,
  type RuntimeMemoryTarget,
  type RuntimeMemoryTargetView,
  type RuntimeMemoryUsage
} from './types'

/**
 * RuntimeMemoryController — 运行时热记忆唯一事实源
 *
 * 移植自 dsh-mnemon 的 RuntimeMemoryController：
 * - `memories.json` 是唯一事实源；`USER.md` / `MEMORY.md` 是确定性派生投影；
 * - `add` 写入独立新事实（完全相同内容不重复添加）；`replace` / `remove` 用唯一子串定位；
 * - 容量：USER 4 KiB / MEMORY 10 KiB；`add` 溢出自动触发维护，`replace` 溢出直接报错；
 *   - USER 溢出：本地保守压缩（合并内容互为子串的 low 条目）；
 *   - MEMORY 溢出：归档钩子把条目写入长期层（mnemon-archive）；
 * - 写入经队列串行化（避免并发竞态）。
 */

interface RuntimeMemoryFile {
  version: number
  entries: RuntimeMemoryEntry[]
}

export interface MemoryMaintenanceHooks {
  /**
   * MEMORY 溢出时的归档回调：把条目写入长期层。
   * 返回的 archivedIndexes 是「传入 entries 子数组内的局部索引」（而非数据文件全局索引），
   * 调用方负责换算为全局索引后再删除条目。
   */
  archiveEntries?: (
    entries: RuntimeMemoryEntry[]
  ) => Promise<{ archivedIndexes: number[]; memoryBodyIds: string[] }>
}

export class RuntimeMemoryController {
  readonly directory: string
  readonly sourcePath: string
  readonly memoryPath: string
  readonly userPath: string

  private readonly hooks: MemoryMaintenanceHooks
  private queue: Promise<unknown> = Promise.resolve()
  private cached: RuntimeMemoryFile | null = null

  constructor(storageRoot: string, hooks: MemoryMaintenanceHooks = {}) {
    this.directory = path.join(storageRoot, 'runtime')
    this.sourcePath = path.join(this.directory, 'memories.json')
    this.memoryPath = path.join(this.directory, 'MEMORY.md')
    this.userPath = path.join(this.directory, 'USER.md')
    this.hooks = hooks
    this.initialize()
  }

  /** 启动时确保目录与事实源存在，并修复被手工修改的投影 */
  private initialize(): void {
    fs.mkdirSync(this.directory, { recursive: true })
    const data = this.readSource()
    if (!fs.existsSync(this.sourcePath)) {
      // 首次初始化：写入空事实源
      this.persist(data)
    }
    this.repairProjections(data.entries)
  }

  /** 同步快照（prompt 组装时使用） */
  snapshot(): RuntimeMemorySnapshot {
    const data = this.readSource()
    const generatedAt = new Date().toISOString()
    return {
      directory: this.directory,
      sourcePath: this.sourcePath,
      revision: this.revisionOf(data),
      generatedAt,
      entries: data.entries,
      targets: {
        memory: this.targetView(data.entries, 'memory'),
        user: this.targetView(data.entries, 'user')
      }
    }
  }

  /** 组装 prompt 的紧凑上下文文本（USER + MEMORY 全部条目） */
  contextText(): string {
    const data = this.readSource()
    if (data.entries.length === 0) return ''
    return data.entries.map((e) => `- ${e.content}`).join('\n')
  }

  /** 变更热记忆（add / replace / remove），队列串行化；MEMORY 溢出时异步归档后重试 */
  async mutate(request: RuntimeMemoryMutation): Promise<RuntimeMemoryMutationResult> {
    const run = async (): Promise<RuntimeMemoryMutationResult> => {
      const tm = mainToolMessages().mnemon
      let result = this.mutateLocked(request)
      // MEMORY 溢出标记：执行异步归档后重试
      if (!result.success && result.message === '__NEEDS_ASYNC_ARCHIVE__') {
        const archived = await this.runArchive()
        if (!archived.ok) {
          return {
            success: false,
            message: mainFormat(tm.runtimeMemory.archiveFailed, { message: archived.message })
          }
        }
        result = this.mutateLocked(request)
        if (result.success && result.added) {
          result = {
            ...result,
            message: mainFormat(tm.runtimeMemory.addedWithArchive, {
              entryCount: mainPlural(tm.entryCount_one, tm.entryCount_other, archived.count)
            })
          }
        }
      }
      return result
    }
    return (await this.enqueue(run)) as RuntimeMemoryMutationResult
  }

  /** 异步归档：把低优先级/最旧的 MEMORY 条目写入长期层并移除 */
  private async runArchive(): Promise<
    { ok: true; count: number } | { ok: false; message: string }
  > {
    const tm = mainToolMessages().mnemon
    if (!this.hooks.archiveEntries) {
      return { ok: false, message: tm.errors.archiveHookMissing }
    }
    const data = this.readSource()
    const memoryItems = data.entries
      .map((e, i) => ({ entry: e, index: i }))
      .filter((x) => x.entry.target === 'memory')

    // 优先归档 low；不够则追加最旧的 normal（按 created_at）
    const selected: Array<{ entry: RuntimeMemoryEntry; index: number }> = []
    const low = memoryItems.filter((x) => x.entry.importance === 'low')
    selected.push(...low)
    if (selected.length < Math.min(memoryItems.length, 3)) {
      const normals = memoryItems
        .filter((x) => x.entry.importance !== 'low')
        .sort((a, b) => a.entry.created_at.localeCompare(b.entry.created_at))
      const need = Math.min(memoryItems.length, 3) - selected.length
      selected.push(...normals.slice(0, need))
    }
    if (selected.length === 0) {
      return { ok: false, message: tm.errors.nothingToArchive }
    }

    try {
      const { archivedIndexes, memoryBodyIds } = await this.hooks.archiveEntries(
        selected.map((x) => x.entry)
      )
      // 钩子契约：archivedIndexes 是「传入子数组内的局部索引」，必须换算为 data.entries
      // 的全局索引再删除——selected 不一定是文件最前的条目，user/memory 交错存放时
      // 局部索引恰好等于全局索引只是巧合，直接使用会误删未归档条目（含 USER 画像）。
      const removeSet = new Set(
        archivedIndexes
          .map((i) => selected[i]?.index)
          .filter((i): i is number => typeof i === 'number')
      )
      const remaining = selected.filter((x) => !removeSet.has(x.index))
      if (remaining.length === selected.length) {
        return { ok: false, message: tm.errors.hookArchivedNothing }
      }
      data.entries = data.entries.filter((_, i) => !removeSet.has(i))
      this.persist(data)
      this.repairProjections(data.entries)
      logger.info(
        `[Mnemon.RuntimeMemory] 归档 ${archivedIndexes.length} 条记忆到长期层 ${memoryBodyIds.join(',')}`
      )
      return { ok: true, count: archivedIndexes.length }
    } catch (err) {
      logger.error('[Mnemon.RuntimeMemory] 归档失败:', err)
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  }

  // --------------------------------------------------------------------------
  // 内部实现
  // --------------------------------------------------------------------------

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task)
    this.queue = next.catch(() => undefined)
    return next
  }

  private mutateLocked(request: RuntimeMemoryMutation): RuntimeMemoryMutationResult {
    const tm = mainToolMessages().mnemon
    const data = this.readSource()
    const { target } = request

    if (request.action === 'add') {
      const content = request.content?.trim()
      if (!content) return { success: false, message: tm.errors.contentRequired }
      if (Buffer.byteLength(content, 'utf-8') > RUNTIME_ENTRY_MAX_BYTES) {
        return {
          success: false,
          message: mainFormat(tm.errors.entryTooLarge, { limit: RUNTIME_ENTRY_MAX_BYTES })
        }
      }
      // 完全相同内容不重复添加
      const duplicate = data.entries.some((e) => e.target === target && e.content === content)
      if (duplicate) {
        return { success: false, message: tm.errors.entryExists }
      }

      // 容量检查：add 溢出时触发维护
      const projected =
        this.usageOf(data.entries, target).used + Buffer.byteLength(content, 'utf-8')
      if (projected > RUNTIME_MEMORY_LIMITS[target]) {
        return this.maintainAndRetryAdd(data, target, content, request.importance)
      }

      data.entries.push(this.entry(content, target, request.importance ?? 'normal'))
      this.persist(data)
      this.repairProjections(data.entries)
      return {
        success: true,
        message: tm.runtimeMemory.added,
        target,
        entryCount: data.entries.length,
        usage: this.usageOf(data.entries, target),
        added: content
      }
    }

    if (request.action === 'remove' || request.action === 'replace') {
      const oldText = request.oldText?.trim()
      if (!oldText) return { success: false, message: tm.errors.keyRequired }
      const indexes = data.entries
        .map((e, i) => (e.content.includes(oldText) ? i : -1))
        .filter((i) => i >= 0)
      if (indexes.length === 0) {
        return { success: false, message: mainFormat(tm.errors.keyNotFound, { oldText }) }
      }
      if (indexes.length > 1) {
        return {
          success: false,
          message: mainFormat(tm.errors.keyAmbiguous, { oldText, count: indexes.length })
        }
      }

      const index = indexes[0]
      const existing = data.entries[index]

      if (request.action === 'remove') {
        data.entries.splice(index, 1)
        this.persist(data)
        this.repairProjections(data.entries)
        return {
          success: true,
          message: tm.runtimeMemory.removed,
          target,
          entryCount: data.entries.length,
          usage: this.usageOf(data.entries, target),
          removed: existing.content
        }
      }

      // replace
      const content = request.content?.trim()
      if (!content) return { success: false, message: tm.errors.newContentRequired }
      const replaced = { from: existing.content, to: content }
      // replace 溢出直接报错（调用方应先显式整理），与 dsh-mnemon 一致
      const usage = this.usageOf(data.entries, target)
      const projected =
        usage.used -
        Buffer.byteLength(existing.content, 'utf-8') +
        Buffer.byteLength(content, 'utf-8')
      if (projected > RUNTIME_MEMORY_LIMITS[target]) {
        return {
          success: false,
          message: mainFormat(tm.errors.replaceOverLimit, {
            limit: RUNTIME_MEMORY_LIMITS[target]
          })
        }
      }
      data.entries[index] = {
        ...existing,
        content,
        updated_at: new Date().toISOString(),
        importance: request.importance ?? existing.importance
      }
      this.persist(data)
      this.repairProjections(data.entries)
      return {
        success: true,
        message: tm.runtimeMemory.replaced,
        target,
        entryCount: data.entries.length,
        usage: this.usageOf(data.entries, target),
        replaced
      }
    }

    return {
      success: false,
      message: mainFormat(tm.errors.unknownAction, { action: request.action })
    }
  }

  /** add 溢出：USER 本地压缩（同步）或 MEMORY 归档（异步，经 enqueue 后重试） */
  private maintainAndRetryAdd(
    data: RuntimeMemoryFile,
    target: RuntimeMemoryTarget,
    content: string,
    importance?: RuntimeMemoryImportance
  ): RuntimeMemoryMutationResult {
    const tm = mainToolMessages().mnemon
    if (target === 'user') {
      // USER 本地保守压缩：删除互为子串的 low 条目（保留较长者）
      const lowIndexes = data.entries
        .map((e, i) => (e.target === 'user' && e.importance === 'low' ? i : -1))
        .filter((i) => i >= 0)
      const removedIndexes: number[] = []
      for (const i of lowIndexes) {
        if (removedIndexes.includes(i)) continue
        const dup = lowIndexes.find(
          (j) =>
            j !== i &&
            !removedIndexes.includes(j) &&
            data.entries[j].content.includes(data.entries[i].content)
        )
        if (dup !== undefined) removedIndexes.push(i)
      }
      if (removedIndexes.length > 0) {
        const removeSet = new Set(removedIndexes)
        data.entries = data.entries.filter((_, i) => !removeSet.has(i))
        this.persist(data)
        this.repairProjections(data.entries)
        // 重试 add
        return this.mutateLocked({
          action: 'add',
          target,
          content,
          importance
        }) as RuntimeMemoryMutationResult & { maintenance?: unknown }
      }
      return {
        success: false,
        message: mainFormat(tm.errors.userOverLimit, { limit: RUNTIME_MEMORY_LIMITS.user })
      }
    }

    // MEMORY 溢出：返回特殊标记，由 mutate() 执行异步归档后重试
    return {
      success: false,
      message: '__NEEDS_ASYNC_ARCHIVE__',
      target,
      entryCount: data.entries.length,
      usage: this.usageOf(data.entries, target)
    } as unknown as RuntimeMemoryMutationResult
  }

  private entry(
    content: string,
    target: RuntimeMemoryTarget,
    importance: RuntimeMemoryImportance
  ): RuntimeMemoryEntry {
    const now = new Date().toISOString()
    return { content, created_at: now, updated_at: now, target, importance }
  }

  private usageOf(entries: RuntimeMemoryEntry[], target: RuntimeMemoryTarget): RuntimeMemoryUsage {
    const used = entries
      .filter((e) => e.target === target)
      .reduce((sum, e) => sum + Buffer.byteLength(e.content, 'utf-8'), 0)
    return { used, limit: RUNTIME_MEMORY_LIMITS[target] }
  }

  private targetView(
    entries: RuntimeMemoryEntry[],
    target: RuntimeMemoryTarget
  ): RuntimeMemoryTargetView {
    return {
      target,
      used: this.usageOf(entries, target).used,
      limit: RUNTIME_MEMORY_LIMITS[target],
      entryCount: entries.filter((e) => e.target === target).length,
      markdownPath: target === 'user' ? this.userPath : this.memoryPath
    }
  }

  private readSource(): RuntimeMemoryFile {
    if (this.cached) return this.cached
    try {
      if (fs.existsSync(this.sourcePath)) {
        const raw = fs.readFileSync(this.sourcePath, 'utf-8')
        const parsed = JSON.parse(raw) as RuntimeMemoryFile
        if (parsed.version === RUNTIME_MEMORY_VERSION && Array.isArray(parsed.entries)) {
          this.cached = parsed
          return parsed
        }
      }
    } catch (err) {
      logger.warn('[Mnemon.RuntimeMemory] 读取 memories.json 失败，使用空事实源:', err)
    }
    const fresh: RuntimeMemoryFile = { version: RUNTIME_MEMORY_VERSION, entries: [] }
    this.cached = fresh
    return fresh
  }

  private revisionOf(data: RuntimeMemoryFile): string {
    // 事实源内容哈希作为修订号（并发冲突检测）
    return hashOf(JSON.stringify(data))
  }

  /** 写入事实源（原子：临时文件 + rename） */
  private persist(data: RuntimeMemoryFile): void {
    this.cached = data
    const tmpPath = this.sourcePath + '.tmp'
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
    fs.renameSync(tmpPath, this.sourcePath)
  }

  /** 从事实源重建 Markdown 投影（条目归一成单行，§ 分隔） */
  private repairProjections(entries: RuntimeMemoryEntry[]): void {
    const render = (target: RuntimeMemoryTarget): string => {
      const lines = entries
        .filter((e) => e.target === target)
        .map((e) => e.content.replace(/\r?\n/g, ' '))
      return lines.join(RUNTIME_ENTRY_DELIMITER)
    }
    this.atomicWrite(this.userPath, render('user'))
    this.atomicWrite(this.memoryPath, render('memory'))
  }

  private atomicWrite(filePath: string, content: string): void {
    const tmpPath = filePath + '.tmp'
    fs.writeFileSync(tmpPath, content, 'utf-8')
    fs.renameSync(tmpPath, filePath)
  }
}

/** 简单字符串哈希（FNV-1a 32 位 hex） */
export function hashOf(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}
