/**
 * `run_code` 工具（PTC：programmatic tool calling）——让模型写一段 JS，在 `node:vm` 里
 * 循环/过滤/聚合地调用**只读工具**，一次调用完成本来要多轮的工具编排。
 *
 * 安全边界（与持久终端同一规则）：`node:vm` 不是安全边界，所以
 * - 只在 `danger-full-access` 档放行（工具层强制校验，其它档返回本地化拒绝文本）；
 * - 桥接只暴露**只读类**工具（`classifyTool(name) === 'read'`），写/执行类不注入；
 * - 执行核心还有同步时限、整体时限、输出上限与工具调用上限（见 `run-code.ts`）。
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

/** 工具运行时上下文：话题与本次调用实际生效的档位 */
function contextOf(config: unknown): { topicId: number; mode: PermissionMode } {
  const cfg = config as
    | { configurable?: { topicId?: unknown; sandboxMode?: unknown } }
    | undefined
  const topicId = typeof cfg?.configurable?.topicId === 'number' ? cfg.configurable.topicId : 0
  const injected = cfg?.configurable?.sandboxMode
  const mode = isPermissionMode(injected) ? injected : permissionGate.modeFor(topicId)
  return { topicId, mode }
}

/** 档位名称本地化 */
function modeLabel(texts: RunCodeTexts, mode: PermissionMode): string {
  if (mode === 'read-only') return texts.modeReadOnly
  if (mode === 'workspace-write') return texts.modeWorkspace
  return texts.modeDanger
}

/**
 * 构造 run_code 工具。
 *
 * @param availableTools 当前会话已装配的工具（运行时在**全部工具装配完成后**再建本工具，
 *   避免把自己也桥接进去）；桥接时按只读类过滤。
 */
export function buildRunCodeTool(options: {
  availableTools: StructuredToolInterface[]
}): StructuredToolInterface {
  // 只读、且不是 run_code 本身的工具才允许被代码调用
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

      // 每个只读工具包装成 (args) => Promise<string>；schema 校验仍由各工具自己完成
      const bridge: RunCodeBridge = {}
      for (const candidate of bridgeable) {
        bridge[candidate.name] = async (args) => {
          try {
            const result = await candidate.invoke(args, config)
            return typeof result === 'string' ? result : JSON.stringify(result)
          } catch (err) {
            // 工具参数校验失败等：作为普通值返回给模型代码，让它自己决定怎么处理
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
