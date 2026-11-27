/**
 * 自研 AI 层自测（node:test）。
 *
 * 跑法：pnpm test:ai
 * 覆盖：消息 / 工具 / 结构化输出解析 / 图执行引擎 / 各供应商协议（本地 mock HTTP 服务器）。
 * 全部离线运行，不依赖任何真实模型或 LangChain 包。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { generateKeyPairSync } from 'node:crypto'
import { z } from 'zod'

import {
  AIMessage,
  AIMessageChunk,
  BaseChatModel,
  END,
  START,
  StateGraph,
  Annotation,
  GraphRecursionError,
  HumanMessage,
  ModelEmptyResponseError,
  ModelStreamCollector,
  OpenAICompatibleChatModel,
  StructuredOutputParser,
  SystemMessage,
  ToolInputError,
  ToolMessage,
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
  contentToText,
  jsonSchemaOf,
  parseDataUrl,
  tool,
  toAnthropicMessages,
  toBedrockMessages,
  toGeminiContents,
  toOllamaMessages,
  type ModelCallOptions,
  type StructuredToolInterface
} from '../../src/main/ai/index'

// ============================================================================
// 测试工具：本地 mock HTTP 服务器
// ============================================================================

interface CapturedRequest {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  rawBody: string
  body: any
}

type MockHandler = (req: CapturedRequest, res: http.ServerResponse) => void | Promise<void>

async function withMockServer(
  handler: MockHandler,
  run: (ctx: { url: string; requests: CapturedRequest[] }) => Promise<void>
): Promise<void> {
  const requests: CapturedRequest[] = []
  const server = http.createServer(async (rawReq, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of rawReq) chunks.push(Buffer.from(chunk))
    const rawBody = Buffer.concat(chunks).toString('utf8')
    let body: unknown
    try {
      body = rawBody ? JSON.parse(rawBody) : undefined
    } catch {
      body = undefined
    }
    const captured: CapturedRequest = {
      method: rawReq.method ?? '',
      url: rawReq.url ?? '',
      headers: rawReq.headers,
      rawBody,
      body
    }
    requests.push(captured)
    try {
      await handler(captured, res)
    } catch (err) {
      res.statusCode = 500
      res.end(String(err))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  try {
    await run({ url: `http://127.0.0.1:${address.port}`, requests })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

/** 写 SSE 响应（events 为对象时自动 JSON.stringify） */
function writeSse(
  res: http.ServerResponse,
  events: Array<unknown>,
  options: { contentType?: string; doneMarker?: boolean } = {}
): void {
  res.writeHead(200, {
    'content-type': options.contentType ?? 'text/event-stream',
    'cache-control': 'no-cache'
  })
  for (const event of events) {
    const data = typeof event === 'string' ? event : JSON.stringify(event)
    res.write(`data: ${data}\n\n`)
  }
  if (options.doneMarker !== false) res.write('data: [DONE]\n\n')
  res.end()
}

/** 写 NDJSON 响应 */
function writeNdjson(res: http.ServerResponse, lines: Array<unknown>): void {
  res.writeHead(200, { 'content-type': 'application/x-ndjson' })
  for (const line of lines) res.write(`${JSON.stringify(line)}\n`)
  res.end()
}

/** 构造一个 AWS event-stream 帧（CRC 置 0：解码器不校验） */
function awsEventFrame(payload: unknown): Buffer {
  const payloadBuffer = Buffer.from(JSON.stringify(payload), 'utf8')
  const total = 12 + payloadBuffer.length + 4
  const frame = Buffer.alloc(total)
  frame.writeUInt32BE(total, 0)
  frame.writeUInt32BE(0, 4)
  frame.writeUInt32BE(0, 8)
  payloadBuffer.copy(frame, 12)
  frame.writeUInt32BE(0, total - 4)
  return frame
}

/** 收集一次 invoke 期间产生的流式 chunk */
function collectChunks(): {
  options: ModelCallOptions
  chunks: AIMessageChunk[]
} {
  const chunks: AIMessageChunk[] = []
  return {
    chunks,
    options: {
      onModelChunk: (chunk) => chunks.push(chunk)
    }
  }
}

// ============================================================================
// 消息模型
// ============================================================================

test('messages: 构造 / 类型 / 文本提取 / data URL 解析', () => {
  const human = new HumanMessage('hello')
  assert.equal(human.type, 'human')
  assert.equal(human._getType(), 'human')
  assert.equal(human.text, 'hello')

  const system = new SystemMessage({ content: 'rules' })
  assert.equal(system.type, 'system')

  const ai = new AIMessage({
    content: [{ type: 'text', text: 'part1' }, { type: 'text', text: 'part2' }],
    tool_calls: [{ name: 'demo', args: { a: 1 } }]
  })
  assert.equal(ai.type, 'ai')
  assert.equal(ai.text, 'part1part2')
  assert.equal(ai.tool_calls.length, 1)
  // 缺 id 的工具调用会补齐稳定 id（工具结果要能对上）
  assert.ok(ai.tool_calls[0].id && ai.tool_calls[0].id.length > 0)

  const toolMessage = new ToolMessage({ content: 'ok', tool_call_id: 'call_1', tool_name: 'demo' })
  assert.equal(toolMessage.type, 'tool')
  assert.equal(toolMessage.tool_call_id, 'call_1')

  const chunk = new AIMessageChunk({
    content: 'x',
    tool_call_chunks: [{ index: 0, id: 'c', name: 'demo', args: '{"a":' }]
  })
  assert.equal(chunk.type, 'ai')
  assert.equal(chunk.tool_call_chunks.length, 1)
  assert.equal(contentToText([{ type: 'text', text: 'a' }, { type: 'image_url' }]), 'a')

  const parsed = parseDataUrl('data:image/png;base64,QUJD')
  assert.deepEqual(parsed, { mimeType: 'image/png', data: 'QUJD' })
  assert.equal(parseDataUrl('https://example.com/a.png'), null)
})

// ============================================================================
// 工具
// ============================================================================

test('tools: zod 校验 / JSON Schema 转换 / 参数错误', async () => {
  const calls: unknown[] = []
  const demoTool = tool(
    async (args: { text: string; count?: number }) => {
      calls.push(args)
      return `${args.text}:${args.count ?? 0}`
    },
    {
      name: 'demo_tool',
      description: 'demo',
      schema: z.object({
        text: z.string().describe('text to echo'),
        count: z.number().int().min(1).max(5).optional().describe('repeat count')
      })
    }
  )

  assert.equal(demoTool.name, 'demo_tool')
  assert.equal(await demoTool.invoke({ text: 'hi', count: 3 }), 'hi:3')
  assert.deepEqual(calls[0], { text: 'hi', count: 3 })

  // 额外字段会被 zod 剥掉，不会传给工具
  await demoTool.invoke({ text: 'x', extra: 'ignored' } as never)
  assert.deepEqual(calls[1], { text: 'x' })

  await assert.rejects(
    async () => await demoTool.invoke({ count: 9 } as never),
    (err: unknown) => {
      assert.ok(err instanceof ToolInputError)
      assert.match((err as Error).message, /demo_tool/)
      assert.match((err as Error).message, /text/)
      return true
    }
  )

  const schema = jsonSchemaOf(demoTool)
  assert.equal(schema.type, 'object')
  assert.equal((schema.properties as any).text.type, 'string')
  assert.equal((schema.properties as any).text.description, 'text to echo')
  assert.deepEqual(schema.required, ['text'])
  assert.equal((schema as any).$schema, undefined)

  // 宽松对象：额外参数原样保留
  const loose = tool(async (args: Record<string, unknown>) => JSON.stringify(args), {
    name: 'loose',
    description: 'loose',
    schema: z.looseObject({})
  })
  assert.deepEqual(JSON.parse((await loose.invoke({ a: 1, b: 'x' })) as string), { a: 1, b: 'x' })
  assert.equal((jsonSchemaOf(loose).type as string), 'object')

  // 现成 JSON Schema 原样透传（去掉 $schema）
  const raw = tool(async () => 'ok', {
    name: 'raw',
    description: 'raw',
    schema: { $schema: 'x', type: 'object', properties: { q: { type: 'string' } } }
  })
  const rawSchema = jsonSchemaOf(raw)
  assert.equal(rawSchema.type, 'object')
  assert.equal((rawSchema as any).$schema, undefined)

  // 无 schema 工具：宽松空对象
  const noSchema = tool(async () => 'ok', { name: 'noop', description: 'noop' })
  assert.deepEqual(jsonSchemaOf(noSchema), { type: 'object', properties: {} })
})

test('tools: 权限闸门式包装（把原工具套一层仍保留 schema 契约）', async () => {
  const inner = tool(async (args: { value: string }) => `value=${args.value}`, {
    name: 'inner',
    description: 'inner tool',
    schema: z.object({ value: z.string() })
  })
  const guarded = tool(
    async (args: Record<string, unknown>, config: unknown) => {
      assert.equal((config as { configurable?: { marker?: string } }).configurable?.marker, 'x')
      return await inner.invoke(args as { value: string }, config as never)
    },
    {
      name: inner.name,
      description: inner.description,
      schema: inner.schema
    }
  )
  assert.equal(await guarded.invoke({ value: 'v' }, { configurable: { marker: 'x' } }), 'value=v')
  assert.equal(jsonSchemaOf(guarded).type, 'object')
})

// ============================================================================
// 结构化输出解析
// ============================================================================

test('output parser: 裸 JSON / 围栏 / 夹在文本中 / 数组 / 校验失败', () => {
  const schema = z.object({ name: z.string(), score: z.number() })
  const parser = StructuredOutputParser.fromZodSchema(schema)

  assert.deepEqual(parser.parse('{"name":"a","score":1}'), { name: 'a', score: 1 })
  assert.deepEqual(parser.parse('```json\n{"name":"b","score":2}\n```'), { name: 'b', score: 2 })
  assert.deepEqual(parser.parse('结果如下：{"name":"c","score":3} 完毕'), { name: 'c', score: 3 })
  // 字符串里带大括号不能截断错
  assert.deepEqual(parser.parse('{"name":"a}b","score":4}'), { name: 'a}b', score: 4 })

  const arrayParser = StructuredOutputParser.fromZodSchema(z.array(z.object({ x: z.string() })))
  assert.deepEqual(arrayParser.parse('[{"x":"1"},{"x":"2"}]'), [{ x: '1' }, { x: '2' }])
  assert.deepEqual(arrayParser.parse('说明文字\n```json\n[{"x":"3"}]\n```'), [{ x: '3' }])

  assert.throws(() => parser.parse('{"name":"a"}'), /schema validation/i)
  assert.throws(() => parser.parse('not json at all'), /Cannot parse/i)
  assert.match(parser.getFormatInstructions(), /JSON/i)
})

