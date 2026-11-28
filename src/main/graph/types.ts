export interface BuildConfig {
  /** Maximum number of concurrent LLM calls (default 8) */
  maxConcurrency?: number
  /** Whether to force a full rebuild */
  force?: boolean
  gleaningThreshold?: number
  /** Whether to enable gleaning, a second pass for missed entities (default true) */
  enableGleaning?: boolean
  /**
   * Max documents gleaning may process, capping its total cost on large libraries
   * (default 100; 0 means unlimited)
   */
  gleaningMaxDocs?: number
  /** Max characters per Markdown chunk (default 2000) */
  maxChunkSize?: number
  /** Documents processed per single LLM call in batch mode (default 1) */
  batchSize?: number
  /** Hybrid confidence weight: share of the LLM confidence (default 0.6) */
  llmConfidenceWeight?: number
  /** Hybrid confidence weight: share of the statistical score (default 0.4) */
  statConfidenceWeight?: number
}

export interface ExtractedEntity {
  name: string
  type: string
  description: string
  aliases: string[]
  confidence: number
  source_doc_ids: number[]
  relationCount?: number
}

export interface ExtractedRelation {
  source: string
  target: string
  relation_type: string
  description: string
}

export type ProgressCallback = (progress: {
  wikiId: number
  phase: string
  phaseLabel: string
  phaseProgress: number
  overallProgress: number
  processedDocs: number
  totalDocs: number
  processedChunks: number
  totalChunks: number
  entityCount: number
  relationCount: number
  message: string
  needsRefresh?: boolean
}) => void

/** A text chunk */
export interface TextChunk {
  docId: number
  chunkIndex: number
  content: string
}

export interface EntityStats {
  relationCount: number
  totalEntities: number
  totalDocs: number
  totalRelations: number
}
