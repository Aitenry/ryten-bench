import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { z } from 'zod'
import vm from 'node:vm'
import { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { HumanMessage } from '@langchain/core/messages'
import logger from 'electron-log'
import { buildAgentGraph } from './agent'
import { invokeGraph } from './graph'
import type { SpillStore } from './spill'
import { mainFormat } from '../../i18n'
import { getAgentToolTexts } from '../../i18n/tool-results-agent'

/**
 * 工作流工具（workflow）— 对应 deepseek-harness 的 dsh-workflow / dsh-tool-workflow 体系
 *
 * 机制（参考 DSH，v1 主进程内执行）：
 * - 模型编写一段 JavaScript 编排脚本（纯脚本体，支持顶层 await，以 return 结束），
 *   用 agent / pipeline / parallel / phase / log / args 六个钩子做多代理 fan-out；
 * - 脚本在主进程 node:vm 沙箱执行（无 fs/网络/定时器/Node 全局），初始同步切片 5s 超时；
 * - 所有错误码都是 fatal（误用钩子/非法选项/超上限 → 整个脚本终止），
 *   而 pipeline 的 stage 抛错只丢弃该项、parallel 的 thunk 抛错解析为 null；
 * - agent() 启动一次性子代理（业务工具 + 文件工具，不含 task/goal/jobs/ask，
 *   防止递归嵌套）；有 opts.schema 时校验为对象（失败/非对象 → null）；
 * - 上限：并发（默认 4）、总代理数（默认 50）；
 * - 工具前台阻塞直至运行结束，返回 { stopReason, value, error?, agentsStarted }。
 */

/** 工作流运行结果 */
export interface WorkflowRunResult {
  stopReason: 'completed' | 'cancelled' | 'error'
  value?: unknown
  error?: string
  agentsStarted: number
}

/** 工作流工具上下文（由 Runtime 注入，复用主运行时组件） */
export interface WorkflowToolContext {
  mainModel: BaseChatModel
  resolveModel: (spec: string | undefined) => Promise<BaseChatModel | undefined>
  /** 工作流子代理工具集（业务工具 + 文件工具；不含任务/目标/提问/续接控制） */
  buildAgentTools: () => StructuredToolInterface[]
  recursionLimit: number
  /** 工具调用总次数上限（模型级「工具调用轮数」；与主图共用同一模型设置） */
  maxToolCalls: number
  spillRef?: { current?: SpillStore }
}

/** JSON Schema 子集校验（仅 DSH 允许的关键字） */
const ALLOWED_SCHEMA_KEYS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'oneOf'
])

function assertSchemaSubset(schema: Record<string, unknown>, path = 'schema'): void {
  for (const key of Object.keys(schema)) {
    if (!ALLOWED_SCHEMA_KEYS.has(key)) {
      const m = getAgentToolTexts()
      throw new Error(
        `UNSUPPORTED_SCHEMA: ${mainFormat(m.workflow.unsupportedSchema, { path, key })}`
      )
    }
  }
  const props = schema.properties
  if (props != null && typeof props === 'object') {
    for (const [key, sub] of Object.entries(props as Record<string, unknown>)) {
      assertSchemaSubset(sub as Record<string, unknown>, `${path}.properties.${key}`)
    }
  }
  if (schema.items && typeof schema.items === 'object') {
    assertSchemaSubset(schema.items as Record<string, unknown>, `${path}.items`)
  }
  for (const sub of (schema.oneOf as unknown[] | undefined) ?? []) {
    if (sub && typeof sub === 'object') {
      assertSchemaSubset(sub as Record<string, unknown>, `${path}.oneOf[]`)
    }
  }
}

function validateSubset(schema: Record<string, unknown>, value: unknown, path = 'value'): boolean {
  const type = schema.type
  if (type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const record = value as Record<string, unknown>
    const required = (schema.required as string[] | undefined) ?? []
    for (const key of required) {
      if (!(key in record)) return false
    }
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>
    for (const [key, sub] of Object.entries(props)) {
      if (key in record && !validateSubset(sub, record[key], `${path}.${key}`)) return false
    }
    const additional = schema.additionalProperties
    if (additional === false) {
      for (const key of Object.keys(record)) {
        if (!(key in props)) return false
      }
    } else if (additional && typeof additional === 'object') {
      for (const [key, v] of Object.entries(record)) {
        if (key in props) continue
        if (!validateSubset(additional as Record<string, unknown>, v, `${path}.${key}`))
          return false
      }
    }
    return true
  }
  if (type === 'array') {
    if (!Array.isArray(value)) return false
    const items = schema.items
    if (items && typeof items === 'object') {
      for (let i = 0; i < value.length; i++) {
        if (!validateSubset(items as Record<string, unknown>, value[i], `${path}[${i}]`))
          return false
      }
    }
    return true
  }
  if ('const' in schema) return value === schema.const
  if (Array.isArray(schema.enum)) return (schema.enum as unknown[]).includes(value)
  if (Array.isArray(schema.oneOf)) {
    return (schema.oneOf as Array<Record<string, unknown>>).some((sub) =>
      validateSubset(sub, value, path)
    )
  }
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    default:
      return false
  }
}

