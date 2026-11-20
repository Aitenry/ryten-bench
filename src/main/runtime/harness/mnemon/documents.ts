import * as fs from 'fs'
import * as path from 'path'
import logger from 'electron-log'
import { mainFormat, mainToolMessages } from '../../../i18n'
import { hashOf } from './runtime-memory'
import {
  DOCUMENTS_ACTIVE_LIMIT_BYTES,
  DOCUMENTS_VERSION,
  DOCUMENT_MAX_BYTES,
  type DocumentMutation,
  type DocumentMutationResult,
  type DocumentRecord,
  type DocumentSearchResult,
  type DocumentSnapshot,
  type DocumentView
} from './types'

/**
 * DocumentController — Project Documents 控制面
 *
 * 移植自 dsh-mnemon 的 DocumentController：
 * - `index.json` 是元数据事实源；Markdown 托管副本带生成 frontmatter；
 * - active（参与默认搜索）/ archived（冷层，不计 active 容量）分层；
 * - active 总量 10 MiB / 单份 2 MiB；容量不足时按 LRU（lastAccessedAt）选择归档候选；
 * - 搜索只覆盖 active（除非显式 includeArchived），命中更新 lastAccessedAt（LRU 排序）。
 */

interface DocumentIndexFile {
  version: number
  documents: DocumentRecord[]
}

interface ArchiveOptions {
  summary: string
  /** 归档时写入长期层的冷引用（memoryBodyIds 由调用方提供） */
  memoryBodyIds?: string[]
}

export class DocumentController {
  readonly directory: string
  readonly activeDirectory: string
  readonly archivedDirectory: string
  readonly indexPath: string
  readonly limitBytes = DOCUMENTS_ACTIVE_LIMIT_BYTES

  private queue: Promise<unknown> = Promise.resolve()
  private cached: DocumentIndexFile | null = null

  constructor(storageRoot: string) {
    this.directory = path.join(storageRoot, 'documents')
    this.activeDirectory = path.join(this.directory, 'active')
    this.archivedDirectory = path.join(this.directory, 'archived')
    this.indexPath = path.join(this.directory, 'index.json')
    this.initialize()
  }

  private initialize(): void {
    fs.mkdirSync(this.activeDirectory, { recursive: true })
    fs.mkdirSync(this.archivedDirectory, { recursive: true })
    const index = this.readIndex()
    if (!fs.existsSync(this.indexPath)) {
      this.persistIndex(index)
    }
    this.reconcileFiles(index)
  }

  /** 目录快照 */
  snapshot(): DocumentSnapshot {
    const index = this.readIndex()
    const active = index.documents.filter((d) => d.status === 'active')
    const archived = index.documents.filter((d) => d.status === 'archived')
    return {
      directory: this.directory,
      indexPath: this.indexPath,
      generatedAt: new Date().toISOString(),
      limitBytes: this.limitBytes,
      activeBytes: active.reduce((sum, d) => sum + d.sizeBytes, 0),
      activeCount: active.length,
      archivedCount: archived.length,
      total: index.documents.length,
      documents: index.documents.map((d) => ({
        ...d,
        healthy: fs.existsSync(this.pathFor(d)),
        excerpt: this.excerpt(d.title, d.description)
      }))
    }
  }

  /** 读取一份文档 */
  get(id: string): DocumentView | undefined {
    const index = this.readIndex()
    const record = index.documents.find((d) => d.id === id)
    if (!record) return undefined
    return this.view(record)
  }

  /** 搜索（只覆盖 active；命中更新 lastAccessedAt 用于 LRU） */
  async search(
    query: string,
    options: { includeArchived?: boolean; limit?: number } = {}
  ): Promise<DocumentSearchResult> {
    const run = async (): Promise<DocumentSearchResult> => {
      const index = this.readIndex()
      const limit = options.limit ?? 10
      const terms = query
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 0)
      const candidates = index.documents.filter(
        (d) => d.status === 'active' || (options.includeArchived && d.status === 'archived')
      )
      const scored = candidates
        .map((d) => {
          const title = d.title.toLowerCase()
          const description = d.description.toLowerCase()
          let score = 0
          if (terms.length === 0) {
            score = 1
          } else {
            for (const term of terms) {
              if (title.includes(term)) score += 5
              if (description.includes(term)) score += 3
            }
          }
          return { record: d, score }
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)

      // 命中更新 lastAccessedAt（LRU 排序），并写回索引
      let touched = false
      const now = new Date().toISOString()
      for (const hit of scored) {
        if (hit.record.lastAccessedAt !== now) {
          hit.record.lastAccessedAt = now
          touched = true
        }
      }
      if (touched) {
        this.persistIndex(index)
      }

      return {
        query,
        includeArchived: options.includeArchived ?? false,
        total: scored.length,
        generatedAt: now,
        results: scored.map(({ record, score }) => ({
          ...this.view(record),
          score,
          excerpt: this.excerpt(record.title, record.description)
        }))
      }
    }
    return (await this.enqueue(run)) as DocumentSearchResult
  }

