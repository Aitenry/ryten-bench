/**
 * 真实 Agent 图集成测试（不依赖 Electron / 网络）。
 *
 * 直接使用 `src/main/runtime/harness/agent.ts` 的 `buildAgentGraph` 与
 * `src/main/runtime/harness/graph.ts` 的 `startGraphStream` / `invokeGraph`，
 * 验证：模型 → 工具 → 模型循环、记录队列、流式 chunk 转记录、参数校验失败回灌、
 * 递归上限优雅收尾。Electron 相关模块由 scripts/ai-selftest.mjs 的 stub 插件替换。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { z } from 'zod'

import { buildAgentGraph } from '../../src/main/runtime/harness/agent'
import {
  RECURSION_STOP_NOTE,
  RecordQueue,
  invokeGraph,
  startGraphStream
} from '../../src/main/runtime/harness/graph'
import { classifyModelError } from '../../src/main/runtime/harness/model-recovery'
import {
  AIMessage,
  AIMessageChunk,
  BaseChatModel,
  ChatOpenAI,
  HumanMessage,
  ModelEmptyResponseError,
  ToolMessage,
  tool,
  type ModelCallOptions,
  type StructuredToolInterface
} from '../../src/main/ai/index'
import type { BaseMessage } from '../../src/main/ai/messages'

interface ScriptStep {
  message: AIMessage
  chunks?: string[]
  toolChunk?: { index: number; id: string; name: string; args: string }
}

/** 测试替身：按脚本逐次回复；每次调用记录收到的消息与工具集 */
class ScriptedChatModel extends BaseChatModel {
  readonly model = 'scripted-model'
  private index = 0
  readonly received: Array<{ messages: BaseMessage[]; tools: string[] }> = []

  constructor(private readonly script: ScriptStep[]) {
    super()
  }

  protected async _generate(
    messages: BaseMessage[],
    tools: StructuredToolInterface[],
    options: ModelCallOptions
  ): Promise<AIMessage> {
    this.received.push({ messages, tools: tools.map((item) => item.name) })
    const step = this.script[Math.min(this.index, this.script.length - 1)]
    this.index += 1
    for (const chunk of step.chunks ?? []) {
      options.onModelChunk?.(new AIMessageChunk({ content: chunk }))
    }
    if (step.toolChunk) {
      options.onModelChunk?.(
        new AIMessageChunk({ content: '', tool_call_chunks: [step.toolChunk] })
      )
    }
    return step.message
  }
}

/** 消费三路记录流（生产者是后台任务，必须并发消费） */
async function drain(
  run: ReturnType<typeof startGraphStream>
): Promise<{
  messages: Array<Record<string, any>>
  toolCalls: Array<Record<string, any>>
}> {
  const messages: Array<Record<string, any>> = []
  const toolCalls: Array<Record<string, any>> = []
  await Promise.all([
    (async () => {
      for await (const record of run.messages) messages.push(record as Record<string, any>)
    })(),
    (async () => {
      for await (const record of run.toolCalls) toolCalls.push(record as Record<string, any>)
    })(),
    (async () => {
      for await (const _record of run.subagents) {
        // 本文件不测子代理流
      }
    })()
  ])
  return { messages, toolCalls }
}

