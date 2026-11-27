/**
 * 联网搜索后端纯逻辑回归（mappers + mask）：响应归一化、掩码规则、provider 校验。
 *
 * 由 `scripts/ai-selftest.mjs` 打包执行（不依赖网络 / electron / 数据库）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { asSearchProviderId, maskApiKey, SEARCH_PROVIDER_IDS } from '../../src/main/search/mask'
import { mapDeepSeekResponse, mapTavilyResults } from '../../src/main/search/mappers'
import type { SearchRequest } from '../../src/main/search/types'

const request = (includeContent = false): SearchRequest => ({
  query: 'agent runtime',
  maxResults: 5,
  includeContent
})

test('search mask: first6 + last6 for long keys, last4 for short keys', () => {
  assert.deepEqual(SEARCH_PROVIDER_IDS, ['builtin', 'deepseek', 'tavily'])
  const longKey = 'sk-abcdef1234567890xyz'
  const masked = maskApiKey(longKey)
  assert.equal(masked, 'sk-abc••••••890xyz')
  assert.ok(masked.includes('••••••'))
  // 短 Key 只露末 4 位
  assert.equal(maskApiKey('abc123'), '••••c123')
  // 前后空格被裁掉
  assert.equal(maskApiKey('  tvly-1234567890abcdef  '), 'tvly-1••••••abcdef')
  // provider 白名单
  assert.equal(asSearchProviderId('deepseek'), 'deepseek')
  assert.equal(asSearchProviderId('builtin'), 'builtin')
  assert.equal(asSearchProviderId('google'), null)
  assert.equal(asSearchProviderId(undefined), null)
})

test('search mapper: DeepSeek response is normalised', () => {
  const json = {
    results: [
      {
        rerank_score: 1.8,
        title: 'Agent runtimes',
        url: 'https://example.com/agents',
        snippet: 'short',
        summary: 'longer summary for the model',
        content: 'page body',
        site_name: 'Example',
        date: '2026-11-20T00:00:00Z'
      },
      // 无 url 的行被跳过
      { title: 'no url', snippet: 'x' },
      {
        title: '',
        url: 'https://example.com/untitled',
        snippet: 'only snippet'
      }
    ]
  }
  const withoutContent = mapDeepSeekResponse(json, request(false))
  assert.equal(withoutContent.ok, true)
  if (!withoutContent.ok) return
  assert.equal(withoutContent.items.length, 2)
  const first = withoutContent.items[0]
  assert.equal(first.title, 'Agent runtimes')
  assert.equal(first.url, 'https://example.com/agents')
  // 优先长摘要
  assert.equal(first.snippet, 'longer summary for the model')
  assert.equal(first.siteName, 'Example')
  assert.equal(first.publishedAt, '2026-11-20T00:00:00Z')
  assert.equal(first.score, 1.8)
  assert.equal(first.content, undefined)
  // 无标题时退回 URL
  assert.equal(withoutContent.items[1].title, 'https://example.com/untitled')

  const withContent = mapDeepSeekResponse(json, request(true))
  assert.equal(withContent.ok, true)
  if (withContent.ok) assert.equal(withContent.items[0].content, 'page body')

  // 结构异常返回可读错误（不抛异常）
  assert.deepEqual(mapDeepSeekResponse(null, request()), { ok: false, message: 'empty response' })
  assert.deepEqual(mapDeepSeekResponse({ oops: true }, request()), {
    ok: false,
    message: 'missing results array'
  })
})

test('search mapper: Tavily results are normalised', () => {
  const results = [
    {
      title: 'Tavily hit',
      url: 'https://example.com/tavily',
      content: 'snippet content',
      rawContent: '# markdown body',
      score: 0.91
    },
    { title: 'no url', content: 'x' }
  ]
  const items = mapTavilyResults(results, request(false))
  assert.equal(items.length, 1)
  assert.equal(items[0].title, 'Tavily hit')
  assert.equal(items[0].snippet, 'snippet content')
  assert.equal(items[0].score, 0.91)
  assert.equal(items[0].content, undefined)

  const withContent = mapTavilyResults(results, request(true))
  assert.equal(withContent[0].content, '# markdown body')

  assert.deepEqual(mapTavilyResults(null, request()), [])
  assert.deepEqual(mapTavilyResults([], request()), [])
})