  /** 创建 / 更新文档 */
  async mutate(request: DocumentMutation): Promise<DocumentMutationResult> {
    const run = async (): Promise<DocumentMutationResult> => {
      const tm = mainToolMessages().mnemon
      const index = this.readIndex()
      const now = new Date().toISOString()

      if (request.action === 'create') {
        const content = request.content
        const sizeBytes = Buffer.byteLength(content, 'utf-8')
        if (sizeBytes > DOCUMENT_MAX_BYTES) {
          throw new Error(mainFormat(tm.errors.documentTooLarge, { limit: DOCUMENT_MAX_BYTES }))
        }
        // 容量规划：active 总量 10 MiB
        const activeBytes = index.documents
          .filter((d) => d.status === 'active')
          .reduce((sum, d) => sum + d.sizeBytes, 0)
        if (activeBytes + sizeBytes > this.limitBytes) {
          throw new Error(
            mainFormat(tm.errors.documentCapacityExceeded, {
              limit: this.limitBytes,
              current: activeBytes,
              needed: sizeBytes
            })
          )
        }

        const id = crypto.randomUUID()
        const filename = `${id}.md`
        const record: DocumentRecord = {
          id,
          title: request.title.trim(),
          description: request.description?.trim() ?? '',
          status: 'active',
          filename,
          relativePath: `active/${filename}`,
          sourcePaths: this.normalizeSourcePaths(request.sourcePaths),
          createdAt: now,
          updatedAt: now,
          lastAccessedAt: now,
          revision: 1,
          contentHash: hashOf(content),
          sizeBytes
        }
        index.documents.push(record)
        this.persistDocument(record, content)
        this.persistIndex(index)
        return { success: true, action: 'created', document: this.view(record) }
      }

      // update
      const record = index.documents.find((d) => d.id === request.id)
      if (!record) throw new Error(mainFormat(tm.errors.documentNotFound, { id: request.id }))
      if (record.status !== 'active') {
        throw new Error(mainFormat(tm.errors.documentArchived, { id: request.id }))
      }
      if (request.title !== undefined) record.title = request.title.trim()
      if (request.description !== undefined) record.description = request.description.trim()
      if (request.content !== undefined) {
        const sizeBytes = Buffer.byteLength(request.content, 'utf-8')
        if (sizeBytes > DOCUMENT_MAX_BYTES) {
          throw new Error(mainFormat(tm.errors.documentTooLarge, { limit: DOCUMENT_MAX_BYTES }))
        }
        const activeBytes = index.documents
          .filter((d) => d.status === 'active' && d.id !== record.id)
          .reduce((sum, d) => sum + d.sizeBytes, 0)
        if (activeBytes + sizeBytes > this.limitBytes) {
          throw new Error(tm.errors.documentCapacityExceededOnUpdate)
        }
        record.contentHash = hashOf(request.content)
        record.sizeBytes = sizeBytes
        this.persistDocument(record, request.content)
      }
      record.updatedAt = now
      record.revision += 1
      this.persistIndex(index)
      return { success: true, action: 'updated', document: this.view(record) }
    }
    return (await this.enqueue(run)) as DocumentMutationResult
  }