// ============================================================================
// 图执行引擎
// ============================================================================

/** 测试替身：按脚本逐次返回消息，并可吐流式 chunk */
class ScriptedChatModel extends BaseChatModel {
  readonly model = 'scripted-model'
  private callIndex = 0
  readonly calls: Array<{ messages: import('../../src/main/ai/index').BaseMessage[]; tools: string[] }> =
    []

  constructor(
    private readonly script: Array<{ message: AIMessage; chunks?: string[] }>
  ) {
    super()
  }

  protected async _generate(
    messages: import('../../src/main/ai/index').BaseMessage[],
    tools: StructuredToolInterface[],
    options: ModelCallOptions
  ): Promise<AIMessage> {
    this.calls.push({ messages, tools: tools.map((tool) => tool.name) })
    const step = this.script[Math.min(this.callIndex, this.script.length - 1)]
    this.callIndex += 1
    for (const chunk of step.chunks ?? []) {
      options.onModelChunk?.(new AIMessageChunk({ content: chunk }))
    }
    return step.message
  }
}

const AgentState = Annotation.Root({
  messages: Annotation<import('../../src/main/ai/index').BaseMessage[]>({
    reducer: (left, right) => left.concat(right),
    default: () => []
  })
})

function buildDemoAgentGraph(model: BaseChatModel, tools: StructuredToolInterface[]) {
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]))
  const boundModel = model.bindTools(tools)
  async function callModel(state: { messages: any[] }, config: ModelCallOptions) {
    const response = await boundModel.invoke([new SystemMessage('sys'), ...state.messages], config)
    return { messages: [response] }
  }
  async function callTools(state: { messages: any[] }) {
    const last = state.messages[state.messages.length - 1] as AIMessage
    const outputs: ToolMessage[] = []
    for (const call of last.tool_calls) {
      const tool = toolsByName.get(call.name)
      const output = tool ? String(await tool.invoke(call.args)) : `missing tool ${call.name}`
      outputs.push(new ToolMessage({ content: output, tool_call_id: call.id ?? 'x' }))
    }
    return { messages: outputs }
  }
  function shouldContinue(state: { messages: any[] }): string {
    const last = state.messages[state.messages.length - 1] as AIMessage
    return last.tool_calls?.length ? 'tools' : END
  }
  return new StateGraph(AgentState)
    .addNode('model', callModel)
    .addNode('tools', callTools)
    .addEdge(START, 'model')
    .addConditionalEdges('model', shouldContinue)
    .addEdge('tools', 'model')
    .compile()
}

test('graph: 工具循环 + 状态 reducer + invoke 最终状态', async () => {
  const executions: Array<Record<string, unknown>> = []
  const echo = tool(
    async (args: { text: string }) => {
      executions.push(args)
      return `echo:${args.text}`
    },
    { name: 'echo', description: 'echo', schema: z.object({ text: z.string() }) }
  )
  const toolCallMessage = new AIMessage({
    content: '',
    tool_calls: [{ id: 'call_1', name: 'echo', args: { text: 'hello' } }]
  })
  const finalMessage = new AIMessage({ content: 'done' })
  const model = new ScriptedChatModel([
    { message: toolCallMessage, chunks: ['thinking...'] },
    { message: finalMessage, chunks: ['do', 'ne'] }
  ])
  const graph = buildDemoAgentGraph(model, [echo])

  const result = await graph.invoke(
    { messages: [new HumanMessage('go')] },
    { recursionLimit: 10, configurable: { topicId: 7 } }
  )
  const messages = (result as { messages: any[] }).messages
  assert.equal(messages.length, 4)
  assert.equal(messages[0].type, 'human')
  assert.equal(messages[1].type, 'ai')
  assert.equal(messages[2].type, 'tool')
  assert.equal(messages[2].content, 'echo:hello')
  assert.equal(messages[3].type, 'ai')
  assert.equal(messages[3].content, 'done')
  assert.deepEqual(executions, [{ text: 'hello' }])
  assert.equal(model.calls.length, 2)
  assert.deepEqual(model.calls[1].tools, ['echo'])
})

test('graph: stream 逐 chunk 输出且 metadata 为 model 命名空间', async () => {
  const finalMessage = new AIMessage({ content: 'hello world' })
  const model = new ScriptedChatModel([{ message: finalMessage, chunks: ['hello ', 'world'] }])
  const graph = buildDemoAgentGraph(model, [])

  const events: Array<[string, [unknown, Record<string, unknown>]]> = []
  for await (const event of graph.stream(
    { messages: [new HumanMessage('hi')] },
    { streamMode: ['messages'], recursionLimit: 10 }
  )) {
    events.push(event as [string, [unknown, Record<string, unknown>]])
  }
  assert.equal(events.length, 2)
  assert.equal(events[0][0], 'messages')
  assert.equal((events[0][1][0] as AIMessageChunk).content, 'hello ')
  assert.equal(events[1][1][1].langgraph_node, 'model')
  assert.match(String(events[1][1][1].langgraph_checkpoint_ns), /^model:/)
})

test('graph: 递归上限抛 GraphRecursionError，取消抛 AbortError', async () => {
  const loopCall = new AIMessage({
    content: '',
    tool_calls: [{ id: 'c1', name: 'noop', args: {} }]
  })
  const loopTool = tool(async () => 'again', {
    name: 'noop',
    description: 'noop',
    schema: z.object({})
  })
  const model = new ScriptedChatModel([{ message: loopCall }])
  const graph = buildDemoAgentGraph(model, [loopTool])

  await assert.rejects(
    async () =>
      await graph.invoke({ messages: [new HumanMessage('loop')] }, { recursionLimit: 5 }),
    (err: unknown) => {
      assert.ok(err instanceof GraphRecursionError)
      assert.equal((err as Error).name, 'GraphRecursionError')
      assert.match((err as Error).message, /Recursion limit of 5/)
      return true
    }
  )

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    async () =>
      await graph.invoke(
        { messages: [new HumanMessage('loop')] },
        { recursionLimit: 100, signal: controller.signal }
      ),
    (err: unknown) => {
      assert.equal((err as Error).name, 'AbortError')
      return true
    }
  )
})

test('graph: 条件边引用未注册节点 / 缺入口时编译报错', () => {
  const empty = new StateGraph(AgentState)
  assert.throws(() => empty.compile(), /entry point/i)

  const graph = new StateGraph(AgentState)
    .addNode('a', () => undefined)
    .addEdge(START, 'a')
    .addConditionalEdges('missing', () => END)
  assert.throws(() => {
    graph.compile()
  }, /Conditional edge source "missing" is not registered/)
})

// ============================================================================
// 流式聚合器
// ============================================================================

test('collector: 工具参数分片聚合 / 非法 JSON / 用量合并 / 推理内容', () => {
  const emitted: AIMessageChunk[] = []
  const collector = new ModelStreamCollector((chunk) => emitted.push(chunk))
  collector.text('hel')
  collector.text('lo')
  collector.reasoning('thinking')
  collector.toolDelta(0, { id: 'call_1', name: 'demo', args: '{"a":' })
  collector.toolDelta(0, { args: '1}' })
  collector.usage({ input_tokens: 3 })
  collector.usage({ output_tokens: 2 })
  const message = collector.finalize()
  assert.equal(message.content, 'hello')
  assert.deepEqual(message.tool_calls, [
    { id: 'call_1', name: 'demo', args: { a: 1 }, type: 'tool_call' }
  ])
  assert.deepEqual(message.usage_metadata, { input_tokens: 3, output_tokens: 2 })
  assert.equal(message.additional_kwargs.reasoning_content, 'thinking')
  assert.equal(emitted.length, 5)
  assert.deepEqual(emitted[3].tool_call_chunks, [
    { index: 0, id: 'call_1', name: 'demo', args: '{"a":' }
  ])

  const broken = new ModelStreamCollector()
  broken.toolDelta(0, { id: 'c2', name: 'bad', args: 'not-json' })
  const brokenMessage = broken.finalize()
  assert.equal(brokenMessage.tool_calls.length, 0)
  assert.equal(brokenMessage.invalid_tool_calls.length, 1)
  assert.equal(brokenMessage.invalid_tool_calls[0].name, 'bad')
})

// ============================================================================
// OpenAI 兼容族
// ============================================================================

function openAIChunk(delta: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    model: 'gpt-test',
    choices: [{ index: 0, delta, finish_reason: null }],
    ...extra
  }
}

test('openai: 流式文本 + 工具调用 + 用量 + 请求体', async () => {
  await withMockServer(
    (_req, res) => {
      writeSse(res, [
        openAIChunk({ role: 'assistant', content: 'Hel' }),
        openAIChunk({ content: 'lo' }),
        openAIChunk({
          tool_calls: [
            { index: 0, id: 'call_9', function: { name: 'echo', arguments: '{"text":' } }
          ]
        }),
        {
          id: 'chatcmpl-1',
          object: 'chat.completion.chunk',
          model: 'gpt-test',
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, function: { arguments: '"hi"}' } }] },
              finish_reason: 'tool_calls'
            }
          ]
        },
        {
          id: 'chatcmpl-1',
          model: 'gpt-test',
          choices: [],
          usage: {
            prompt_tokens: 11,
            completion_tokens: 7,
            total_tokens: 18,
            prompt_tokens_details: { cached_tokens: 3 },
            completion_tokens_details: { reasoning_tokens: 2 }
          }
        }
      ])
    },
    async ({ url, requests }) => {
      const client = new ChatOpenAI({
        model: 'gpt-test',
        apiKey: 'sk-test',
        baseURL: url,
        temperature: 0.2,
        maxTokens: 256
      })
      const { options, chunks } = collectChunks()
      const echo = tool(async () => 'ok', {
        name: 'echo',
        description: 'echo tool',
        schema: z.object({ text: z.string().describe('text') })
      })
      const message = await client
        .bindTools([echo])
        .invoke([new SystemMessage('sys'), new HumanMessage('hi')], options)

      assert.equal(message.content, 'Hello')
      assert.deepEqual(message.tool_calls, [
        { id: 'call_9', name: 'echo', args: { text: 'hi' }, type: 'tool_call' }
      ])
      assert.equal(message.usage_metadata?.input_tokens, 11)
      assert.equal(message.usage_metadata?.output_tokens, 7)
      assert.equal(message.usage_metadata?.total_tokens, 18)
      assert.deepEqual(message.usage_metadata?.input_token_details, { cache_read: 3 })
      assert.deepEqual(message.usage_metadata?.output_token_details, { reasoning: 2 })
      assert.equal(message.response_metadata.finish_reason, 'tool_calls')

      const textChunks = chunks.filter((chunk) => typeof chunk.content === 'string' && chunk.content)
      assert.deepEqual(
        textChunks.map((chunk) => chunk.content),
        ['Hel', 'lo']
      )
      const toolChunks = chunks.filter((chunk) => chunk.tool_call_chunks.length > 0)
      assert.equal(toolChunks.length, 2)
      assert.equal(toolChunks[0].tool_call_chunks[0].name, 'echo')

      const request = requests[0]
      // 纯域名 base_url（无路径）优先使用 Spring AI 风格的 /v1/chat/completions
      assert.equal(request.url, '/v1/chat/completions')
      assert.equal(request.headers.authorization, 'Bearer sk-test')
      assert.equal(request.body.model, 'gpt-test')
      assert.equal(request.body.stream, true)
      assert.deepEqual(request.body.stream_options, { include_usage: true })
      assert.equal(request.body.max_tokens, 256)
      assert.equal(request.body.temperature, 0.2)
      assert.equal(request.body.messages[0].role, 'system')
      assert.equal(request.body.messages[1].role, 'user')
      assert.equal(request.body.tools[0].type, 'function')
      assert.equal(request.body.tools[0].function.name, 'echo')
      assert.equal(request.body.tools[0].function.parameters.properties.text.type, 'string')
    }
  )
})

