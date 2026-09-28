import logger from 'electron-log'
import type { SubAgentConfig } from '../types'
import { MAX_TOOL_CALLS, MIN_TOOL_CALLS } from './agent'
import { subagentSessions } from './subagent-sessions'
import { getMnemonComponent } from '../mnemon-singleton'

/**
 * 记忆整理后台子代理 —— 消息操作栏「存入记忆」的真正执行者。
 *
 * 为什么不直接写：热记忆是「给未来每一轮对话看的长期事实」，一条助手回复动辄几千字，
 * 直接截断塞进 MEMORY 只会把热记忆撑满、还塞进一堆一次性进度。正确做法是让一个
 * 专门的子代理读这一轮问答，判断哪些是**可复用的事实**（用户偏好、项目决策、环境坑、
 * 失败教训），再决定落到哪一层（热记忆 / 项目文档 / 长期记忆空间）并自己去写。
 *
 * 复用现有后台子代理体系（subagentSessions）的好处：
 * - 顶部栏 BackgroundAgentsButton 自动出现「进行中」入口，点开可看实时输出，无需新 UI；
 * - 同时注册为同名后台任务（job_output/job_kill 可管）；
 * - 话题删除时由 clearTopic 一并清理。
 *
 * 工具集刻意只给 mnemon_*（不给文件/业务工具）：这个代理的职责边界就是记忆本身。
 */

/** 子代理标识（顶部栏显示名走 i18n 模板，这里用稳定的 ASCII 名） */
export const MEMORY_AGENT_NAME = 'memory-curator'

/** 单次整理读取的回答上限：超长回答只取前 N 字符，避免把整份文件塞进提示词 */
const MAX_SOURCE_CHARS = 20_000

/** 系统提示词（提示词固定英文，与项目其余提示词一致） */
export const MEMORY_AGENT_PROMPT = `You are the memory curator: a background subagent that runs when the user marks one assistant reply as worth remembering.

Your job is to decide what from that exchange deserves long-term memory and to store it yourself with the Mnemon tools. Never just report what should be stored — actually store it.

Worth keeping (durable, reusable):
- user preferences, habits, and corrections that should change future behaviour;
- project decisions, conventions, and the reason behind them;
- environment facts, tool quirks, and lessons learned from failures.

Never store: transient progress, completed-work logs, raw dumps, one-off values, secrets, or anything already stored.

How to store:
- Your system prompt already carries the current hot memory and the Mnemon routing rules: never duplicate an entry that is already there — use replace when an existing entry can be made more precise.
- Before writing something new into project documents or a memory space, search first (mnemon_document_search / mnemon_recall) so you merge instead of duplicating.
- Hot memory via mnemon_runtime_memory: target "user" only for who the user is; target "memory" for project, environment and tool facts. Keep entries compact and self-contained.
- Substantial structured knowledge (architecture notes, multi-step recipes, evidence) belongs in a project document via mnemon_document_manage.
- Reusable conclusions can also go to a long-term memory space with mnemon_remember; search first (mnemon_recall) so you merge instead of duplicating.
- Record facts, not commentary: no "the user asked me to remember", no dates unless the date is the point.

Finish with 1-3 lines: what you stored and where.`

export interface StartMemoryAgentParams {
  /** 归属话题（顶部栏按话题列后台代理） */
  topicId: number
  /** 助手回复正文（要整理的材料） */
  answer: string
  /** 该轮的用户提问（拿不到时只整理回答） */
  question?: string
  /** 当前工作区（记忆按工作区隔离） */
  workspaceId: number
  /**
   * 插件 id：非空表示这条会话是插件的，记忆落进**那份插件自己的**作用域
   * （`<memoryPath>/plugin-<id>/`，见 main/memory-scope.ts），与工作记忆零交叉。
   */
  pluginId?: string
  /** 记忆存储根；未配置时记忆系统整体不可用 */
  memoryPath?: string
  /** 供应商 ID，缺省用默认供应商 */
  providerId?: number
  /** 模型级「工具调用轮数」上限 */
  maxToolRounds?: number
}

export type StartMemoryAgentResult =
  | { ok: true; agentId: string; label: string }
  | { ok: false; reason: 'memory-disabled' | 'no-model' | 'model-failed'; message?: string }

/**
 * 解析供应商 ID：显式传入 > 设置里的默认供应商 > 已启用里的第一个。
 *
 * `ProviderService.createModel()` 刻意不再回退默认供应商（要求显式传 ID，聊天轮次由前端
 * 传当前所选模型）。按钮这条路径没有「当前所选」可言，所以在这里自己补一条回退链，
 * 否则 providerId 为 undefined 时必定抛「目标模型不存在」。
 */