/** 并发上限（desktop 保守值；DSH 为 min(16, CPU-2)） */
const MAX_CONCURRENT_AGENTS = 4
/** 总代理数上限 */
const DEFAULT_MAX_TOTAL_AGENTS = 50
/**
 * 工作流脚本墙钟硬上限：vm 的 timeout 只约束同步执行段，脚本若返回永不 settle 的
 * Promise（如 `await new Promise(() => {})`）会让工具调用永久挂起——宿主侧加一道竞速
 * 保证工具能返回；正常编排（即使 50 个子代理串行）也远达不到 30 分钟。
 */
const WORKFLOW_HARD_TIMEOUT_MS = 30 * 60 * 1000

/** 运行一次工作流脚本 */
export async function runWorkflow(
  script: string,
  meta: Record<string, unknown>,
  args: unknown,
  ctx: WorkflowToolContext,
  signal?: AbortSignal,
  maxTotalAgents = DEFAULT_MAX_TOTAL_AGENTS
): Promise<WorkflowRunResult> {
  const m = getAgentToolTexts()
  // meta 前置校验（DSH start() 同步校验：meta 非法 → META_INVALID）
  if (!meta || typeof meta !== 'object') {
    return {
      stopReason: 'error',
      error: `META_INVALID: ${m.workflow.metaMustBeObject}`,
      agentsStarted: 0
    }
  }
  const name = (meta as { name?: unknown }).name
  if (typeof name !== 'string' || !name.trim()) {
    return {
      stopReason: 'error',
      error: `META_INVALID: ${m.workflow.metaNameRequired}`,
      agentsStarted: 0
    }
  }
  const phases = (meta as { phases?: unknown }).phases
  if (phases != null) {
    if (
      !Array.isArray(phases) ||
      phases.some((p) => !p || typeof (p as { title?: unknown }).title !== 'string')
    ) {
      return {
        stopReason: 'error',
        error: `META_INVALID: ${m.workflow.metaPhasesRequired}`,
        agentsStarted: 0
      }
    }
  }

  let agentsStarted = 0
  let cancelled = false
  let rejectGuard: ((reason: Error) => void) | null = null
  // 工作流级取消控制器：外部取消/脚本失败/超时都会中止在飞的子代理
  //（修复：此前脚本出错后已启动的子代理继续跑完，白烧 token 且输出无人消费）
  const workflowAbort = new AbortController()
  const onSignalAbort = (): void => {
    cancelled = true
    workflowAbort.abort()
    // 唤醒墙钟竞速（见下方 hardGuard）：用户停止后工具调用立即返回，不等脚本自行结束
    rejectGuard?.(new Error('CANCELLED'))
  }
  if (signal) {
    if (signal.aborted) {
      cancelled = true
      workflowAbort.abort()
    } else {
      signal.addEventListener('abort', onSignalAbort, { once: true })
    }
  }

  // 并发信号量
  let active = 0
  const waiters: Array<() => void> = []
  const acquire = async (): Promise<void> => {
    while (active >= MAX_CONCURRENT_AGENTS) {
      await new Promise<void>((resolve) => waiters.push(resolve))
    }
    active++
  }
  const release = (): void => {
    active--
    waiters.shift()?.()
  }

  const checkCancelled = (): void => {
    if (cancelled) throw new Error('CANCELLED')
  }

  /** agent 钩子：启动一次性子代理，返回最终文本或校验对象 */
  const agentHook = async (prompt: string, opts?: Record<string, unknown>): Promise<unknown> => {
    checkCancelled()
    if (agentsStarted >= maxTotalAgents) {
      throw new Error(
        `AGENT_CAP: ${mainFormat(m.workflow.agentCapExceeded, { limit: maxTotalAgents })}`
      )
    }
    // 选项白名单（DSH：其余如 effort/isolation/agentType 一律拒绝杀脚本）
    if (opts) {
      const allowed = new Set(['label', 'phase', 'schema', 'model'])
      for (const key of Object.keys(opts)) {
        if (!allowed.has(key)) {
          throw new Error(
            `UNSUPPORTED_OPTION: ${mainFormat(m.workflow.unsupportedOption, { key })}`
          )
        }
      }
    }
    const schema = opts?.schema as Record<string, unknown> | undefined
    if (schema) {
      assertSchemaSubset(schema)
    }
    if (typeof prompt !== 'string' || !prompt.trim()) {
      throw new Error(m.workflow.emptyPrompt)
    }

    agentsStarted++
    await acquire()
    try {
      const modelSpec = typeof opts?.model === 'string' ? (opts.model as string) : undefined
      const model = modelSpec
        ? ((await ctx.resolveModel(modelSpec)) ?? ctx.mainModel)
        : ctx.mainModel
      const tools = ctx.buildAgentTools()
      const graph = buildAgentGraph({
        model,
        tools,
        systemPrompt:
          'You are a single execution unit inside a workflow. Focus on the one task you were given and return the result text directly; if the caller declared a schema, output JSON that matches that schema. Do not ask the user questions, do not delegate to others, and do not restate the task instructions.',
        spill: ctx.spillRef?.current,
        maxToolCalls: ctx.maxToolCalls
      })
      const messages = await invokeGraph(
        graph,
        { messages: [new HumanMessage(prompt)] },
        { recursionLimit: ctx.recursionLimit, signal: workflowAbort.signal }
      )
      const last = messages[messages.length - 1]
      const text =
        typeof last?.content === 'string'
          ? last.content.trim()
          : Array.isArray(last?.content)
            ? (last.content as Array<{ type?: string; text?: string }>)
                .filter((c) => c.type === 'text')
                .map((c) => c.text || '')
                .join('')
                .trim()
            : ''
      if (schema) {
        try {
          const parsed = JSON.parse(text) as unknown
          return validateSubset(schema, parsed) ? parsed : null
        } catch {
          return null
        }
      }
      return text
    } catch (err) {
      if (cancelled) throw new Error('CANCELLED')
      // 子代理失败 → null（DSH：子失败/未完成 → null，调用方 .filter(Boolean)）
      logger.warn('[Workflow] agent 执行失败（返回 null）:', err)
      return null
    } finally {
      release()
    }
  }

  // 宿主侧钩子实现（不直接注入沙箱，经下方 vm realm 包装函数暴露）
  const hooks = {
    agent: agentHook,
    pipeline: async (
      items: unknown[],
      ...stages: Array<(prev: unknown, item: unknown, index: number) => Promise<unknown>>
    ): Promise<unknown[]> => {
      const results: unknown[] = []
      for (let i = 0; i < items.length; i++) {
        checkCancelled()
        let current: unknown
        let failed = false
        for (const stage of stages) {
          try {
            current = await stage(current, items[i], i)
          } catch {
            failed = true
            break
          }
        }
        results.push(failed ? null : current)
      }
      return results
    },
    parallel: async (thunks: Array<() => Promise<unknown>>): Promise<unknown[]> => {
      return await Promise.all(
        thunks.map(async (thunk) => {
          try {
            return await thunk()
          } catch {
            return null
          }
        })
      )
    },
    phase: (title: string): void => {
      logger.info(`[Workflow] phase: ${title}`)
    },
    log: (message: string): void => {
      logger.info(`[Workflow] ${message}`)
    }
  }

  // 沙箱硬化（修复：宿主 realm 函数直入沙箱时，脚本内 `agent.constructor("return process")()`
  // 可借宿主 Function 构造器在主进程执行任意代码；实测 Node 22 下 vm 上下文全局代理的
  // 构造链（this/globalThis.constructor.constructor）同样可逃逸，注入宿主对象亦会泄漏）：
  // 1. 上下文目标用 null 原型对象，切断 globalThis/this 的原型链；
  // 2. codeGeneration 禁用字符串编译，沙箱内 eval/Function 全部失效；
  // 3. 钩子以 vm realm 内创建的包装函数暴露（闭包持有宿主实现）——沙箱代码经
  //    constructor 链只能拿到沙箱自己的 Function，且其字符串编译被禁用；
  // 4. 跨边界数据 JSON 深拷贝：args 在 vm 内解析、宿主返回值在 vm 内重建，宿主对象不回流入沙箱。
  const context = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false }
  })
  const makeBridge = vm.runInContext(
    '(fn) => (...a) => Promise.resolve(fn(...a)).then((v) => (v == null ? null : JSON.parse(JSON.stringify(v))))',
    context,
    { timeout: 5000 }
  ) as (fn: (...a: never[]) => unknown) => (...a: never[]) => Promise<unknown>
  context.agent = makeBridge(hooks.agent)
  context.pipeline = makeBridge(hooks.pipeline)
  context.parallel = makeBridge(hooks.parallel)
  context.phase = makeBridge(hooks.phase)
  context.log = makeBridge(hooks.log)
  context.args = vm.runInContext('(j) => JSON.parse(j)', context, { timeout: 5000 })(
    JSON.stringify(args ?? null)
  )
  context.console = undefined

  const code = `(async () => {\n${script}\n})()`
  let hardTimer: NodeJS.Timeout | null = null
  let vmExecution: Promise<unknown> | null = null
  try {
    vmExecution = vm.runInContext(code, context, { timeout: 5000 }) as Promise<unknown>
    const hardGuard = new Promise<never>((_, reject) => {
      rejectGuard = reject
      hardTimer = setTimeout(() => {
        // 置 cancelled 拦截仍在后台运行的脚本的后续钩子调用（不再启动新子代理），
        // 并中止已启动的在飞子代理
        cancelled = true
        workflowAbort.abort()
        reject(new Error(`WORKFLOW_TIMEOUT: ${m.workflow.timeout}`))
      }, WORKFLOW_HARD_TIMEOUT_MS)
    })
    const value = await Promise.race([vmExecution, hardGuard])
    if (hardTimer) clearTimeout(hardTimer)
    signal?.removeEventListener('abort', onSignalAbort)
    return { stopReason: 'completed', value, agentsStarted }
  } catch (err) {
    if (hardTimer) clearTimeout(hardTimer)
    // 脚本失败/取消/超时：中止仍在飞行的子代理（其输出已无人消费）
    workflowAbort.abort()
    // 竞速已结束（超时/取消先到），吞掉脚本晚到的拒绝，避免 unhandled rejection；
    // 仍在后台运行的脚本后续钩子调用会被 cancelled 拦截（不再启动新子代理）
    vmExecution?.catch(() => undefined)
    signal?.removeEventListener('abort', onSignalAbort)
    const message = err instanceof Error ? err.message : String(err)
    if (cancelled || message.includes('CANCELLED')) {
      return { stopReason: 'cancelled', error: message, agentsStarted }
    }
    return { stopReason: 'error', error: message, agentsStarted }
  }
}

