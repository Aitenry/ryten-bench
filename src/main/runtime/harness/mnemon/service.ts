import type { PGlite } from '@electric-sql/pglite'
import * as path from 'path'
import logger from 'electron-log'
import { mainFormat, mainToolMessages } from '../../../i18n'
import {
  forgetInsight,
  linkInsights,
  listInsights,
  MemoryBodyRegistry,
  openSpaceDatabase,
  relatedInsights,
  rememberInsight,
  searchInsights,
  spaceStats
} from './memory-spaces'
import {
  MNEMON_CATEGORIES,
  MNEMON_SOURCES,
  type Insight,
  type MemoryBody,
  type MemoryBodyCatalog,
  type MemoryBodyView,
  type MnemonCategory,
  type MnemonEdgeType,
  type MnemonSource,
  type RememberRequest,
  type SearchRequest
} from './types'
import type { DocumentController } from './documents'
import type { RuntimeMemoryController } from './runtime-memory'

/**
 * MnemonService — 记忆系统应用门面
 *
 * 移植自 dsh-mnemon 的 MnemonService：组织 Runtime Memory、Documents 与 Memory Spaces
 * 三个控制面，向工具层暴露确定性服务（不做 LLM 判断）。
 */

export interface MnemonServiceOptions {
  /** 记忆系统存储根目录 */
  storageRoot: string
  /** 热记忆控制器（可延迟注入，避免构造环） */
  runtimeMemory?: RuntimeMemoryController
  /** 文档控制器（可延迟注入） */
  documents?: DocumentController
}

export class MnemonService {
  readonly registry: MemoryBodyRegistry
  readonly storageRoot: string
  runtimeMemory?: RuntimeMemoryController
  documents?: DocumentController

  /** 已打开的 PGlite 实例缓存（按空间 ID） */
  private readonly openDbs = new Map<string, PGlite>()

  constructor(options: MnemonServiceOptions) {
    this.storageRoot = options.storageRoot
    this.registry = new MemoryBodyRegistry(options.storageRoot)
    this.runtimeMemory = options.runtimeMemory
    this.documents = options.documents
  }

  // --------------------------------------------------------------------------
  // 目录与状态
  // --------------------------------------------------------------------------

