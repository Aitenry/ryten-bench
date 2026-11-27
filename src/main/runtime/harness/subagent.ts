import { tool, type StructuredToolInterface } from '../../ai/tools'
import { z } from 'zod'
import { BaseChatModel } from '../../ai/chat-model'
import { HumanMessage, SystemMessage } from '../../ai/messages'
import { GraphRecursionError } from '../../ai/graph'
import logger from 'electron-log'
import * as fs from 'fs'
import * as path from 'path'
import type { SubAgentRecord } from './types'
import { buildAgentGraph, pushMessageRecords, type QueueRef, type StreamMessageLike } from './agent'
import { buildSkillsPromptSection, loadSkills } from './skills'
import type { SpillStore } from './spill'
import { subagentSessions } from './subagent-sessions'
import { subagentTeamPromptSection, teamModeStore } from './team-mode'
import type { SubAgentConfig, SubAgentMainModelDescriptor } from '../../services/harness/types'
import { mainFormat } from '../../i18n'
import { getAgentToolTexts } from '../../i18n/tool-results-agent'

/**
 * 子代理（task 工具）— 替代 deepagents subagents + task 分派
 *
 * 机制：
 * - task 工具 schema 保持 deepagents 兼容（subagent_type / description / prompt）；
 * - 每次调用动态编译子代理子图（独立模型/工具/系统提示词 + 专属记忆 + 技能）；
 * - causeId 通过 config.configurable.toolCallId 注入（由工具节点写入）；
 * - 子图 token 级事件转发为 sub_* 记录，驱动前端子代理活动块；
 * - 模型按 'provider:model' 解析，失败回退主模型（依赖缺失 = 降级而非报错）；
 * - 子代理清单（名称/功能描述）动态注入 task 工具描述与 schema，
 *   主模型据此决定是否委托及选用哪个子代理（deepagents 同款行为）。
 */

/** 子代理运行时上下文 */
export interface SubAgentRuntimeContext {
  /** 子代理定义列表 */
  /** 子代理定义列表（构造期快照：用于 task 工具描述/初始 schema） */
  subAgents: SubAgentConfig[]
  /**
   * 调用期重新解析子代理清单（主智能体刚用 agent_create 建好、或设置页刚改过配置时，
   * 同一轮内的 task 调用必须看到最新配置，而不是构造 Runtime 时的快照）。
   * 缺省 = 使用构造期快照（后台会话/工作流等无作者化能力的路径）。
   */
  reloadSubAgents?: () => Promise<SubAgentConfig[]>
  /** 主代理模型（回退目标） */
  mainModel: BaseChatModel
  /** 按 'provider:model' 创建模型的回调（由 Runtime 注入） */
  resolveModel: (spec: string | undefined) => Promise<BaseChatModel | undefined>
  /** spawn 时主模型描述符：随后台会话持久化，冷恢复回到同一模型 */
  mainModelDescriptor?: SubAgentMainModelDescriptor
  /** 业务工具构建（按子代理声明的工具名） */
  buildTools: (subAgent: SubAgentConfig) => StructuredToolInterface[]
  /** 记录队列引用（流式时注入） */
  queue: QueueRef
  /** 溢出存储引用（与主图共享同一次请求的实例；子代理工具输出同样走溢出策略） */
  spillRef?: { current?: SpillStore }
  /** 子代理图递归上限（由主运行时工程常量推导） */
  recursionLimit: number
  /** 工具调用总次数上限（模型级「工具调用轮数」；与主图共用同一模型设置） */
  maxToolCalls: number
  /** 子代理记忆存储根（<memoryPath>/workspace-<wsId>/，其下 sub-agents/<name>/memories/AGENTS.md） */
  memoryPath?: string
  /** 技能目录（含 SKILL.md 的子目录即技能），子代理按声明的 skills 过滤 */
  skillsPath?: string
}

/** 子代理专属记忆文件（AGENTS.md），与旧版 deepagents 目录约定一致 */
function loadSubAgentMemory(memoryPath: string | undefined, name: string): string {
  if (!memoryPath) return ''
  const memoryFile = path.join(memoryPath, 'sub-agents', name, 'memories', 'AGENTS.md')
  try {
    if (fs.existsSync(memoryFile)) {
      const content = fs.readFileSync(memoryFile, 'utf-8').trim()
      return content || ''
    }
  } catch (err) {
    logger.warn(`[SubAgent] Failed to read memory file ${memoryFile}:`, err)
  }
  return ''
}

/** 子代理会话提示词构建所需的挂载路径（前台 spawn / 后台会话 / 冷恢复共用） */
export interface SubAgentPromptPaths {
  memoryPath?: string
  skillsPath?: string
}

/**
 * 构建子代理系统提示词：基础 systemPrompt + 专属记忆 + 技能段 + 团队协作段。
 *
 * 抽成独立导出函数的原因：冷恢复（`subagent-resume.ts`）没有 `SubAgentRuntimeContext`
 * （没有主模型/工具构建器等运行时依赖），但必须用与前台/后台会话完全一致的提示词规则，
 * 否则恢复后的子代理行为会漂移。
 */
