import logger from 'electron-log'
import { StructuredOutputParser } from '@langchain/core/output_parsers'
import {
  EntitiesArraySchema,
  UnifiedExtractionSchema,
  ALLOWED_ENTITY_TYPES,
  ALLOWED_RELATION_TYPES,
  type EntitiesArrayOutput,
  type UnifiedExtractionOutput
} from '../schemas'
import { ENTITY_GLEANING_PROMPT, ENTITY_RELATION_EXTRACTION_PROMPT } from '../prompts'
import type { ExtractedEntity, ExtractedRelation } from '../types'
import type { ServiceContext } from './llm-invoke'

const entityParser = StructuredOutputParser.fromZodSchema(EntitiesArraySchema)
const unifiedParser = StructuredOutputParser.fromZodSchema(UnifiedExtractionSchema)

/**
 * 统一抽取：从文本块中同时抽取实体和关系（一次 LLM 调用）
 */
export async function extractEntitiesAndRelations(
  ctx: ServiceContext,
  text: string,
  noteId: number
): Promise<{
  entities: Omit<ExtractedEntity, 'source_doc_ids'>[]
  relations: (ExtractedRelation & { source_note_id: number })[]
}> {
  try {
    const parsed = await ctx.cachedInvoke<UnifiedExtractionOutput>(
      ENTITY_RELATION_EXTRACTION_PROMPT.replace('{text}', text),
      unifiedParser
    )

    if (parsed) {
      const entityNames = new Set<string>()
      const entities = (parsed.entities || [])
        .map((e) => ({
          name: (e.name || '').trim(),
          type: ALLOWED_ENTITY_TYPES.has(e.type) ? e.type : 'other',
          description: e.description || '',
          aliases: [] as string[],
          confidence:
            typeof e.confidence === 'number' && e.confidence >= 0 && e.confidence <= 1
              ? e.confidence
              : 0.7
        }))
        .filter((e) => e.name.length > 0)

      for (const e of entities) {
        entityNames.add(e.name)
      }

      let invalidRelationCount = 0
      const relations = (parsed.relations || [])
        .filter(
          (r) =>
            r.source &&
            r.target &&
            r.relation_type &&
            entityNames.has(r.source) &&
            entityNames.has(r.target) &&
            r.source !== r.target
        )
        .filter((r) => {
          const valid = ALLOWED_RELATION_TYPES.has(r.relation_type)
          if (!valid) invalidRelationCount++
          return valid
        })
        .map((r) => ({
          source: r.source,
          target: r.target,
          relation_type: r.relation_type,
          description: r.description || '',
          source_note_id: noteId
        }))

      if (invalidRelationCount > 0) {
        logger.warn(
          `Filtered out ${invalidRelationCount} relation(s) with invalid type in chunk of doc #${noteId}`
        )
      }

      return { entities, relations }
    }
  } catch (error) {
    logger.warn('Unified extraction failed for chunk:', error)
  }

  return { entities: [], relations: [] }
}

/**
 * Gleaning：二次扫描遗漏实体（使用 StructuredOutputParser + Zod 校验）
 */
export async function gleanEntities(
  ctx: ServiceContext,
  text: string,
  existingNames: string[]
): Promise<Omit<ExtractedEntity, 'source_doc_ids'>[]> {
  try {
    const parsed = await ctx.cachedInvoke<EntitiesArrayOutput>(
      ENTITY_GLEANING_PROMPT.replace('{existing_entities}', existingNames.join('、')).replace(
        '{text}',
        text
      ),
      entityParser
    )

    if (parsed && Array.isArray(parsed)) {
      return parsed
        .map((e) => ({
          name: (e.name || '').trim(),
          type: e.type || 'other',
          description: e.description || '',
          aliases: [] as string[],
          confidence:
            typeof e.confidence === 'number' && e.confidence >= 0 && e.confidence <= 1
              ? e.confidence
              : 0.65
        }))
        .filter((e) => e.name.length > 0 && !existingNames.includes(e.name))
    }
  } catch (error) {
    logger.warn('Entity gleaning failed:', error)
  }

  return []
}