  /** 记忆空间目录（含统计；复用已打开实例，避免同一目录多实例锁冲突） */
  async bodies(): Promise<MemoryBodyCatalog> {
    const items: MemoryBodyView[] = []
    for (const body of this.registry.list()) {
      try {
        const db = await this.openDb(body.id)
        const stats = await spaceStats(db)
        items.push({ ...body, healthy: true, stats })
      } catch (err) {
        items.push({
          ...body,
          healthy: false,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }
    return {
      items,
      total: items.length,
      activeCount: items.filter((b) => b.active).length,
      directory: path.join(this.storageRoot, 'data'),
      generatedAt: new Date().toISOString()
    }
  }

  // --------------------------------------------------------------------------
  // 召回（只读）
  // --------------------------------------------------------------------------

  /**
   * 从一个或多个 active 记忆空间召回。
   * 未指定 memoryBodyIds 时使用全部激活空间；每个空间独立召回后按 score 合并排序。
   */
  async search(
    request: SearchRequest
  ): Promise<{ query: string; mode: string; results: Insight[]; hint?: string }> {
    const tm = mainToolMessages().mnemon
    const targets = this.resolveTargets(request.memoryBodyIds)
    const mode = request.mode ?? 'smart'
    const perSpaceLimit = Math.min(request.limit ?? 10, 12)

    const all: Insight[] = []
    for (const body of targets) {
      try {
        const db = await this.openDb(body.id)
        const results = await searchInsights(
          db,
          { ...request, limit: perSpaceLimit },
          body.id,
          body.name
        )
        all.push(...results)
      } catch (err) {
        logger.warn(`[Mnemon] Recall failed (space ${body.name}):`, err)
      }
    }
    // 合并排序：按 score 降序，截断到 limit（默认 10）
    const limit = Math.min(request.limit ?? 10, 12)
    all.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    const results = all.slice(0, limit)
    return {
      query: request.query,
      mode,
      results,
      hint: results.length === 0 ? tm.hint.noMatchInActiveSpaces : undefined
    }
  }

  /** 关系遍历 */
  async related(
    id: string,
    depth = 2,
    edge?: MnemonEdgeType,
    memoryBodyId?: string
  ): Promise<Insight[]> {
    const targets = this.resolveTargets(memoryBodyId ? [memoryBodyId] : undefined)
    const all: Insight[] = []
    for (const body of targets) {
      try {
        const db = await this.openDb(body.id)
        const results = await relatedInsights(db, id, depth, edge, body.id, body.name)
        all.push(...results)
      } catch (err) {
        logger.warn(`[Mnemon] Relation traversal failed (space ${body.name}):`, err)
      }
    }
    return all.slice(0, 12)
  }

  /** 内容浏览（无召回副作用） */
  async list(memoryBodyIds?: string[], limit = 50): Promise<Insight[]> {
    const targets = this.resolveTargets(memoryBodyIds)
    const all: Insight[] = []
    for (const body of targets) {
      try {
        const db = await this.openDb(body.id)
        all.push(...(await listInsights(db, body.id, body.name, limit)))
      } catch (err) {
        logger.warn(`[Mnemon] Content listing failed (space ${body.name}):`, err)
      }
    }
    return all.slice(0, limit)
  }

  // --------------------------------------------------------------------------
  // 长期写入
  // --------------------------------------------------------------------------

  /** 沉淀一条洞察；未指定空间时使用第一个激活空间 */
  async remember(request: RememberRequest): Promise<Insight> {
    this.validateWrite()
    const tm = mainToolMessages().mnemon
    const target = this.resolveWriteTarget(request.memoryBodyId)
    if (request.category && !MNEMON_CATEGORIES.includes(request.category)) {
      throw new Error(
        mainFormat(tm.errors.categoryInvalid, { values: MNEMON_CATEGORIES.join(' / ') })
      )
    }
    if (request.source && !MNEMON_SOURCES.includes(request.source)) {
      throw new Error(mainFormat(tm.errors.sourceInvalid, { values: MNEMON_SOURCES.join(' / ') }))
    }
    const db = await this.openDb(target.id)
    const insight = await rememberInsight(db, request, target.id, target.name)
    logger.info(`[Mnemon] Persisted memory to ${target.name}: ${insight.content.slice(0, 60)}...`)
    return insight
  }

  /** 建立关系 */
  async link(
    sourceId: string,
    targetId: string,
    type: MnemonEdgeType,
    weight = 1,
    reason?: string,
    memoryBodyId?: string
  ): Promise<{ sourceId: string; targetId: string; type: MnemonEdgeType }> {
    this.validateWrite()
    const target = this.resolveWriteTarget(memoryBodyId)
    const db = await this.openDb(target.id)
    await linkInsights(db, sourceId, targetId, type, weight, reason)
    return { sourceId, targetId, type }
  }

  /** 软删除 */
  async forget(id: string, memoryBodyId?: string): Promise<boolean> {
    this.validateWrite()
    const target = this.resolveWriteTarget(memoryBodyId)
    const db = await this.openDb(target.id)
    const removed = await forgetInsight(db, id)
    if (!removed) {
      throw new Error(mainFormat(mainToolMessages().mnemon.errors.insightNotFound, { id }))
    }
    return true
  }

  /** 创建记忆空间 */
  async createBody(request: {
    name: string
    description: string
    active?: boolean
    role?: 'archive'
  }): Promise<MemoryBody> {
    this.validateWrite()
    return await this.registry.create(request)
  }

  /** 更新记忆空间元数据 */
  updateBody(
    id: string,
    request: { name?: string; description?: string; active?: boolean }
  ): MemoryBody {
    this.validateWrite()
    return this.registry.update(id, request)
  }

  /** 非破坏性合并 */
  async mergeBodies(
    targetBodyId: string,
    sourceBodyIds: string[],
    deactivateSources = true
  ): Promise<{ imported: number; skippedDuplicates: number }> {
    this.validateWrite()
    // 经 openDb 缓存取数据库实例（修复：registry.merge 直开同目录新实例，与缓存实例并存，
    // 同目录多实例存在锁冲突与一致性风险；缓存实例由 close() 统一收尾）
    const provider = async (
      bodyId: string
    ): Promise<{ db: PGlite; release: () => Promise<void> }> => {
      const db = await this.openDb(bodyId)
      return {
        db,
        release: async () => {}
      }
    }
    return await this.registry.merge(targetBodyId, sourceBodyIds, deactivateSources, provider)
  }

  // --------------------------------------------------------------------------
  // 内部实现
  // --------------------------------------------------------------------------

  private validateWrite(): void {
    // 写入口：注册表更新前校验（预留写权限开关）
  }

  private resolveTargets(memoryBodyIds?: string[]): MemoryBody[] {
    const tm = mainToolMessages().mnemon
    if (memoryBodyIds && memoryBodyIds.length > 0) {
      const targets = memoryBodyIds
        .map((id) => this.registry.get(id))
        .filter((b): b is MemoryBody => b !== undefined)
      const inactive = memoryBodyIds.filter((id) => {
        const body = this.registry.get(id)
        return !body || !body.active
      })
      if (inactive.length > 0) {
        throw new Error(mainFormat(tm.errors.spaceNotActivated, { spaces: inactive.join(', ') }))
      }
      return targets
    }
    const active = this.registry.active()
    if (active.length === 0) {
      throw new Error(tm.errors.noActiveSpace)
    }
    return active
  }

  /** 写入目标：指定 ID（未激活则自动激活）或第一个激活空间 */
  private resolveWriteTarget(memoryBodyId?: string): MemoryBody {
    const tm = mainToolMessages().mnemon
    if (memoryBodyId) {
      const body = this.registry.get(memoryBodyId)
      if (!body) throw new Error(mainFormat(tm.errors.spaceNotFound, { id: memoryBodyId }))
      if (!body.active) {
        // 对未激活目标写入成功后自动激活（对应 dsh-mnemon 行为）
        this.registry.update(memoryBodyId, { active: true })
      }
      return body
    }
    const active = this.registry.active()
    if (active.length === 0) {
      throw new Error(tm.errors.noActiveSpace)
    }
    return active[0]
  }

  /** 打开（并缓存）空间数据库 */
  private async openDb(bodyId: string): Promise<PGlite> {
    const cached = this.openDbs.get(bodyId)
    if (cached) return cached
    const body = this.registry.get(bodyId)
    if (!body) {
      throw new Error(mainFormat(mainToolMessages().mnemon.errors.spaceNotFound, { id: bodyId }))
    }
    const db = await openSpaceDatabase(body.dbPath)
    this.openDbs.set(bodyId, db)
    return db
  }

  /** 关闭全部已打开数据库（应用退出时调用） */
  async close(): Promise<void> {
    for (const [id, db] of this.openDbs) {
      try {
        await db.close()
      } catch (err) {
        logger.warn(`[Mnemon] Failed to close space ${id}:`, err)
      }
    }
    this.openDbs.clear()
  }
}

export type { MnemonCategory, MnemonSource }
