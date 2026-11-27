import { tool, type StructuredToolInterface } from '../../ai/tools'
import { z } from 'zod'
import { mainFormat } from '../../i18n'
import { getAgentToolTexts } from '../../i18n/tool-results-agent'
import { createSubAgentDefinition } from '../../services/harness/subagents'
import {
  SUBAGENT_DESCRIPTION_MAX_LENGTH,
  SUBAGENT_NAME_MAX_LENGTH,
  SUBAGENT_NAME_PATTERN,
  SUBAGENT_PROMPT_MAX_LENGTH
} from '../../../shared/harness/subagent'

/**
 * 子代理作者化工具（`agent_create`）—— 主智能体可以「委派构建」一个可复用的子代理配置。
 *
 * 与设置页「智能体」写入同一条服务链路（`services/harness/subagents.ts`）：
 * - 校验/归一/落库/缓存失效全部同源，不会出现两套规则；
 * - 创建后写入 `agent_config`（按工作区隔离，重启保留），用户可在设置页看到并编辑；
 * - `task` 工具在调用期重新解析子代理清单，因此**同一轮对话内**创建完即可派发；
 * - 工具只挂给主代理（lead），子代理不获得作者化能力，避免递归造代理。
 *
 * 这是 DSH「agent preset authoring」的 RytenBench 对应物：DSH 由模型作者化 preset，
 * 这里作者化的是 `agent_config` 行（字段一一对应）。
 */
export interface AgentAuthoringContext {
  /** 当前工作区 id：配置按工作区隔离，且必须已存在 */
  workspaceId: number
  /** 主代理本轮的工具名（`tools` 省略时由新建子代理继承这份清单） */
  availableToolNames: string[]
}

export function createAgentAuthoringTool(ctx: AgentAuthoringContext): StructuredToolInterface {
  /** 默认工具集：继承主代理本轮可用的真实工具（内部工具在构建子代理工具时会被注册表过滤） */
  const defaultTools = Array.from(new Set(ctx.availableToolNames))

  const schema = z.object({
    name: z
      .string()
      .min(1)
      .max(SUBAGENT_NAME_MAX_LENGTH)
      .describe(
        `Unique identifier of the new subagent (matches ${SUBAGENT_NAME_PATTERN}). It is also the task(subagent_type=...) value and must not collide with an existing subagent.`
      ),
    display_name: z
      .string()
      .optional()
      .describe('Human-readable display name (optional; falls back to name).'),
    description: z
      .string()
      .min(1)
      .max(SUBAGENT_DESCRIPTION_MAX_LENGTH)
      .describe(
        'One-line capability description. It is shown in the task tool catalog so you/other turns know what this subagent is for.'
      ),
    system_prompt: z
      .string()
      .min(1)
      .max(SUBAGENT_PROMPT_MAX_LENGTH)
      .describe(
        'Complete system prompt for the subagent: role, working rules, output expectations. It has its own toolset/model and does not see this conversation history.'
      ),
    tools: z
      .array(z.string())
      .optional()
      .describe(
        `Tool names the subagent may use (real tool names only). Omit to inherit the main agent's current toolset (${defaultTools.length} tools).`
      ),
    model: z
      .string()
      .optional()
      .describe('Optional "provider:model" override. Omit to inherit the main model.'),
    skills: z.array(z.string()).optional().describe('Optional enabled skill ids; omit for none.')
  })

  return tool(
    async (args) => {
      const m = getAgentToolTexts()
      try {
        const result = await createSubAgentDefinition({
          workspaceId: ctx.workspaceId,
          name: args.name,
          displayName: args.display_name,
          description: args.description,
          systemPrompt: args.system_prompt,
          tools: args.tools ?? defaultTools,
          model: args.model,
          skills: args.skills
        })
        return mainFormat(m.agentAuthoring.created, {
          name: result.config.name,
          id: result.id
        })
      } catch (err) {
        // 校验失败属于模型可以自行纠正的输入错误：回一段可读文本让它重试，不炸整轮
        return mainFormat(m.agentAuthoring.failed, {
          message: err instanceof Error ? err.message : String(err)
        })
      }
    },
    {
      name: 'agent_create',
      description:
        'Create a reusable subagent definition for the current workspace when no configured subagent fits the work. The definition persists (visible/editable in Settings → Agents), and task(subagent_type=<name>) can delegate to it immediately, including later in this same turn. Prefer existing subagents; do not recreate one that already exists.',
      schema
    }
  )
}
