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
 * RuntimeMemoryController — the single source of truth for runtime hot memory
 *
 * - `memories.json` is the only source of truth; `USER.md` / `MEMORY.md` are deterministic
 *   derived projections;
 * - `add` writes a new independent fact (identical content is not added twice);
 *   `replace` / `remove` locate an entry by a unique substring;
 * - Capacity: USER 4 KiB / MEMORY 10 KiB; an overflowing `add` triggers maintenance
 *   automatically, while an overflowing `replace` fails with an error;
 *   - USER overflow: conservative local compaction (merges low entries whose content is a
 *     substring of another entry);
 *   - MEMORY overflow: an archive hook writes entries to the long-term layer (mnemon-archive);
 * - Writes are serialized through a queue (to avoid concurrent races).
 */

interface RuntimeMemoryFile {
  version: number
  entries: RuntimeMemoryEntry[]
}

export interface MemoryMaintenanceHooks {
  /**
   * Archive callback for MEMORY overflow: writes entries to the long-term layer.
   * The returned archivedIndexes are "local indexes within the passed entries sub-array"
   * (not global indexes in the data file); the caller converts them to global indexes
   * before removing entries.
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

  /** Ensures the directory and source of truth exist at startup, and repairs hand-edited projections */
  private initialize(): void {
    fs.mkdirSync(this.directory, { recursive: true })
    const data = this.readSource()
    if (!fs.existsSync(this.sourcePath)) {
      // First initialization: write an empty source of truth
      this.persist(data)
    }
    this.repairProjections(data.entries)
  }

  /** Synchronous snapshot (used when assembling the prompt) */
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

  /** Compact context text for prompt assembly (all USER + MEMORY entries) */
  contextText(): string {
    const data = this.readSource()
    if (data.entries.length === 0) return ''
    return data.entries.map((e) => `- ${e.content}`).join('\n')
  }

  /** Mutates hot memory (add / replace / remove), serialized through the queue; on MEMORY overflow, archives asynchronously and retries */
  async mutate(request: RuntimeMemoryMutation): Promise<RuntimeMemoryMutationResult> {
    const run = async (): Promise<RuntimeMemoryMutationResult> => {
      const tm = mainToolMessages().mnemon
      let result = this.mutateLocked(request)
      // MEMORY overflow marker: run the asynchronous archive, then retry
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

  /** Asynchronous archive: writes low-priority/oldest MEMORY entries to the long-term layer and removes them */
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

    // Archive low entries first; if not enough, append the oldest normal entries (by created_at)
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
      // Hook contract: archivedIndexes are "local indexes within the passed sub-array" and must
      // be converted to global indexes in data.entries before removal — selected is not
      // necessarily at the front of the file, and when user/memory entries interleave, a local
      // index coinciding with the global index is only a coincidence; using it directly would
      // remove entries that were not archived (including USER profiles).
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
        `[Mnemon.RuntimeMemory] Archived ${archivedIndexes.length} memories to long-term layer ${memoryBodyIds.join(',')}`
      )
      return { ok: true, count: archivedIndexes.length }
    } catch (err) {
      logger.error('[Mnemon.RuntimeMemory] Archive failed:', err)
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  }

  // --------------------------------------------------------------------------
  // Internal implementation
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
      // Never add identical content twice
      const duplicate = data.entries.some((e) => e.target === target && e.content === content)
      if (duplicate) {
        return { success: false, message: tm.errors.entryExists }
      }

      // Capacity check: an overflowing add triggers maintenance
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
      // An overflowing replace fails with an error (the caller should tidy up explicitly first)
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

  /** add overflow: USER local compaction (synchronous) or MEMORY archive (asynchronous, retried through enqueue) */
  private maintainAndRetryAdd(
    data: RuntimeMemoryFile,
    target: RuntimeMemoryTarget,
    content: string,
    importance?: RuntimeMemoryImportance
  ): RuntimeMemoryMutationResult {
    const tm = mainToolMessages().mnemon
    if (target === 'user') {
      // Conservative USER local compaction: drop low entries whose content is a substring of a longer low entry (keep the longer one)
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
        // Retry the add
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

    // MEMORY overflow: return a special marker; mutate() runs the asynchronous archive and retries
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
      logger.warn('[Mnemon.RuntimeMemory] Failed to read memories.json, using empty fact source:', err)
    }
    const fresh: RuntimeMemoryFile = { version: RUNTIME_MEMORY_VERSION, entries: [] }
    this.cached = fresh
    return fresh
  }

  private revisionOf(data: RuntimeMemoryFile): string {
    // Content hash of the source of truth as the revision (concurrency conflict detection)
    return hashOf(JSON.stringify(data))
  }

  /** Writes the source of truth (atomic: temp file + rename) */
  private persist(data: RuntimeMemoryFile): void {
    this.cached = data
    const tmpPath = this.sourcePath + '.tmp'
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
    fs.renameSync(tmpPath, this.sourcePath)
  }

  /** Rebuilds the Markdown projections from the source of truth (entries normalized to single lines, separated by §) */
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

/** Simple string hash (FNV-1a 32-bit hex) */
export function hashOf(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}