test('openai: 非 2xx 抛 ModelHttpError(status)；stream_options 400 自动降级重试', async () => {
  let attempt = 0
  await withMockServer(
    (req, res) => {
      attempt += 1
      if (attempt === 1) {
        assert.ok((req.body as any).stream_options)
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Unsupported parameter: stream_options' } }))
        return
      }
      assert.equal((req.body as any).stream_options, undefined)
      writeSse(res, [openAIChunk({ content: 'ok' })])
    },
    async ({ url, requests }) => {
      const client = new ChatOpenAI({ model: 'gpt-test', apiKey: 'k', baseURL: url })
      const message = await client.invoke('hi')
      assert.equal(message.content, 'ok')
      assert.equal(requests.length, 2)
    }
  )

  await withMockServer(
    (_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end('{"error":{"message":"boom"}}')
    },
    async ({ url }) => {
      const client = new ChatOpenAI({ model: 'gpt-test', apiKey: 'k', baseURL: url })
      await assert.rejects(
        async () => await client.invoke('hi'),
        (err: unknown) => {
          assert.equal((err as Error).name, 'ModelHttpError')
          assert.equal((err as { status?: number }).status, 500)
          assert.match((err as Error).message, /boom/)
          return true
        }
      )
    }
  )
})

test('openai 兼容族: 缺 key 报鉴权类错误 / 各供应商默认端点与参数透传', async () => {
  const original = process.env.OPENAI_API_KEY
  delete process.env.OPENAI_API_KEY
  const noKey = new ChatOpenAI({ model: 'gpt-test' })
  await assert.rejects(
    async () => await noKey.invoke('hi'),
    (err: unknown) => {
      assert.equal((err as { status?: number }).status, 401)
      return true
    }
  )
  if (original !== undefined) process.env.OPENAI_API_KEY = original

  // 各子类的默认 baseURL 不影响显式传入（这里只验证可构造 + provider 标识）
  assert.equal(new ChatDeepSeek({ model: 'deepseek-chat', apiKey: 'k' }).provider, 'deepseek')
  assert.equal(new ChatXAI({ model: 'grok-2', apiKey: 'k' }).provider, 'xai')
  assert.equal(new ChatOpenRouter({ model: 'x', apiKey: 'k' }).provider, 'openrouter')
  assert.equal(new ChatMistralAI({ model: 'mistral-large-latest', apiKey: 'k' }).provider, 'mistralai')

  // modelKwargs（思考 / 推理等级）必须并入请求体，且后写覆盖
  await withMockServer(
    (req, res) => {
      assert.deepEqual((req.body as any).thinking, { type: 'enabled' })
      assert.equal((req.body as any).reasoning_effort, 'high')
      assert.equal((req.body as any).response_format, 'json_object')
      writeSse(res, [openAIChunk({ content: 'ok' })])
    },
    async ({ url }) => {
      const client = new ChatDeepSeek({
        model: 'deepseek-reasoner',
        apiKey: 'k',
        baseURL: url,
        modelKwargs: { thinking: { type: 'enabled' }, reasoning_effort: 'high' },
        response_format: 'json_object'
      })
      const message = await client.invoke('hi')
      assert.equal(message.content, 'ok')
    }
  )

  // 非 SSE（网关返回整包 JSON）也能解析
  await withMockServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          model: 'gpt-test',
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'full',
                tool_calls: [
                  {
                    id: 'call_json',
                    type: 'function',
                    function: { name: 'demo', arguments: '{"x":1}' }
                  }
                ]
              },
              finish_reason: 'stop'
            }
          ],
          usage: { prompt_tokens: 1, completion_tokens: 2 }
        })
      )
    },
    async ({ url }) => {
      const client = new ChatOpenAI({ model: 'gpt-test', apiKey: 'k', baseURL: url })
      const message = await client.invoke('hi')
      assert.equal(message.content, 'full')
      assert.deepEqual(message.tool_calls[0].args, { x: 1 })
      assert.equal(message.usage_metadata?.input_tokens, 1)
      assert.equal(message.usage_metadata?.output_tokens, 2)
      assert.equal(message.usage_metadata?.total_tokens, 3)
    }
  )
})

// ============================================================================
// Anthropic
// ============================================================================

test('anthropic: 流式文本 / 工具 / 思考 / 用量与请求报文', async () => {
  await withMockServer(
    (req, res) => {
      const body = req.body as any
      assert.equal(req.headers['x-api-key'], 'ak-test')
      assert.equal(req.headers['anthropic-version'], '2023-06-01')
      assert.equal(body.model, 'claude-sonnet-4-5')
      assert.equal(body.max_tokens, 64000)
      assert.equal(body.system, 'sys1\n\nsys2')
      assert.equal(body.thinking.type, 'enabled')
      assert.equal(body.output_config.effort, 'high')
      // 思考开启时 Anthropic 不接受 temperature / top_k
      assert.equal(body.temperature, undefined)
      assert.equal(body.top_k, undefined)
      assert.equal(body.tools[0].input_schema.properties.q.type, 'string')
      assert.equal(body.messages[0].role, 'user')

      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const events: Array<[string, unknown]> = [
        [
          'message_start',
          {
            type: 'message_start',
            message: {
              id: 'msg_1',
              model: 'claude-sonnet-4-5',
              usage: {
                input_tokens: 10,
                output_tokens: 1,
                cache_read_input_tokens: 4,
                cache_creation_input_tokens: 2
              }
            }
          }
        ],
        [
          'content_block_start',
          { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }
        ],
        [
          'content_block_delta',
          { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan' } }
        ],
        [
          'content_block_start',
          {
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'tool_use', id: 'toolu_1', name: 'search', input: {} }
          }
        ],
        [
          'content_block_delta',
          {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'input_json_delta', partial_json: '{"q":' }
          }
        ],
        [
          'content_block_delta',
          {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'input_json_delta', partial_json: '"cats"}' }
          }
        ],
        [
          'content_block_start',
          { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } }
        ],
        [
          'content_block_delta',
          { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Hello' } }
        ],
        [
          'message_delta',
          {
            type: 'message_delta',
            delta: { stop_reason: 'tool_use' },
            usage: { output_tokens: 42 }
          }
        ],
        ['message_stop', { type: 'message_stop' }]
      ]
      for (const [event, payload] of events) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
      }
      res.end()
    },
    async ({ url, requests }) => {
      const client = new ChatAnthropic({
        model: 'claude-sonnet-4-5',
        apiKey: 'ak-test',
        anthropicApiUrl: url,
        maxTokens: 64000,
        thinking: { type: 'enabled', budget_tokens: 2048 },
        output_config: { effort: 'high' },
        stopSequences: ['END']
      })
      const { options, chunks } = collectChunks()
      const search = tool(async () => 'ok', {
        name: 'search',
        description: 'search',
        schema: z.object({ q: z.string() })
      })
      const message = await client
        .bindTools([search])
        .invoke([new SystemMessage('sys1'), new SystemMessage('sys2'), new HumanMessage('hi')], options)

      assert.equal(requests.length, 1)
      assert.equal(message.content, 'Hello')
      assert.deepEqual(message.tool_calls, [
        { id: 'toolu_1', name: 'search', args: { q: 'cats' }, type: 'tool_call' }
      ])
      assert.equal(message.additional_kwargs.reasoning_content, 'plan')
      assert.deepEqual(message.usage_metadata, {
        input_tokens: 10,
        output_tokens: 42,
        total_tokens: 52,
        input_token_details: { cache_read: 4, cache_creation: 2 },
        cache_read_input_tokens: 4,
        cache_creation_input_tokens: 2
      })
      assert.equal(message.response_metadata.finish_reason, 'tool_use')
      assert.ok(chunks.some((chunk) => chunk.additional_kwargs.reasoning_content === 'plan'))
      assert.ok(chunks.some((chunk) => chunk.tool_call_chunks.length > 0))
    }
  )
})

test('anthropic: 未开启思考时下发 temperature / top_p / top_k', async () => {
  await withMockServer(
    (req, res) => {
      const body = req.body as any
      assert.equal(body.temperature, 0.7)
      assert.equal(body.top_p, 0.9)
      assert.equal(body.top_k, 3)
      assert.equal(body.thinking, undefined)
      assert.equal(body.max_tokens, 4096)
      writeSse(
        res,
        [
          {
            type: 'message_start',
            message: { id: 'm', model: 'claude-3-haiku', usage: { input_tokens: 1 } }
          },
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' }
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'ok' }
          },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
          { type: 'message_stop' }
        ],
        { doneMarker: false }
      )
    },
    async ({ url }) => {
      const client = new ChatAnthropic({
        model: 'claude-3-haiku',
        apiKey: 'k',
        anthropicApiUrl: url,
        temperature: 0.7,
        topP: 0.9,
        topK: 3
      })
      const message = await client.invoke('hi')
      assert.equal(message.content, 'ok')
      assert.equal(message.usage_metadata?.total_tokens, 2)
    }
  )
})

