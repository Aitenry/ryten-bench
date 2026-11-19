import * as fs from 'fs'
import * as path from 'path'
import { PGlite } from '@electric-sql/pglite'
import logger from 'electron-log'
import { mainFormat, mainToolMessages } from '../../../../../main/i18n'
import { hashOf } from './runtime-memory'
import {
  MNEMON_EDGE_TYPES,
  type Insight,
  type MemoryBody,
  type MemoryBodyStats,
  type MnemonEdgeType,
  type RememberRequest,
  type SearchRequest
} from './types'

/**
 * Memory Spaces — 长期记忆空间（Mnemon 原生 Store 的 PGlite 实现）
 *
 * 移植自 dsh-mnemon 的 MemoryBodyRegistry + MnemonService 的存储面：
 * - 每个记忆空间是 `<storageRoot>/data/<space-id>/` 下的独立 PGlite 数据库；
 * - `.memory-bodies.json` 是空间目录元数据事实源（id/name/description/active）；
 * - insights 表：洞察本体（category/importance/tags/entities/source + 软删除标记）；
 * - edges 表：四类关系（temporal/semantic/causal/entity）；
 * - recall 支持 smart（词元重叠评分）/ keyword / basic（LIKE）三种模式；
 * - related 沿边 BFS 遍历；forget 为软删除；merge 非破坏性导入。
 */

// ============================================================================
// 空间内数据库
// ============================================================================