test('agent: 流式执行（工具循环 + 记录队列 + 流式 chunk 转记录）', async () => {
  const executed: unknown[] = []
  const echo = tool(
    async (args: { text: string }) => {
      executed.push(args)
      return `echo:${args.text}`
    },
    { name: 'echo', description: 'echo tool', schema: z.object({ text: z.string() }) }
  )
  const model = new ScriptedChatModel([
    {
      message: new AIMessage({
        content: 'I will call echo',
        tool_calls: [{ id: 'call_1', name: 'echo', args: { text: 'hi' } }]
      }),
      chunks: ['I will ', 'call echo'],
      toolChunk: { index: 0, id: 'call_1', name: 'echo', args: '{"text":"hi"}' }
    },
    { message: new AIMessage({ content: 'final answer' }), chunks: ['final ', 'answer'] }
  ])
  const queue = new RecordQueue()
  const queueRef = { current: queue as { push(record: unknown): void } | undefined }
  const graph = buildAgentGraph({
    model,
    tools: [echo],
    systemPrompt: 'system prompt',
    queue: queueRef as never,
    maxToolCalls: 20
  })
  const run = startGraphStream(
    graph,
    { messages: [new HumanMessage('go')] },
    { recursionLimit: 20, configurable: { topicId: 42 } },
    queue
  )
  const { messages, toolCalls } = await drain(run)

  assert.equal(run.error, undefined)
  // 文本 chunk 与工具块起点都变成了运行时记录
  assert.deepEqual(
    messages.filter((record) => record.kind === 'text').map((record) => record.text),
    ['I will ', 'call echo', 'final ', 'answer']
  )
  const blockStart = messages.find((record) => record.kind === 'tool_block_start')
  assert.equal(blockStart?.name, 'echo')
  assert.equal(blockStart?.id, 'call_1')

  // 工具调用记录：名称/入参/输出 Promise 都对得上；输出内容为工具真实结果
  assert.equal(toolCalls.length, 1)
  assert.equal(toolCalls[0].name, 'echo')
  assert.equal(toolCalls[0].callId, 'call_1')
  assert.deepEqual(toolCalls[0].input, { text: 'hi' })
  assert.equal(await toolCalls[0].output, 'echo:hi')
  assert.deepEqual(executed, [{ text: 'hi' }])

  // 模型拿到的是 system + 完整历史（第二轮里带工具结果）
  assert.equal(model.received.length, 2)
  assert.deepEqual(model.received[0].tools, ['echo'])
  assert.equal(model.received[0].messages[0].type, 'system')
  const secondMessages = model.received[1].messages
  assert.equal(secondMessages[0].type, 'system')
  const toolMessage = secondMessages[secondMessages.length - 1]
  assert.equal(toolMessage.type, 'tool')
  assert.equal((toolMessage as ToolMessage).content, 'echo:hi')
  assert.equal((toolMessage as ToolMessage).tool_call_id, 'call_1')
})

test('agent: invoke 路径返回最终消息序列', async () => {
  const add = tool(async (args: { a: number; b: number }) => String(args.a + args.b), {
    name: 'add',
    description: 'add numbers',
    schema: z.object({ a: z.number(), b: z.number() })
  })
  const model = new ScriptedChatModel([
    {
      message: new AIMessage({
        content: '',
        tool_calls: [{ id: 'call_add', name: 'add', args: { a: 2, b: 3 } }]
      })
    },
    { message: new AIMessage({ content: 'sum is 5' }) }
  ])
  const graph = buildAgentGraph({ model, tools: [add], systemPrompt: 'sys' })
  const messages = await invokeGraph(
    graph,
    { messages: [new HumanMessage('2+3?')] },
    { recursionLimit: 10 }
  )
  assert.equal(messages.length, 4)
  assert.equal(messages[0].type, 'human')
  assert.equal(messages[1].type, 'ai')
  assert.equal(messages[2].type, 'tool')
  assert.equal((messages[2] as ToolMessage).content, '5')
  assert.equal(messages[3].type, 'ai')
  assert.equal(messages[3].text, 'sum is 5')
})

test('agent: 工具参数校验失败回灌给模型（不中断整轮）', async () => {
  const strict = tool(async (args: { count: number }) => `count=${args.count}`, {
    name: 'strict',
    description: 'needs count',
    schema: z.object({ count: z.number().int().min(1) })
  })
  const model = new ScriptedChatModel([
    {
      message: new AIMessage({
        content: '',
        tool_calls: [{ id: 'bad_call', name: 'strict', args: {} }]
      })
    },
    { message: new AIMessage({ content: 'recovered' }) }
  ])
  const graph = buildAgentGraph({ model, tools: [strict], systemPrompt: 'sys' })
  const messages = await invokeGraph(
    graph,
    { messages: [new HumanMessage('go')] },
    { recursionLimit: 10 }
  )
  assert.equal(messages[messages.length - 1].text, 'recovered')
  const toolResult = messages.find((message) => message.type === 'tool') as ToolMessage
  assert.ok(toolResult)
  assert.match(toolResult.content as string, /validation failed/i)
  // 模型第二轮确实读到了这条失败结果
  const secondCall = model.received[1].messages
  assert.equal(secondCall[secondCall.length - 1].type, 'tool')
  assert.match(
    (secondCall[secondCall.length - 1] as ToolMessage).content as string,
    /validation failed/i
  )
})

