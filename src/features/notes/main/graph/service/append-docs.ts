import logger from 'electron-log'
import {
  batchUpsertEntities,
  batchUpsertRelations,
  batchUpdateEntityConfidence,
  getFullGraphData,
  getBuildJobByWikiId,
  getRelationsByWikiId,
  updateBuildJob
} from '../../db/mapper/graph'
import { getDocById } from '../../db/mapper/document'
import {
  splitByMarkdownHeaders,
  filterEntitiesInText,
  assembleDocContent,
  applyHybridConfidence
} from '../utils'
import type {
  BuildConfig,
  ExtractedEntity,
  ExtractedRelation,
  ProgressCallback,
  TextChunk
} from '../types'
import type { ServiceContext } from './llm-invoke'
import { extractEntitiesAndRelations, gleanEntities } from './extraction'
import { mergeEntities } from './merging'
import { extractIncrementalCrossChunkRelations } from './cross-chunk'
import { mainFormat, mainMessages } from '../../../../../main/i18n'

export async function appendDocs(
  ctx: ServiceContext,
  wikiId: number,
  docIds: number[],
  onProgress?: ProgressCallback,
  config?: BuildConfig
): Promise<{ entitiesAdded: number; relationsAdded: number }> {
  const maxConcurrency = config?.maxConcurrency ?? 8
  const maxChunkSize = config?.maxChunkSize
  const startTime = Date.now()
  const totalDocs = docIds.length
  const gp = mainMessages().graphProgress

  const PHASES = {
    collect: { label: gp.labels.collect, weight: 10 },
    extract: { label: gp.labels.extract, weight: 40 },
    gleaning: { label: gp.labels.gleaning, weight: 10 },
    merge_entities: { label: gp.labels.mergeEntities, weight: 10 },
    cross_chunk: { label: gp.labels.crossChunk, weight: 10 },
    save_entities: { label: gp.labels.saveEntities, weight: 5 },
    load_existing_relations: { label: gp.labels.loadExistingRelations, weight: 5 },
    adjust_confidence: { label: gp.labels.adjustConfidence, weight: 5 },
    update_confidence: { label: gp.labels.updateConfidence, weight: 5 },
    save_relations: { label: gp.labels.saveRelations, weight: 10 }
  }

  const PHASE_ORDER = [
    'collect',
    'extract',
    'gleaning',
    'merge_entities',
    'cross_chunk',
    'save_entities',
    'load_existing_relations',
    'adjust_confidence',
    'update_confidence',
    'save_relations'
  ] as const
  const TOTAL_WEIGHT = PHASE_ORDER.reduce((sum, phase) => sum + PHASES[phase].weight, 0)

  let currentPhaseIndex = 0
  let phaseProgress = 0

  const sendProgress = (
    phase: string,
    message: string,
    details: {
      processedDocs?: number
      totalDocs?: number
      processedChunks?: number
      totalChunks?: number
      entityCount?: number
      relationCount?: number
      needsRefresh?: boolean
    } = {}
  ): void => {
    const phaseIndex = PHASE_ORDER.indexOf(phase as (typeof PHASE_ORDER)[number])
    if (phaseIndex >= 0 && phaseIndex > currentPhaseIndex) {
      currentPhaseIndex = phaseIndex
      phaseProgress = 0
    }

    const completedWeight = PHASE_ORDER.slice(0, currentPhaseIndex).reduce(
      (sum, p) => sum + PHASES[p].weight,
      0
    )
    const currentPhase = PHASES[phase as keyof typeof PHASES]

    let overallProgress = completedWeight
    if (currentPhase) {
      overallProgress += currentPhase.weight * phaseProgress
    }
    overallProgress = Math.min(100, Math.round((overallProgress / TOTAL_WEIGHT) * 100))

    onProgress?.({
      wikiId,
      phase,
      phaseLabel: currentPhase?.label || phase,
      phaseProgress: Math.round(phaseProgress * 100),
      overallProgress,
      processedDocs: details.processedDocs ?? 0,
      totalDocs: details.totalDocs ?? 0,
      processedChunks: details.processedChunks ?? 0,
      totalChunks: details.totalChunks ?? 0,
      entityCount: details.entityCount ?? 0,
      relationCount: details.relationCount ?? 0,
      message,
      needsRefresh: details.needsRefresh
    })
  }

  if (totalDocs === 0) {
    return { entitiesAdded: 0, relationsAdded: 0 }
  }

  // 1. 并行读取所有文档内容
  currentPhaseIndex = PHASE_ORDER.indexOf('collect')
  phaseProgress = 0
  sendProgress('collect', gp.messages.readingDocs, { totalDocs })

  const docEntries: { docId: number; content: string; title: string }[] = []
  for (let i = 0; i < docIds.length; i++) {
    const note = await getDocById(docIds[i])
    if (!note || !note.content) {
      logger.warn(`Doc ${docIds[i]} not found or empty, skipping`)
      continue
    }
    docEntries.push({
      docId: note.id,
      title: note.title,
      content: assembleDocContent(note.title, note.content)
    })
  }

  if (docEntries.length === 0) {
    throw new Error(gp.errors.emptyDocs)
  }

  // 2. 获取已有图谱实体
  currentPhaseIndex = PHASE_ORDER.indexOf('extract')
  phaseProgress = 0
  sendProgress('extract', gp.messages.loadingExistingEntities, { totalDocs })
  const { entities: existingEntities } = await getFullGraphData(wikiId)

  // 3. 分块 + 统一抽取（实体+关系）
  const allChunks: TextChunk[] = []
  for (const entry of docEntries) {
    const chunks = splitByMarkdownHeaders(entry.content, maxChunkSize)
    chunks.forEach((chunk, idx) => {
      allChunks.push({ docId: entry.docId, chunkIndex: idx, content: chunk })
    })
  }

  const totalChunks = allChunks.length
  sendProgress('extract', mainFormat(gp.messages.extractionStarted, { count: totalChunks }), {
    totalDocs,
    totalChunks
  })

  const allNewEntities: ExtractedEntity[] = []
  const allNewRelations: (ExtractedRelation & { source_note_id: number })[] = []
  let entityNameToId = new Map<string, number>()

  for (const e of existingEntities) {
    entityNameToId.set(e.name, e.id)
  }

  for (let i = 0; i < allChunks.length; i += maxConcurrency) {
    const batch = allChunks.slice(i, i + maxConcurrency)
    const batchResults = await Promise.all(
      batch.map((chunk) => extractEntitiesAndRelations(ctx, chunk.content, chunk.docId))
    )

    const batchEntities: ExtractedEntity[] = []
    const batchRelations: (ExtractedRelation & { source_note_id: number })[] = []

    for (let j = 0; j < batch.length; j++) {
      const { entities, relations } = batchResults[j]
      const docId = batch[j].docId

      for (const e of entities) {
        batchEntities.push({ ...e, source_doc_ids: [docId] })
      }
      batchRelations.push(...relations)
    }

    allNewEntities.push(...batchEntities)
    allNewRelations.push(...batchRelations)

    const batchEntityNames = batchEntities.map((e) => e.name)
    const batchRelationsToSave = batchRelations.filter(
      (r) =>
        (batchEntityNames.includes(r.source) && batchEntityNames.includes(r.target)) ||
        (entityNameToId.has(r.source) && entityNameToId.has(r.target))
    )

    const batchEntityNameToId = await batchUpsertEntities(
      batchEntities.map((e) => ({
        wiki_id: wikiId,
        name: e.name,
        type: e.type,
        description: e.description,
        aliases: JSON.stringify(e.aliases),
        properties: null,
        confidence: e.confidence,
        source_note_ids: JSON.stringify(e.source_doc_ids)
      }))
    )

    for (const [name, id] of batchEntityNameToId) {
      entityNameToId.set(name, id)
    }

    const batchRelationSet = new Map<string, (typeof batchRelationsToSave)[0]>()
    for (const rel of batchRelationsToSave) {
      const sourceId = entityNameToId.get(rel.source)
      const targetId = entityNameToId.get(rel.target)
      if (!sourceId || !targetId || sourceId === targetId) continue

      const key = `${sourceId}:${targetId}:${rel.relation_type}`
      if (!batchRelationSet.has(key)) {
        batchRelationSet.set(key, rel)
      }
    }

    if (batchRelationSet.size > 0) {
      await batchUpsertRelations(
        Array.from(batchRelationSet.values()).map((rel) => ({
          wiki_id: wikiId,
          source_id: entityNameToId.get(rel.source)!,
          target_id: entityNameToId.get(rel.target)!,
          relation_type: rel.relation_type,
          description: rel.description,
          properties: null,
          confidence: 1.0,
          source_note_ids: JSON.stringify([rel.source_note_id])
        }))
      )
    }

    const processedChunks = Math.min(i + maxConcurrency, totalChunks)
    const processedDocs = new Set(allChunks.slice(0, i + maxConcurrency).map((c) => c.docId)).size
    phaseProgress = processedChunks / totalChunks
    sendProgress(
      'extract',
      mainFormat(gp.messages.extractionProgress, {
        done: processedChunks,
        total: totalChunks,
        entities: entityNameToId.size,
        relations: allNewRelations.length
      }),
      {
        processedDocs: Math.min(processedDocs, totalDocs),
        totalDocs,
        processedChunks,
        totalChunks,
        entityCount: entityNameToId.size,
        relationCount: allNewRelations.length,
        needsRefresh: true
      }
    )
  }

  // Gleaning 二次抽取
  const enableGleaning = config?.enableGleaning !== false
  if (enableGleaning && allChunks.length > 0) {
    currentPhaseIndex = PHASE_ORDER.indexOf('gleaning')
    phaseProgress = 0
    sendProgress('gleaning', mainFormat(gp.messages.gleaningStarted, { count: allChunks.length }), {
      totalDocs,
      totalChunks,
      entityCount: entityNameToId.size,
      relationCount: allNewRelations.length
    })

    for (let i = 0; i < allChunks.length; i += maxConcurrency) {
      const batch = allChunks.slice(i, i + maxConcurrency)
      const existingNames = [...entityNameToId.keys()]
      const batchResults =
        existingNames.length > 0
          ? await Promise.all(
              batch.map((chunk) => gleanEntities(ctx, chunk.content, existingNames))
            )
          : batch.map(() => [] as Omit<ExtractedEntity, 'source_doc_ids'>[])

      for (let j = 0; j < batch.length; j++) {
        if (batchResults[j].length > 0) {
          const gleanedEntities = batchResults[j].map((e) => ({
            ...e,
            source_doc_ids: [batch[j].docId]
          }))
          allNewEntities.push(...gleanedEntities)

          const gleanedNameToId = await batchUpsertEntities(
            gleanedEntities.map((e) => ({
              wiki_id: wikiId,
              name: e.name,
              type: e.type,
              description: e.description,
              aliases: JSON.stringify(e.aliases),
              properties: null,
              confidence: e.confidence,
              source_note_ids: JSON.stringify(e.source_doc_ids)
            }))
          )

          for (const [name, id] of gleanedNameToId) {
            entityNameToId.set(name, id)
          }
        }
      }

      const processedChunks = Math.min(i + maxConcurrency, allChunks.length)
      const processedDocs = new Set(allChunks.slice(0, i + maxConcurrency).map((c) => c.docId)).size
      phaseProgress = processedChunks / allChunks.length
      sendProgress(
        'gleaning',
        mainFormat(gp.messages.gleaningProgress, {
          done: processedChunks,
          total: allChunks.length,
          entities: entityNameToId.size
        }),
        {
          processedDocs: Math.min(processedDocs, totalDocs),
          totalDocs,
          processedChunks,
          totalChunks,
          entityCount: entityNameToId.size,
          relationCount: allNewRelations.length,
          needsRefresh: true
        }
      )
    }
  }

  if (allNewEntities.length === 0) {
    logger.info('No entities extracted from selected notes')
    return { entitiesAdded: 0, relationsAdded: 0 }
  }

  // 4. 将已有实体转为 ExtractedEntity 格式，与新实体一起合并
  const existingAsExtracted: ExtractedEntity[] = existingEntities.map((e) => ({
    name: e.name,
    type: e.type,
    description: e.description || '',
    aliases: e.aliases ? JSON.parse(e.aliases) : [],
    // confidence 库列为可空（DEFAULT 1），null 按默认置信度处理
    confidence: e.confidence ?? 1,
    source_doc_ids: e.source_note_ids ? JSON.parse(e.source_note_ids) : []
  }))

  const allEntitiesForMerge = [...existingAsExtracted, ...allNewEntities]

  currentPhaseIndex = PHASE_ORDER.indexOf('merge_entities')
  phaseProgress = 0
  sendProgress('merge_entities', gp.messages.merging, {
    totalDocs,
    entityCount: entityNameToId.size,
    relationCount: allNewRelations.length
  })
  const mergedResult = await mergeEntities(ctx, allEntitiesForMerge, (done, total) => {
    phaseProgress = Math.min(1, done / total)
    sendProgress('merge_entities', mainFormat(gp.messages.mergingBatches, { done, total }), {
      totalDocs,
      entityCount: entityNameToId.size,
      relationCount: allNewRelations.length,
      needsRefresh: true
    })
  })
  let mergedEntities = mergedResult.entities
  phaseProgress = 1
  sendProgress(
    'merge_entities',
    mainFormat(gp.messages.mergingDone, { count: mergedEntities.length }),
    {
      totalDocs,
      entityCount: mergedEntities.length,
      relationCount: allNewRelations.length
    }
  )

  // 5. 跨块关系补全
  const allEntityNames = mergedEntities.map((e) => e.name)
  const entityDescMap = new Map(
    mergedEntities.map((e) => [e.name, { name: e.name, type: e.type, description: e.description }])
  )

  const docChunksMap = new Map<number, TextChunk[]>()
  for (const chunk of allChunks) {
    if (!docChunksMap.has(chunk.docId)) docChunksMap.set(chunk.docId, [])
    docChunksMap.get(chunk.docId)!.push(chunk)
  }

  const crossChunkTasks: Array<{
    docId: number
    docTitle: string
    previousEntities: { name: string; type: string; description: string }[]
    currentEntities: { name: string; type: string; description: string }[]
    existingPairs: { source: string; target: string }[]
  }> = []

  for (const [docId, chunks] of docChunksMap) {
    if (chunks.length < 2) continue

    const docEntry = docEntries.find((e) => e.docId === docId)
    const docTitle = docEntry?.title || mainFormat(gp.messages.docFallbackTitle, { id: docId })

    const allDocPairs = allNewRelations
      .filter((r) => r.source_note_id === docId)
      .map((r) => ({ source: r.source, target: r.target }))

    const chunkEntityLists: { name: string; type: string; description: string }[][] = []
    for (const chunk of chunks) {
      const names = filterEntitiesInText(allEntityNames, chunk.content)
      chunkEntityLists.push(names.map((name) => entityDescMap.get(name)!).filter(Boolean))
    }

    const accumulated: { name: string; type: string; description: string }[] = [
      ...chunkEntityLists[0]
    ]
    const seen = new Set(chunkEntityLists[0].map((e) => e.name))

    for (let ci = 1; ci < chunks.length; ci++) {
      if (accumulated.length > 0 && chunkEntityLists[ci].length > 0) {
        crossChunkTasks.push({
          docId,
          docTitle,
          previousEntities: [...accumulated],
          currentEntities: chunkEntityLists[ci],
          existingPairs: allDocPairs
        })
      }

      for (const e of chunkEntityLists[ci]) {
        if (!seen.has(e.name)) {
          seen.add(e.name)
          accumulated.push(e)
        }
      }
    }
  }

  if (crossChunkTasks.length > 0) {
    currentPhaseIndex = PHASE_ORDER.indexOf('cross_chunk')
    phaseProgress = 0
    sendProgress(
      'cross_chunk',
      mainFormat(gp.messages.crossChunkStarted, { count: crossChunkTasks.length }),
      {
        totalDocs,
        entityCount: mergedEntities.length,
        relationCount: allNewRelations.length
      }
    )

    for (let i = 0; i < crossChunkTasks.length; i += maxConcurrency) {
      const batch = crossChunkTasks.slice(i, i + maxConcurrency)
      const batchResults = await Promise.all(
        batch.map(({ docId, docTitle, previousEntities, currentEntities, existingPairs }) =>
          extractIncrementalCrossChunkRelations(
            ctx,
            docTitle,
            previousEntities,
            currentEntities,
            existingPairs,
            docId
          )
        )
      )
      for (let j = 0; j < batchResults.length; j++) {
        allNewRelations.push(...batchResults[j])
      }

      const processed = Math.min(i + maxConcurrency, crossChunkTasks.length)
      phaseProgress = processed / crossChunkTasks.length
      sendProgress(
        'cross_chunk',
        mainFormat(gp.messages.crossChunkProgress, {
          done: processed,
          total: crossChunkTasks.length
        }),
        {
          processedDocs: Math.min(
            processed,
            new Set(crossChunkTasks.slice(0, i + maxConcurrency).map((t) => t.docId)).size
          ),
          totalDocs,
          entityCount: mergedEntities.length,
          relationCount: allNewRelations.length,
          needsRefresh: true
        }
      )
    }
  }

  // 6. 批量保存合并后的实体
  currentPhaseIndex = PHASE_ORDER.indexOf('save_entities')
  phaseProgress = 0
  sendProgress(
    'save_entities',
    mainFormat(gp.messages.savingEntities, { count: mergedEntities.length }),
    {
      totalDocs,
      entityCount: mergedEntities.length,
      relationCount: allNewRelations.length
    }
  )

  entityNameToId = await batchUpsertEntities(
    mergedEntities.map((e) => ({
      wiki_id: wikiId,
      name: e.name,
      type: e.type,
      description: e.description,
      aliases: JSON.stringify(e.aliases),
      properties: null,
      confidence: e.confidence,
      source_note_ids: JSON.stringify(e.source_doc_ids)
    }))
  )
  phaseProgress = 1
  sendProgress('save_entities', gp.messages.entitiesSaved, {
    totalDocs,
    entityCount: entityNameToId.size,
    relationCount: allNewRelations.length
  })

  // 7. 查询已有关系，与新抽取关系合并用于置信度计算
  currentPhaseIndex = PHASE_ORDER.indexOf('load_existing_relations')
  phaseProgress = 0
  sendProgress('load_existing_relations', gp.messages.loadingExistingRelations, {
    totalDocs,
    entityCount: entityNameToId.size,
    relationCount: allNewRelations.length
  })
  const existingDbRelations = await getRelationsByWikiId(wikiId)
  const entityIdToName = new Map<string, string>()
  for (const [name, id] of entityNameToId) {
    entityIdToName.set(String(id), name)
  }
  const allRelationsWithExisting = [
    ...allNewRelations,
    ...existingDbRelations.map((r) => ({
      source: entityIdToName.get(String(r.source_id)) || '',
      target: entityIdToName.get(String(r.target_id)) || '',
      relation_type: r.relation_type,
      description: r.description || '',
      source_note_id: 0
    }))
  ].filter((r) => r.source && r.target)
  phaseProgress = 1
  sendProgress(
    'load_existing_relations',
    mainFormat(gp.messages.relationsLoaded, { count: existingDbRelations.length }),
    {
      totalDocs,
      entityCount: entityNameToId.size,
      relationCount: allRelationsWithExisting.length
    }
  )

  // 8. 混合置信度计算
  currentPhaseIndex = PHASE_ORDER.indexOf('adjust_confidence')
  phaseProgress = 0
  sendProgress('adjust_confidence', gp.messages.adjustingConfidence, {
    totalDocs,
    entityCount: entityNameToId.size,
    relationCount: allRelationsWithExisting.length
  })
  const llmWeight = config?.llmConfidenceWeight ?? 0.6
  const statWeight = config?.statConfidenceWeight ?? 0.4
  mergedEntities = applyHybridConfidence(
    mergedEntities,
    allRelationsWithExisting,
    llmWeight,
    statWeight
  )

  // 9. 更新实体置信度
  currentPhaseIndex = PHASE_ORDER.indexOf('update_confidence')
  phaseProgress = 0
  sendProgress('update_confidence', gp.messages.updatingConfidence, {
    totalDocs,
    entityCount: entityNameToId.size,
    relationCount: allNewRelations.length
  })
  await batchUpdateEntityConfidence(
    mergedEntities.map((e) => ({
      id: entityNameToId.get(e.name)!,
      confidence: e.confidence
    }))
  )
  phaseProgress = 1
  sendProgress('update_confidence', gp.messages.confidenceUpdated, {
    totalDocs,
    entityCount: entityNameToId.size,
    relationCount: allNewRelations.length
  })

  // 10. 去重并批量保存关系
  currentPhaseIndex = PHASE_ORDER.indexOf('save_relations')
  phaseProgress = 0
  sendProgress('save_relations', gp.messages.savingCrossChunkRelations, {
    totalDocs,
    entityCount: entityNameToId.size,
    relationCount: allNewRelations.length
  })

  const relationSet = new Map<string, (typeof allNewRelations)[0]>()
  for (const rel of allNewRelations) {
    const sourceId = entityNameToId.get(rel.source)
    const targetId = entityNameToId.get(rel.target)
    if (!sourceId || !targetId || sourceId === targetId) continue

    const key = `${sourceId}:${targetId}:${rel.relation_type}`
    if (!relationSet.has(key)) {
      relationSet.set(key, rel)
    }
  }

  const relationsToSave = Array.from(relationSet.values())
  const savedRelationCount = await batchUpsertRelations(
    relationsToSave.map((rel) => ({
      wiki_id: wikiId,
      source_id: entityNameToId.get(rel.source)!,
      target_id: entityNameToId.get(rel.target)!,
      relation_type: rel.relation_type,
      description: rel.description,
      properties: null,
      confidence: 1.0,
      source_note_ids: JSON.stringify([rel.source_note_id])
    }))
  )
  phaseProgress = 1
  sendProgress(
    'save_relations',
    mainFormat(gp.messages.relationsSaved, { count: savedRelationCount }),
    {
      totalDocs,
      entityCount: entityNameToId.size,
      relationCount: savedRelationCount
    }
  )

  logger.info(
    `Notes append completed: ${mergedEntities.length - existingEntities.length} entities, ${savedRelationCount} relations in ${Date.now() - startTime}ms`
  )

  // 更新 build job
  const existingJob = await getBuildJobByWikiId(wikiId)
  const existingDocIds: number[] = existingJob?.processed_note_ids
    ? JSON.parse(existingJob.processed_note_ids)
    : []
  const mergedDocIds = [...new Set([...existingDocIds, ...docIds])]
  if (existingJob) {
    await updateBuildJob(existingJob.id, {
      processed_note_ids: JSON.stringify(mergedDocIds)
    })
  }

  return {
    entitiesAdded: mergedEntities.length - existingEntities.length,
    relationsAdded: savedRelationCount
  }
}