test('anthropic: 消息转换（图片 / 工具结果合并 / system 抽取）', () => {
  const converted = toAnthropicMessages([
    new SystemMessage('rules'),
    new HumanMessage({
      content: [
        { type: 'text', text: 'look' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }
      ]
    }),
    new AIMessage({ content: '', tool_calls: [{ id: 't1', name: 'a', args: { x: 1 } }] }),
    new ToolMessage({ content: 'r1', tool_call_id: 't1' }),
    new ToolMessage({ content: 'r2', tool_call_id: 't2' })
  ])
  assert.equal(converted.system, 'rules')
  assert.equal(converted.messages.length, 3)
  assert.equal(converted.messages[0].role, 'user')
  assert.equal(converted.messages[0].content[1].type, 'image')
  assert.equal(converted.messages[1].role, 'assistant')
  assert.equal((converted.messages[1].content[0] as any).type, 'tool_use')
  // 连续工具结果合并进同一条 user 消息
  assert.equal(converted.messages[2].role, 'user')
  assert.equal(converted.messages[2].content.length, 2)
  assert.equal((converted.messages[2].content[0] as any).type, 'tool_result')
})

// ============================================================================
// Ollama
// ============================================================================

test('ollama: NDJSON 文本 / thinking / 工具 / 用量与请求体', async () => {
  await withMockServer(
    (req, res) => {
      const body = req.body as any
      assert.equal(body.model, 'llama3.1')
      assert.equal(body.stream, true)
      assert.equal(body.think, 'high')
      assert.equal(body.options.temperature, 0.1)
      assert.equal(body.options.num_predict, 128)
      assert.equal(body.options.top_k, 40)
      assert.equal(body.tools[0].function.name, 'calc')
      writeNdjson(res, [
        { model: 'llama3.1', message: { role: 'assistant', content: '3', thinking: '1+2' }, done: false },
        {
          model: 'llama3.1',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ function: { name: 'calc', arguments: { expression: '1+2' } } }]
          },
          done: false
        },
        {
          model: 'llama3.1',
          message: { role: 'assistant', content: '' },
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 8,
          eval_count: 5
        }
      ])
    },
    async ({ url, requests }) => {
      const client = new ChatOllama({
        model: 'llama3.1',
        baseUrl: url,
        temperature: 0.1,
        numPredict: 128,
        topK: 40,
        think: 'high'
      })
      const calc = tool(async () => 'answer', {
        name: 'calc',
        description: 'calculate',
        schema: z.object({ expression: z.string() })
      })
      const message = await client.bindTools([calc]).invoke('1+2?')
      assert.equal(requests[0].url, '/api/chat')
      assert.equal(message.content, '3')
      assert.equal(message.additional_kwargs.reasoning_content, '1+2')
      assert.equal(message.tool_calls.length, 1)
      assert.equal(message.tool_calls[0].name, 'calc')
      assert.deepEqual(message.tool_calls[0].args, { expression: '1+2' })
      assert.equal(typeof message.tool_calls[0].id, 'string')
      assert.deepEqual(message.usage_metadata, {
        input_tokens: 8,
        output_tokens: 5,
        total_tokens: 13
      })
    }
  )
})

test('ollama: 消息转换（图片 base64 / 工具名回填）', () => {
  const converted = toOllamaMessages([
    new SystemMessage('sys'),
    new HumanMessage({
      content: [
        { type: 'text', text: 'see' },
        { type: 'image_url', image_url: 'data:image/png;base64,QUJD' }
      ]
    }),
    new AIMessage({ content: '', tool_calls: [{ id: 't1', name: 'look', args: {} }] }),
    new ToolMessage({ content: 'res', tool_call_id: 't1' })
  ])
  assert.equal(converted[0].role, 'system')
  assert.deepEqual(converted[1].images, ['QUJD'])
  assert.equal((converted[2].tool_calls as any)[0].function.name, 'look')
  assert.equal(converted[3].tool_name, 'look')
})

// ============================================================================
// Google Gemini
// ============================================================================

