import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { permissionGate } from './permission-gate'
import { recordToolFacts } from './tool-result-facts'

/**
 * 权限闸门的 **LangChain 适配层**：把闸门套在每个工具外面。
 *
 * 为什么在「工具组装处」包而不是在图执行处拦：工具实例会被三个地方拿去跑——
 * 主代理图、子代理子图（task）、工作流脚本里的子代理；只要在 Runtime 组装工具时统一
 * 包一层，这三条路径与「以后新增的调用方」都自动受控，不必逐个改执行流程。
 * 代价是每次调用多一层函数，可忽略。
 *
 * 本文件与闸门分开的原因：这里 import @langchain/core（ESM-only），
 * 而 permission-gate.ts 要能直接被 node 加载做离线回归（见 permission.ts 头部注释）。
 */

/** 包装上下文（Runtime 组装工具时给出；topicId 是审批事件归属的兜底值） */
export interface GuardContext {
  topicId: number
  /** 工作区根目录（execute 的 cwd；命令越界判定用它） */
  workspaceRoot?: string
}

/** 权限面参数：不是工具的业务参数，交给真正的工具前必须摘掉 */
const PERMISSION_ARGS = new Set(['sandbox_permissions', 'justification'])

/** 从工具运行配置里取本次调用的 toolCallId（agent.ts 注入 `configurable.toolCallId`） */
function callIdOf(config: unknown): string | undefined {
  const cfg = config as { configurable?: Record<string, unknown> } | undefined
  const id = cfg?.configurable?.toolCallId
  return typeof id === 'string' ? id : undefined
}

/** 从运行配置里取话题 id（图执行时注入；子代理图不带，回落到组装期的 topicId） */
function topicIdOf(config: unknown, fallback: number): number {
  const cfg = config as { configurable?: Record<string, unknown> } | undefined
  const id = cfg?.configurable?.topicId
  return typeof id === 'number' && id > 0 ? id : fallback
}

/**
 * 包装单个工具：先过闸门，再交给原工具。
 *
 * - 放行 → 摘掉权限面参数后调用原工具（其余参数、config、取消信号原样透传）；
 * - 拦截 → 返回拦截文本（模型读到的就是它），并把一句话登记到工具卡片的事实表，
 *   让用户在聊天里直接看到「被拦了什么、为什么」。
 */
export function guardTool(
  target: StructuredToolInterface,
  ctx: GuardContext
): StructuredToolInterface {
  // 定义类工具（name/description/schema 齐备）才需要包；纯字符串工具原样返回
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
      // 把「本次实际生效的档位」交给工具：执行层据此选隔离强度（升权重试后会更宽）。
      // 不加的话 execute 只能回落到话题档位——一次注入 bug 就等于把沙箱关掉。
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
      schema: schema as never
    }
  ) as unknown as StructuredToolInterface
}

/** 批量包装（工具集组装处使用；空数组原样返回） */
export function guardTools(
  tools: StructuredToolInterface[],
  ctx: GuardContext
): StructuredToolInterface[] {
  return tools.map((item) => guardTool(item, ctx))
}
