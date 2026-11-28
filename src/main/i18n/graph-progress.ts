/**
 * Knowledge graph build progress texts (phase labels and progress messages shown in the progress
 * card and notifications).
 * Sent to the renderer process by the graph build services.
 * Chinese is the source language; `enUSGraphProgress` is typed against `typeof zhCNGraphProgress`.
 */
export const zhCNGraphProgress = {
  /** Phase labels: keyed by the phase key passed as sendProgress's first argument */
  labels: {
    cleanup: '清理数据',
    collect: '收集文档',
    extract: '抽取实体与关系',
    gleaning: '二次抽取遗漏实体',
    mergeEntities: '实体消歧合并',
    crossChunk: '跨块关系补全',
    saveEntities: '保存实体',
    loadExistingRelations: '加载已有关系',
    adjustConfidence: '计算混合置信度',
    updateConfidence: '更新实体置信度',
    saveRelations: '保存关系'
  },
  /** Progress messages: the second argument of sendProgress */
  messages: {
    cleaningUp: '清理已有图谱数据...',
    cleanupDone: '清理完成',
    collectingWikiDocs: '收集知识库文档...',
    collectDone: '收集完成，共 {{count}} 篇文档',
    readingDocs: '读取文档内容...',
    preparingChunks: '准备文本分块...',
    loadingExistingEntities: '加载已有图谱实体...',
    extractionStarted: '开始实体和关系抽取... {{count}} 个文本块',
    extractionProgress: '抽取中... {{done}}/{{total}} 块（{{entities}} 实体，{{relations}} 关系）',
    gleaningStarted: '二次扫描遗漏实体... {{count}} 个文本块',
    gleaningProgress: '二次抽取中... {{done}}/{{total}} 块（{{entities}} 实体）',
    merging: '实体消歧合并中...',
    mergingBatches: '实体消歧合并中... {{done}}/{{total}} 批次',
    mergingDone: '实体消歧合并完成，共 {{count}} 个实体',
    crossChunkStarted: '跨块关系补全中... {{count}} 个片段',
    crossChunkProgress: '跨块关系补全中... {{done}}/{{total}}',
    savingEntities: '保存 {{count}} 个实体...',
    entitiesSaved: '实体保存完成',
    loadingExistingRelations: '加载已有关系...',
    relationsLoaded: '加载完成，共 {{count}} 条关系',
    adjustingConfidence: '计算混合置信度...',
    updatingConfidence: '更新实体置信度...',
    confidenceUpdated: '实体置信度更新完成',
    /** build-graph saves cross-chunk relations */
    savingRelations: '保存跨块关系...',
    /** append-docs saves all relations */
    savingCrossChunkRelations: '保存关系...',
    relationsSaved: '关系保存完成，共 {{count}} 条',
    docFallbackTitle: '文档 #{{id}}'
  },
  /** Errors that surface in the UI through IPC */
  errors: {
    emptyDocs: '所选文档均不存在或内容为空'
  }
}

export const enUSGraphProgress: typeof zhCNGraphProgress = {
  labels: {
    cleanup: 'Cleaning up data',
    collect: 'Collecting documents',
    extract: 'Extracting entities and relations',
    gleaning: 'Gleaning missed entities',
    mergeEntities: 'Merging duplicate entities',
    crossChunk: 'Completing cross-chunk relations',
    saveEntities: 'Saving entities',
    loadExistingRelations: 'Loading existing relations',
    adjustConfidence: 'Computing hybrid confidence',
    updateConfidence: 'Updating entity confidence',
    saveRelations: 'Saving relations'
  },
  messages: {
    cleaningUp: 'Cleaning up existing graph data...',
    cleanupDone: 'Cleanup complete',
    collectingWikiDocs: 'Collecting knowledge base documents...',
    collectDone: 'Collection complete — {{count}} documents',
    readingDocs: 'Reading document contents...',
    preparingChunks: 'Preparing text chunks...',
    loadingExistingEntities: 'Loading existing graph entities...',
    extractionStarted: 'Starting entity and relation extraction... {{count}} chunks',
    extractionProgress:
      'Extracting... chunk {{done}}/{{total}} ({{entities}} entities, {{relations}} relations)',
    gleaningStarted: 'Scanning for missed entities... {{count}} chunks',
    gleaningProgress: 'Second pass... chunk {{done}}/{{total}} ({{entities}} entities)',
    merging: 'Merging duplicate entities...',
    mergingBatches: 'Merging duplicate entities... batch {{done}}/{{total}}',
    mergingDone: 'Entity merge complete — {{count}} entities',
    crossChunkStarted: 'Completing cross-chunk relations... {{count}} segments',
    crossChunkProgress: 'Completing cross-chunk relations... {{done}}/{{total}}',
    savingEntities: 'Saving {{count}} entities...',
    entitiesSaved: 'Entities saved',
    loadingExistingRelations: 'Loading existing relations...',
    relationsLoaded: 'Loading complete — {{count}} relations',
    adjustingConfidence: 'Computing hybrid confidence...',
    updatingConfidence: 'Updating entity confidence...',
    confidenceUpdated: 'Entity confidence updated',
    savingRelations: 'Saving cross-chunk relations...',
    savingCrossChunkRelations: 'Saving relations...',
    relationsSaved: 'Relations saved — {{count}} total',
    docFallbackTitle: 'Document #{{id}}'
  },
  errors: {
    emptyDocs: 'None of the selected documents exist or they are all empty'
  }
}