test('agent: 递归上限（invoke / stream 两条路径都优雅收尾）', async () => {
  const loop = tool(async () => 'again', {
    name: 'noop',
    description: 'noop',
    schema: z.object({})
  })
  const loopCall = new AIMessage({
    content: '',
    tool_calls: [{ id: 'loop_call', name: 'noop', args: {} }]
  })

  // 非流式：返回收尾提示消息而不是抛错
  const invokeModel = new ScriptedChatModel([{ message: loopCall }])
  const invokeGraphInstance = buildAgentGraph({
    model: invokeModel,
    tools: [loop],
    systemPrompt: 'sys'
  })
  const messages = await invokeGraph(
    invokeGraphInstance,
    { messages: [new HumanMessage('loop')] },
    { recursionLimit: 3 }
  )
  assert.equal(messages.length, 1)
  assert.equal(messages[0].text, RECURSION_STOP_NOTE.trim())

  // 流式：推一条收尾文本记录后正常关闭
  const streamModel = new ScriptedChatModel([{ message: loopCall }])
  const queue = new RecordQueue()
  const queueRef = { current: queue as { push(record: unknown): void } | undefined }
  const graph = buildAgentGraph({
    model: streamModel,
    tools: [loop],
    systemPrompt: 'sys',
    queue: queueRef as never,
    maxToolCalls: 20
  })
  const run = startGraphStream(
    graph,
    { messages: [new HumanMessage('loop')] },
    { recursionLimit: 3 },
    queue
  )
  const { messages: records } = await drain(run)
  assert.equal(run.error, undefined)
  const note = records[records.length - 1]
  assert.equal(note.kind, 'text')
  assert.equal(note.text, RECURSION_STOP_NOTE)
})

test('agent: 用户取消（aborted signal）以 AbortError 结束', async () => {
  const noop = tool(async () => 'x', {
    name: 'noop',
    description: 'noop',
    schema: z.object({})
  })
  const model = new ScriptedChatModel([{ message: new AIMessage({ content: 'x' }) }])
  const graph = buildAgentGraph({ model, tools: [noop], systemPrompt: 'sys' })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    async () =>
      await invokeGraph(
        graph,
        { messages: [new HumanMessage('go')] },
        { recursionLimit: 10, signal: controller.signal }
      ),
    (err: unknown) => {
      assert.equal((err as Error).name, 'AbortError')
      return true
    }
  )
})


// ============================================================================
// 端到端：真实 OpenAI 协议（本地 SSE 桩）+ 真实 Agent 图
// ============================================================================

interface MockRequest {
  body: any
}

async function withSseServer(
  handler: (req: MockRequest, res: http.ServerResponse) => void,
  run: (ctx: { url: string; requests: MockRequest[] }) => Promise<void>
): Promise<void> {
  const requests: MockRequest[] = []
  const server = http.createServer(async (rawReq, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of rawReq) chunks.push(Buffer.from(chunk))
    let body: unknown
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      body = undefined
    }
    requests.push({ body })
    handler({ body }, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  try {
    await run({ url: `http://127.0.0.1:${address.port}`, requests })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

/** OpenAI 兼容 SSE 桩：第一次返回工具调用，第二次返回文本 */
function toolLoopHandler(state: { calls: number }) {
  return (_req: MockRequest, res: http.ServerResponse): void => {
    state.calls += 1
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (state.calls === 1) {
      res.write(
        `data: ${JSON.stringify({
          id: 'chatcmpl-1',
          model: 'mock-gpt',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    function: { name: 'echo', arguments: '{"text":"hi"}' }
                  }
                ]
              },
              finish_reason: 'tool_calls'
            }
          ]
        })}\n\n`
      )
      res.write(
        `data: ${JSON.stringify({
          choices: [],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
        })}\n\n`
      )
    } else {
      res.write(
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: { content: 'final ' } }]
        })}\n\n`
      )
      res.write(
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: { content: 'answer' }, finish_reason: 'stop' }]
        })}\n\n`
      )
    }
    res.write('data: [DONE]\n\n')
    res.end()
  }
}