test('gemini: SSE 文本 / 思考 / 工具 / 用量与请求报文', async () => {
  await withMockServer(
    (req, res) => {
      const body = req.body as any
      assert.match(req.url ?? '', /^\/v1beta\/models\/gemini-2\.5-flash:streamGenerateContent\?alt=sse&key=AIza-test$/)
      assert.equal(body.systemInstruction.parts[0].text, 'sys')
      assert.equal(body.generationConfig.temperature, 0.4)
      assert.equal(body.generationConfig.maxOutputTokens, 512)
      assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, -1)
      assert.equal(body.tools[0].functionDeclarations[0].name, 'lookup')
      // Gemini 不认识的 JSON Schema 关键字必须被剔除
      const parameters = body.tools[0].functionDeclarations[0].parameters
      assert.equal(parameters.$schema, undefined)
      assert.equal(parameters.additionalProperties, undefined)
      assert.equal(body.contents[0].role, 'user')

      const chunk = (parts: unknown[], usage: Record<string, unknown> | null = null) => ({
        candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
        modelVersion: 'gemini-2.5-flash',
        ...(usage ? { usageMetadata: usage } : {})
      })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify(chunk([{ text: 'Let ' }]))}\n\n`)
      res.write(`data: ${JSON.stringify(chunk([{ text: 'me think', thought: true }]))}\n\n`)
      res.write(`data: ${JSON.stringify(chunk([{ text: 'check ' }]))}\n\n`)
      res.write(
        `data: ${JSON.stringify(
          chunk([
            {
              functionCall: { name: 'lookup', args: { q: 'x' } },
              thoughtSignature: 'sig-1'
            }
          ])
        )}\n\n`
      )
      res.write(
        `data: ${JSON.stringify(
          chunk([], {
            promptTokenCount: 9,
            candidatesTokenCount: 4,
            thoughtsTokenCount: 2,
            cachedContentTokenCount: 1,
            totalTokenCount: 13
          })
        )}\n\n`
      )
      res.end()
    },
    async ({ url }) => {
      const client = new ChatGoogleGenerativeAI('gemini-2.5-flash', {
        apiKey: 'AIza-test',
        baseUrl: url,
        temperature: 0.4,
        maxOutputTokens: 512,
        thinkingConfig: { thinkingBudget: -1, includeThoughts: true }
      })
      const lookup = tool(async () => 'ok', {
        name: 'lookup',
        description: 'lookup',
        schema: z.object({ q: z.string() })
      })
      const message = await client
        .bindTools([lookup])
        .invoke([new SystemMessage('sys'), new HumanMessage('go')])
      assert.equal(message.content, 'Let check ')
      assert.equal(message.additional_kwargs.reasoning_content, 'me think')
      assert.deepEqual(message.tool_calls[0].args, { q: 'x' })
      assert.equal(message.tool_calls[0].name, 'lookup')
      assert.deepEqual(message.additional_kwargs.__gemini_thought_signatures__, ['sig-1'])
      assert.deepEqual(message.usage_metadata, {
        input_tokens: 9,
        output_tokens: 6,
        total_tokens: 13,
        input_token_details: { cache_read: 1 },
        cachedContentTokenCount: 1,
        output_token_details: { reasoning: 2 }
      })
    }
  )
})

test('gemini: 工具结果回传（functionResponse 名称从历史工具调用解析）', () => {
  const converted = toGeminiContents([
    new SystemMessage('sys'),
    new HumanMessage('q'),
    new AIMessage({ content: '', tool_calls: [{ id: 'call_1', name: 'lookup', args: { q: 'x' } }] }),
    new ToolMessage({ content: '{"ok":true}', tool_call_id: 'call_1' })
  ])
  assert.equal(converted.contents.length, 3)
  assert.equal(converted.contents[0].role, 'user')
  assert.equal(converted.contents[1].role, 'model')
  const functionCall = (converted.contents[1].parts as any[])[0].functionCall
  assert.equal(functionCall.name, 'lookup')
  const toolPart = converted.contents[2] as any
  assert.equal(toolPart.role, 'user')
  assert.equal(toolPart.parts[0].functionResponse.name, 'lookup')
  assert.deepEqual(toolPart.parts[0].functionResponse.response.content, { ok: true })
})

test('vertex: Express Mode（API Key）URL 与鉴权头', async () => {
  await withMockServer(
    (req, res) => {
      assert.match(
        req.url ?? '',
        /^\/v1\/publishers\/google\/models\/gemini-2\.0-flash:streamGenerateContent\?alt=sse&key=AIza-v$/
      )
      assert.equal(req.headers.authorization, undefined)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(
        `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'vertex-ok' }] } }] })}\n\n`
      )
      res.end()
    },
    async ({ url }) => {
      const client = new ChatVertexAI({
        model: 'gemini-2.0-flash',
        apiKey: 'AIza-v',
        baseUrl: url
      })
      const message = await client.invoke('hi')
      assert.equal(message.content, 'vertex-ok')
      assert.equal(client.provider, 'vertexai')
    }
  )
})

test('vertex: 项目模式（服务账号 JWT 换票 + Bearer 头）', async () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  })
  await withMockServer(
    (req, res) => {
      if ((req.url ?? '').startsWith('/token')) {
        assert.equal(req.method, 'POST')
        assert.match(req.rawBody, /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer/)
        assert.match(req.rawBody, /assertion=/)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ access_token: 'ya29.test', expires_in: 3600 }))
        return
      }
      assert.equal(
        req.url,
        '/v1/projects/proj-1/locations/us-central1/publishers/google/models/gemini-2.0-flash:streamGenerateContent?alt=sse'
      )
      assert.equal(req.headers.authorization, 'Bearer ya29.test')
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(
        `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'vertex-proj' }] } }] })}\n\n`
      )
      res.end()
    },
    async ({ url }) => {
      const client = new ChatVertexAI({
        model: 'gemini-2.0-flash',
        baseUrl: url,
        location: 'us-central1',
        credentials: {
          type: 'service_account',
          client_email: 'test@proj-1.iam.gserviceaccount.com',
          private_key: privateKey,
          token_uri: `${url}/token`,
          project_id: 'proj-1'
        }
      })
      const message = await client.invoke('hi')
      assert.equal(message.content, 'vertex-proj')
    }
  )
})

// ============================================================================
// Mistral
// ============================================================================

test('mistral: serverURL / 9 位工具调用 id 标准化 / 流式解析', async () => {
  await withMockServer(
    (req, res) => {
      assert.equal(req.url, '/v1/chat/completions')
      const body = req.body as any
      assert.equal(body.model, 'mistral-large-latest')
      // 历史里的非法 id 与工具结果 id 必须映射成同一个 9 位 id
      const assistant = body.messages.find((message: any) => message.role === 'assistant')
      const toolResult = body.messages.find((message: any) => message.role === 'tool')
      const mapped = assistant.tool_calls[0].id
      assert.match(mapped, /^[A-Za-z0-9]{9}$/)
      assert.equal(toolResult.tool_call_id, mapped)
      // Mistral 不发 stream_options
      assert.equal(body.stream_options, undefined)

      writeSse(res, [
        { choices: [{ index: 0, delta: { content: 'mis' } }] },
        { choices: [{ index: 0, delta: { content: 'tral' } }] },
        {
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }
        }
      ])
    },
    async ({ url }) => {
      const client = new ChatMistralAI({ model: 'mistral-large-latest', apiKey: 'k', serverURL: url })
      const message = await client.invoke([
        new HumanMessage('q'),
        new AIMessage({ content: '', tool_calls: [{ id: 'hist_1_0', name: 'demo', args: {} }] }),
        new ToolMessage({ content: 'r', tool_call_id: 'hist_1_0' })
      ])
      assert.equal(message.content, 'mistral')
      assert.equal(message.usage_metadata?.input_tokens, 2)
      assert.equal(message.usage_metadata?.output_tokens, 1)
      assert.equal(message.usage_metadata?.total_tokens, 3)
    }
  )
})

// ============================================================================
// Bedrock
// ============================================================================

test('bedrock: Bearer Token + AWS event-stream 解码（文本 / 工具 / 用量）', async () => {
  await withMockServer(
    (req, res) => {
      assert.equal(
        req.url,
        '/model/anthropic.claude-3-5-sonnet-20240620-v1%3A0/converse-stream'
      )
      assert.equal(req.headers.authorization, 'Bearer bedrock-key')
      assert.equal(req.headers.accept, 'application/vnd.amazon.eventstream')
      const body = req.body as any
      assert.equal(body.system[0].text, 'sys')
      assert.equal(body.inferenceConfig.maxTokens, 1024)
      assert.equal(body.inferenceConfig.temperature, 0.5)
      assert.equal(body.toolConfig.tools[0].toolSpec.name, 'lookup')
      assert.equal(body.toolConfig.tools[0].toolSpec.inputSchema.json.type, 'object')
      assert.equal(body.additionalModelRequestFields.thinking.type, 'enabled')

      res.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream' })
      res.write(awsEventFrame({ messageStart: { role: 'assistant' } }))
      res.write(
        awsEventFrame({
          contentBlockStart: {
            contentBlockIndex: 0,
            start: { toolUse: { toolUseId: 'toolu_1', name: 'lookup' } }
          }
        })
      )
      res.write(
        awsEventFrame({
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { toolUse: { input: '{"q":' } }
          }
        })
      )
      res.write(
        awsEventFrame({
          contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '"x"}' } } }
        })
      )
      res.write(awsEventFrame({ contentBlockStop: { contentBlockIndex: 0 } }))
      res.write(awsEventFrame({ contentBlockStart: { contentBlockIndex: 1, start: {} } }))
      res.write(
        awsEventFrame({ contentBlockDelta: { contentBlockIndex: 1, delta: { text: 'result' } } })
      )
      res.write(
        awsEventFrame({
          contentBlockDelta: {
            contentBlockIndex: 1,
            delta: { reasoningContent: { text: 'why' } }
          }
        })
      )
      res.write(awsEventFrame({ contentBlockStop: { contentBlockIndex: 1 } }))
      res.write(awsEventFrame({ messageStop: { stopReason: 'tool_use' } }))
      res.write(
        awsEventFrame({
          metadata: {
            usage: {
              inputTokens: 12,
              outputTokens: 6,
              totalTokens: 18,
              cacheReadInputTokens: 5
            }
          }
        })
      )
      res.end()
    },
    async ({ url }) => {
      const client = new ChatBedrockConverse({
        model: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
        apiKey: 'bedrock-key',
        endpointHost: url,
        maxTokens: 1024,
        temperature: 0.5,
        additionalModelRequestFields: { thinking: { type: 'enabled' } }
      })
      const lookup = tool(async () => 'ok', {
        name: 'lookup',
        description: 'lookup',
        schema: z.object({ q: z.string() })
      })
      const message = await client
        .bindTools([lookup])
        .invoke([new SystemMessage('sys'), new HumanMessage('hi')])
      assert.equal(message.content, 'result')
      assert.equal(message.additional_kwargs.reasoning_content, 'why')
      assert.deepEqual(message.tool_calls[0].args, { q: 'x' })
      assert.equal(message.tool_calls[0].id, 'toolu_1')
      assert.deepEqual(message.usage_metadata, {
        input_tokens: 12,
        output_tokens: 6,
        total_tokens: 18,
        input_token_details: { cache_read: 5 },
        cache_read_input_tokens: 5
      })
      assert.equal(message.response_metadata.finish_reason, 'tool_use')
    }
  )
})

test('bedrock: SigV4 签名头 + 流内异常帧 + 缺凭据报错', async () => {
  await withMockServer(
    (req, res) => {
      assert.match(req.headers.authorization ?? '', /^AWS4-HMAC-SHA256 Credential=AKID/)
      assert.match(req.headers.authorization ?? '', /SignedHeaders=.*host.*x-amz-date/)
      assert.match(req.headers.authorization ?? '', /Signature=[0-9a-f]{64}$/)
      assert.ok(req.headers['x-amz-date'])
      assert.ok(req.headers['x-amz-content-sha256'])
      assert.equal(req.headers['x-amz-security-token'], 'session-token')
      res.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream' })
      res.write(awsEventFrame({ throttlingException: { message: 'slow down' } }))
      res.end()
    },
    async ({ url }) => {
      const client = new ChatBedrockConverse({
        model: 'meta.llama3-8b-instruct-v1:0',
        region: 'us-east-1',
        endpointHost: url,
        credentials: {
          accessKeyId: 'AKID',
          secretAccessKey: 'SECRET',
          sessionToken: 'session-token'
        }
      })
      await assert.rejects(
        async () => await client.invoke('hi'),
        (err: unknown) => {
          assert.match((err as Error).message, /throttlingException/)
          assert.equal((err as { status?: number }).status, 429)
          return true
        }
      )
    }
  )

  const noCreds = new ChatBedrockConverse({ model: 'meta.llama3-8b-instruct-v1:0', region: 'us-west-2' })
  await assert.rejects(
    async () => await noCreds.invoke('hi'),
    (err: unknown) => {
      assert.equal((err as { status?: number }).status, 401)
      return true
    }
  )
})

test('bedrock: 消息转换（工具结果 / 图片）', () => {
  const converted = toBedrockMessages([
    new SystemMessage('sys'),
    new HumanMessage({
      content: [
        { type: 'text', text: 'see' },
        { type: 'image_url', image_url: 'data:image/png;base64,QUJD' }
      ]
    }),
    new AIMessage({ content: '', tool_calls: [{ id: 'toolu_1', name: 'lookup', args: { q: 'x' } }] }),
    new ToolMessage({ content: 'res', tool_call_id: 'toolu_1' })
  ])
  assert.equal(converted.system[0].text, 'sys')
  assert.equal((converted.messages[0].content as any[])[1].image.format, 'png')
  assert.equal((converted.messages[1].content as any[])[0].toolUse.toolUseId, 'toolu_1')
  const toolResult = (converted.messages[2].content as any[])[0].toolResult
  assert.equal(toolResult.toolUseId, 'toolu_1')
  assert.equal(toolResult.content[0].text, 'res')
})

// ============================================================================
// Cloudflare
// ============================================================================

test('cloudflare: SSE response 文本聚合与端点/鉴权', async () => {
  await withMockServer(
    (req, res) => {
      assert.equal(req.url, '/accounts/acc-1/ai/run/@cf/meta/llama-3-8b-instruct')
      assert.equal(req.headers.authorization, 'Bearer cf-token')
      assert.equal((req.body as any).stream, true)
      assert.equal((req.body as any).max_tokens, 64)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ response: 'cloud' })}\n\n`)
      res.write(`data: ${JSON.stringify({ response: 'flare' })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    },
    async ({ url }) => {
      const client = new ChatCloudflareWorkersAI({
        model: '@cf/meta/llama-3-8b-instruct',
        cloudflareAccountId: 'acc-1',
        cloudflareApiToken: 'cf-token',
        baseUrl: `${url}/accounts/acc-1/ai/run`,
        maxTokens: 64
      })
      const message = await client.invoke([new SystemMessage('s'), new HumanMessage('hi')])
      assert.equal(message.content, 'cloudflare')
    }
  )

  const noToken = new ChatCloudflareWorkersAI({
    model: '@cf/meta/llama-3-8b-instruct',
    cloudflareAccountId: 'acc-1'
  })
  await assert.rejects(
    async () => await noToken.invoke('hi'),
    (err: unknown) => {
      assert.equal((err as { status?: number }).status, 401)
      return true
    }
  )
})

// ============================================================================
// 其它契约（兼容上层用法）
// ============================================================================

test('openai-compatible: bindTools 不改原实例（并发绑定互不影响）', async () => {
  await withMockServer(
    (req, res) => {
      const names = ((req.body as any).tools ?? []).map((tool: any) => tool.function.name)
      writeSse(res, [openAIChunk({ content: names.length > 0 ? names.join(',') : 'none' })])
    },
    async ({ url }) => {
      const base = new ChatOpenAI({ model: 'gpt-test', apiKey: 'k', baseURL: url })
      const a = tool(async () => 'a', { name: 'tool_a', description: 'a', schema: z.object({}) })
      const b = tool(async () => 'b', { name: 'tool_b', description: 'b', schema: z.object({}) })
      const boundA = base.bindTools([a])
      const boundB = base.bindTools([b])
      assert.equal((await boundA.invoke('x')).content, 'tool_a')
      assert.equal((await boundB.invoke('x')).content, 'tool_b')
      assert.equal((await base.invoke('x')).content, 'none')
    }
  )
})

test('供应商实例都实现 BaseChatModel 契约（model / provider / bindTools）', () => {
  const instances: BaseChatModel[] = [
    new ChatOpenAI({ model: 'x', apiKey: 'k' }),
    new ChatDeepSeek({ model: 'x', apiKey: 'k' }),
    new ChatXAI({ model: 'x', apiKey: 'k' }),
    new ChatOpenRouter({ model: 'x', apiKey: 'k' }),
    new ChatMistralAI({ model: 'x', apiKey: 'k' }),
    new ChatAnthropic({ model: 'x', apiKey: 'k' }),
    new ChatGoogleGenerativeAI('x', { apiKey: 'k' }),
    new ChatVertexAI({ model: 'x', apiKey: 'k' }),
    new ChatOllama({ model: 'x' }),
    new ChatCloudflareWorkersAI({ model: 'x', cloudflareAccountId: 'a', cloudflareApiToken: 't' }),
    new ChatBedrockConverse({ model: 'x', apiKey: 'k', region: 'us-east-1' })
  ]
  const providers = instances.map((instance) => instance.provider)
  assert.deepEqual(providers, [
    'openai',
    'deepseek',
    'xai',
    'openrouter',
    'mistralai',
    'anthropic',
    'google',
    'vertexai',
    'ollama',
    'cloudflare',
    'bedrock'
  ])
  for (const instance of instances) {
    assert.equal(typeof instance.model, 'string')
    assert.equal(instance.modelName, instance.model)
    assert.ok(instance.bindTools([]) instanceof BaseChatModel)
  }
})

/** 直接继承 OpenAI 兼容基类的自定义端点（供应商类型 `custom` 走这条路径） */
test('custom: 继承 OpenAICompatibleChatModel 的自定义端点可用', async () => {
  class ChatCustom extends OpenAICompatibleChatModel {
    protected get defaultBaseURL(): string {
      return 'http://127.0.0.1:1/never-used'
    }
  }
  await withMockServer(
    (_req, res) => writeSse(res, [openAIChunk({ content: 'custom' })]),
    async ({ url }) => {
      const client = new ChatCustom({ model: 'custom-model', apiKey: 'k', baseURL: url })
      assert.equal(client.provider, 'openai')
      assert.equal((await client.invoke('hi')).content, 'custom')
    }
  )
})


// ============================================================================
// 空响应诊断（HTTP 200 但没有任何可用输出）
// ============================================================================

test('openai: 只有 usage 的空流 → ModelEmptyResponseError（带模型与原始报文）', async () => {
  await withMockServer(
    (_req, res) => {
      writeSse(res, [
        {
          id: 'chatcmpl-empty',
          model: 'empty-model',
          choices: [],
          usage: { prompt_tokens: 9, completion_tokens: 0, total_tokens: 9 }
        }
      ])
    },
    async ({ url }) => {
      const client = new ChatOpenAI({ model: 'empty-model', apiKey: 'k', baseURL: url })
      await assert.rejects(
        async () => await client.invoke('hi'),
        (err: unknown) => {
          assert.ok(err instanceof ModelEmptyResponseError)
          assert.match((err as Error).message, /openai returned an empty chat response/)
          assert.match((err as Error).message, /empty-model/)
          assert.match((err as Error).message, /no text content and no tool calls/)
          assert.match((err as Error).message, /Raw response/)
          assert.match((err as Error).message, /usage/)
          assert.equal((err as { status?: number }).status, undefined)
          return true
        }
      )
    }
  )
})

test('openai: HTTP 200 + error JSON → 显示服务商原文并映射状态码', async () => {
  await withMockServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          error: {
            message: 'Rate limit reached for requests',
            type: 'rate_limit_error',
            code: 'rate_limit_exceeded'
          }
        })
      )
    },
    async ({ url }) => {
      const client = new ChatOpenAI({ model: 'gpt-test', apiKey: 'k', baseURL: url })
      await assert.rejects(
        async () => await client.invoke('hi'),
        (err: unknown) => {
          assert.equal((err as Error).name, 'ModelProviderError')
          assert.equal((err as { status?: number }).status, 429)
          assert.match((err as Error).message, /Rate limit reached for requests/)
          assert.match((err as Error).message, /rate_limit_exceeded/)
          return true
        }
      )
    }
  )
})

test('openai: HTTP 200 + HTML 错误页 → 空响应错误包含页面片段与 content-type', async () => {
  await withMockServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html><body><h1>502 Bad Gateway</h1><p>upstream connect error</p></body></html>')
    },
    async ({ url }) => {
      const client = new ChatOpenAI({ model: 'gpt-test', apiKey: 'k', baseURL: url })
      await assert.rejects(
        async () => await client.invoke('hi'),
        (err: unknown) => {
          assert.ok(err instanceof ModelEmptyResponseError)
          assert.match((err as Error).message, /502 Bad Gateway/)
          assert.match((err as Error).message, /text\/html/)
          return true
        }
      )
    }
  )
})

test('openai: refusal 文本按内容返回（不误判为空响应）', async () => {
  await withMockServer(
    (_req, res) => {
      writeSse(res, [
        openAIChunk({ role: 'assistant', refusal: 'I cannot help with that request.' }),
        { id: 'x', model: 'gpt-test', choices: [], usage: { prompt_tokens: 2, completion_tokens: 1 } }
      ])
    },
    async ({ url }) => {
      const client = new ChatOpenAI({ model: 'gpt-test', apiKey: 'k', baseURL: url })
      const message = await client.invoke('do something forbidden')
      assert.equal(message.content, 'I cannot help with that request.')
    }
  )
})

test('anthropic: 只有 usage/stop_reason 的空流 → 空响应错误带 finish_reason', async () => {
  await withMockServer(
    (_req, res) => {
      writeSse(
        res,
        [
          {
            type: 'message_start',
            message: { id: 'm', model: 'claude-x', usage: { input_tokens: 5 } }
          },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } },
          { type: 'message_stop' }
        ],
        { doneMarker: false }
      )
    },
    async ({ url }) => {
      const client = new ChatAnthropic({ model: 'claude-x', apiKey: 'k', anthropicApiUrl: url })
      await assert.rejects(
        async () => await client.invoke('hi'),
        (err: unknown) => {
          assert.ok(err instanceof ModelEmptyResponseError)
          assert.match((err as Error).message, /anthropic returned an empty chat response/)
          assert.match((err as Error).message, /finish_reason=end_turn/)
          return true
        }
      )
    }
  )
})

test('anthropic: HTTP 200 + overloaded_error → ModelProviderError(status=529)', async () => {
  await withMockServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'overloaded_error', message: 'Overloaded' }
        })
      )
    },
    async ({ url }) => {
      const client = new ChatAnthropic({ model: 'claude-x', apiKey: 'k', anthropicApiUrl: url })
      await assert.rejects(
        async () => await client.invoke('hi'),
        (err: unknown) => {
          assert.equal((err as Error).name, 'ModelProviderError')
          assert.equal((err as { status?: number }).status, 529)
          assert.match((err as Error).message, /Overloaded/)
          return true
        }
      )
    }
  )
})

test('gemini: 只返回思考内容 → 空响应错误说明没有最终答复', async () => {
  await withMockServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(
        `data: ${JSON.stringify({
          candidates: [
            {
              content: { role: 'model', parts: [{ text: 'I am thinking very hard', thought: true }] },
              finishReason: 'STOP'
            }
          ]
        })}\n\n`
      )
      res.end()
    },
    async ({ url }) => {
      const client = new ChatGoogleGenerativeAI('gemini-2.5-flash', { apiKey: 'k', baseUrl: url })
      await assert.rejects(
        async () => await client.invoke('hi'),
        (err: unknown) => {
          assert.ok(err instanceof ModelEmptyResponseError)
          assert.match((err as Error).message, /Only reasoning\/thinking content/)
          assert.match((err as Error).message, /I am thinking very hard/)
          return true
        }
      )
    }
  )
})

test('ollama: 非 NDJSON（HTML 错误页）→ 空响应错误包含原始页面', async () => {
  await withMockServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html><body>Ollama is not running on this port</body></html>')
    },
    async ({ url }) => {
      const client = new ChatOllama({ model: 'llama3.1', baseUrl: url })
      await assert.rejects(
        async () => await client.invoke('hi'),
        (err: unknown) => {
          assert.ok(err instanceof ModelEmptyResponseError)
          assert.match((err as Error).message, /Ollama is not running/)
          assert.match((err as Error).message, /text\/html/)
          return true
        }
      )
    }
  )
})

test('cloudflare: success=false 错误体 → ModelProviderError 带服务商信息', async () => {
  await withMockServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          success: false,
          errors: [{ code: 10000, message: 'Authentication error' }],
          result: null
        })
      )
    },
    async ({ url }) => {
      const client = new ChatCloudflareWorkersAI({
        model: '@cf/meta/llama-3-8b-instruct',
        cloudflareAccountId: 'acc',
        cloudflareApiToken: 'token',
        baseUrl: `${url}/ai/run`
      })
      await assert.rejects(
        async () => await client.invoke('hi'),
        (err: unknown) => {
          assert.equal((err as Error).name, 'ModelProviderError')
          assert.match((err as Error).message, /Authentication error/)
          return true
        }
      )
    }
  )
})

test('bedrock: 空事件流（只有 messageStart/messageStop）→ 空响应错误', async () => {
  await withMockServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream' })
      res.write(awsEventFrame({ messageStart: { role: 'assistant' } }))
      res.write(awsEventFrame({ messageStop: { stopReason: 'end_turn' } }))
      res.end()
    },
    async ({ url }) => {
      const client = new ChatBedrockConverse({
        model: 'meta.llama3-8b-instruct-v1:0',
        apiKey: 'bedrock-key',
        endpointHost: url
      })
      await assert.rejects(
        async () => await client.invoke('hi'),
        (err: unknown) => {
          assert.ok(err instanceof ModelEmptyResponseError)
          assert.match((err as Error).message, /bedrock returned an empty chat response/)
          assert.match((err as Error).message, /finish_reason=end_turn/)
          return true
        }
      )
    }
  )
})

// ============================================================================
// 流式兼容性：空流 / 网关拒绝流式时自动降级为「非流式」请求
// ============================================================================

/** 非流式完整响应体（带内容 / 工具调用两种形态） */
function openAICompletion(body: {
  content?: string
  toolCalls?: Array<{ id: string; name: string; args: string }>
}): Record<string, unknown> {
  const message: Record<string, unknown> = {
    role: 'assistant',
    content: body.content ?? ''
  }
  if (body.toolCalls && body.toolCalls.length > 0) {
    message.tool_calls = body.toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.args }
    }))
  }
  return {
    id: 'chatcmpl-fallback',
    model: 'mock-model',
    choices: [{ index: 0, message, finish_reason: body.toolCalls ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }
  }
}

test('openai: 空流自动降级非流式（对齐 Spring AI 的 stream:false 行为）', async () => {
  await withMockServer(
    (req, res) => {
      if ((req.body as any)?.stream === true) {
        writeSse(res, [
          {
            id: 'chatcmpl-empty',
            model: 'mock-model',
            choices: [],
            usage: { prompt_tokens: 4, completion_tokens: 0, total_tokens: 4 }
          }
        ])
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(openAICompletion({ content: 'recovered by non-streaming' })))
    },
    async ({ url, requests }) => {
      const client = new ChatOpenAI({ model: 'mock-model', apiKey: 'k', baseURL: url })
      const message = await client.invoke('hi')
      assert.equal(message.content, 'recovered by non-streaming')
      assert.equal(message.response_metadata.fallback, 'non-streaming')
      assert.equal(message.usage_metadata?.total_tokens, 6)
      assert.equal(requests.length, 2)
      assert.equal((requests[0].body as any).stream, true)
      assert.equal((requests[1].body as any).stream, false)
      assert.equal((requests[1].body as any).stream_options, undefined)
    }
  )
})

test('openai: 网关拒绝流式参数（400）→ 自动换非流式并继续', async () => {
  await withMockServer(
    (req, res) => {
      if ((req.body as any)?.stream === true) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'streaming is not supported' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(openAICompletion({ content: 'non-stream only gateway' })))
    },
    async ({ url, requests }) => {
      const client = new ChatOpenAI({ model: 'mock-model', apiKey: 'k', baseURL: url })
      const message = await client.invoke('hi')
      assert.equal(message.content, 'non-stream only gateway')
      // 流式 → 参数兼容重试（仍流式）→ 非流式兜底
      assert.equal(requests.length, 3)
      const nonStreamingRequests = requests.filter((request) => (request.body as any).stream === false)
      assert.equal(nonStreamingRequests.length, 1)
      assert.equal((nonStreamingRequests[0].body as any).stream, false)
    }
  )
})

test('openai: 用户配置 streaming:false → 只发非流式请求', async () => {
  await withMockServer(
    (req, res) => {
      assert.equal((req.body as any).stream, false)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(openAICompletion({ content: 'configured non-streaming' })))
    },
    async ({ url, requests }) => {
      const client = new ChatOpenAI({
        model: 'mock-model',
        apiKey: 'k',
        baseURL: url,
        streaming: false
      })
      const message = await client.invoke('hi')
      assert.equal(message.content, 'configured non-streaming')
      assert.equal(requests.length, 1)
      assert.equal(message.response_metadata.fallback, 'non-streaming')
    }
  )
})

test('openai: 两次尝试都为空 → 错误里同时保留两次原始报文', async () => {
  await withMockServer(
    (req, res) => {
      if ((req.body as any)?.stream === true) {
        writeSse(res, [
          { id: 'chatcmpl-empty', model: 'mock-model', choices: [] }
        ])
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'chatcmpl-empty',
          model: 'mock-model',
          choices: [],
          usage: { prompt_tokens: 1, completion_tokens: 0 }
        })
      )
    },
    async ({ url, requests }) => {
      const client = new ChatOpenAI({ model: 'mock-model', apiKey: 'k', baseURL: url })
      await assert.rejects(
        async () => await client.invoke('hi'),
        (err: unknown) => {
          assert.ok(err instanceof ModelEmptyResponseError)
          assert.match((err as Error).message, /streaming attempt/)
          assert.match((err as Error).message, /non-streaming attempt/)
          assert.match((err as Error).message, /chatcmpl-empty/)
          return true
        }
      )
      // 纯域名 base_url 会尝试两个候选端点，每个端点各试流式 + 非流式
      assert.equal(requests.length, 4)
    }
  )
})

test('openai: 非流式响应被标错 content-type（text/plain）也能解析', async () => {
  await withMockServer(
    (req, res) => {
      if ((req.body as any)?.stream === true) {
        writeSse(res, [{ id: 'x', model: 'mock-model', choices: [] }])
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(JSON.stringify(openAICompletion({ content: 'plain text json body' })))
    },
    async ({ url }) => {
      const client = new ChatOpenAI({ model: 'mock-model', apiKey: 'k', baseURL: url })
      const message = await client.invoke('hi')
      assert.equal(message.content, 'plain text json body')
    }
  )
})

test('openai: 标成 application/json 的 SSE 报文也能解析（反向容错）', async () => {
  await withMockServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        `data: ${JSON.stringify(openAIChunk({ content: 'json-labeled sse' }))}\n\ndata: [DONE]\n\n`
      )
    },
    async ({ url, requests }) => {
      const client = new ChatOpenAI({ model: 'mock-model', apiKey: 'k', baseURL: url })
      const message = await client.invoke('hi')
      assert.equal(message.content, 'json-labeled sse')
      // 同一次响应内就解析出来了，不需要再发兜底请求
      assert.equal(requests.length, 1)
    }
  )
})

test('openai: 非流式兜底也能拿到工具调用', async () => {
  await withMockServer(
    (req, res) => {
      if ((req.body as any)?.stream === true) {
        writeSse(res, [{ id: 'x', model: 'mock-model', choices: [] }])
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify(
          openAICompletion({
            toolCalls: [{ id: 'call_fb', name: 'echo', args: '{"text":"hi"}' }]
          })
        )
      )
    },
    async ({ url }) => {
      const client = new ChatOpenAI({ model: 'mock-model', apiKey: 'k', baseURL: url })
      const echo = tool(async () => 'ok', {
        name: 'echo',
        description: 'echo',
        schema: z.object({ text: z.string() })
      })
      const message = await client.bindTools([echo]).invoke('hi')
      assert.equal(message.tool_calls.length, 1)
      assert.deepEqual(message.tool_calls[0].args, { text: 'hi' })
      assert.equal(message.tool_calls[0].id, 'call_fb')
    }
  )
})

// ============================================================================
// 其它协议的非流式兜底（对齐 Spring AI 默认 stream:false 的行为）
// ============================================================================

test('anthropic: 空流自动降级非流式并继续', async () => {
  await withMockServer(
    (req, res) => {
      if ((req.body as any)?.stream === true) {
        writeSse(
          res,
          [
            {
              type: 'message_start',
              message: { id: 'm', model: 'claude-x', usage: { input_tokens: 3 } }
            },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } },
            { type: 'message_stop' }
          ],
          { doneMarker: false }
        )
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'm2',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'anthropic recovered' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 3, output_tokens: 2 }
        })
      )
    },
    async ({ url, requests }) => {
      const client = new ChatAnthropic({ model: 'claude-x', apiKey: 'k', anthropicApiUrl: url })
      const message = await client.invoke('hi')
      assert.equal(message.content, 'anthropic recovered')
      assert.equal(message.response_metadata.fallback, 'non-streaming')
      assert.equal(requests.length, 2)
      assert.equal((requests[1].body as any).stream, false)
    }
  )
})

test('gemini: 空流自动降级 :generateContent 非流式接口', async () => {
  await withMockServer(
    (req, res) => {
      if ((req.url ?? '').includes(':streamGenerateContent')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ candidates: [] })}\n\n`)
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          candidates: [
            { content: { role: 'model', parts: [{ text: 'gemini recovered' }] }, finishReason: 'STOP' }
          ],
          usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 }
        })
      )
    },
    async ({ url, requests }) => {
      const client = new ChatGoogleGenerativeAI('gemini-2.5-flash', { apiKey: 'k', baseUrl: url })
      const message = await client.invoke('hi')
      assert.equal(message.content, 'gemini recovered')
      assert.equal(message.response_metadata.fallback, 'non-streaming')
      assert.equal(requests.length, 2)
      assert.match(requests[1].url, /:generateContent\?key=/)
      assert.doesNotMatch(requests[1].url, /alt=sse/)
    }
  )
})