export function buildSubAgentSessionPrompt(
  sa: SubAgentConfig,
  paths: SubAgentPromptPaths,
  teamMode: boolean
): string {
  let prompt = sa.systemPrompt

  const memory = loadSubAgentMemory(paths.memoryPath, sa.name)
  if (memory) {
    prompt += `\n\n## Long-term memory\n${memory}`
  }

  if (sa.skills && sa.skills.length > 0) {
    const skillsSection = buildSkillsPromptSection(
      loadSkills({ skillsPath: paths.skillsPath, enabledSkills: sa.skills })
    )
    if (skillsSection) {
      prompt += skillsSection
    }
  }

  prompt += subagentTeamPromptSection(teamMode)

  return prompt
}

/** 构建子代理系统提示词（运行时上下文版本；委托给共享实现） */
function buildSubAgentSystemPrompt(
  ctx: SubAgentRuntimeContext,
  sa: SubAgentConfig,
  teamMode: boolean
): string {
  return buildSubAgentSessionPrompt(
    sa,
    { memoryPath: ctx.memoryPath, skillsPath: ctx.skillsPath },
    teamMode
  )
}

/** 构建 task 工具描述：静态引导 + 子代理清单（名称 + 功能描述） */
function buildTaskDescription(subAgents: SubAgentConfig[]): string {
  if (subAgents.length === 0) {
    return 'Delegate complex work to a dedicated subagent. A subagent has its own system prompt and toolset, which suits subtasks that need focused handling. No subagent definitions are configured in this workspace yet: create one with agent_create (name/description/system_prompt/tools), then delegate to it with task.'
  }
  const list = subAgents
    .map((sa) => {
      const display = sa.rename && sa.rename !== sa.name ? `${sa.rename} (${sa.name})` : sa.name
      return `- ${display}: ${sa.description || '(no description)'}`
    })
    .join('\n')
  return `Delegate complex work to a dedicated subagent. A subagent has its own system prompt and toolset, which suits subtasks that need focused handling.

Available subagents:
${list}

Usage rules:
- Pick the subagent that best fits the task; pass its name field as subagent_type.
- A subagent's full output is shown to the user directly. Once the task finishes, just give a brief summary or wrap up; do not restate the detail the subagent already produced.`
}

/** 解析子代理图输入（systemPrompt + 任务消息） */
function buildSubAgentMessages(
  systemPrompt: string,
  prompt: string
): (SystemMessage | HumanMessage)[] {
  return [new SystemMessage(systemPrompt), new HumanMessage(prompt)]
}