test('agent + OpenAI 协议端到端：invoke 走完工具循环并记录真实用量', async () => {
  const serverState = { calls: 0 }
  await withSseServer(toolLoopHandler(serverState), async ({ url, requests }) => {
    const model = new ChatOpenAI({ model: 'mock-gpt', apiKey: 'sk-mock', baseURL: url })
    const echo = tool(async (args: { text: string }) => `echo:${args.text}`, {
      name: 'echo',
      description: 'echo tool',
      schema: z.object({ text: z.string() })
    })
    const graph = buildAgentGraph({ model, tools: [echo], systemPrompt: 'sys' })
    const messages = await invokeGraph(
      graph,
      { messages: [new HumanMessage('please echo')] },
      { recursionLimit: 10 }
    )

    assert.equal(requests.length, 2)
    const firstRequest = requests[0].body
    assert.equal(firstRequest.model, 'mock-gpt')
    assert.equal(firstRequest.stream, true)
    assert.equal(firstRequest.messages[1].role, 'user')
    assert.equal(firstRequest.tools[0].function.name, 'echo')
    const secondRequest = requests[1].body
    const toolMessage = secondRequest.messages.find((message: any) => message.role === 'tool')
    assert.ok(toolMessage)
    assert.equal(toolMessage.content, 'echo:hi')
    assert.equal(toolMessage.tool_call_id, 'call_1')

    assert.equal(messages[messages.length - 1].text, 'final answer')
    const toolResult = messages.find((message) => message.type === 'tool') as ToolMessage
    assert.equal(toolResult.content, 'echo:hi')
    const finalAi = messages[messages.length - 1] as AIMessage
    assert.equal(finalAi.response_metadata.finish_reason, 'stop')
  })
})

test('agent + OpenAI 协议端到端：stream 的 token 增量转成运行时记录', async () => {
  const serverState = { calls: 0 }
  await withSseServer(toolLoopHandler(serverState), async ({ url }) => {
    const model = new ChatOpenAI({ model: 'mock-gpt', apiKey: 'sk-mock', baseURL: url })
    const echo = tool(async (args: { text: string }) => `echo:${args.text}`, {
      name: 'echo',
      description: 'echo tool',
      schema: z.object({ text: z.string() })
    })
    const queue = new RecordQueue()
    const queueRef = { current: queue as { push(record: unknown): void } | undefined }
    const graph = buildAgentGraph({
      model,
      tools: [echo],
      systemPrompt: 'sys',
      queue: queueRef as never,
      maxToolCalls: 20
    })
    const run = startGraphStream(
      graph,
      { messages: [new HumanMessage('please echo')] },
      { recursionLimit: 10 },
      queue
    )
    const { messages: records, toolCalls } = await drain(run)
    assert.equal(run.error, undefined)
    assert.deepEqual(
      records.filter((record) => record.kind === 'text').map((record) => record.text),
      ['final ', 'answer']
    )
    assert.equal(toolCalls.length, 1)
    assert.equal(toolCalls[0].name, 'echo')
    assert.equal(await toolCalls[0].output, 'echo:hi')
  })
})

// ============================================================================
// 空响应：必须把可诊断的错误交到调用层，而不是静默产出空消息
// ============================================================================

