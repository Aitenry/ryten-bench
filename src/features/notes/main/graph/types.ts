export interface BuildConfig {
  /** 最大并发 LLM 调用数（默认 8） */
  maxConcurrency?: number
  /** 是否强制重建 */
  force?: boolean
  gleaningThreshold?: number
  /** 是否启用 gleaning（二次抽取遗漏实体，默认 true） */
  enableGleaning?: boolean
  /** Gleaning 最大处理文档数：当库中文档很多时限制 gleaning 总成本（默认 100，设为 0 不限） */
  gleaningMaxDocs?: number
  /** Markdown 分块最大字符数（默认 2000） */
  maxChunkSize?: number
  /** 单次 LLM 调用处理的文档数量（批量模式，默认 1） */
  batchSize?: number
  /** 混合置信度权重：LLM 置信度占比（默认 0.6） */
  llmConfidenceWeight?: number
  /** 混合置信度权重：统计特征占比（默认 0.4） */
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

/** 文本分块结果 */
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
