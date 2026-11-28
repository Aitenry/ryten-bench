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
 * MnemonService — application facade for the memory system
 *
 * Organizes three control planes — Runtime Memory, Documents and Memory Spaces —
 * exposing deterministic services to the tool layer (no LLM judgment).
 */

export interface MnemonServiceOptions {
  /** Root directory for memory-system storage */
  storageRoot: string
  /** Hot-memory controller (may be injected later to avoid a construction cycle) */
  runtimeMemory?: RuntimeMemoryController
  /** Document controller (may be injected later) */
  documents?: DocumentController
}

export class MnemonService {
  readonly registry: MemoryBodyRegistry
  readonly storageRoot: string
  runtimeMemory?: RuntimeMemoryController
  documents?: DocumentController

  /** Cache of opened PGlite instances (by space ID) */
  private readonly openDbs = new Map<string, PGlite>()

  constructor(options: MnemonServiceOptions) {
    this.storageRoot = options.storageRoot
    this.registry = new MemoryBodyRegistry(options.storageRoot)
    this.runtimeMemory = options.runtimeMemory
    this.documents = options.documents
  }

  // --------------------------------------------------------------------------
  // Catalog and state
  // --------------------------------------------------------------------------

  /** Memory Space catalog (with statistics; reuses opened instances to avoid lock conflicts between instances on the same directory) */
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
  // Recall (read-only)
  // --------------------------------------------------------------------------

  /**
   * Recalls from one or more active Memory Spaces.
   * When memoryBodyIds is omitted, all active spaces are used; each space recalls
   * independently, then results are merged and sorted by score.
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
    // Merge and sort: descending by score, truncated to limit (default 10)
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

  /** Relation traversal */
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

  /** Content listing (no recall side effects) */
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
  // Long-term writes
  // --------------------------------------------------------------------------

  /** Persists one insight; uses the first active space when no space is specified */
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

  /** Creates a relation */
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

  /** Soft delete */
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

  /** Creates a Memory Space */
  async createBody(request: {
    name: string
    description: string
    active?: boolean
    role?: 'archive'
  }): Promise<MemoryBody> {
    this.validateWrite()
    return await this.registry.create(request)
  }

  /** Updates Memory Space metadata */
  updateBody(
    id: string,
    request: { name?: string; description?: string; active?: boolean }
  ): MemoryBody {
    this.validateWrite()
    return this.registry.update(id, request)
  }

  /** Non-destructive merge */
  async mergeBodies(
    targetBodyId: string,
    sourceBodyIds: string[],
    deactivateSources = true
  ): Promise<{ imported: number; skippedDuplicates: number }> {
    this.validateWrite()
    // Obtain the database instance through the openDb cache (fix: registry.merge used to open a
    // second instance on the same directory alongside the cached one; multiple instances on one
    // directory risk lock conflicts and inconsistency — cached instances are closed by close())
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
  // Internal implementation
  // --------------------------------------------------------------------------

  private validateWrite(): void {
    // Write entry point: validated before registry updates (reserved write-permission switch)
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

  /** Write target: the specified ID (auto-activated if inactive) or the first active space */
  private resolveWriteTarget(memoryBodyId?: string): MemoryBody {
    const tm = mainToolMessages().mnemon
    if (memoryBodyId) {
      const body = this.registry.get(memoryBodyId)
      if (!body) throw new Error(mainFormat(tm.errors.spaceNotFound, { id: memoryBodyId }))
      if (!body.active) {
        // Auto-activate an inactive target after a successful write
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

  /** Opens (and caches) a space database */
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

  /** Closes all opened databases (called when the application exits) */
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
