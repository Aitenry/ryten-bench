/**
 * 供应商工厂集成测试（不依赖 Electron / 数据库 / 网络）。
 *
 * 直接使用 `src/main/provider/service.ts`：把数据库 mapper 与 i18n 换成内存桩，
 * 验证「供应商配置 → 自研 ChatModel 实例」的完整映射（含 custom 协议、思考参数注入、
 * 配置缓存与错误路径）。这些正是移除 LangChain 后最容易接错的一层。
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'

import { ProviderService } from '../../src/main/provider/service'
import {
  ChatAnthropic,
  ChatBedrockConverse,
  ChatCloudflareWorkersAI,
  ChatDeepSeek,
  ChatGoogleGenerativeAI,
  ChatMistralAI,
  ChatOllama,
  ChatOpenAI,
  ChatOpenRouter,
  ChatVertexAI,
  ChatXAI,
  tool
} from '../../src/main/ai/index'

/** 与 LlmProviderConfig 同形的测试配置（mapper 桩返回它） */
interface FakeProvider {
  id: number
  name: string
  provider: string
  model: string
  api_key?: string | null
  base_url?: string | null
  is_default?: boolean
  is_enabled?: boolean
  max_tokens?: number | null
  temperature?: number | null
  top_p?: number | null
  top_k?: number | null
  thinking_mode?: string | null
  reasoning_effort?: string | null
  metadata?: Record<string, unknown> | null
  extra_config?: Record<string, unknown> | null
}

declare global {
  // eslint-disable-next-line no-var
  var __RB_TEST_PROVIDERS__: FakeProvider[] | undefined
}

function setProviders(providers: FakeProvider[]): void {
  globalThis.__RB_TEST_PROVIDERS__ = providers
}

function baseProvider(overrides: Partial<FakeProvider> & { provider: string }): FakeProvider {
  return {
    id: 1,
    name: 'test provider',
    model: 'test-model',
    api_key: 'sk-test',
    is_enabled: true,
    is_default: true,
    metadata: {},
    extra_config: {},
    ...overrides
  }
}

beforeEach(() => {
  setProviders([])
})

test('provider service: 各供应商类型映射到对应自研 ChatModel', async () => {
  const cases: Array<{ provider: string; expected: any; expectedName: string }> = [
    { provider: 'openai', expected: ChatOpenAI, expectedName: 'openai' },
    { provider: 'anthropic', expected: ChatAnthropic, expectedName: 'anthropic' },
    { provider: 'deepseek', expected: ChatDeepSeek, expectedName: 'deepseek' },
    { provider: 'google', expected: ChatGoogleGenerativeAI, expectedName: 'google' },
    { provider: 'google-genai', expected: ChatGoogleGenerativeAI, expectedName: 'google' },
    { provider: 'vertexai', expected: ChatVertexAI, expectedName: 'vertexai' },
    { provider: 'google-vertexai', expected: ChatVertexAI, expectedName: 'vertexai' },
    { provider: 'mistral', expected: ChatMistralAI, expectedName: 'mistralai' },
    { provider: 'mistralai', expected: ChatMistralAI, expectedName: 'mistralai' },
    { provider: 'ollama', expected: ChatOllama, expectedName: 'ollama' },
    { provider: 'openrouter', expected: ChatOpenRouter, expectedName: 'openrouter' },
    { provider: 'xai', expected: ChatXAI, expectedName: 'xai' },
    { provider: 'aws', expected: ChatBedrockConverse, expectedName: 'bedrock' },
    { provider: 'bedrock', expected: ChatBedrockConverse, expectedName: 'bedrock' },
    { provider: 'cloudflare', expected: ChatCloudflareWorkersAI, expectedName: 'cloudflare' }
  ]

  const providers = cases.map((item, index) =>
    baseProvider({
      id: index + 1,
      provider: item.provider,
      model: `model-${item.provider}`,
      is_default: false
    })
  )
  setProviders(providers)
  const service = new ProviderService()
  for (const [index, item] of cases.entries()) {
    const model = await service.createModel(index + 1)
    assert.ok(
      model instanceof item.expected,
      `${item.provider} should build ${item.expected.name}, got ${model.constructor.name}`
    )
    assert.equal(model.provider, item.expectedName)
    assert.equal(model.model, `model-${item.provider}`)
  }
})

test('provider service: custom 按 api_format 选协议，未知供应商回退 OpenAI', async () => {
  setProviders([
    baseProvider({
      id: 1,
      provider: 'custom',
      model: 'custom-openai',
      base_url: 'https://gateway.example/v1',
      extra_config: { api_format: 'openai' }
    }),
    baseProvider({
      id: 2,
      provider: 'custom',
      model: 'custom-anthropic',
      base_url: 'https://gateway.example',
      extra_config: { api_format: 'anthropic' }
    }),
    baseProvider({ id: 3, provider: 'nonsense', model: 'unknown-model' })
  ])
  const service = new ProviderService()
  assert.ok((await service.createModel(1)) instanceof ChatOpenAI)
  assert.ok((await service.createModel(2)) instanceof ChatAnthropic)
  const fallback = await service.createModel(3)
  assert.ok(fallback instanceof ChatOpenAI)
  assert.equal(fallback.model, 'unknown-model')
})

