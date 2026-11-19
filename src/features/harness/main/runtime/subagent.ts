import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { z } from 'zod'
import { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { GraphRecursionError } from '@langchain/langgraph'
import logger from 'electron-log'
import * as fs from 'fs'
import * as path from 'path'
import type { SubAgentRecord } from './types'
import { buildAgentGraph, pushMessageRecords, type QueueRef, type StreamMessageLike } from './agent'
import { buildSkillsPromptSection, loadSkills } from './skills'
import type { SpillStore } from './spill'
import { subagentSessions } from './subagent-sessions'
import type { SubAgentConfig } from '../types'
import { mainFormat } from '../../../../main/i18n'
import { getAgentToolTexts } from '../../../../main/i18n/tool-results-agent'

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
  subAgents: SubAgentConfig[]
  /** 主代理模型（回退目标） */
  mainModel: BaseChatModel
  /** 按 'provider:model' 创建模型的回调（由 Runtime 注入） */
  resolveModel: (spec: string | undefined) => Promise<BaseChatModel | undefined>
  workspaceId: number
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
    logger.warn(`[SubAgent] 读取记忆文件失败 ${memoryFile}:`, err)
  }
  return ''
}

/** 构建子代理系统提示词：基础 systemPrompt + 专属记忆 + 技能段 */
function buildSubAgentSystemPrompt(ctx: SubAgentRuntimeContext, sa: SubAgentConfig): string {
  let prompt = sa.systemPrompt

  const memory = loadSubAgentMemory(ctx.memoryPath, sa.name)
  if (memory) {
    prompt += `\n\n## Long-term memory\n${memory}`
  }

  if (sa.skills && sa.skills.length > 0) {
    const skillsSection = buildSkillsPromptSection(
      loadSkills({ skillsPath: ctx.skillsPath, enabledSkills: sa.skills })
    )
    if (skillsSection) {
      prompt += skillsSection
    }
  }

  return prompt
}

/** 构建 task 工具描述：静态引导 + 子代理清单（名称 + 功能描述） */
function buildTaskDescription(subAgents: SubAgentConfig[]): string {
  if (subAgents.length === 0) {
    return 'Delegate complex work to a dedicated subagent. A subagent has its own system prompt and toolset, which suits subtasks that need focused handling.'
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
      const sa = ctx.subAgents.find((s) => s.name === subagent_type)
      if (!sa) {
        return mainFormat(m.subagent.notFound, {
          type: subagent_type,
          names: ctx.subAgents.map((s) => s.name).join(', ') || m.subagent.noneAvailable
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
          extendSystemPrompt: (s) => buildSubAgentSystemPrompt(ctx, s)
        })
        return mainFormat(m.subagent.backgroundStarted, { id: row.id, label: row.label })
      }

      const causeId =
        ((config?.configurable as Record<string, unknown> | undefined)?.toolCallId as
          string | undefined) ?? 'unknown'
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
        const systemPrompt = buildSubAgentSystemPrompt(ctx, sa)

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
              signal: config?.signal
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
            logger.warn(`[SubAgent] ${sa.name} 工具调用轮次已达上限，自动停止`)
            const output = fullText.trim()
              ? `${fullText.trim()}${m.subagent.roundLimitNote}`
              : m.subagent.roundLimitIncomplete
            push({ kind: 'sub_end', name: sa.name, causeId, output } satisfies SubAgentRecord)
            return output
          }
          const message = err instanceof Error ? err.message : String(err)
          logger.warn(`[SubAgent] ${sa.name} 执行失败:`, err)
          const output = mainFormat(m.subagent.failed, { message })
          push({ kind: 'sub_end', name: sa.name, causeId, output } satisfies SubAgentRecord)
          return output
        }
      } catch (err) {
        // 模型解析 / 建图等前置步骤失败（流式执行阶段的错误已由内层 catch 处理）
        const message = err instanceof Error ? err.message : String(err)
        logger.warn(`[SubAgent] ${sa.name} 初始化失败:`, err)
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