  /** 归档：把 active 文档移入 archived（先写长期层冷引用，再迁移原文） */
  async archive(id: string, details: ArchiveOptions): Promise<DocumentMutationResult> {
    const run = async (): Promise<DocumentMutationResult> => {
      const tm = mainToolMessages().mnemon
      const index = this.readIndex()
      const record = index.documents.find((d) => d.id === id)
      if (!record) throw new Error(mainFormat(tm.errors.documentNotFound, { id }))
      if (record.status !== 'active') {
        throw new Error(mainFormat(tm.errors.documentNotActive, { id }))
      }

      const now = new Date().toISOString()
      record.status = 'archived'
      record.archivedAt = now
      record.archiveSummary = details.summary
      record.relativePath = `archived/${record.filename}`
      record.revision += 1
      record.updatedAt = now

      // 迁移原文文件
      const srcPath = path.join(this.activeDirectory, record.filename)
      const dstPath = path.join(this.archivedDirectory, record.filename)
      if (fs.existsSync(srcPath)) {
        fs.renameSync(srcPath, dstPath)
      }
      this.persistIndex(index)
      logger.info(
        `[Mnemon.Documents] 归档文档 ${record.title}（${details.summary}，冷引用 ${details.memoryBodyIds?.join(',') ?? '无'}）`
      )
      return { success: true, action: 'archived', document: this.view(record) }
    }
    return (await this.enqueue(run)) as DocumentMutationResult
  }

  // --------------------------------------------------------------------------
  // 内部实现
  // --------------------------------------------------------------------------

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task)
    this.queue = next.catch(() => undefined)
    return next
  }

  /** 检查磁盘文件与索引一致（启动时修复缺失的托管副本） */
  private reconcileFiles(index: DocumentIndexFile): void {
    for (const record of index.documents) {
      const filePath = this.pathFor(record)
      if (!fs.existsSync(filePath)) {
        logger.warn(`[Mnemon.Documents] 托管副本缺失，重建: ${record.relativePath}`)
        fs.writeFileSync(filePath, this.renderMarkdown(record, ''), 'utf-8')
      }
    }
  }

  private readIndex(): DocumentIndexFile {
    if (this.cached) return this.cached
    try {
      if (fs.existsSync(this.indexPath)) {
        const parsed = JSON.parse(fs.readFileSync(this.indexPath, 'utf-8')) as DocumentIndexFile
        if (parsed.version === DOCUMENTS_VERSION && Array.isArray(parsed.documents)) {
          this.cached = parsed
          return parsed
        }
      }
    } catch (err) {
      logger.warn('[Mnemon.Documents] 读取 index.json 失败，使用空索引:', err)
    }
    const fresh: DocumentIndexFile = { version: DOCUMENTS_VERSION, documents: [] }
    this.cached = fresh
    return fresh
  }

  private persistIndex(index: DocumentIndexFile): void {
    this.cached = index
    const tmpPath = this.indexPath + '.tmp'
    fs.writeFileSync(tmpPath, JSON.stringify(index, null, 2), 'utf-8')
    fs.renameSync(tmpPath, this.indexPath)
  }

  private pathFor(record: DocumentRecord): string {
    return path.join(this.directory, record.relativePath)
  }

  /** 写托管 Markdown（带生成 frontmatter） */
  private persistDocument(record: DocumentRecord, content: string): void {
    const filePath = this.pathFor(record)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const tmpPath = filePath + '.tmp'
    fs.writeFileSync(tmpPath, this.renderMarkdown(record, content), 'utf-8')
    fs.renameSync(tmpPath, filePath)
  }

  private renderMarkdown(record: DocumentRecord, content: string): string {
    return [
      '---',
      `title: ${record.title}`,
      `description: ${record.description}`,
      `id: ${record.id}`,
      `status: ${record.status}`,
      `created_at: ${record.createdAt}`,
      `updated_at: ${record.updatedAt}`,
      '---',
      '',
      content
    ].join('\n')
  }

  private view(record: DocumentRecord): DocumentView {
    const filePath = this.pathFor(record)
    let content = ''
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf-8')
        content = raw.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '')
      }
    } catch (err) {
      logger.warn(`[Mnemon.Documents] 读取文档失败 ${record.id}:`, err)
    }
    return { ...record, content }
  }

  private excerpt(title: string, description: string): string {
    const text = `${title} ${description}`.trim()
    return text.length > 120 ? text.slice(0, 120) + '…' : text
  }

  private normalizeSourcePaths(sourcePaths?: string[]): string[] {
    if (!sourcePaths) return []
    const unique = [...new Set(sourcePaths.map((p) => p.replace(/\\/g, '/')))]
    return unique.slice(0, 8)
  }
}