/** 构建工作流工具（仅注入主代理） */
export function buildWorkflowTool(ctx: WorkflowToolContext): StructuredToolInterface {
  return tool(
    async ({ script, meta, args }, config) => {
      try {
        const result = await runWorkflow(script, meta, args, ctx, config?.signal)
        return JSON.stringify(result)
      } catch (err) {
        return JSON.stringify({
          stopReason: 'error',
          error: `SCRIPT_PARSE: ${(err as Error).message}`,
          agentsStarted: 0
        })
      }
    },
    {
      name: 'workflow',
      description: `Run a JavaScript orchestration script that fans work out to many one-shot subagents in parallel or as a pipeline (suited to bulk audits, multi-angle research, and large batches of independent tasks).

Script contract (a plain JavaScript function body that supports top-level await and ends with return <value>; the returned value must be JSON-serializable):
- agent(prompt, opts?): start one subagent and run it to completion. Without opts.schema it resolves to the subagent's final text; with opts.schema (an object-rooted JSON Schema supporting only type/properties/required/additionalProperties/items/enum/const/oneOf) it resolves to the validated object. A failed subagent resolves to null (filter with .filter(Boolean)). opts accepts label (for display)/phase/schema/model (such as 'provider:model'); any other option is rejected loudly.
- pipeline(items, ...stages): run every item through all stages in order (stage signature is (prev, item, index)) with no barrier between items; a single stage that throws drops that item to null and skips its remaining stages.
- parallel(thunks): run all thunks concurrently and await all of them (a barrier); a thunk that throws resolves to null.
- phase(title) / log(message): progress narration; args is the tool call's args passed through verbatim.

Error semantics: a misused hook (bad arguments, unsupported option, tripped cap) throws and kills the entire script; the result JSON is { stopReason: 'completed'|'cancelled'|'error', value?, error?, agentsStarted }.`,
      schema: z.object({
        script: z
          .string()
          .describe(
            'Plain JavaScript script body (not TypeScript; top-level await allowed; end with return)'
          ),
        meta: z
          .object({
            name: z.string().describe('Workflow name (kebab-case)'),
            description: z.string().optional().describe('One-line description'),
            whenToUse: z.string().optional().describe('Guidance on when this workflow applies'),
            phases: z
              .array(z.object({ title: z.string() }))
              .optional()
              .describe('Phase declarations (matched by phase(title) calls)')
          })
          .describe('Workflow identity information'),
        args: z
          .unknown()
          .optional()
          .describe(
            'Input passed to the script (read inside the script as the global args, passed through verbatim)'
          )
      })
    }
  )
}
