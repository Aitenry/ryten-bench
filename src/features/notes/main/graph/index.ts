import { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { GraphData } from '../db/mapper/graph'
import type { BuildConfig, ProgressCallback } from './types'
import { createCachedInvoke, type ServiceContext } from './service/llm-invoke'
import { buildGraph as buildGraphFn } from './service/build-graph'
import { appendDocs as appendDocsFn } from './service/append-docs'

export class KnowledgeGraphService {
  private ctx: ServiceContext

  constructor(model: BaseChatModel) {
    const cache = new Map<string, string>()
    this.ctx = {
      model,
      cache,
      cachedInvoke: createCachedInvoke(model, cache)
    }
  }

  async buildGraph(
    wikiId: number,
    onProgress?: ProgressCallback,
    config?: BuildConfig
  ): Promise<GraphData> {
    return buildGraphFn(this.ctx, wikiId, onProgress, config)
  }

  async appendDocs(
    wikiId: number,
    docIds: number[],
    onProgress?: ProgressCallback,
    config?: BuildConfig
  ): Promise<{ entitiesAdded: number; relationsAdded: number }> {
    return appendDocsFn(this.ctx, wikiId, docIds, onProgress, config)
  }
}

export type {
  BuildConfig,
  ExtractedEntity,
  ExtractedRelation,
  ProgressCallback,
  TextChunk,
  EntityStats
} from './types'