test('vertex: 空流自动降级 :generateContent 非流式接口', async () => {
  await withMockServer(
    (req, res) => {
      if ((req.url ?? '').includes(':streamGenerateContent')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ candidates: [] })}\n\n`)
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          candidates: [{ content: { role: 'model', parts: [{ text: 'vertex recovered' }] } }]
        })
      )
    },
    async ({ url, requests }) => {
      const client = new ChatVertexAI({ model: 'gemini-2.0-flash', apiKey: 'AIza-v', baseUrl: url })
      const message = await client.invoke('hi')
      assert.equal(message.content, 'vertex recovered')
      assert.equal(requests.length, 2)
      assert.match(requests[1].url, /:generateContent\?key=/)
    }
  )
})

test('ollama: 空流自动降级非流式并继续', async () => {
  await withMockServer(
    (req, res) => {
      if ((req.body as any)?.stream === true) {
        writeNdjson(res, [
          { model: 'llama3.1', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' }
        ])
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          model: 'llama3.1',
          message: { role: 'assistant', content: 'ollama recovered' },
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 2,
          eval_count: 1
        })
      )
    },
    async ({ url, requests }) => {
      const client = new ChatOllama({ model: 'llama3.1', baseUrl: url })
      const message = await client.invoke('hi')
      assert.equal(message.content, 'ollama recovered')
      assert.equal(message.response_metadata.fallback, 'non-streaming')
      assert.equal(requests.length, 2)
      assert.equal((requests[1].body as any).stream, false)
    }
  )
})

test('bedrock: 空事件流自动降级 /converse 非流式接口', async () => {
  await withMockServer(
    (req, res) => {
      if ((req.url ?? '').includes('converse-stream')) {
        res.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream' })
        res.write(awsEventFrame({ messageStart: { role: 'assistant' } }))
        res.write(awsEventFrame({ messageStop: { stopReason: 'end_turn' } }))
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          output: { message: { role: 'assistant', content: [{ text: 'bedrock recovered' }] } },
          stopReason: 'end_turn',
          usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 }
        })
      )
    },
    async ({ url, requests }) => {
      const client = new ChatBedrockConverse({
        model: 'meta.llama3-8b-instruct-v1:0',
        apiKey: 'bedrock-key',
        endpointHost: url
      })
      const message = await client.invoke('hi')
      assert.equal(message.content, 'bedrock recovered')
      assert.equal(message.response_metadata.fallback, 'non-streaming')
      assert.equal(requests.length, 2)
      assert.match(requests[1].url, /\/converse$/)
      assert.equal(requests[1].headers.accept, 'application/json')
    }
  )
})

test('cloudflare: 空流自动降级非流式并继续', async () => {
  await withMockServer(
    (req, res) => {
      if ((req.body as any)?.stream === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ success: true, result: { response: 'cloudflare recovered' } }))
    },
    async ({ url, requests }) => {
      const client = new ChatCloudflareWorkersAI({
        model: '@cf/meta/llama-3-8b-instruct',
        cloudflareAccountId: 'acc',
        cloudflareApiToken: 'token',
        baseUrl: `${url}/ai/run`
      })
      const message = await client.invoke('hi')
      assert.equal(message.content, 'cloudflare recovered')
      assert.equal(message.response_metadata.fallback, 'non-streaming')
      assert.equal(requests.length, 2)
      assert.equal((requests[1].body as any).stream, false)
    }
  )
})

test('openai: HTTP 200 的「不支持流式」错误体 → 自动降级非流式成功', async () => {
  await withMockServer(
    (req, res) => {
      if ((req.body as any)?.stream === true) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'streaming is not supported' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(openAICompletion({ content: 'recovered from embedded error' })))
    },
    async ({ url, requests }) => {
      const client = new ChatOpenAI({ model: 'mock-model', apiKey: 'k', baseURL: url })
      const message = await client.invoke('hi')
      assert.equal(message.content, 'recovered from embedded error')
      assert.equal(requests.length, 2)
      assert.equal((requests[1].body as any).stream, false)
    }
  )
})

test('openai: SSE 里的「不支持流式」错误事件 → 自动降级非流式成功', async () => {
  await withMockServer(
    (req, res) => {
      if ((req.body as any)?.stream === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ error: { message: 'unsupported parameter: stream' } })}\n\n`)
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(openAICompletion({ content: 'recovered from stream error event' })))
    },
    async ({ url, requests }) => {
      const client = new ChatOpenAI({ model: 'mock-model', apiKey: 'k', baseURL: url })
      const message = await client.invoke('hi')
      assert.equal(message.content, 'recovered from stream error event')
      assert.equal(requests.length, 2)
    }
  )
})

