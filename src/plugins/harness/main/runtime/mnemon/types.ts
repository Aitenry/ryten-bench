/**
 * Mnemon 记忆机制 — 类型契约
 *
 * 移植自 deepseek-harness 的 dsh-mnemon 插件（@omdsh-dev/dsh-mnemon，MIT），
 * 三层记忆模型：
 *   1. Runtime Memory   — 每轮注入的紧凑热记忆（memories.json 事实源 + Markdown 投影）
 *   2. Project Documents — 完整 Markdown 项目知识（index.json + active/archived 冷热分层）
 *   3. Memory Spaces    — 长期记忆空间（PGlite Store + 四类关系 + 按需召回）
 *
 * 类型命名与 dsh-mnemon 的公开契约保持一致，便于对照。
 */

// ============================================================================
// Runtime Memory
// ============================================================================

export const RUNTIME_MEMORY_VERSION = 1
/** Markdown 投影条目分隔符（保留字符） */
export const RUNTIME_ENTRY_DELIMITER = '\n§\n'
/** 容量上限：memory 10 KiB / user 4 KiB（按投影正文 UTF-8 字节） */
export const RUNTIME_MEMORY_LIMITS = {
  memory: 10 * 1024,
  user: 4 * 1024
} as const
/** 单条内容上限 */
export const RUNTIME_ENTRY_MAX_BYTES = 8 * 1024

export type RuntimeMemoryTarget = keyof typeof RUNTIME_MEMORY_LIMITS
export type RuntimeMemoryImportance = 'critical' | 'normal' | 'low'
export type RuntimeMemoryAction = 'add' | 'replace' | 'remove'

export interface RuntimeMemoryEntry {
  content: string
  created_at: string
  updated_at: string
  target: RuntimeMemoryTarget
  importance: RuntimeMemoryImportance
}

export interface RuntimeMemoryUsage {
  used: number
  limit: number
}

export interface RuntimeMemoryTargetView extends RuntimeMemoryUsage {
  target: RuntimeMemoryTarget
  entryCount: number
  markdownPath: string
}

export interface RuntimeMemorySnapshot {
  directory: string
  sourcePath: string
  revision: string
  generatedAt: string
  entries: RuntimeMemoryEntry[]
  targets: Record<RuntimeMemoryTarget, RuntimeMemoryTargetView>
}

export interface RuntimeMemoryMutation {
  action: RuntimeMemoryAction
  target: RuntimeMemoryTarget
  content?: string
  oldText?: string
  importance?: RuntimeMemoryImportance
}

export interface RuntimeMemoryMaintenance {
  kind: 'local-compaction' | 'mnemon-archive'
  summary: string
  memoryBodyIds: string[]
}

export type RuntimeMemoryMutationResult =
  | {
      success: true
      message: string
      target: RuntimeMemoryTarget
      entryCount: number
      usage: RuntimeMemoryUsage
      added?: string
      replaced?: { from: string; to: string }
      removed?: string
      maintenance?: RuntimeMemoryMaintenance
    }
  | { success: false; message: string }

// ============================================================================
// Project Documents
// ============================================================================

export const DOCUMENTS_VERSION = 1
/** active 总量上限 10 MiB */
export const DOCUMENTS_ACTIVE_LIMIT_BYTES = 10 * 1024 * 1024
/** 单份正文上限 2 MiB */
export const DOCUMENT_MAX_BYTES = 2 * 1024 * 1024

export type DocumentStatus = 'active' | 'archived'

export interface DocumentRecord {
  id: string
  title: string
  description: string
  status: DocumentStatus
  filename: string
  relativePath: string
  sourcePaths: string[]
  createdAt: string
  updatedAt: string
  lastAccessedAt: string
  revision: number
  contentHash: string
  sizeBytes: number
  archivedAt?: string
  archiveSummary?: string
}

export interface DocumentView extends DocumentRecord {
  content: string
}

export interface DocumentSnapshot {
  directory: string
  indexPath: string
  generatedAt: string
  limitBytes: number
  activeBytes: number
  activeCount: number
  archivedCount: number
  total: number
  documents: Array<DocumentRecord & { healthy: boolean; excerpt: string }>
}

export interface DocumentSearchResult {
  query: string
  includeArchived: boolean
  total: number
  generatedAt: string
  results: Array<DocumentView & { score: number; excerpt: string }>
}

export type DocumentMutation =
  | {
      action: 'create'
      title: string
      description?: string
      content: string
      sourcePaths?: string[]
    }
  | {
      action: 'update'
      id: string
      title?: string
      description?: string
      content?: string
      sourcePaths?: string[]
    }

export interface DocumentMutationResult {
  success: true
  action: 'created' | 'updated' | 'archived'
  document: DocumentView
}

// ============================================================================
// Memory Spaces（长期记忆）
// ============================================================================

/** 洞察类别（与 Mnemon 一致） */
export const MNEMON_CATEGORIES = [
  'preference',
  'decision',
  'fact',
  'insight',
  'context',
  'general'
] as const
export type MnemonCategory = (typeof MNEMON_CATEGORIES)[number]

/** 洞察来源 */
export const MNEMON_SOURCES = ['user', 'agent', 'external'] as const
export type MnemonSource = (typeof MNEMON_SOURCES)[number]

/** 四类关系 */
export const MNEMON_EDGE_TYPES = ['temporal', 'semantic', 'causal', 'entity'] as const
export type MnemonEdgeType = (typeof MNEMON_EDGE_TYPES)[number]

/** 召回意图 */
export const MNEMON_INTENTS = ['WHY', 'WHEN', 'ENTITY', 'GENERAL'] as const
export type MnemonIntent = (typeof MNEMON_INTENTS)[number]

export interface Insight {
  id: string
  content: string
  category?: string
  importance?: number
  tags?: string[]
  entities?: string[]
  source?: string
  score?: number
  confidence?: string
  intent?: string
  matchedVia?: string
  createdAt?: string
  depth?: number
  edgeType?: string
  memoryBodyId?: string
  memoryBodyName?: string
}

export interface SearchRequest {
  query: string
  mode?: 'smart' | 'keyword' | 'basic'
  limit?: number
  category?: MnemonCategory
  source?: MnemonSource
  intent?: MnemonIntent
  memoryBodyIds?: string[]
}

export interface RememberRequest {
  content: string
  category?: MnemonCategory
  importance?: number
  tags?: string[]
  entities?: string[]
  source?: MnemonSource
  memoryBodyId?: string
}

export interface MemoryBody {
  id: string
  name: string
  description: string
  active: boolean
  /** 空间用途（结构化角色；archive=热记忆溢出归档目标），不依赖名称判定 */
  role?: 'archive'
  dbPath: string
  createdAt: string
  updatedAt: string
}

export interface MemoryBodyStats {
  totalInsights: number
  deletedInsights: number
  edgeCount: number
  dbSizeBytes: number
  byCategory: Record<string, number>
  topEntities: Array<{ entity: string; count: number }>
}

export interface MemoryBodyView extends MemoryBody {
  healthy: boolean
  error?: string
  stats?: MemoryBodyStats
}

export interface MemoryBodyCatalog {
  items: MemoryBodyView[]
  total: number
  activeCount: number
  directory: string
  generatedAt: string
}
