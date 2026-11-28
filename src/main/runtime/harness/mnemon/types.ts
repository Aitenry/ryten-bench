/**
 * Mnemon memory mechanism — type contracts
 *
 * Three-layer memory model:
 *   1. Runtime Memory   — compact hot memory injected every turn (memories.json source of truth + Markdown projections)
 *   2. Project Documents — complete Markdown project knowledge (index.json + active/archived hot/cold tiers)
 *   3. Memory Spaces    — long-term memory spaces (PGlite Store + four relation types + on-demand recall)
 *
 * Type names follow the public contract for easy cross-referencing.
 */

// ============================================================================
// Runtime Memory
// ============================================================================

export const RUNTIME_MEMORY_VERSION = 1
/** Markdown projection entry delimiter (reserved character) */
export const RUNTIME_ENTRY_DELIMITER = '\n§\n'
/** Capacity limits: memory 10 KiB / user 4 KiB (by UTF-8 bytes of projected body text) */
export const RUNTIME_MEMORY_LIMITS = {
  memory: 10 * 1024,
  user: 4 * 1024
} as const
/** Per-entry content limit */
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
/** active total limit 10 MiB */
export const DOCUMENTS_ACTIVE_LIMIT_BYTES = 10 * 1024 * 1024
/** Per-document body limit 2 MiB */
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
// Memory Spaces (long-term memory)
// ============================================================================

/** Insight categories */
export const MNEMON_CATEGORIES = [
  'preference',
  'decision',
  'fact',
  'insight',
  'context',
  'general'
] as const
export type MnemonCategory = (typeof MNEMON_CATEGORIES)[number]

/** Insight source */
export const MNEMON_SOURCES = ['user', 'agent', 'external'] as const
export type MnemonSource = (typeof MNEMON_SOURCES)[number]

/** Four relation types */
export const MNEMON_EDGE_TYPES = ['temporal', 'semantic', 'causal', 'entity'] as const
export type MnemonEdgeType = (typeof MNEMON_EDGE_TYPES)[number]

/** Recall intent */
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
  /** Space purpose (structured role; archive=target for hot-memory overflow archiving); does not depend on the name */
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