test('openai: HTTP 200 的限流错误体不会被误当成「不支持流式」', async () => {
  await withMockServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          error: { message: 'Rate limit reached', type: 'rate_limit_error', code: 'rate_limit_exceeded' }
        })
      )
    },
    async ({ url, requests }) => {
      const client = new ChatOpenAI({ model: 'mock-model', apiKey: 'k', baseURL: url })
      await assert.rejects(
        async () => await client.invoke('hi'),
        (err: unknown) => {
          assert.equal((err as Error).name, 'ModelProviderError')
          assert.equal((err as { status?: number }).status, 429)
          return true
        }
      )
      // 429 是明确的限流，不应再发一次非流式请求
      assert.equal(requests.length, 1)
    }
  )
})

// ============================================================================
// 端点路径兼容（LangChain 的 base+ /chat/completions vs Spring AI 的 base+ /v1/chat/completions）
// ============================================================================

test('openai: 纯域名 base_url 优先生成 Spring AI 风格的 /v1/chat/completions', async () => {
  await withMockServer(
    (_req, res) => {
      writeSse(res, [openAIChunk({ content: 'root base works' })])
    },
    async ({ url, requests }) => {
      const client = new ChatOpenAI({ model: 'mock-model', apiKey: 'k', baseURL: url })
      const message = await client.invoke('hi')
      assert.equal(message.content, 'root base works')
      assert.equal(requests.length, 1)
      assert.equal(requests[0].url, '/v1/chat/completions')
    }
  )
})