/** 只回 usage、没有任何 choices 的 OpenAI SSE（典型「HTTP 200 空响应」） */
function emptyOpenAIResponse(_req: MockRequest, res: http.ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(
    `data: ${JSON.stringify({
      id: 'chatcmpl-empty',
      model: 'mock-gpt',
      choices: [],
      usage: { prompt_tokens: 3, completion_tokens: 0, total_tokens: 3 }
    })}\n\n`
  )
  res.write('data: [DONE]\n\n')
  res.end()
}

test('agent + OpenAI 协议：空响应以 ModelEmptyResponseError 抛给调用层', async () => {
  await withSseServer(emptyOpenAIResponse, async ({ url }) => {
    const model = new ChatOpenAI({ model: 'mock-gpt', apiKey: 'sk-mock', baseURL: url })
    const graph = buildAgentGraph({ model, tools: [], systemPrompt: 'sys' })
    await assert.rejects(
      async () =>
        await invokeGraph(graph, { messages: [new HumanMessage('hi')] }, { recursionLimit: 5 }),
      (err: unknown) => {
        // model-recovery 会把「可重试的网络类失败」重试 2 次后包成 ModelRequestError，
        // 原始的空响应诊断保留在 cause 与 message 里。
        assert.equal((err as Error).name, 'ModelRequestError')
        assert.ok((err as { cause?: unknown }).cause instanceof ModelEmptyResponseError)
        assert.match((err as Error).message, /empty chat response/)
        assert.match((err as Error).message, /mock-gpt/)
        assert.match((err as Error).message, /no text content and no tool calls/)
        return true
      }
    )
  })
})

test('agent + stream：空响应写入 run.error（而不是伪造文本记录）', async () => {
  await withSseServer(emptyOpenAIResponse, async ({ url }) => {
    const model = new ChatOpenAI({ model: 'mock-gpt', apiKey: 'sk-mock', baseURL: url })
    const queue = new RecordQueue()
    const queueRef = { current: queue as { push(record: unknown): void } | undefined }
    const graph = buildAgentGraph({
      model,
      tools: [],
      systemPrompt: 'sys',
      queue: queueRef as never
    })
    const run = startGraphStream(
      graph,
      { messages: [new HumanMessage('hi')] },
      { recursionLimit: 5 },
      queue
    )
    const failure = await drain(run).then(
      () => null,
      (err: unknown) => err
    )
    assert.equal((failure as Error).name, 'ModelRequestError')
    assert.ok((failure as { cause?: unknown }).cause instanceof ModelEmptyResponseError)
    assert.match((failure as Error).message, /empty chat response/)
    assert.equal(run.error, failure)
  })
})

test('model-recovery: 空响应按可重试的网络错误分类，带状态码的按其分类', () => {
  const empty = new ModelEmptyResponseError({ provider: 'openai', model: 'mock-gpt' })
  const network = classifyModelError(empty)
  assert.equal(network.kind, 'network')
  assert.equal(network.transient, true)
  assert.equal(network.retryLimit, 2)

  const limited = new ModelEmptyResponseError({ provider: 'openai', model: 'mock-gpt', status: 429 })
  const rateLimit = classifyModelError(limited)
  assert.equal(rateLimit.kind, 'rate-limit')
  assert.equal(rateLimit.status, 429)
})