/** 子代理执行器：编译子图 → 流式执行 → 转发记录 → 返回最终文本 */
export function createTaskTool(ctx: SubAgentRuntimeContext): StructuredToolInterface {
  const availableNames =
    ctx.subAgents.length > 0
      ? `Available names: ${ctx.subAgents.map((s) => s.name).join(', ')}`
      : '(no subagents available)'
  const taskSchema = z.object({
    subagent_type: z
      .string()
      .describe(`Name of the subagent type to delegate to. ${availableNames}`),
    description: z.string().optional().describe('Short description of the task (for display)'),
    prompt: z.string().describe('Complete task instructions to hand to the subagent'),
    background: z
      .boolean()
      .optional()
      .describe(
        'When true, run in the background: returns a job_id immediately. Use job_output(job_id, wait=true) to poll for the result, job_list to inspect jobs, and job_kill to terminate. Suited to long-running tasks.'
      )
  })

  return tool(
    async ({ subagent_type, description, prompt, background }, config) => {
      const m = getAgentToolTexts()
      // 调用期重新解析：agent_create / 设置页可能在 Runtime 构造之后刚改过配置
      const subAgents = ctx.reloadSubAgents ? await ctx.reloadSubAgents() : ctx.subAgents
      const sa = subAgents.find((s) => s.name === subagent_type)
      if (!sa) {
        return mainFormat(m.subagent.notFound, {
          type: subagent_type,
          names: subAgents.map((s) => s.name).join(', ') || m.subagent.noneAvailable
        })
      }

      // 后台模式：启动可续接的子代理会话（send_message/list_agents/interrupt_agent 续接），
      // 会话运行同时注册为同名后台任务（job_output/job_kill 监控）
      if (background) {
        const configurable = (config?.configurable ?? {}) as Record<string, unknown>
        const topicId = typeof configurable.topicId === 'number' ? configurable.topicId : 0
        const row = subagentSessions.start(topicId, sa, prompt, {
          mainModel: ctx.mainModel,
          resolveModel: ctx.resolveModel,
          buildTools: ctx.buildTools,
          recursionLimit: ctx.recursionLimit,
          maxToolCalls: ctx.maxToolCalls,
          spillRef: ctx.spillRef,
          extendSystemPrompt: (s) =>
            buildSubAgentSystemPrompt(ctx, s, teamModeStore.isEnabled(topicId)),
          mainModelDescriptor: ctx.mainModelDescriptor
        })
        return mainFormat(m.subagent.backgroundStarted, { id: row.id, label: row.label })
      }

      const causeId =
        ((config?.configurable as Record<string, unknown> | undefined)?.toolCallId as
          string | undefined) ?? 'unknown'
      // 父图 configurable 里的 topicId：前台子代理同样要能读写本话题的共享任务板
      const parentConfigurable = (config?.configurable ?? {}) as Record<string, unknown>
      const parentTopicId =
        typeof parentConfigurable.topicId === 'number' ? parentConfigurable.topicId : 0
      const queue = ctx.queue
      const push = (record: SubAgentRecord): void => queue.current?.push(record)

      // sub_start：前端子代理活动块（started 由 toolCalls 流的 task 记录发出，此处供内容流标记）
      push({ kind: 'sub_start', name: sa.name, causeId, description } satisfies SubAgentRecord)

      try {
        // 模型解析（provider:model → 模型；失败回退主模型）
        const model = (await ctx.resolveModel(sa.model)) ?? ctx.mainModel

        // 工具：子代理声明的业务工具
        const tools = ctx.buildTools(sa)
        // 系统提示词：基础提示词 + 专属记忆 + 技能段
        const systemPrompt = buildSubAgentSystemPrompt(
          ctx,
          sa,
          teamModeStore.isEnabled(parentTopicId)
        )

        // 编译子代理子图（记录经 subagentCtx 包装为 sub_* 记录）
        const graph = buildAgentGraph({
          model,
          tools,
          systemPrompt,
          queue,
          spill: ctx.spillRef?.current,
          subagentCtx: { name: sa.name, causeId },
          maxToolCalls: ctx.maxToolCalls
        })

        // 流式执行：转发 token / 推理 / 工具块为 sub_* 记录，并累积最终文本。
        // 注意：messages 模式会把工具节点的 ToolMessage 也发出来，累积前必须过滤，
        // 否则子代理最终输出会混入工具结果文本。
        const seenIndexes = new Set<number>()
        let fullText = ''
        try {
          const stream = await graph.stream(
            { messages: buildSubAgentMessages(systemPrompt, prompt) },
            {
              streamMode: ['messages'] as const,
              recursionLimit: ctx.recursionLimit,
              signal: config?.signal,
              // 团队身份：前台子代理也作为 member 参与共享任务板（id 用派遣调用 id）
              configurable: {
                topicId: parentTopicId,
                teamAgent: { id: `task-${causeId}`, name: sa.name, isLead: false }
              }
            }
          )
          for await (const item of stream) {
            if (config?.signal?.aborted) break
            // 迭代元素为 [mode, [message, metadata]] 元组
            const [, payload] = item as readonly [string, [StreamMessageLike, unknown]]
            const chunk = payload[0]
            const chunkType = chunk._getType?.()
            if (chunkType && chunkType !== 'ai') continue
            if (typeof chunk.content === 'string') fullText += chunk.content
            pushMessageRecords(chunk, { push: (r) => push(r as SubAgentRecord) }, seenIndexes, {
              name: sa.name,
              causeId
            })
          }

          const output = fullText.trim() || m.subagent.noTextOutput
          push({ kind: 'sub_end', name: sa.name, causeId, output } satisfies SubAgentRecord)
          // 返回给主模型的内容末尾附加抑制提示：子智能体完整输出已直接展示给用户，
          // 主模型无需在最终回答中复述（否则出现「子智能体块 + 主内容」双份重复）。
          return `${output}\n\n(The above is the complete output of subagent ${sa.name} and has already been shown to the user directly. Do not restate it in your final answer; just wrap up briefly.)`
        } catch (err) {
          // 工具调用轮次耗尽：返回已生成的部分内容 + 收尾提示（而非「执行失败」）
          const isRecursion =
            err instanceof GraphRecursionError || (err as Error)?.name === 'GraphRecursionError'
          if (isRecursion) {
            logger.warn(
              `[SubAgent] ${sa.name} reached the tool call round limit, stopping automatically`
            )
            const output = fullText.trim()
              ? `${fullText.trim()}${m.subagent.roundLimitNote}`
              : m.subagent.roundLimitIncomplete
            push({ kind: 'sub_end', name: sa.name, causeId, output } satisfies SubAgentRecord)
            return output
          }
          const message = err instanceof Error ? err.message : String(err)
          logger.warn(`[SubAgent] ${sa.name} failed to run:`, err)
          const output = mainFormat(m.subagent.failed, { message })
          push({ kind: 'sub_end', name: sa.name, causeId, output } satisfies SubAgentRecord)
          return output
        }
      } catch (err) {
        // 模型解析 / 建图等前置步骤失败（流式执行阶段的错误已由内层 catch 处理）
        const message = err instanceof Error ? err.message : String(err)
        logger.warn(`[SubAgent] ${sa.name} failed to initialize:`, err)
        const output = mainFormat(m.subagent.failed, { message })
        push({ kind: 'sub_end', name: sa.name, causeId, output } satisfies SubAgentRecord)
        return output
      }
    },
    {
      name: 'task',
      description: buildTaskDescription(ctx.subAgents),
      schema: taskSchema
    }
  )
}