test('openai: 自定义路径先按原语义请求，404 后回退 /v1 路径', async () => {
  await withMockServer(
    (req, res) => {
      if (req.url === '/api/chat/completions') {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'not found' } }))
        return
      }
      writeSse(res, [openAIChunk({ content: 'path fallback works' })])
    },
    async ({ url, requests }) => {
      const client = new ChatOpenAI({ model: 'mock-model', apiKey: 'k', baseURL: `${url}/api` })
      const message = await client.invoke('hi')
      assert.equal(message.content, 'path fallback works')
      assert.deepEqual(
        requests.map((request) => request.url),
        ['/api/chat/completions', '/api/v1/chat/completions']
      )
    }
  )
})

test('openai: 带版本段的 base_url 不重复拼接 /v1', async () => {
  await withMockServer(
    (_req, res) => {
      writeSse(res, [openAIChunk({ content: 'versioned base works' })])
    },
    async ({ url, requests }) => {
      const client = new ChatOpenAI({ model: 'mock-model', apiKey: 'k', baseURL: `${url}/v1` })
      const message = await client.invoke('hi')
      assert.equal(message.content, 'versioned base works')
      assert.equal(requests[0].url, '/v1/chat/completions')
    }
  )
})

test('openai: base_url 已经包含 /chat/completions 时原样使用', async () => {
  await withMockServer(
    (_req, res) => {
      writeSse(res, [openAIChunk({ content: 'full endpoint works' })])
    },
    async ({ url, requests }) => {
      const client = new ChatOpenAI({
        model: 'mock-model',
        apiKey: 'k',
        baseURL: `${url}/v1/chat/completions`
      })
      const message = await client.invoke('hi')
      assert.equal(message.content, 'full endpoint works')
      assert.equal(requests[0].url, '/v1/chat/completions')
    }
  )
})

test('openai: 两个候选端点都为空 → 错误里同时列出两次尝试', async () => {
  await withMockServer(
    (_req, res) => {
      writeSse(res, [
        { id: 'x', model: 'mock-model', choices: [], usage: { prompt_tokens: 1, completion_tokens: 0 } }
      ])
    },
    async ({ url }) => {
      const client = new ChatOpenAI({ model: 'mock-model', apiKey: 'k', baseURL: `${url}/api` })
      await assert.rejects(
        async () => await client.invoke('hi'),
        (err: unknown) => {
          assert.ok(err instanceof ModelEmptyResponseError)
          assert.match((err as Error).message, /first endpoint/)
          assert.match((err as Error).message, /fallback endpoint/)
          return true
        }
      )
    }
  )
})

// ============================================================================
// 流式报文形态容错（对标 Spring AI 的宽进解析）
// ============================================================================

test('openai: CR 换行的 SSE（\\r\\r 分帧）也能解析', async () => {
  await withMockServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify(openAIChunk({ content: 'cr-' }))}\r\r`)
      res.write(`data: ${JSON.stringify(openAIChunk({ content: 'framed' }))}\r\r`)
      res.write('data: [DONE]\r\r')
      res.end()
    },
    async ({ url }) => {
      const client = new ChatOpenAI({ model: 'mock-model', apiKey: 'k', baseURL: `${url}/v1` })
      const message = await client.invoke('hi')
      assert.equal(message.content, 'cr-framed')
    }
  )
})

test('openai: 没有 data: 前缀的裸 JSON 行（NDJSON）也能解析', async () => {
  await withMockServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`${JSON.stringify(openAIChunk({ content: 'bare-' }))}\n`)
      res.write(`${JSON.stringify(openAIChunk({ content: 'json' }))}\n`)
      res.end()
    },
    async ({ url }) => {
      const client = new ChatOpenAI({ model: 'mock-model', apiKey: 'k', baseURL: `${url}/v1` })
      const message = await client.invoke('hi')
      assert.equal(message.content, 'bare-json')
    }
  )
})

test('openai: 一个 SSE 事件里是 JSON 数组（多个 chunk）也能解析', async () => {
  await withMockServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(
        `data: ${JSON.stringify([
          openAIChunk({ content: 'array-' }),
          openAIChunk({ content: 'chunks' })
        ])}\n\n`
      )
      res.end()
    },
    async ({ url }) => {
      const client = new ChatOpenAI({ model: 'mock-model', apiKey: 'k', baseURL: `${url}/v1` })
      const message = await client.invoke('hi')
      assert.equal(message.content, 'array-chunks')
    }
  )
})

test('openai: 顶层 content 流（无 choices 包装）也能解析', async () => {
  await withMockServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ content: 'top-level' })}\n\n`)
      res.end()
    },
    async ({ url }) => {
      const client = new ChatOpenAI({ model: 'mock-model', apiKey: 'k', baseURL: `${url}/v1` })
      const message = await client.invoke('hi')
      assert.equal(message.content, 'top-level')
    }
  )
})

test('openai: completion 风格 choices[].text 也能解析', async () => {
  await withMockServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ text: 'completion-' }] })}\n\n`)
      res.write(
        `data: ${JSON.stringify({ choices: [{ text: 'style', finish_reason: 'stop' }] })}\n\n`
      )
      res.end()
    },
    async ({ url }) => {
      const client = new ChatOpenAI({ model: 'mock-model', apiKey: 'k', baseURL: `${url}/v1` })
      const message = await client.invoke('hi')
      assert.equal(message.content, 'completion-style')
    }
  )
})

test('openai: 一个事件里多行 data（多个 JSON）也能解析', async () => {
  await withMockServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(
        `data: ${JSON.stringify(openAIChunk({ content: 'multi-' }))}\n` +
          `data: ${JSON.stringify(openAIChunk({ content: 'line' }))}\n\n`
      )
      res.end()
    },
    async ({ url }) => {
      const client = new ChatOpenAI({ model: 'mock-model', apiKey: 'k', baseURL: `${url}/v1` })
      const message = await client.invoke('hi')
      assert.equal(message.content, 'multi-line')
    }
  )
})

// ============================================================================
// 参数兼容重试（网关拒绝 thinking / reasoning 等可选字段时，用最小请求体继续）
// ============================================================================

test('openai: 网关拒绝 thinking 参数（400）→ 最小请求体重试并成功', async () => {
  await withMockServer(
    (req, res) => {
      if ((req.body as any)?.thinking !== undefined) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Unsupported parameter: thinking' } }))
        return
      }
      writeSse(res, [openAIChunk({ content: 'compat retry works' })])
    },
    async ({ url, requests }) => {
      const client = new ChatOpenAI({
        model: 'mock-model',
        apiKey: 'k',
        baseURL: `${url}/v1`,
        modelKwargs: { thinking: { type: 'enabled' }, reasoning_effort: 'medium' }
      })
      const message = await client.invoke('hi')
      assert.equal(message.content, 'compat retry works')
      assert.equal(requests.length, 2)
      assert.deepEqual((requests[0].body as any).thinking, { type: 'enabled' })
      assert.equal((requests[0].body as any).reasoning_effort, 'medium')
      assert.equal((requests[1].body as any).thinking, undefined)
      assert.equal((requests[1].body as any).reasoning_effort, undefined)
      assert.equal(message.response_metadata.compatibility, 'minimal-request')
    }
  )
})

test('openai: 非流式模式同样支持参数兼容重试', async () => {
  await withMockServer(
    (req, res) => {
      if ((req.body as any)?.thinking !== undefined) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'unsupported field: thinking' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(openAICompletion({ content: 'non-stream compat works' })))
    },
    async ({ url, requests }) => {
      const client = new ChatOpenAI({
        model: 'mock-model',
        apiKey: 'k',
        baseURL: `${url}/v1`,
        streaming: false,
        modelKwargs: { thinking: { type: 'enabled' } }
      })
      const message = await client.invoke('hi')
      assert.equal(message.content, 'non-stream compat works')
      assert.equal(requests.length, 2)
      assert.deepEqual((requests[0].body as any).thinking, { type: 'enabled' })
      assert.equal((requests[1].body as any).thinking, undefined)
      assert.equal(message.response_metadata.compatibility, 'minimal-request')
    }
  )
})

test('openai: 非参数类 400（模型名错误）不触发兼容重试', async () => {
  await withMockServer(
    (_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'The model does not exist' } }))
    },
    async ({ url, requests }) => {
      const client = new ChatOpenAI({ model: 'bad-model', apiKey: 'k', baseURL: `${url}/v1` })
      await assert.rejects(
        async () => await client.invoke('hi'),
        (err: unknown) => {
          assert.equal((err as { status?: number }).status, 400)
          return true
        }
      )
      // 不触发「最小请求体」兼容重试，但仍会做一次非流式兜底（400 不在跳过名单里）
      assert.equal(requests.length, 2)
    }
  )
})