const SPACE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS insights (
  id          TEXT PRIMARY KEY,
  content     TEXT NOT NULL,
  category    TEXT,
  importance  INTEGER DEFAULT 3,
  tags        TEXT DEFAULT '[]',
  entities    TEXT DEFAULT '[]',
  source      TEXT,
  score       REAL DEFAULT 0,
  confidence  TEXT,
  intent      TEXT,
  source_hash TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted     INTEGER DEFAULT 0,
  deleted_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_insights_deleted ON insights(deleted);
CREATE INDEX IF NOT EXISTS idx_insights_category ON insights(category);
CREATE TABLE IF NOT EXISTS edges (
  id          TEXT PRIMARY KEY,
  source_id   TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  type        TEXT NOT NULL,
  weight      REAL DEFAULT 1,
  reason      TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
`

interface InsightRow {
  id: string
  content: string
  category: string | null
  importance: number | null
  tags: string | null
  entities: string | null
  source: string | null
  score: number | null
  confidence: string | null
  intent: string | null
  source_hash: string | null
  created_at: string
}

interface EdgeRow {
  id: string
  source_id: string
  target_id: string
  type: string
  weight: number | null
  reason: string | null
  created_at: string
}

/** 打开一个空间的 PGlite 数据库（目录即数据库） */
export async function openSpaceDatabase(dbDir: string): Promise<PGlite> {
  fs.mkdirSync(dbDir, { recursive: true })
  const db = new PGlite(dbDir)
  await db.exec(SPACE_SCHEMA_SQL)
  return db
}

function rowToInsight(row: InsightRow, memoryBodyId?: string, memoryBodyName?: string): Insight {
  let tags: string[] = []
  let entities: string[] = []
  try {
    tags = row.tags ? JSON.parse(row.tags) : []
    entities = row.entities ? JSON.parse(row.entities) : []
  } catch {
    // 忽略损坏的 JSON 数组
  }
  return {
    id: row.id,
    content: row.content,
    category: row.category ?? undefined,
    importance: row.importance ?? undefined,
    tags,
    entities,
    source: row.source ?? undefined,
    score: row.score ?? undefined,
    confidence: row.confidence ?? undefined,
    intent: row.intent ?? undefined,
    createdAt: row.created_at,
    memoryBodyId,
    memoryBodyName
  }
}

/** 智能召回评分：查询词元与内容词元重叠 + importance 加权 */
function smartScore(content: string, queryTerms: string[]): number {
  if (queryTerms.length === 0) return 1
  const text = content.toLowerCase()
  let hits = 0
  for (const term of queryTerms) {
    if (text.includes(term)) hits++
  }
  return hits / queryTerms.length
}

// ============================================================================
// 记忆体注册表
// ============================================================================

interface RegistryFile {
  version: number
  bodies: MemoryBody[]
}

const REGISTRY_VERSION = 1

/**
 * MemoryBodyRegistry — 记忆空间目录元数据（文件事实源 + 磁盘发现对账）
 */
export class MemoryBodyRegistry {
  readonly directory: string
  readonly registryPath: string

  private bodies: MemoryBody[] = []
  private readonly now: () => Date

  constructor(storageRoot: string, now: () => Date = () => new Date()) {
    this.directory = path.join(storageRoot, 'data')
    this.registryPath = path.join(this.directory, '.memory-bodies.json')
    this.now = now
    this.initialize()
  }

  private initialize(): void {
    fs.mkdirSync(this.directory, { recursive: true })
    this.loadAndReconcile()
  }

  list(): MemoryBody[] {
    return [...this.bodies]
  }

  active(): MemoryBody[] {
    return this.bodies.filter((b) => b.active)
  }

  get(id: string): MemoryBody | undefined {
    return this.bodies.find((b) => b.id === id)
  }

  /** 创建空间（目录 + 元数据）；写成功后自动激活（对应 dsh-mnemon 行为） */
  async create(request: {
    name: string
    description: string
    active?: boolean
    role?: 'archive'
  }): Promise<MemoryBody> {
    const tm = mainToolMessages().mnemon
    const id = crypto.randomUUID()
    const now = this.now().toISOString()
    const body: MemoryBody = {
      id,
      name: request.name.trim() || tm.defaultNames.untitledSpace,
      description: request.description.trim(),
      active: request.active ?? true,
      ...(request.role ? { role: request.role } : {}),
      dbPath: path.join(this.directory, id),
      createdAt: now,
      updatedAt: now
    }
    // 初始化数据库目录
    const db = await openSpaceDatabase(body.dbPath)
    await db.close()
    this.bodies.push(body)
    this.save()
    logger.info(`[Mnemon] 创建记忆空间 ${body.name}（${id}）`)
    return body
  }

  update(
    id: string,
    request: { name?: string; description?: string; active?: boolean }
  ): MemoryBody {
    const body = this.get(id)
    if (!body) throw new Error(mainFormat(mainToolMessages().mnemon.errors.spaceNotFound, { id }))
    if (request.name !== undefined) body.name = request.name.trim() || body.name
    if (request.description !== undefined) body.description = request.description.trim()
    if (request.active !== undefined) body.active = request.active
    body.updatedAt = this.now().toISOString()
    this.save()
    return body
  }

  /**
   * 非破坏性合并：把源空间内容导入目标空间；默认将源空间设为未激活。
   * openDb 注入式数据库获取（可选）：service 层传缓存 provider，避免同目录多实例；
   * 缺省直开并在用完后关闭。
   */
  async merge(
    targetBodyId: string,
    sourceBodyIds: string[],
    deactivateSources = true,
    openDb?: (bodyId: string) => Promise<{ db: PGlite; release: () => Promise<void> }>
  ): Promise<{ imported: number; skippedDuplicates: number }> {
    const tm = mainToolMessages().mnemon
    const target = this.get(targetBodyId)
    if (!target) throw new Error(mainFormat(tm.errors.targetSpaceNotFound, { id: targetBodyId }))

    const open =
      openDb ??
      (async (bodyId: string): Promise<{ db: PGlite; release: () => Promise<void> }> => {
        const body = this.get(bodyId)
        if (!body) throw new Error(mainFormat(tm.errors.spaceNotFound, { id: bodyId }))
        const db = await openSpaceDatabase(body.dbPath)
        return { db, release: async () => await db.close() }
      })

    const targetHandle = await open(targetBodyId)
    const targetDb = targetHandle.db

    let imported = 0
    let skippedDuplicates = 0
    try {
      for (const sourceId of sourceBodyIds) {
        const source = this.get(sourceId)
        if (!source) {
          logger.warn(`[Mnemon] 合并跳过：源空间不存在 ${sourceId}`)
          continue
        }
        if (source.id === target.id) continue
        const sourceHandle = await open(sourceId)
        try {
          const result = await sourceHandle.db.query<InsightRow>(
            'SELECT * FROM insights WHERE deleted = 0'
          )
          for (const row of result.rows) {
            const existing = await targetDb.query<{ c: number }>(
              'SELECT COUNT(*) AS c FROM insights WHERE source_hash = $1 AND deleted = 0',
              [row.source_hash ?? hashOf(row.content)]
            )
            if (Number(existing.rows[0]?.c ?? 0) > 0) {
              skippedDuplicates++
              continue
            }
            await targetDb.query(
              `INSERT INTO insights (id, content, category, importance, tags, entities, source, score, confidence, intent, source_hash, created_at, updated_at, deleted)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,0)`,
              [
                crypto.randomUUID(),
                row.content,
                row.category,
                row.importance,
                row.tags,
                row.entities,
                row.source,
                row.score,
                row.confidence,
                row.intent,
                row.source_hash ?? hashOf(row.content),
                row.created_at,
                this.now().toISOString()
              ]
            )
            imported++
          }
        } finally {
          await sourceHandle.release()
        }
      }
    } finally {
      await targetHandle.release()
    }

    if (deactivateSources) {
      for (const sourceId of sourceBodyIds) {
        const body = this.get(sourceId)
        if (body && body.id !== target.id) {
          body.active = false
          body.updatedAt = this.now().toISOString()
        }
      }
      this.save()
    }
    return { imported, skippedDuplicates }
  }

  private loadAndReconcile(): void {
    try {
      if (fs.existsSync(this.registryPath)) {
        const parsed = JSON.parse(fs.readFileSync(this.registryPath, 'utf-8')) as RegistryFile
        if (parsed.version === REGISTRY_VERSION && Array.isArray(parsed.bodies)) {
          this.bodies = parsed.bodies
        }
      }
    } catch (err) {
      logger.warn('[Mnemon] 读取 .memory-bodies.json 失败，使用空注册表:', err)
    }
    // 磁盘发现对账：既有空间目录自动登记（不移动数据库）
    try {
      const entries = fs.readdirSync(this.directory, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (entry.name.startsWith('.')) continue
        const dbPath = path.join(this.directory, entry.name)
        const hasDb = fs.existsSync(path.join(dbPath, 'postgresql.conf')) || fs.existsSync(dbPath)
        if (!hasDb) continue
        if (!this.bodies.some((b) => b.id === entry.name)) {
          const now = this.now().toISOString()
          this.bodies.push({
            id: entry.name,
            name: mainFormat(mainToolMessages().mnemon.defaultNames.discoveredSpace, {
              id: entry.name.slice(0, 8)
            }),
            description: mainToolMessages().mnemon.defaultNames.discoveredSpaceDescription,
            active: true,
            dbPath,
            createdAt: now,
            updatedAt: now
          })
        }
      }
      if (this.bodies.length > 0 && !fs.existsSync(this.registryPath)) {
        this.save()
      }
    } catch (err) {
      logger.warn('[Mnemon] 记忆空间磁盘发现失败:', err)
    }
  }

  private save(): void {
    const file: RegistryFile = { version: REGISTRY_VERSION, bodies: this.bodies }
    const tmpPath = this.registryPath + '.tmp'
    fs.writeFileSync(tmpPath, JSON.stringify(file, null, 2), 'utf-8')
    fs.renameSync(tmpPath, this.registryPath)
  }
}

// ============================================================================
// 空间数据操作（召回 / 写入 / 关系 / 统计）
// ============================================================================

/** 查询洞察：smart / keyword / basic 三种模式 */
export async function searchInsights(
  db: PGlite,
  request: SearchRequest,
  bodyId: string,
  bodyName: string
): Promise<Insight[]> {
  const limit = Math.min(request.limit ?? 10, 20)
  const queryTerms = request.query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0)

  if (request.mode === 'basic') {
    const like = `%${request.query}%`
    const result = await db.query<InsightRow>(
      `SELECT * FROM insights WHERE deleted = 0 AND content LIKE $1
       ORDER BY importance DESC, created_at DESC LIMIT $2`,
      [like, limit]
    )
    return result.rows.map((r) => rowToInsight(r, bodyId, bodyName))
  }

  if (request.mode === 'keyword') {
    // keyword：所有词元必须命中（内容或类别），按词元命中数排序
    const result = await db.query<InsightRow>('SELECT * FROM insights WHERE deleted = 0')
    const scored = result.rows
      .map((row) => {
        const text = `${row.content} ${row.category ?? ''}`.toLowerCase()
        const hits = queryTerms.filter((t) => text.includes(t)).length
        return { row, hits, score: hits }
      })
      .filter((x) => x.hits === queryTerms.length)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
    return scored.map((x) => rowToInsight(x.row, bodyId, bodyName))
  }

  // smart：词元重叠评分 + importance 加权
  const result = await db.query<InsightRow>('SELECT * FROM insights WHERE deleted = 0')
  const scored = result.rows
    .map((row) => {
      const overlap = smartScore(row.content, queryTerms)
      const importanceBoost = (row.importance ?? 3) / 10
      return { row, score: overlap + importanceBoost }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
  return scored.map((x) => ({
    ...rowToInsight(x.row, bodyId, bodyName),
    score: Number(x.score.toFixed(3)),
    matchedVia: request.mode === 'keyword' ? 'keyword' : 'smart'
  }))
}

/** 写入一条洞察（source_hash 查重） */
export async function rememberInsight(
  db: PGlite,
  request: RememberRequest,
  bodyId: string,
  bodyName: string
): Promise<Insight> {
  const tm = mainToolMessages().mnemon
  const content = request.content.trim()
  if (!content) throw new Error(tm.errors.contentRequired)
  const sourceHash = hashOf(content)

  // 查重：完全相同内容不重复写入
  const existing = await db.query<{ c: number }>(
    'SELECT COUNT(*) AS c FROM insights WHERE source_hash = $1 AND deleted = 0',
    [sourceHash]
  )
  if (Number(existing.rows[0]?.c ?? 0) > 0) {
    throw new Error(tm.errors.insightExists)
  }

  const now = new Date().toISOString()
  const insight: Insight = {
    id: crypto.randomUUID(),
    content,
    category: request.category,
    importance: request.importance ?? 3,
    tags: request.tags ?? [],
    entities: request.entities ?? [],
    source: request.source ?? 'agent',
    createdAt: now,
    memoryBodyId: bodyId,
    memoryBodyName: bodyName
  }
  await db.query(
    `INSERT INTO insights (id, content, category, importance, tags, entities, source, score, confidence, intent, source_hash, created_at, updated_at, deleted)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,0)`,
    [
      insight.id,
      content,
      request.category ?? null,
      request.importance ?? 3,
      JSON.stringify(request.tags ?? []),
      JSON.stringify(request.entities ?? []),
      request.source ?? 'agent',
      0,
      null,
      null,
      sourceHash,
      now,
      now
    ]
  )
  return insight
}

/** 关系遍历：沿边 BFS（depth 最多 2 跳，可按边类型过滤） */
export async function relatedInsights(
  db: PGlite,
  id: string,
  depth: number,
  edgeType?: MnemonEdgeType,
  bodyId?: string,
  bodyName?: string
): Promise<Insight[]> {
  const seen = new Set<string>([id])
  let frontier = [id]
  const results: Insight[] = []
  const maxDepth = Math.min(Math.max(depth, 1), 2)

  for (let d = 1; d <= maxDepth; d++) {
    const next: string[] = []
    for (const current of frontier) {
      const edges = await db.query<EdgeRow>(
        `SELECT * FROM edges WHERE (source_id = $1 OR target_id = $1) AND ($2 = '' OR type = $2)`,
        [current, edgeType ?? '']
      )
      for (const edge of edges.rows) {
        const neighbor = edge.source_id === current ? edge.target_id : edge.source_id
        if (seen.has(neighbor)) continue
        seen.add(neighbor)
        next.push(neighbor)
        const insight = await db.query<InsightRow>(
          'SELECT * FROM insights WHERE id = $1 AND deleted = 0',
          [neighbor]
        )
        if (insight.rows[0]) {
          results.push({
            ...rowToInsight(insight.rows[0], bodyId, bodyName),
            depth: d,
            edgeType: edge.type
          })
        }
      }
    }
    frontier = next
  }
  return results.slice(0, 12)
}

/** 建立关系 */
export async function linkInsights(
  db: PGlite,
  sourceId: string,
  targetId: string,
  type: MnemonEdgeType,
  weight: number,
  reason?: string
): Promise<void> {
  const tm = mainToolMessages().mnemon
  if (!MNEMON_EDGE_TYPES.includes(type)) {
    throw new Error(
      mainFormat(tm.errors.relationTypeInvalid, { values: MNEMON_EDGE_TYPES.join(' / ') })
    )
  }
  if (sourceId === targetId) throw new Error(tm.errors.selfRelation)
  const now = new Date().toISOString()
  await db.query(
    `INSERT INTO edges (id, source_id, target_id, type, weight, reason, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [crypto.randomUUID(), sourceId, targetId, type, weight, reason ?? null, now]
  )
}

