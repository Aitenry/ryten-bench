import { tool, type StructuredToolInterface } from '../../ai/tools'
import { permissionGate } from './permission-gate'
import { recordToolFacts } from './tool-result-facts'

/**
 * **AI tool adapter layer** for the permission gate: wraps every tool with the gate.
 *
 * Why wrap at "tool assembly" instead of intercepting at graph execution: tool instances are
 * run from three places — the main agent graph, subagent subgraphs (task), and subagents inside
 * workflow scripts; wrapping once when the Runtime assembles tools covers all three paths and
 * any future callers, without changing each execution flow. The cost is one extra function
 * layer per call, which is negligible.
 *
 * Why this file is separate from the gate: it depends on the self-developed AI layer's tool
 * contract (src/main/ai/tools.ts), while permission-gate.ts must be loadable by plain node for
 * offline regression (see the header comment in permission.ts).
 */

/** Wrapping context (provided when the Runtime assembles tools; topicId is the fallback for approval event routing) */
export interface GuardContext {
  topicId: number
  /** Workspace root (cwd of execute; used for command out-of-bounds checks) */
  workspaceRoot?: string
}

/** Permission-plane arguments: not the tool's business arguments, must be stripped before reaching the real tool */
const PERMISSION_ARGS = new Set(['sandbox_permissions', 'justification'])

/** Reads the toolCallId of this call from the tool runtime config (agent.ts injects `configurable.toolCallId`) */
function callIdOf(config: unknown): string | undefined {
  const cfg = config as { configurable?: Record<string, unknown> } | undefined
  const id = cfg?.configurable?.toolCallId
  return typeof id === 'string' ? id : undefined
}

/** Reads the topic id from the runtime config (injected during graph execution; subagent graphs omit it, falling back to the assembly-time topicId) */
function topicIdOf(config: unknown, fallback: number): number {
  const cfg = config as { configurable?: Record<string, unknown> } | undefined
  const id = cfg?.configurable?.topicId
  return typeof id === 'number' && id > 0 ? id : fallback
}

/**
 * Wraps a single tool: pass the gate first, then hand over to the original tool.
 *
 * - Allowed → strip permission-plane arguments and call the original tool (other arguments,
 *   config, and cancellation signal pass through unchanged);
 * - Blocked → return the interception text (that is what the model reads) and record a one-line
 *   message in the tool card's fact table, so users can see "what was blocked and why".
 */
export function guardTool(
  target: StructuredToolInterface,
  ctx: GuardContext
): StructuredToolInterface {
  // Only definition-style tools (with name/description/schema) need wrapping; plain string tools are returned as-is
  const schema = (target as { schema?: unknown }).schema
  if (!schema) return target

  return tool(
    async (args: Record<string, unknown>, config: unknown): Promise<unknown> => {
      const topicId = topicIdOf(config, ctx.topicId)
      const verdict = await permissionGate.authorize({
        topicId,
        toolName: target.name,
        args: args ?? {},
        signal: (config as { signal?: AbortSignal } | undefined)?.signal,
        workspaceRoot: ctx.workspaceRoot
      })

      if (!verdict.run) {
        const message = verdict.cardMessage ?? verdict.text ?? ''
        recordToolFacts(callIdOf(config), { error: message })
        return verdict.text ?? message
      }

      const cleanArgs: Record<string, unknown> = { ...(args ?? {}) }
      for (const key of PERMISSION_ARGS) delete cleanArgs[key]
      // Pass the "mode actually in effect for this call" to the tool: the execution layer picks
      // the isolation strength from it (wider after an escalation retry). Without this, execute
      // would fall back to the topic mode — one injection bug could effectively disable the sandbox.
      const inner = {
        ...(config as Record<string, unknown> | undefined),
        configurable: {
          ...((config as { configurable?: Record<string, unknown> } | undefined)?.configurable ??
            {}),
          sandboxMode: verdict.effectiveMode
        }
      }
      return await target.invoke(cleanArgs as never, inner as never)
    },
    {
      name: target.name,
      description: target.description,
      schema: schema as never,
      // The concurrency-safety classifier must be passed through with the wrapper: otherwise,
      // once gated, every tool degrades to exclusive and parallel tool calls are silently disabled.
      isConcurrencySafe: target.isConcurrencySafe as ((args: unknown) => boolean) | undefined,
      // The timeout budget is passed down with the wrapper too (otherwise every gated tool has no deadline)
      timeoutMs: target.timeoutMs
    }
  ) as unknown as StructuredToolInterface
}

/** Batch wrapping (used at tool-set assembly; an empty array is returned as-is) */
export function guardTools(
  tools: StructuredToolInterface[],
  ctx: GuardContext
): StructuredToolInterface[] {
  return tools.map((item) => guardTool(item, ctx))
}