test('provider service: 思考 / 推理等级参数真正进入实例字段', async () => {
  setProviders([
    baseProvider({
      id: 1,
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      max_tokens: 8192,
      temperature: 0.4,
      thinking_mode: 'on',
      reasoning_effort: 'high',
      metadata: { capabilities: { reasoning_effort_levels: ['low', 'medium', 'high'] } }
    }),
    baseProvider({
      id: 2,
      provider: 'deepseek',
      model: 'deepseek-chat',
      max_tokens: 4096,
      thinking_mode: 'on',
      reasoning_effort: 'medium'
    }),
    baseProvider({
      id: 3,
      provider: 'google',
      model: 'gemini-2.5-flash',
      thinking_mode: 'on',
      metadata: { max_output_tokens: 2048 }
    }),
    baseProvider({
      id: 4,
      provider: 'ollama',
      model: 'qwen3:8b',
      thinking_mode: 'off'
    })
  ])
  const service = new ProviderService()
  const anthropic = (await service.createModel(1)) as unknown as {
    thinking?: { type: string; budget_tokens?: number }
    outputConfig?: Record<string, unknown>
    maxTokens: number
    temperature: number
  }
  assert.equal(anthropic.thinking?.type, 'enabled')
  assert.equal(anthropic.outputConfig?.effort, 'high')
  assert.ok((anthropic.thinking?.budget_tokens ?? 0) >= 1024)
  assert.equal(anthropic.temperature, 0.4)

  const deepseek = (await service.createModel(2)) as unknown as {
    modelKwargs?: Record<string, unknown>
    maxTokens?: number
  }
  assert.deepEqual(deepseek.modelKwargs?.thinking, { type: 'enabled' })
  assert.equal(deepseek.modelKwargs?.reasoning_effort, 'medium')
  assert.equal(deepseek.maxTokens, 4096)

  const google = (await service.createModel(3)) as unknown as {
    thinkingConfig?: Record<string, unknown>
    maxOutputTokens?: number
  }
  assert.equal(google.thinkingConfig?.thinkingBudget, -1)
  assert.equal(google.maxOutputTokens, 2048)

  const ollama = (await service.createModel(4)) as unknown as { think?: boolean | string }
  assert.equal(ollama.think, false)
})

test('provider service: 配置缓存 / 禁用 / 缺模型名 / 缺 providerId 的错误路径', async () => {
  setProviders([
    baseProvider({ id: 1, provider: 'openai', model: 'gpt-x', is_default: true }),
    baseProvider({ id: 2, provider: 'openai', model: 'disabled-model', is_enabled: false }),
    baseProvider({ id: 3, provider: 'openai', model: '   ' })
  ])
  const service = new ProviderService()

  const first = await service.createModel(1)
  assert.ok(first instanceof ChatOpenAI)
  // 缓存命中：第二次仍能拿到实例（mapper 桩每次都会返回同样配置，这里验证不抛错即可）
  assert.ok((await service.createModel(1)) instanceof ChatOpenAI)

  await assert.rejects(
    async () => await service.createModel(2),
    /providerNotFound/
  )
  await assert.rejects(
    async () => await service.createModel(3),
    /modelNameMissing/
  )
  await assert.rejects(async () => await service.createModel(), /modelNotSelected/)
  service.clearCache()
  assert.ok((await service.createModel(1)) instanceof ChatOpenAI)
  // 没有默认供应商时 getConfig() 才报 noProviderConfigured（有默认时会回落到默认供应商）
  setProviders([])
  await assert.rejects(async () => await new ProviderService().getConfig(), /noProviderConfigured/)
})

test('provider service: 供应商字段正确落到构造参数（key / base_url / 上限 / 采样）', async () => {
  setProviders([
    baseProvider({
      id: 1,
      provider: 'openai',
      model: 'gpt-4o',
      api_key: 'sk-fields',
      base_url: 'https://gateway.example/v1',
      max_tokens: 1024,
      temperature: 0.75,
      top_p: 0.9,
      top_k: 40
    }),
    baseProvider({
      id: 2,
      provider: 'ollama',
      model: 'llama3.1',
      api_key: null,
      base_url: 'http://127.0.0.1:12345',
      max_tokens: 512,
      temperature: 0.1,
      top_p: 0.8,
      top_k: 12
    })
  ])
  const service = new ProviderService()
  const openai = (await service.createModel(1)) as unknown as {
    model: string
    baseURL: string
    apiKey: string
    maxTokens: number
    temperature: number
    topP: number
  }
  assert.equal(openai.model, 'gpt-4o')
  assert.equal(openai.baseURL, 'https://gateway.example/v1')
  assert.equal(openai.apiKey, 'sk-fields')
  assert.equal(openai.maxTokens, 1024)
  assert.equal(openai.temperature, 0.75)
  assert.equal(openai.topP, 0.9)

  const ollama = (await service.createModel(2)) as unknown as {
    baseUrl: string
    options: Record<string, unknown>
  }
  assert.equal(ollama.baseUrl, 'http://127.0.0.1:12345')
  assert.deepEqual(ollama.options, {
    temperature: 0.1,
    top_p: 0.8,
    top_k: 12,
    num_predict: 512
  })
})

/** 确保工具契约没有被 provider 工厂顺手改坏（工具可正常 invoke） */
test('provider service: 工厂返回的模型可绑定自研工具', async () => {
  setProviders([baseProvider({ id: 1, provider: 'openai', model: 'gpt-4o-mini' })])
  const service = new ProviderService()
  const model = await service.createModel(1)
  const echo = tool(async (args: { text: string }) => args.text, {
    name: 'echo',
    description: 'echo',
    schema: z.object({ text: z.string() })
  })
  const bound = model.bindTools([echo])
  assert.equal(typeof bound.invoke, 'function')
  assert.equal(bound.model, 'gpt-4o-mini')
})
