/**
 * `run_code` tool (PTC: programmatic tool calling) — lets the model write a snippet of JS that
 * calls **read-only tools** in loops/filters/aggregations inside `node:vm`, doing in one call what
 * would otherwise take multiple rounds of tool orchestration.
 *
 * Security boundary (same rule as the persistent terminal): `node:vm` is not a security boundary,
 * so
 * - it is only allowed in the `danger-full-access` mode (enforced by the tool layer; other modes
 *   return a localized refusal text);
 * - the bridge exposes **read-only** tools only (`classifyTool(name) === 'read'`); write/execute
 *   tools are not injected;
 * - the execution core also has a synchronous time limit, an overall time limit, an output cap and
 *   a tool-call cap (see `run-code.ts`).
 */
import { z } from 'zod'
import { tool, type StructuredToolInterface } from '../../ai/tools'
import { mainFormat } from '../../i18n'
import { getRunCodeTexts, type RunCodeTexts } from '../../i18n/tool-results-run-code'
import { classifyTool, isPermissionMode, type PermissionMode } from './permission'
import { permissionGate } from './permission-gate'
import {
  RUN_CODE_MAX_CHARS,
  RUN_CODE_RESULT_MAX_CHARS,
  executeRunCode,
  type RunCodeBridge
} from './run-code'

/** Tool runtime context: topic and the permission mode actually in effect for this call */
function contextOf(config: unknown): { topicId: number; mode: PermissionMode } {
  const cfg = config as
    | { configurable?: { topicId?: unknown; sandboxMode?: unknown } }
    | undefined
  const topicId = typeof cfg?.configurable?.topicId === 'number' ? cfg.configurable.topicId : 0
  const injected = cfg?.configurable?.sandboxMode
  const mode = isPermissionMode(injected) ? injected : permissionGate.modeFor(topicId)
  return { topicId, mode }
}

/** Localize the permission mode name */
function modeLabel(texts: RunCodeTexts, mode: PermissionMode): string {
  if (mode === 'read-only') return texts.modeReadOnly
  if (mode === 'workspace-write') return texts.modeWorkspace
  return texts.modeDanger
}

/**
 * Build the run_code tool.
 *
 * @param availableTools tools already assembled for the current session (the runtime builds this
 *   tool **after all tools are assembled** to avoid bridging itself); only read-only ones are
 *   bridged.
 */
export function buildRunCodeTool(options: {
  availableTools: StructuredToolInterface[]
}): StructuredToolInterface {
  // Only read-only tools other than run_code itself may be called from code
  const bridgeable = options.availableTools.filter(
    (candidate) => candidate.name !== 'run_code' && classifyTool(candidate.name) === 'read'
  )

  return tool(
    async ({ code, description }, config) => {
      const texts = getRunCodeTexts()
      const { mode } = contextOf(config)
      if (mode !== 'danger-full-access') {
        return mainFormat(texts.denied, { mode: modeLabel(texts, mode) })
      }
      if (code.trim().length === 0) return texts.empty
      if (code.length > RUN_CODE_MAX_CHARS) {
        return mainFormat(texts.tooLong, { max: RUN_CODE_MAX_CHARS })
      }

      // Wrap each read-only tool as (args) => Promise<string>; schema validation stays in the tool
      const bridge: RunCodeBridge = {}
      for (const candidate of bridgeable) {
        bridge[candidate.name] = async (args) => {
          try {
            const result = await candidate.invoke(args, config)
            return typeof result === 'string' ? result : JSON.stringify(result)
          } catch (err) {
            // Tool argument validation failures etc.: return as a plain value and let code decide
            return `[tool-error] ${err instanceof Error ? err.message : String(err)}`
          }
        }
      }

      const output = await executeRunCode({ code, tools: bridge })
      const header = description
        ? mainFormat(texts.headerWithDescription, { description })
        : texts.header
      const parts: string[] = [header]
      if (output.logs) parts.push(mainFormat(texts.logs, { logs: output.logs }))
      if (output.timedOut) {
        parts.push(texts.timedOut)
      } else if (output.error) {
        parts.push(mainFormat(texts.error, { message: output.error }))
      } else if (output.result.trim() === '') {
        parts.push(texts.emptyResult)
      } else {
        parts.push(mainFormat(texts.result, { result: output.result }))
      }
      if (output.truncated) {
        parts.push(mainFormat(texts.truncated, { max: RUN_CODE_RESULT_MAX_CHARS }))
      }
      parts.push(
        mainFormat(texts.toolCalls, {
          count: output.toolCalls,
          ms: output.durationMs
        })
      )
      return parts.join('\n\n')
    },
    {
      name: 'run_code',
      description:
        'Run JavaScript that can call read-only tools programmatically: use `await tools.<name>(args)` where <name> is a bridged tool such as read_file, grep, glob, ls, read_image, web_fetch, web_search, session_search or conversation_read. Put statements in the code body and `return` a JSON-serializable value; console.log output is captured. This is for loops, filtering, and combining many tool results in one call. Limitations: node:vm is not a security boundary (hence danger-full-access only), 20k characters of code, 5s of synchronous work, 120s overall, 200 tool calls, and captured output is capped. Available tools: ' +
        (bridgeable.length > 0 ? bridgeable.map((item) => item.name).join(', ') : 'none'),
      schema: z.object({
        code: z
          .string()
          .min(1)
          .describe(
            'JavaScript body (async). Use await tools.<name>(args) for bridged read-only tools and return a serializable value.'
          ),
        description: z
          .string()
          .max(120)
          .optional()
          .describe('Optional one-line summary shown in the tool card')
      })
    }
  )
}
