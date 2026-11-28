import { tool, type StructuredToolInterface } from '../../ai/tools'
import { z } from 'zod'
import vm from 'node:vm'
import { BaseChatModel } from '../../ai/chat-model'
import { HumanMessage } from '../../ai/messages'
import logger from 'electron-log'
import { buildAgentGraph } from './agent'
import { invokeGraph } from './graph'
import type { SpillStore } from './spill'
import { mainFormat } from '../../i18n'
import { getAgentToolTexts } from '../../i18n/tool-results-agent'

/**
 * Workflow tool — fanning work out to many subagents from a JavaScript script
 *
 * Mechanism (v1 runs in the main process):
 * - The model writes a JavaScript orchestration script (plain script body, top-level await
 *   supported, ends with return) and uses the six hooks agent / pipeline / parallel / phase /
 *   log / args to fan work out across subagents;
 * - The script runs in a node:vm sandbox in the main process (no fs/network/timers/Node globals);
 *   the initial synchronous slice has a 5s timeout;
 * - Every error code is fatal (misused hook / invalid option / cap exceeded → the whole script
 *   terminates), while a throwing pipeline stage drops only that item and a throwing parallel
 *   thunk resolves to null;
 * - agent() starts a one-shot subagent (business tools + file tools, without task/goal/jobs/ask,
 *   to prevent recursive nesting); when opts.schema is given, the result is validated as an
 *   object (failure or non-object → null);
 * - Limits: concurrency (default 4) and total agents (default 50);
 * - The tool blocks in the foreground until the run ends and returns
 *   { stopReason, value, error?, agentsStarted }.
 */

/** Workflow run result */
export interface WorkflowRunResult {
  stopReason: 'completed' | 'cancelled' | 'error'
  value?: unknown
  error?: string
  agentsStarted: number
}

/** Workflow tool context (injected by the Runtime, reusing main runtime components) */
export interface WorkflowToolContext {
  mainModel: BaseChatModel
  resolveModel: (spec: string | undefined) => Promise<BaseChatModel | undefined>
  /** Tool set for workflow subagents (business + file tools; no task/goal/ask/continuation) */
  buildAgentTools: () => StructuredToolInterface[]
  recursionLimit: number
  /** Total tool call cap (model-level "tool call rounds"; shared with the main graph) */
  maxToolCalls: number
  spillRef?: { current?: SpillStore }
}

/** JSON Schema subset validation (only the allowed keywords) */
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

/** Concurrency cap (a conservative desktop value) */
const MAX_CONCURRENT_AGENTS = 4
/** Total agent cap */
const DEFAULT_MAX_TOTAL_AGENTS = 50
/**
 * Hard wall-clock cap for a workflow script: the vm timeout only constrains synchronous
 * execution, and a script returning a never-settling Promise (such as
 * `await new Promise(() => {})`) would hang the tool call forever — the host adds a race so the
 * tool always returns; normal orchestration (even 50 subagents in series) stays far below 30
 * minutes.
 */
const WORKFLOW_HARD_TIMEOUT_MS = 30 * 60 * 1000

/** Run a workflow script once */
export async function runWorkflow(
  script: string,
  meta: Record<string, unknown>,
  args: unknown,
  ctx: WorkflowToolContext,
  signal?: AbortSignal,
  maxTotalAgents = DEFAULT_MAX_TOTAL_AGENTS
): Promise<WorkflowRunResult> {
  const m = getAgentToolTexts()
  // Upfront meta validation (meta is validated synchronously: invalid meta → META_INVALID)
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
  // Workflow-level cancel controller: external cancellation, script failure, and timeout all
  // abort in-flight subagents (fix: previously subagents started before a script error kept
  // running to completion, burning tokens with nobody consuming their output)
  const workflowAbort = new AbortController()
  const onSignalAbort = (): void => {
    cancelled = true
    workflowAbort.abort()
    // Wake the wall-clock race (see hardGuard below): after the user stops, the tool call
    // returns immediately instead of waiting for the script to finish on its own
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

  // Concurrency semaphore
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

  /** agent hook: start a one-shot subagent and return its final text or validated object */
  const agentHook = async (prompt: string, opts?: Record<string, unknown>): Promise<unknown> => {
    checkCancelled()
    if (agentsStarted >= maxTotalAgents) {
      throw new Error(
        `AGENT_CAP: ${mainFormat(m.workflow.agentCapExceeded, { limit: maxTotalAgents })}`
      )
    }
    // Option allowlist (anything else, such as effort/isolation/agentType, is rejected and
    // kills the script)
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
      // Subagent failure → null (failed/incomplete subagents yield null; callers filter with
      // .filter(Boolean))
      logger.warn('[Workflow] agent failed to run (returning null):', err)
      return null
    } finally {
      release()
    }
  }

  // Host-side hook implementations (not injected into the sandbox directly; exposed through the
  // vm realm wrapper functions below)
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

  // Sandbox hardening (fix: when host-realm functions are passed straight into the sandbox,
  // `agent.constructor("return process")()` inside the script can use the host Function
  // constructor to run arbitrary code in the main process; on Node 22 the vm context's global
  // proxy constructor chain (this/globalThis.constructor.constructor) also escapes, and injected
  // host objects leak):
  // 1. The context target is a null-prototype object, cutting the globalThis/this prototype chain;
  // 2. codeGeneration disables string compilation, so eval/Function no longer work in the sandbox;
  // 3. Hooks are exposed as wrapper functions created inside the vm realm (the closure holds the
  //    host implementation) — sandbox code can only reach the sandbox's own Function through the
  //    constructor chain, and its string compilation is disabled;
  // 4. Cross-boundary data is deep-copied through JSON: args is parsed inside the vm and host
  //    return values are rebuilt inside the vm, so host objects never flow back into the sandbox.
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
        // Set cancelled so later hook calls from the still-running script are blocked (no new
        // subagents) and abort the subagents already in flight
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
    // Script failure/cancellation/timeout: abort subagents still in flight (their output is no
    // longer consumed)
    workflowAbort.abort()
    // The race is already over (timeout/cancellation won), so swallow the script's late rejection
    // to avoid an unhandled rejection; later hook calls from the still-running script are blocked
    // by cancelled (no new subagents started)
    vmExecution?.catch(() => undefined)
    signal?.removeEventListener('abort', onSignalAbort)
    const message = err instanceof Error ? err.message : String(err)
    if (cancelled || message.includes('CANCELLED')) {
      return { stopReason: 'cancelled', error: message, agentsStarted }
    }
    return { stopReason: 'error', error: message, agentsStarted }
  }
}

/** Build the workflow tool (injected into the main agent only) */
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
