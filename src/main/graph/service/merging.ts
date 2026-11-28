import { StructuredOutputParser } from '../../ai/output-parsers'
import logger from 'electron-log'
import { dice } from 'strsimkit'
import { EntityMergingResultSchema, type EntityMergingResultOutput } from '../schemas'
import { ENTITY_MERGING_PROMPT } from '../prompts'
import type { ExtractedEntity } from '../types'
import type { ServiceContext } from './llm-invoke'

const mergeParser = StructuredOutputParser.fromZodSchema(EntityMergingResultSchema)

/**
 * Cluster entities by the textual similarity of their names so that entities with the same or
 * similar names end up merged in the same batch.
 * Uses the Dice coefficient: a similarity of 0.6 or above puts two names in the same group.
 * - At most 40 entities per batch
 * - Shorter names are compared first (they are more likely substrings or abbreviations of others)
 */
export function groupEntitiesByPrefix(entities: ExtractedEntity[]): ExtractedEntity[][] {
  const MAX_BATCH = 40
  const SIMILARITY_THRESHOLD = 0.6

  if (entities.length <= MAX_BATCH) return [entities]

  const sorted = [...entities].sort((a, b) => a.name.length - b.name.length)

  const clusters: { names: string[]; entities: ExtractedEntity[] }[] = []

  for (const entity of sorted) {
    const name = entity.name

    let bestClusterIndex = -1
    let bestScore = 0

    for (let i = 0; i < clusters.length; i++) {
      if (clusters[i].entities.length >= MAX_BATCH) continue

      let maxSimilarity = 0
      for (const existingName of clusters[i].names) {
        const sim = dice(name, existingName)
        if (sim > maxSimilarity) maxSimilarity = sim
        if (maxSimilarity >= SIMILARITY_THRESHOLD) break
      }

      if (maxSimilarity >= SIMILARITY_THRESHOLD && maxSimilarity > bestScore) {
        bestScore = maxSimilarity
        bestClusterIndex = i
      }
    }

    if (bestClusterIndex >= 0) {
      clusters[bestClusterIndex].names.push(name)
      clusters[bestClusterIndex].entities.push(entity)
    } else {
      clusters.push({ names: [name], entities: [entity] })
    }
  }

  return clusters.map((c) => c.entities)
}

/**
 * Merge result: the merged entity list plus an old-name → canonical-name map, used by the
 * persistence stage to repoint relations and clean up stale rows.
 */
export interface EntityMergeResult {
  entities: ExtractedEntity[]
  renameMap: Map<string, string>
}

/**
 * Entity deduplication and merging (Stage 1 programmatic dedup → Stage 2 batched LLM merging
 * grouped by name similarity).
 * onProgress(processedBatches, totalBatches) reports detailed phase progress.
 */
export async function mergeEntities(
  ctx: ServiceContext,
  entities: ExtractedEntity[],
  onProgress?: (processed: number, total: number) => void
): Promise<EntityMergeResult> {
  /** Old name → canonical name: names of merged-away entities point to the kept name */
  const renameMap = new Map<string, string>()

  if (entities.length <= 1) {
    onProgress?.(1, 1)
    return { entities, renameMap }
  }

  // Stage 1: Programmatic merge (exact same name + simple alias matching)
  const nameMap = new Map<string, ExtractedEntity>()

  for (const entity of entities) {
    const key = entity.name.toLowerCase()
    const existing = nameMap.get(key)
    if (existing) {
      existing.aliases = [...new Set([...existing.aliases, ...entity.aliases])]
      existing.source_doc_ids = [...new Set([...existing.source_doc_ids, ...entity.source_doc_ids])]
      existing.confidence = Math.max(existing.confidence, entity.confidence)
      if (entity.description.length > existing.description.length) {
        existing.description = entity.description
        if (entity.name !== existing.name) {
          renameMap.set(existing.name, entity.name)
        }
        existing.name = entity.name
      } else if (entity.name !== existing.name) {
        renameMap.set(entity.name, existing.name)
      }
    } else {
      nameMap.set(key, { ...entity })
    }
  }

  const stage1Entities = Array.from(nameMap.values())
  if (stage1Entities.length <= 1) {
    onProgress?.(1, 1)
    return { entities: stage1Entities, renameMap }
  }

  // Stage 2: Group by name similarity → batched LLM merging
  const batches = groupEntitiesByPrefix(stage1Entities)
  onProgress?.(0, batches.length)

  const allMerged: ExtractedEntity[] = []

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]
    if (batch.length <= 1) {
      allMerged.push(...batch)
    } else {
      try {
        const parsed = await ctx.cachedInvoke<EntityMergingResultOutput>(
          ENTITY_MERGING_PROMPT.replace('{entities}', JSON.stringify(batch, null, 2)),
          mergeParser
        )

        if (parsed?.merged && Array.isArray(parsed.merged)) {
          const batchNames = new Set(batch.map((e) => e.name))
          const merged = parsed.merged.map(
            (e) =>
              ({
                name: e.name,
                type: e.type || 'other',
                description: e.description || '',
                aliases: e.aliases || [],
                confidence: e.confidence ?? 0.9,
                source_doc_ids: e.source_doc_ids || []
              }) as ExtractedEntity
          )
          // Record old name → canonical name: batch entity names found among the merged aliases,
          // plus removed_names
          for (const m of merged) {
            for (const alias of m.aliases) {
              if (batchNames.has(alias) && alias !== m.name) {
                renameMap.set(alias, m.name)
              }
            }
          }
          for (const removed of parsed.removed_names ?? []) {
            if (!batchNames.has(removed) || renameMap.has(removed)) continue
            const owner = merged.find((m) => (m.aliases ?? []).includes(removed))
            if (owner && owner.name !== removed) {
              renameMap.set(removed, owner.name)
            }
          }
          allMerged.push(...merged)
        } else {
          allMerged.push(...batch)
        }
      } catch (error) {
        logger.warn(
          `Entity merging batch ${i + 1}/${batches.length} failed, keeping original:`,
          error
        )
        allMerged.push(...batch)
      }
    }
    onProgress?.(i + 1, batches.length)
  }

  // Collapse rename chains: A→B and B→C both resolve to C; drop redundant self-mappings
  const resolveChain = (name: string): string => {
    let current = name
    const seen = new Set<string>([name])
    while (renameMap.has(current)) {
      const next = renameMap.get(current)!
      if (next === current || seen.has(next)) break
      seen.add(next)
      current = next
    }
    return current
  }
  for (const key of [...renameMap.keys()]) {
    renameMap.set(key, resolveChain(key))
  }
  for (const [from, to] of [...renameMap]) {
    if (from === to) renameMap.delete(from)
  }

  return { entities: allMerged, renameMap }
}