/** 软删除一条洞察 */
export async function forgetInsight(db: PGlite, id: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE insights SET deleted = 1, deleted_at = $2 WHERE id = $1 AND deleted = 0`,
    [id, new Date().toISOString()]
  )
  return (result.affectedRows ?? 0) > 0
}

/** 空间统计 */
export async function spaceStats(db: PGlite): Promise<MemoryBodyStats> {
  const total = await db.query<{ c: number }>(
    'SELECT COUNT(*) AS c FROM insights WHERE deleted = 0'
  )
  const deleted = await db.query<{ c: number }>(
    'SELECT COUNT(*) AS c FROM insights WHERE deleted = 1'
  )
  const edges = await db.query<{ c: number }>('SELECT COUNT(*) AS c FROM edges')
  const byCategoryRows = await db.query<{ category: string | null; c: number }>(
    'SELECT category, COUNT(*) AS c FROM insights WHERE deleted = 0 GROUP BY category'
  )
  const byCategory: Record<string, number> = {}
  for (const row of byCategoryRows.rows) {
    byCategory[row.category ?? 'general'] = Number(row.c)
  }
  const entityRows = await db.query<{ entity: string; c: number }>(
    `SELECT (e.value #>> '{}') AS entity, COUNT(*) AS c
     FROM insights i, jsonb_array_elements(i.entities::jsonb) AS e
     WHERE i.deleted = 0
     GROUP BY e.value ORDER BY c DESC LIMIT 10`
  )
  return {
    totalInsights: Number(total.rows[0]?.c ?? 0),
    deletedInsights: Number(deleted.rows[0]?.c ?? 0),
    edgeCount: Number(edges.rows[0]?.c ?? 0),
    dbSizeBytes: 0,
    byCategory,
    topEntities: entityRows.rows.map((r) => ({ entity: r.entity, count: Number(r.c) }))
  }
}

/** 全部洞察（内容浏览） */
export async function listInsights(
  db: PGlite,
  bodyId: string,
  bodyName: string,
  limit = 50
): Promise<Insight[]> {
  const result = await db.query<InsightRow>(
    'SELECT * FROM insights WHERE deleted = 0 ORDER BY importance DESC, created_at DESC LIMIT $1',
    [limit]
  )
  return result.rows.map((r) => rowToInsight(r, bodyId, bodyName))
}
