import { createHash } from 'node:crypto'
import { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { StructuredOutputParser } from '@langchain/core/output_parsers'
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
    // 缓存键必须覆盖完整 prompt：此前只取首尾各 200 字符，模板首尾恒定、负载（实体列表等）
    // 位于中部的调用（如实体合并/跨块补全的多批次）会共享同一键，第二批起命中第一批的
    // 缓存答案，导致结果互相污染。整串哈希既保去重能力又避免键本身占用大量内存。
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
