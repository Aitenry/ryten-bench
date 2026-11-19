import { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { AIMessage, BaseMessage, HumanMessage } from '@langchain/core/messages'
import { GraphRecursionError } from '@langchain/langgraph'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { z } from 'zod'
import logger from 'electron-log'
import type { SubAgentConfig } from '../types'
import { buildAgentGraph, type StreamMessageLike } from './agent'
import { jobsRegistry } from './jobs'
import type { RuntimeRecord } from './types'
import type { SpillStore } from './spill'
import { mainFormat } from '../../../../main/i18n'
import { getAgentToolTexts } from '../../../../main/i18n/tool-results-agent'

/**
 * 子代理续接会话（continuable subagent sessions）— 对应 deepseek-harness 的
 * dsh-subagent / dsh-subagent-spawn-in-process / dsh-tool-subagent-control 体系
 *
 * 机制（参考 DSH，适配 RytenBench 按 topicId 组织的对话）：
 * - task(background=true) 启动一个「可续接」的子代理会话：持久消息历史 + 收件箱队列，
 *   跨主代理轮次存续（进程内；重启丢失，v1 不做冷恢复）；
 * - send_message 向会话投递下一轮消息：运行中则排队（FIFO 收件箱），空闲则唤醒；
 *   只返回投递确认 {messageId}，不等待子代理回复（父经 job_output/job_list 观察）；
 * - interrupt_agent 取消当前运行（keepInbox 语义：排队消息保留，可 send_message 唤醒）；
 * - list_agents 列出全部会话与状态（running=当前轮运行中 / idle=空闲待命；
 *   v1 进程内注册表，无 ready 冷存态）；
 * - 每次会话运行都注册为同名后台任务（job id = 会话 id），job_output/job_kill 复用；
 * - 权限：控制工具只注入主代理，且仅能操作本话题的会话（owner 按 topicId 隔离）。
 */

/** 会话状态行（list_agents 输出） */
export interface SubagentSessionRow {
  id: string
  name: string
  label: string
  status: 'running' | 'idle'
  queuedMessages: number
  createdAt: number
  lastRunAt?: number
  /** 最近一轮运行的终态（顶部栏「进行中 > 已完成/失败/已停止」） */
  lastStatus?: 'completed' | 'failed' | 'killed'
}

interface SessionRecord {
  id: string
  topicId: number
  config: SubAgentConfig
  label: string
  /** 启动时的原始任务指令（弹窗顶部展示；send 后续轮次为追加对话） */
  prompt: string
  /** 会话消息历史（systemPrompt 不入历史；入图时动态注入） */
  messages: BaseMessage[]
  /** 收件箱队列（运行中投递的消息排队） */
  inbox: string[]
  status: 'running' | 'idle'
  createdAt: number
  lastRunAt?: number
  /** 最近一轮运行的终态（顶部栏列表展示「进行中 > 已完成/失败/已停止」） */
  lastStatus?: 'completed' | 'failed' | 'killed'
  /** 最近一轮运行的最终输出（终态后查看结果） */
  lastOutput: string
  /** 当前运行中的增量输出（running 时实时查看） */
  liveOutput: string
  /** 当前运行的取消控制器（interrupt 用） */
  currentAbort?: AbortController
  /** 话题删除后置位：禁止投递与收件箱续跑（防僵尸会话继续执行） */
  dead?: boolean
}

export type SubagentSessionsListener = (topicId: number, rows: SubagentSessionRow[]) => void

/** 会话输出更新回调（IPC 层节流后推送前端；输出以增量形式持续追加） */
export type SubagentOutputListener = (topicId: number, agentId: string) => void

/** 启动子代理会话所需的运行上下文（复用主运行时组件） */
export interface SubagentSessionRuntime {
  mainModel: BaseChatModel
  resolveModel: (spec: string | undefined) => Promise<BaseChatModel | undefined>
  buildTools: (subAgent: SubAgentConfig) => StructuredToolInterface[]
  recursionLimit: number
  /** 工具调用总次数上限（模型级「工具调用轮数」；与主图共用同一模型设置） */
  maxToolCalls: number
  spillRef?: { current?: SpillStore }
  /** 子代理系统提示词扩展（专属记忆/技能），与 task 工具同源 */
  extendSystemPrompt: (sa: SubAgentConfig) => string
}

/** 子代理续接会话注册表（进程级单例，按 topicId 隔离） */
export class SubagentSessionRegistry {
  private readonly sessions = new Map<string, SessionRecord>()
  private counter = 0

  onChange?: SubagentSessionsListener
  /** 输出增量更新（IPC 节流推送；仅在有前端关注该 agent 时消费） */
  onLiveOutput?: SubagentOutputListener

  /** 启动新会话（spawn 语义：全新上下文），首条消息立即开始运行 */
  start(
    topicId: number,
    config: SubAgentConfig,
    firstMessage: string,
    rt: SubagentSessionRuntime
  ): SubagentSessionRow {
    this.counter += 1
    const id = `subagent-${this.counter}`
    const displayName = config.rename && config.rename !== config.name ? config.rename : config.name
    const record: SessionRecord = {
      id,
      topicId,
      config,
      label: mainFormat(getAgentToolTexts().subagentSessions.sessionLabel, {
        name: displayName,
        task: firstMessage.slice(0, 40)
      }),
      prompt: firstMessage,
      messages: [],
      inbox: [],
      // 初始 idle：run() 内有「running 则入队返回」的防御守卫，若此处直接置 running，
      // 首条消息会被守卫吞回收件箱、任务永不注册（job_output 报「任务不存在」、
      // list_agents 卡 running+queuedMessages=1 的根因）。由 run() 统一置 running。
      status: 'idle',
      createdAt: Date.now(),
      lastOutput: '',
      liveOutput: ''
    }
    this.sessions.set(id, record)
    void this.run(record, firstMessage, rt)
    return this.row(record)
  }

  /** 投递消息：空闲立即运行；运行中入队（FIFO）。返回投递确认 */
  send(id: string, topicId: number, message: string): { messageId: string } {
    const messageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const record = this.sessions.get(id)
    if (!record || record.topicId !== topicId) {
      throw new Error(mainFormat(getAgentToolTexts().subagentSessions.notFound, { id }))
    }
    if (record.dead) {
      throw new Error(mainFormat(getAgentToolTexts().subagentSessions.deletedWithTopic, { id }))
    }
    record.inbox.push(message)
    if (record.status === 'idle') {
      const next = record.inbox.shift()!
      void this.run(record, next, this.lastRuntime(record)!)
    }
    return { messageId }
  }

  /** 取消当前运行（keepInbox：排队消息保留）。缺席/已空闲 = no-op 接受 */
  interrupt(id: string, topicId: number): { accepted: boolean } {
    const record = this.sessions.get(id)
    if (!record || record.topicId !== topicId) return { accepted: true } // 缺席/已结束 = no-op
    if (record.status === 'running') {
      record.currentAbort?.abort()
    }
    return { accepted: true }
  }

  /** 全部会话行（按创建顺序） */
  list(topicId: number): SubagentSessionRow[] {
    return [...this.sessions.values()]
      .filter((s) => s.topicId === topicId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((s) => this.row(s))
  }

  /** 话题删除时清理（先中断全部会话，并置 dead 阻止在途闭包续跑收件箱） */
  clearTopic(topicId: number): void {
    for (const [id, record] of this.sessions) {
      if (record.topicId !== topicId) continue
      record.dead = true
      record.inbox.length = 0
      record.currentAbort?.abort()
      this.sessions.delete(id)
    }
  }

  private row(record: SessionRecord): SubagentSessionRow {
    return {
      id: record.id,
      name: record.config.name,
      label: record.label,
      status: record.status,
      queuedMessages: record.inbox.length,
      createdAt: record.createdAt,
      lastRunAt: record.lastRunAt,
      lastStatus: record.lastStatus
    }
  }

  /** 读取会话输出（弹窗查看）：running 时返回增量，终态后返回最终输出；含原始任务指令 */
  readOutput(
    id: string,
    topicId: number
  ):
    | {
        text: string
        status: 'running' | 'idle'
        lastStatus?: SubagentSessionRow['lastStatus']
        prompt: string
      }
    | undefined {
    const record = this.sessions.get(id)
    if (!record || record.topicId !== topicId) return undefined
    return {
      text: record.status === 'running' ? record.liveOutput : record.lastOutput,
      status: record.status,
      lastStatus: record.lastStatus,
      prompt: record.prompt
    }
  }

  private broadcast(topicId: number): void {
    this.onChange?.(topicId, this.list(topicId))
  }

  /** 会话运行一次的 runtime 引用缓存（send 唤醒时复用；start 时注入） */
  private runtimes = new WeakMap<SessionRecord, SubagentSessionRuntime>()

  private lastRuntime(record: SessionRecord): SubagentSessionRuntime | undefined {
    return this.runtimes.get(record)
  }

  /**
   * 执行一轮会话运行：以会话历史为前缀 + 新消息，子图流式执行；
   * 输出增量写入同名后台任务（job_output 可读）；结束后结算任务，
   * 若有排队消息继续下一轮（FIFO）。
   */
  private async run(
    record: SessionRecord,
    message: string,
    rt: SubagentSessionRuntime
  ): Promise<void> {
    if (record.status === 'running') {
      // 理论不可达（send 只在 idle 时唤醒）；防御性入队
      record.inbox.unshift(message)
      return
    }
    record.status = 'running'
    record.currentAbort = new AbortController()
    this.runtimes.set(record, rt)
    this.broadcast(record.topicId)
    const m = getAgentToolTexts()

    // 注册同名后台任务（job id = 会话 id；settlement first-wins）
    const job = jobsRegistry.start(record.topicId, 'subagent', record.label, record.id)
    jobsRegistry.attachCancel(record.id, () => record.currentAbort?.abort())
    const abortSignal = record.currentAbort.signal

    let fullText = ''
    try {
      const sa = record.config
      const model = (await rt.resolveModel(sa.model)) ?? rt.mainModel
      const tools = rt.buildTools(sa)
      const systemPrompt = rt.extendSystemPrompt(sa)

      // 路由到任务帧（父模型经 job_output 观察；顶部栏列表经 readOutput 实时/终态读取）
      const notifyOutput = (): void => {
        // IPC 层消费（节流推送前端弹窗），仅在有关注者时才有成本
        this.onLiveOutput?.(record.topicId, record.id)
      }
      const queueRef = {
        current: {
          push: (rec: RuntimeRecord): void => {
            if (rec.kind === 'text' || rec.kind === 'reasoning') {
              if (rec.text) {
                job.appendOutput(rec.text)
                record.liveOutput += rec.text
                notifyOutput()
              }
            } else if (rec.kind === 'tool_call') {
              const inputText = JSON.stringify(rec.input ?? {}).slice(0, 200)
              job.appendOutput(
                mainFormat(m.subagentSessions.toolCallLine, { name: rec.name, input: inputText })
              )
            }
          }
        }
      }
      const graph = buildAgentGraph({
        model,
        tools,
        systemPrompt,
        queue: queueRef,
        spill: rt.spillRef?.current,
        maxToolCalls: rt.maxToolCalls
      })

      // 会话输入：历史 + 本轮消息
      const input = [...record.messages, new HumanMessage(message)]
      const stream = await graph.stream(
        { messages: input },
        {
          streamMode: ['messages'] as const,
          recursionLimit: rt.recursionLimit,
          signal: abortSignal
        }
      )
      for await (const item of stream) {
        if (abortSignal.aborted) break
        const [, payload] = item as readonly [string, [StreamMessageLike, unknown]]
        const chunk = payload[0]
        const chunkType = chunk._getType?.()
        if (chunkType && chunkType !== 'ai') continue
        if (typeof chunk.content === 'string') fullText += chunk.content
      }

      if (abortSignal.aborted) {
        const partial = fullText.trim()
        record.messages.push(new HumanMessage(message))
        if (partial) record.messages.push(new AIMessage({ content: partial }))
        record.lastStatus = 'killed'
        record.lastOutput = partial
          ? `${partial}\n${m.subagentSessions.interrupted}`
          : m.subagentSessions.interrupted
        record.liveOutput = ''
        job.settle('killed', record.lastOutput, 'interrupted')
        return
      }
      const output = fullText.trim() || m.subagent.noTextOutput
      record.messages.push(new HumanMessage(message))
      record.messages.push(new AIMessage({ content: output }))
      record.lastStatus = 'completed'
      record.lastOutput = output
      record.liveOutput = ''
      job.settle('completed', output)
    } catch (err) {
      // 中断（interrupt_agent/job_kill）在流式中途会以 AbortError 抛出——结算为 killed
      // 而非 failed（修复：此前落入 failed 分支，英文中止错误文案混进历史且状态语义错误）
      if (abortSignal.aborted) {
        const partial = fullText.trim()
        record.messages.push(new HumanMessage(message))
        if (partial) record.messages.push(new AIMessage({ content: partial }))
        record.lastStatus = 'killed'
        record.lastOutput = partial
          ? `${partial}\n${m.subagentSessions.interrupted}`
          : m.subagentSessions.interrupted
        record.liveOutput = ''
        job.settle('killed', record.lastOutput, 'interrupted')
        return
      }
      const isRecursion =
        err instanceof GraphRecursionError || (err as Error)?.name === 'GraphRecursionError'
      const messageText = isRecursion
        ? m.subagentSessions.roundLimitReached
        : err instanceof Error
          ? err.message
          : String(err)
      logger.warn(`[SubagentSession] ${record.id} 运行失败:`, err)
      const partial = fullText.trim()
      record.messages.push(new HumanMessage(message))
      if (partial) record.messages.push(new AIMessage({ content: partial }))
      record.lastStatus = 'failed'
      const failureNote = mainFormat(m.subagentSessions.runFailed, { message: messageText })
      record.lastOutput = partial ? `${partial}\n${failureNote}` : failureNote
      record.liveOutput = ''
      job.settle('failed', record.lastOutput, messageText)
    } finally {
      record.lastRunAt = Date.now()
      record.currentAbort = undefined
      record.status = 'idle'
      this.broadcast(record.topicId)
      // 终态（含被中断/失败）也推送一次输出（status 已回 idle，readOutput 走 lastOutput）
      this.onLiveOutput?.(record.topicId, record.id)

      // 话题已删除（clearTopic 置位 dead）：不再续跑收件箱（修复：此前僵尸会话闭包
      // 仍逐条跑完收件箱，并在已删除话题下注册不可管理的幽灵任务）
      if (!record.dead) {
        // 收件箱非空 → 继续下一轮（FIFO）
        const next = record.inbox.shift()
        if (next) {
          void this.run(record, next, rt)
        }
      }
    }
  }
}

/** 进程级单例 */
export const subagentSessions = new SubagentSessionRegistry()

/** 构建子代理续接控制工具（仅注入主代理；owner 按 topicId 隔离） */
export function buildSubagentControlTools(
  registry: SubagentSessionRegistry,
  topicId: number
): StructuredToolInterface[] {
  return [
    tool(
      async ({ subagent_id, message }) => {
        try {
          const { messageId } = registry.send(subagent_id, topicId, message)
          return JSON.stringify({ messageId })
        } catch (err) {
          return mainFormat(getAgentToolTexts().subagentSessions.sendFailed, {
            message: (err as Error).message
          })
        }
      },
      {
        name: 'send_message',
        description:
          'Send the next message to a background subagent session so it keeps working (continuing the same conversation and context). If that session is currently running, the message is queued and runs automatically after its current turn ends. Returns only a delivery confirmation (messageId); poll the subagent reply with job_output(job_id).',
        schema: z.object({
          subagent_id: z
            .string()
            .describe(
              'Subagent session ID (returned when the task tool starts in background mode, e.g. subagent-1)'
            ),
          message: z.string().describe('Message content to send to the subagent')
        })
      }
    ),
    tool(
      async ({ agent_id }) => {
        const { accepted } = registry.interrupt(agent_id, topicId)
        return JSON.stringify({ accepted })
      },
      {
        name: 'interrupt_agent',
        description:
          'Interrupt the turn currently running in a background subagent session. Messages already queued but not yet started are kept and can be resumed later with send_message. A harmless no-op when the session does not exist or is idle.',
        schema: z.object({
          agent_id: z.string().describe('ID of the subagent session to interrupt')
        })
      }
    ),
    tool(
      async ({ scope }) => {
        void scope
        return JSON.stringify({ agents: registry.list(topicId) })
      },
      {
        name: 'list_agents',
        description:
          'List all background subagent sessions for this topic with their statuses (running = current turn in progress / idle = waiting between turns) and queued message counts.',
        schema: z.object({
          scope: z
            .enum(['children', 'descendants'])
            .optional()
            .describe('Scope (the current implementation returns a flat list of subagents)')
        })
      }
    )
  ]
}
