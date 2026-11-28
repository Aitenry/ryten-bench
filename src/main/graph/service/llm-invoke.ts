import { createHash } from 'node:crypto'
import { BaseChatModel } from '../../ai/chat-model'
import { StructuredOutputParser } from '../../ai/output-parsers'
import logger from 'electron-log'
import { parseFromLLM } from 'json-llm-repair'
import type { z } from 'zod/v3'

export interface ServiceContext {
  model: BaseChatModel
  cache: Map<string, string>
  cachedInvoke: <T>(
    prompt: string,
    parser: StructuredOutputParser<z.ZodTypeAny>
  ) => Promise<T | null>
}

const CACHE_MAX_SIZE = 500

export function createCachedInvoke(model: BaseChatModel, cache: Map<string, string>) {
  return async function cachedStructuredInvoke<T>(
    prompt: string,
    parser: StructuredOutputParser<z.ZodTypeAny>
  ): Promise<T | null> {
    // The cache key must cover the whole prompt: taking only the first and last 200 characters
    // meant that calls whose variable payload (entity lists and the like) sits in the middle and
    // whose template edges stay constant (e.g. the multiple batches of entity merging or
    // cross-chunk completion) shared one key, so later batches hit the first batch's cached answer
    // and results contaminated each other. Hashing the entire string keeps deduplication while
    // avoiding a large key in memory.
    const cacheKey = createHash('sha256').update(prompt).digest('hex')
    const cached = cache.get(cacheKey)

    let rawContent: string
    if (cached !== undefined) {
      rawContent = cached
    } else {
      const response = await model.invoke(prompt)
      rawContent = typeof response.content === 'string' ? response.content : ''

      if (cache.size >= CACHE_MAX_SIZE) {
        const firstKey = cache.keys().next().value
        if (firstKey) cache.delete(firstKey)
      }
      cache.set(cacheKey, rawContent)
    }

    const attempt = <T>(fn: () => T | Promise<T>): Promise<T | null> =>
      Promise.resolve(fn()).catch(() => null)

    const parsed =
      (await attempt(() => parser.parse(rawContent) as T)) ??
      (await attempt(() => parseFromLLM(rawContent, { mode: 'repair' }) as T))

    if (parsed == null) {
      logger.warn('All parsing strategies failed for prompt')
    }

    return parsed as T
  }
}