test('agent + 非流式网关：自动降级后整轮正常完成', async () => {
  let calls = 0
  await withSseServer(
    (req, res) => {
      calls += 1
      if ((req.body as any)?.stream === true) {
        // 网关把「不支持流式」包成 HTTP 200 错误体
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'streaming is not supported' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'chatcmpl-fb',
          model: 'mock-gpt',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'agent recovered without streaming' },
              finish_reason: 'stop'
            }
          ],
          usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 }
        })
      )
    },
    async ({ url }) => {
      const model = new ChatOpenAI({ model: 'mock-gpt', apiKey: 'sk-mock', baseURL: url })
      const graph = buildAgentGraph({ model, tools: [], systemPrompt: 'sys' })
      const messages = await invokeGraph(
        graph,
        { messages: [new HumanMessage('hi')] },
        { recursionLimit: 5 }
      )
      assert.equal(messages[messages.length - 1].text, 'agent recovered without streaming')
      assert.equal(calls, 2)
    }
  )
})
test('agent: 并行安全（isConcurrencySafe）调用重叠执行，独占调用形成屏障', async () => {
  const events: Array<{ label: string; phase: 'start' | 'end' }> = []
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
  const make = (name: string, delay: number, safe: boolean): StructuredToolInterface =>
    tool(
      async () => {
        events.push({ label: name, phase: 'start' })
        await sleep(delay)
        events.push({ label: name, phase: 'end' })
        return `${name}:done`
      },
      {
        name,
        description: name,
        schema: z.object({}),
        ...(safe ? { isConcurrencySafe: () => true } : {})
      }
    )

  const graph = buildAgentGraph({
    model: new ScriptedChatModel([
      {
        message: new AIMessage({
          content: '',
          tool_calls: [
            { id: 'c1', name: 'safe_a', args: {} },
            { id: 'c2', name: 'safe_b', args: {} },
            { id: 'c3', name: 'exclusive', args: {} },
            { id: 'c4', name: 'safe_c', args: {} }
          ]
        })
      },
      { message: new AIMessage({ content: 'done' }) }
    ]),
    tools: [
      make('safe_a', 80, true),
      make('safe_b', 80, true),
      make('exclusive', 10, false),
      make('safe_c', 10, true)
    ],
    systemPrompt: 'sys',
    maxToolCalls: 20
  })

  const messages = await invokeGraph(
    graph,
    { messages: [new HumanMessage('go')] },
    { recursionLimit: 10 }
  )

  const at = (label: string, phase: 'start' | 'end'): number =>
    events.findIndex((event) => event.label === label && event.phase === phase)

  // 两个安全调用重叠执行：各自的开始都早于对方的结束
  assert.ok(at('safe_a', 'start') < at('safe_b', 'end'))
  assert.ok(at('safe_b', 'start') < at('safe_a', 'end'))

  // 独占调用形成屏障：必须等两个安全调用都结束后才开始
  assert.ok(at('exclusive', 'start') > at('safe_a', 'end'))
  assert.ok(at('exclusive', 'start') > at('safe_b', 'end'))

  // 独占之后的 safe_c 单独成批，排在独占之后
  assert.ok(at('safe_c', 'start') > at('exclusive', 'end'))

  // 结果仍按模型给出的调用顺序写回
  const toolMessages = messages.filter((message) => message.type === 'tool')
  assert.deepEqual(
    toolMessages.map((message) => (message as ToolMessage).tool_call_id),
    ['c1', 'c2', 'c3', 'c4']
  )
  assert.deepEqual(
    toolMessages.map((message) => (message as ToolMessage).content),
    ['safe_a:done', 'safe_b:done', 'exclusive:done', 'safe_c:done']
  )
})

test('agent: 工具超时（timeoutMs）返回可读结果且回合继续', async () => {
  // 永不 resolve 的工具：只有 timeoutMs 能让这一轮继续
  const hang = tool(() => new Promise<string>(() => {}), {
    name: 'hang',
    description: 'never resolves',
    schema: z.object({}),
    timeoutMs: 40
  })

  const graph = buildAgentGraph({
    model: new ScriptedChatModel([
      {
        message: new AIMessage({
          content: '',
          tool_calls: [{ id: 'c1', name: 'hang', args: {} }]
        })
      },
      { message: new AIMessage({ content: 'recovered' }) }
    ]),
    tools: [hang],
    systemPrompt: 'sys'
  })

  const messages = await invokeGraph(
    graph,
    { messages: [new HumanMessage('go')] },
    { recursionLimit: 10 }
  )

  const toolMessage = messages.find((message) => message.type === 'tool') as ToolMessage
  assert.ok(toolMessage, 'the tool result must still be logged')
  assert.match(String(toolMessage.content), /timed out|超时/)
  assert.equal(messages[messages.length - 1].text, 'recovered')
})