async function resolveProviderId(explicit?: number): Promise<number | undefined> {
  if (explicit != null) return explicit
  const { getDefaultProvider, getEnabledProviders } =
    await import('../../../../main/database/mapper/provider')
  const preferred = await getDefaultProvider()
  if (preferred) return preferred.id
  const enabled = await getEnabledProviders()
  return enabled[0]?.id
}

/** 组装交给子代理的任务消息（材料 + 明确的收尾要求） */
export function buildTaskMessage(answer: string, question?: string): string {
  const trimmedAnswer = answer.trim()
  const body =
    trimmedAnswer.length > MAX_SOURCE_CHARS
      ? `${trimmedAnswer.slice(0, MAX_SOURCE_CHARS)}\n\n[... truncated at ${MAX_SOURCE_CHARS} characters ...]`
      : trimmedAnswer
  const ask = question?.trim()
  return [
    'Curate this exchange and store what is worth keeping long-term.',
    '',
    '## User question',
    ask || '(not available)',
    '',
    '## Assistant answer',
    body,
    '',
    'Store the durable parts with the Mnemon tools, then reply with 1-3 lines describing what you stored and where.'
  ].join('\n')
}

/**
 * 起一个记忆整理子代理（立即返回，不等待它跑完）。
 *
 * 模型与护栏和主轮次同源：供应商由调用方决定（缺省=默认供应商），
 * 「工具调用轮数」取该模型的设置并夹在 MIN_TOOL_CALLS..MAX_TOOL_CALLS 之间。
 */
export async function startMemoryAgent(
  params: StartMemoryAgentParams
): Promise<StartMemoryAgentResult> {
  const mnemon = getMnemonComponent(params.memoryPath, params.workspaceId, params.pluginId)
  if (!mnemon) return { ok: false, reason: 'memory-disabled' }

  // 惰性导入：与 runtime.ts 的 resolveSubAgentModel 同款做法，模块本身不绑死供应商层
  const { getProviderService } = await import('../../../../main/provider/service')
  const providerService = getProviderService()

  let providerId: number | undefined
  try {
    providerId = await resolveProviderId(params.providerId)
  } catch (err) {
    return { ok: false, reason: 'model-failed', message: (err as Error)?.message }
  }
  if (providerId == null) return { ok: false, reason: 'no-model' }

  let model
  try {
    model = await providerService.createModel(providerId)
  } catch (err) {
    // 指定的供应商可能已被禁用/删除（例如用的是那条回复当时的模型）：回退到默认供应商，
    // 别让按钮就此死掉；回退也失败才报错。
    const fallbackId = await resolveProviderId(undefined).catch(() => undefined)
    if (fallbackId != null && fallbackId !== providerId) {
      logger.warn(
        `[MemoryAgent] 供应商 ${providerId} 不可用，回退到 ${fallbackId}: ${(err as Error)?.message}`
      )
      try {
        model = await providerService.createModel(fallbackId)
      } catch {
        /* 落到下面的失败返回 */
      }
    }
    if (!model) return { ok: false, reason: 'model-failed', message: (err as Error)?.message }
  }

  const maxToolCalls = Math.max(MIN_TOOL_CALLS, Math.floor(params.maxToolRounds ?? MAX_TOOL_CALLS))
  const config: SubAgentConfig = {
    name: MEMORY_AGENT_NAME,
    description: 'Summarises a conversation turn and writes the durable parts into Mnemon memory.',
    systemPrompt: MEMORY_AGENT_PROMPT
  }

  const row = subagentSessions.start(
    params.topicId,
    config,
    buildTaskMessage(params.answer, params.question),
    {
      mainModel: model,
      // 不解析 'provider:model'：记忆整理跟着当前默认模型走，不额外挑模型
      resolveModel: async () => undefined,
      // 只给记忆工具：这个代理不碰文件系统与业务数据
      buildTools: () => mnemon.tools,
      recursionLimit: maxToolCalls * 2 + 20,
      maxToolCalls,
      // 记忆路由规则（热记忆/档案/空间的用法）与主代理同源，避免它把事实写错层
      extendSystemPrompt: () => `${MEMORY_AGENT_PROMPT}${mnemon.promptSections.join('')}`
    }
  )

  return { ok: true, agentId: row.id, label: row.label }
}
