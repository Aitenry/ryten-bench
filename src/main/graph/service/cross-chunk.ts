import { StructuredOutputParser } from '@langchain/core/output_parsers'
import logger from 'electron-log'
import { RelationsArraySchema, ALLOWED_RELATION_TYPES, type RelationsArrayOutput } from '../schemas'
import { INCREMENTAL_CROSS_CHUNK_PROMPT } from '../prompts'
import type { ExtractedRelation } from '../types'
import type { ServiceContext } from './llm-invoke'

const relationParser = StructuredOutputParser.fromZodSchema(RelationsArraySchema)

/**
 * 增量跨块关系补全（按 chunk 顺序推进）
 * 每次只比较当前 chunk 实体(A组) 与已处理的前序 chunk 实体(B组)之间的关系
 * 上下文窗口可控，同时产生更多批次实现渐进式进度展示
 */
export async function extractIncrementalCrossChunkRelations(
  ctx: ServiceContext,
  noteTitle: string,
  previousEntities: { name: string; type: string; description: string }[],
  currentEntities: { name: string; type: string; description: string }[],
  existingPairs: { source: string; target: string }[],
  noteId: number
): Promise<(ExtractedRelation & { source_note_id: number })[]> {
  const allNames = [...previousEntities.map((e) => e.name), ...currentEntities.map((e) => e.name)]
  if (allNames.length < 2 || previousEntities.length === 0 || currentEntities.length === 0)
    return []

  try {
    const parsed = await ctx.cachedInvoke<RelationsArrayOutput>(
      INCREMENTAL_CROSS_CHUNK_PROMPT.replace('{docTitle}', noteTitle)
        .replace('{previousEntities}', JSON.stringify(previousEntities))
        .replace('{currentEntities}', JSON.stringify(currentEntities))
        .replace(
          '{existingPairs}',
          existingPairs.length > 0 ? JSON.stringify(existingPairs) : '[]'
        ),
      relationParser
    )

    if (parsed && Array.isArray(parsed)) {
      const existingSet = new Set(existingPairs.map((r) => `${r.source}:${r.target}`))
      let invalidTypeCount = 0
      const filtered = parsed
        .filter(
          (r) =>
            r.source &&
            r.target &&
            r.relation_type &&
            allNames.includes(r.source) &&
            allNames.includes(r.target) &&
            r.source !== r.target &&
            !existingSet.has(`${r.source}:${r.target}`)
        )
        .filter((r) => {
          const valid = ALLOWED_RELATION_TYPES.has(r.relation_type)
          if (!valid) invalidTypeCount++
          return valid
        })
        .map((r) => ({
          source: r.source,
          target: r.target,
          relation_type: r.relation_type,
          description: r.description || '',
          source_note_id: noteId
        }))

      if (invalidTypeCount > 0) {
        logger.warn(
          `Filtered out ${invalidTypeCount} incremental cross-chunk relation(s) with invalid type in doc #${noteId}`
        )
      }
      return filtered
    }
  } catch (error) {
    logger.warn('Incremental cross-chunk relation extraction failed:', error)
  }

  return []
}
