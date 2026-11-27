import { BaseChatModel } from '../../ai/chat-model'
import { AIMessage, BaseMessage, HumanMessage } from '../../ai/messages'
import { GraphRecursionError } from '../../ai/graph'
import { tool, type StructuredToolInterface } from '../../ai/tools'
import { z } from 'zod'
import logger from 'electron-log'
import { randomUUID } from 'node:crypto'
import type {
  StructuredMessage,
  SubAgentConfig,
  SubAgentMainModelDescriptor
} from '../../services/harness/types'
import {
  produceMessages,
  produceSubAgents,
  produceToolCalls
} from '../../services/harness/stream-producers'
import {
  deleteSubagentSessionsByTopic,
  listSubagentSessions,
  upsertSubagentSession
} from '../../database/mapper/harness/subagent-session'
import { buildAgentGraph, pushMessageRecords, type QueueRef, type StreamMessageLike } from './agent'
import { jobsRegistry } from './jobs'
import { RecordQueue } from './graph'
import type { RuntimeStream } from './types'
import type { SpillStore } from './spill'
import { sumUsage, type ModelUsageRecord } from './usage'
import { mainFormat } from '../../i18n'
import { getAgentToolTexts } from '../../i18n/tool-results-agent'
import type {
  SubagentConversationEvent,
  SubagentConversationEventInput,
  SubagentConversationSnapshot,
  SubagentConversationHistory,
  SubagentTurnStatus
} from './subagent-conversation'

/**
 * 子代理续接会话（continuable subagent sessions）— 对应 deepseek-harness 的
 * dsh-subagent / dsh-subagent-spawn-in-process / dsh-tool-subagent-control 体系
 *
 * 机制（参考 DSH，适配 RytenBench 按 topicId 组织的对话）：
 * - task(background=true) 启动一个「可续接」的子代理会话：持久消息历史 + 收件箱队列，
 *   跨主代理轮次存续；
 * - 会话快照持久化到 `subagent_session` 表（事件流/消息历史/配置快照/终态/模型 descriptor/用量）：
 *   重启后历史记录仍在，恢复的会话标记为 `inactive`；第一次续聊（UI 输入框 / send_message）
 *   会按快照重建模型/工具/prompt（冷恢复）后转回 idle，继续正常收件箱语义；
 * - send_message 向会话投递下一轮消息：运行中则排队（FIFO 收件箱），空闲则唤醒；
 *   只返回投递确认 {messageId}，不等待子代理回复（父经 job_output/job_list 观察）；
 * - interrupt_agent 取消当前运行（keepInbox 语义：排队消息保留，可 send_message 唤醒）；
 * - list_agents 列出全部会话与状态（running=当前轮运行中 / idle=空闲待命 /
 *   inactive=重启后恢复的历史会话）；
 * - 每次会话运行都注册为同名后台任务（job id = 会话 id），job_output/job_kill 复用；
 * - 权限：控制工具只注入主代理，且仅能操作本话题的会话（owner 按 topicId 隔离）。
 */

/** 会话状态：running / idle 是进程内活跃态；inactive = 重启后从数据库恢复的历史会话 */
export type SubagentSessionStatus = 'running' | 'idle' | 'inactive'

/** 会话状态行（list_agents 输出） */
export interface SubagentSessionRow {
  id: string
  name: string
  label: string
  status: SubagentSessionStatus
  queuedMessages: number
  createdAt: number
  lastRunAt?: number
  /** 最近一轮运行的终态（顶部栏「进行中 > 已完成/失败/已停止」） */
  lastStatus?: 'completed' | 'failed' | 'killed'
  /** 会话累计真实 token 用量（所有轮次 usage_metadata 累加；0 = 未采集到） */
  totalTokens: number
  /** 是否采集到过真实用量（模型没回传 usage 时不显示） */
  hasUsage: boolean
}

/** 单会话事件上限：超出后按整轮丢弃最旧事件（长会话不能无限占内存、快照也不能无限大） */
const MAX_CONVERSATION_EVENTS = 4000

/** JSON 列解析失败时按缺失处理（历史脏数据不应让整个恢复流程失败） */
function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function parseJsonArray<T>(raw: string | null): T[] {
  const parsed = parseJson<unknown>(raw)
  return Array.isArray(parsed) ? (parsed as T[]) : []
}

interface SessionRecord {
  id: string
  topicId: number
  config: SubAgentConfig
  /** spawn 时主模型描述符（冷恢复用；旧会话可能为空） */
  mainModelDescriptor?: SubAgentMainModelDescriptor
  label: string
  /** 启动时的原始任务指令（弹窗顶部展示；send 后续轮次为追加对话） */
  prompt: string
  /** 会话消息历史（systemPrompt 不入历史；入图时动态注入） */
  messages: BaseMessage[]
  /** 收件箱队列（运行中投递的消息排队） */
  inbox: string[]
  status: SubagentSessionStatus
  createdAt: number
  lastRunAt?: number
  /** 最近一轮运行的终态（顶部栏列表展示「进行中 > 已完成/失败/已停止」） */
  lastStatus?: 'completed' | 'failed' | 'killed'
  /** 累计真实 token 用量（跨轮累加；各字段 0 = 未采集） */
  usageInputTokens: number
  usageOutputTokens: number
  usageTotalTokens: number
  usageCalls: number
  /** 最近一轮运行的最终输出（终态后查看结果） */
  lastOutput: string
  /** 当前运行中的增量输出（running 时实时查看） */
  /** 当前运行的取消控制器（interrupt 用） */
  currentAbort?: AbortController
  /** 话题删除后置位：禁止投递与收件箱续跑（防僵尸会话继续执行） */
  dead?: boolean
  /** 轮次编号（turn_start 事件 id / 会话视图里的回合序号） */
  turnCounter: number
  /** 会话事件流序号（增量事件的单调递增游标） */
  conversationSeq: number
  /**
   * 会话事件流（打开子代理会话时全量重放；进程内、主题隔离，重启丢弃）。
   *
   * 只追加不修改：turn_start → chunk* → turn_end。渲染层用与主对话相同的
   * chunk reducer 重放，得到与主对话一致的流式 block。
   */
  conversation: SubagentConversationEvent[]
}

export type SubagentSessionsListener = (topicId: number, rows: SubagentSessionRow[]) => void

/** 会话输出更新回调（IPC 层节流后推送前端；输出以增量形式持续追加） */

/**
 * 会话事件回调（IPC 层消费，节流后把增量事件推给正在查看该子代理的渲染进程）。
 * 事件已带 seq；未 watch 的会话由 IPC 层直接丢弃，不产生成本。
 */
export type SubagentConversationListener = (
  topicId: number,
  agentId: string,
  event: SubagentConversationEvent
) => void

/** 启动子代理会话所需的运行上下文（复用主运行时组件） */
export interface SubagentSessionRuntime {
  mainModel: BaseChatModel
  /** spawn 时主模型描述符（父 Runtime 注入；后台会话持久化后用） */
  mainModelDescriptor?: SubAgentMainModelDescriptor
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
/** 会话视图默认分页轮数：首屏/向前加载都以 turn_start 为界，避免大历史会话一次性 IPC */
const CONVERSATION_PAGE_TURNS = 20

/** 取最后 maxTurns 轮的完整事件（从 turn_start 切起）；返回是否还有更早轮次 */
function sliceRecentConversationTurns(
  events: SubagentConversationEvent[],
  maxTurns = CONVERSATION_PAGE_TURNS
): { events: SubagentConversationEvent[]; hasOlder: boolean } {
  const starts: number[] = []
  events.forEach((event, index) => {
    if (event.kind === 'turn_start') starts.push(index)
  })
  if (starts.length <= maxTurns) return { events, hasOlder: false }
  return { events: events.slice(starts[starts.length - maxTurns]), hasOlder: true }
}

export class SubagentSessionRegistry {
  private readonly sessions = new Map<string, SessionRecord>()
  /** 是否已从数据库恢复过历史会话（账号切换时重置，切库后重新恢复） */
  private restored = false

  onChange?: SubagentSessionsListener
  /** 输出增量更新（IPC 节流推送；仅在有前端关注该 agent 时消费） */
  /** 会话事件增量（IPC 节流推送；仅供正在查看该子代理会话的前端） */
  onConversationEvent?: SubagentConversationListener
  /** 话题删除/账号切换时通知上层清理按 topicId 持有的 watch/定时器（IPC 层用） */
  onTopicCleared?: (topicId: number) => void
  onAllCleared?: () => void
  /**
   * 冷恢复 runtime 工厂：恢复的 inactive 会话在第一次 send 时按话题/配置重建 runtime。
   * 由系统启动装配（`system/harness.ts`），注册表本身不依赖模型/设置模块。
   */
  private runtimeFactory?: (
    topicId: number,
    descriptor?: SubAgentMainModelDescriptor
  ) => Promise<SubagentSessionRuntime | undefined>

  /** 注入/撤销冷恢复 runtime 工厂 */
  setRuntimeFactory(
    factory?: (
      topicId: number,
      descriptor?: SubAgentMainModelDescriptor
    ) => Promise<SubagentSessionRuntime | undefined>
  ): void {
    this.runtimeFactory = factory
  }

  /** 启动新会话（spawn 语义：全新上下文），首条消息立即开始运行 */
  start(
    topicId: number,
    config: SubAgentConfig,
    firstMessage: string,
    rt: SubagentSessionRuntime
  ): SubagentSessionRow {
    const id = `subagent-${randomUUID()}`
    const displayName = config.rename && config.rename !== config.name ? config.rename : config.name
    const record: SessionRecord = {
      id,
      topicId,
      config,
      mainModelDescriptor: rt.mainModelDescriptor,
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
      usageInputTokens: 0,
      usageOutputTokens: 0,
      usageTotalTokens: 0,
      usageCalls: 0,
      createdAt: Date.now(),
      lastOutput: '',
      turnCounter: 0,
      conversationSeq: 0,
      conversation: []
    }
    this.sessions.set(id, record)
    // 先落一条快照：即使首轮中途崩溃/退出，重启后仍能看到这个会话（历史只读）
    this.persist(record)
    void this.run(record, firstMessage, rt)
    return this.row(record)
  }

  /** 投递消息：空闲立即运行；运行中入队（FIFO）。返回投递确认 */
  async send(id: string, topicId: number, message: string): Promise<{ messageId: string }> {
    const messageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const record = this.sessions.get(id)
    if (!record || record.topicId !== topicId) {
      throw new Error(mainFormat(getAgentToolTexts().subagentSessions.notFound, { id }))
    }
    if (record.dead) {
      throw new Error(mainFormat(getAgentToolTexts().subagentSessions.deletedWithTopic, { id }))
    }
    // 冷恢复：重启后恢复的 inactive 会话 / 没有 runtime 的空闲会话，第一次投递时
    // 按持久化配置重建模型/工具/prompt/runtime，再转成 idle 继续正常收件箱语义。
    let rt = this.lastRuntime(record)
    if (!rt) {
      if (!this.runtimeFactory) {
        throw new Error(
          mainFormat(getAgentToolTexts().subagentSessions.inactiveCannotResume, { id })
        )
      }
      rt = await this.runtimeFactory(record.topicId, record.mainModelDescriptor)
      if (!rt) {
        throw new Error(
          mainFormat(getAgentToolTexts().subagentSessions.inactiveCannotResume, { id })
        )
      }
      this.runtimes.set(record, rt)
      if (record.status === 'inactive') record.status = 'idle'
    }
    record.inbox.push(message)
    // 排队条数要能实时出现在会话视图里：运行中投递时先广播一次行快照
    this.broadcast(record.topicId)
    this.persist(record)
    if (record.status === 'idle') {
      const next = record.inbox.shift()!
      void this.run(record, next, rt)
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
    this.onTopicCleared?.(topicId)
    // 持久化快照随话题删除（外键级联是主路径；这里显式删一次，防旧版本库/异常半删）
    void deleteSubagentSessionsByTopic(topicId).catch((err) =>
      logger.warn('[SubagentSessions] Failed to delete persisted sessions for topic:', err)
    )
  }

  private row(record: SessionRecord): SubagentSessionRow {
    return {
      id: record.id,
      name: record.config.name,
      label: record.label,
      status: record.status,
      queuedMessages: record.inbox.length,
      totalTokens: record.usageTotalTokens,
      hasUsage: record.usageCalls > 0,
      createdAt: record.createdAt,
      lastRunAt: record.lastRunAt,
      lastStatus: record.lastStatus
    }
  }

  /**
   * 读取子代理会话快照（打开会话视图时拉一次）。
   *
   * 返回事件流 + 当前 seq：渲染层重放事件得到与主对话一致的流式 block 列表，
   * 之后按 seq 合并增量事件。会话不存在 / 不属于该话题时返回 undefined。
   */
  readConversation(id: string, topicId: number): SubagentConversationSnapshot | undefined {
    const record = this.sessions.get(id)
    if (!record || record.topicId !== topicId) return undefined
    const page = sliceRecentConversationTurns(record.conversation)
    return {
      topicId: record.topicId,
      agentId: record.id,
      name: record.config.name,
      label: record.label,
      prompt: record.prompt,
      status: record.status,
      lastStatus: record.lastStatus,
      queuedMessages: record.inbox.length,
      hasOlder: page.hasOlder,
      seq: record.conversationSeq,
      events: page.events
    }
  }

  /**
   * 向前翻页：取 `beforeSeq` 之前最近的一页完整轮次（以 turn_start 为界）。
   * 打开会话时只返回最近 CONVERSATION_PAGE_TURNS 轮，滚动到顶部再按需加载更早历史。
   */
  readOlderConversation(
    id: string,
    topicId: number,
    beforeSeq: number,
    maxTurns = CONVERSATION_PAGE_TURNS
  ): SubagentConversationHistory | undefined {
    const record = this.sessions.get(id)
    if (!record || record.topicId !== topicId) return undefined
    if (!Number.isFinite(beforeSeq) || beforeSeq <= 0) {
      return { events: [], hasOlder: false }
    }
    const older = record.conversation.filter((event) => event.seq < beforeSeq)
    return sliceRecentConversationTurns(older, Math.max(1, Math.floor(maxTurns)))
  }

  /**
   * 清空全部会话（切换账号数据空间 / 退出时调用）。
   *
   * 会话按 topicId 索引，换库后同一个 id 可能指向另一条话题；不清理会出现
   * 「新账号里点开后台子代理却看到上一个账号的会话」的串号现象（与 jobs 同源问题）。
   */
  clearAll(): void {
    for (const record of this.sessions.values()) {
      record.dead = true
      record.inbox.length = 0
      record.currentAbort?.abort()
    }
    this.sessions.clear()
    this.onAllCleared?.()
    // 账号空间切换后要能从新库重新恢复历史会话（旧库数据不删：只清内存）
    this.restored = false
  }

  /**
   * 把会话当前快照覆盖写入 `subagent_session`（失败只告警）。
   *
   * 为什么覆盖式而不是事件式：事件流/消息历史本来就在内存中累积，单会话体量很小；
   * 一轮结束时整行写一次即可，避免每个 chunk 一次 DB 写。持久化失败不能影响会话运行。
   */
  private persist(record: SessionRecord): void {
    const messages = record.messages.map((message) => ({
      role: message._getType?.() === 'human' ? 'human' : 'ai',
      content: typeof message.content === 'string' ? message.content : ''
    }))
    void upsertSubagentSession({
      id: record.id,
      topic_id: record.topicId,
      name: record.config.name,
      label: record.label,
      prompt: record.prompt,
      config: JSON.stringify(record.config),
      messages: JSON.stringify(messages),
      conversation: JSON.stringify(record.conversation),
      conversation_seq: record.conversationSeq,
      turn_counter: record.turnCounter,
      last_status: record.lastStatus ?? null,
      last_output: record.lastOutput || null,
      inbox: record.inbox.length > 0 ? JSON.stringify(record.inbox) : null,
      last_run_at: record.lastRunAt ? new Date(record.lastRunAt).toISOString() : null,
      main_model_provider_id: record.mainModelDescriptor?.providerId ?? null,
      main_model_name: record.mainModelDescriptor?.model ?? null,
      usage_input_tokens: record.usageInputTokens,
      usage_output_tokens: record.usageOutputTokens,
      usage_total_tokens: record.usageTotalTokens,
      usage_calls: record.usageCalls
    }).catch((err) => logger.warn('[SubagentSessions] Failed to persist session snapshot:', err))
  }

  /**
   * 从数据库恢复历史会话（应用启动 / 账号切换后调用一次）。
   *
   * 恢复出来的会话标记为 `inactive`：事件流/消息历史只读可看，且**不立即重建 runtime**
   * （冷恢复是惰性的）；第一次 send/续聊时才按持久化快照重建模型/工具/prompt 并转回 idle，
   * 避免启动时把所有历史会话的模型/工具都构建一遍。
   */
  async restorePersistedSessions(): Promise<void> {
    if (this.restored) return
    this.restored = true
    try {
      const rows = await listSubagentSessions()
      const touchedTopics = new Set<number>()
      let count = 0
      for (const row of rows) {
        if (this.sessions.has(row.id)) continue
        const config = parseJson<SubAgentConfig>(row.config)
        if (!config || typeof config.name !== 'string' || typeof config.systemPrompt !== 'string') {
          continue
        }
        const messages = parseJsonArray<{ role?: string; content?: string }>(row.messages).map(
          (item) =>
            item.role === 'human'
              ? new HumanMessage(item.content ?? '')
              : new AIMessage({ content: item.content ?? '' })
        )
        const conversation = parseJsonArray<SubagentConversationEvent>(row.conversation).filter(
          (event) =>
            !!event &&
            typeof event === 'object' &&
            typeof (event as { seq?: unknown }).seq === 'number' &&
            typeof (event as { kind?: unknown }).kind === 'string'
        )
        const createdAt = row.created_at ? Date.parse(row.created_at) : Date.now()
        const lastRunAt = row.last_run_at ? Date.parse(row.last_run_at) : undefined
        const lastStatus =
          row.last_status === 'completed' ||
          row.last_status === 'failed' ||
          row.last_status === 'killed'
            ? row.last_status
            : undefined
        const mainModelDescriptor: SubAgentMainModelDescriptor | undefined =
          row.main_model_provider_id != null && row.main_model_name
            ? { providerId: row.main_model_provider_id, model: row.main_model_name }
            : undefined
        const record: SessionRecord = {
          id: row.id,
          topicId: row.topic_id,
          config,
          mainModelDescriptor,
          label: row.label,
          prompt: row.prompt,
          messages,
          inbox: parseJsonArray<string>(row.inbox).filter((item) => typeof item === 'string'),
          status: 'inactive',
          usageInputTokens: row.usage_input_tokens,
          usageOutputTokens: row.usage_output_tokens,
          usageTotalTokens: row.usage_total_tokens,
          usageCalls: row.usage_calls,
          createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
          lastRunAt,
          lastStatus,
          lastOutput: row.last_output ?? '',
          turnCounter: row.turn_counter,
          conversationSeq: row.conversation_seq,
          conversation
        }
        this.sessions.set(row.id, record)
        touchedTopics.add(row.topic_id)
        count += 1
      }
      for (const topicId of touchedTopics) this.broadcast(topicId)
      if (count > 0) {
        logger.info(`[SubagentSessions] Restored ${count} persisted session(s) as inactive`)
      }
    } catch (err) {
      this.restored = false
      logger.warn('[SubagentSessions] Failed to restore persisted sessions:', err)
    }
  }

  /** 追加一条会话事件（seq 单调递增，IPC 层据此去重/续接） */
  private emitConversation(record: SessionRecord, event: SubagentConversationEventInput): void {
    record.conversationSeq += 1
    const full = { ...event, seq: record.conversationSeq } as SubagentConversationEvent
    record.conversation.push(full)
    this.trimConversation(record)
    this.onConversationEvent?.(record.topicId, record.id, full)
  }

  /**
   * 事件流按整轮裁剪：渲染层重放依赖 turn_start → chunk → turn_end，不能从 chunk 中间截断，
   * 所以丢弃最旧的完整轮次直到回到上限内（当前轮本身超限时保留，避免整轮消失）。
   */
  private trimConversation(record: SessionRecord): void {
    while (record.conversation.length > MAX_CONVERSATION_EVENTS) {
      let cut = 0
      for (let i = 1; i < record.conversation.length; i++) {
        if (record.conversation[i].kind === 'turn_start') {
          cut = i
          break
        }
      }
      if (cut === 0) return
      record.conversation.splice(0, cut)
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
   *
   * 2026-11-26：同时把这一轮的流式 chunk 记成会话事件流（见 subagent-conversation），
   * 供主对话区右上角「后台子代理」入口打开后实时查看。chunk 的生产复用主对话的
   * stream-producers——增量形态、工具卡投影、执行/完成生命周期与主对话完全同源。
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

    // 本轮会话事件：用户消息 + 助手流（渲染层重放后就是与主对话同款的会话视图）
    record.turnCounter += 1
    const turnId = `turn-${record.turnCounter}`
    const startedAt = Date.now()
    this.emitConversation(record, { kind: 'turn_start', turnId, prompt: message, startedAt })

    // 注册同名后台任务（job id = 会话 id；settlement first-wins）
    const job = jobsRegistry.start(record.topicId, 'subagent', record.label, record.id)
    jobsRegistry.attachCancel(record.id, () => record.currentAbort?.abort())
    const abortSignal = record.currentAbort.signal

    /** 本轮是否还在收集 chunk：中止/异常结算后，迟到的工具结果不再写进已结束的轮次 */
    const collecting = { value: true }
    let fullText = ''
    /** 本轮真实用量（每次模型调用一条；结算时累加进会话总用量并持久化） */
    const usageRecords: ModelUsageRecord[] = []
    let turnStatus: SubagentTurnStatus = 'completed'
    let turnNote: string | undefined
    let queue: RecordQueue | undefined

    /**
     * 一路结构化 chunk：写入会话事件流 + 同名后台任务输出。
     *
     * 任务输出（job_output）的契约保持不变：正文增量 + 每个工具调用一行；父代理仍按
     * job_output 观察子代理。会话视图则拿到与主对话完全同构的 chunk（含工具卡数据）。
     */
    const enqueue = (chunk: StructuredMessage): void => {
      if (!collecting.value) return
      this.emitConversation(record, { kind: 'chunk', turnId, chunk })
      if (chunk.content) {
        fullText += chunk.content
        job.appendOutput(chunk.content)
      }
      if (chunk.tool && chunk.tool.status === 'executing') {
        const inputText = JSON.stringify(chunk.tool.input ?? {}).slice(0, 200)
        job.appendOutput(
          mainFormat(m.subagentSessions.toolCallLine, { name: chunk.tool.name, input: inputText })
        )
      }
      // IPC 层消费（节流推送会话视图），仅在有关注者时才有成本
    }

    /** 读工具结果：中断时把 AbortError 规范化（与主对话同款约定） */
    const safeGetOutput = async (call: { output: unknown }): Promise<unknown> => {
      try {
        return await call.output
      } catch (err) {
        if (abortSignal.aborted) {
          const abortErr = new Error('Tool call aborted')
          abortErr.name = 'AbortError'
          throw abortErr
        }
        throw err
      }
    }

    try {
      const sa = record.config
      const model = (await rt.resolveModel(sa.model)) ?? rt.mainModel
      const tools = rt.buildTools(sa)
      const systemPrompt = rt.extendSystemPrompt(sa)

      // 记录队列 + 三路生产者：把 RuntimeRecord 转成与主对话同构的 StructuredMessage
      queue = new RecordQueue()
      const queueRef: QueueRef = { current: queue }
      const graph = buildAgentGraph({
        model,
        tools,
        systemPrompt,
        queue: queueRef,
        spill: rt.spillRef?.current,
        maxToolCalls: rt.maxToolCalls,
        // 真实用量：子代理图与主图共用 callModel，同样的 usageSink 采集口径
        usageSink: { push: (record) => usageRecords.push(record) }
      })

      const run: RuntimeStream = {
        messages: queue.iterateMessages(),
        toolCalls: queue.iterateToolCalls(),
        subagents: queue.iterateSubAgents()
      }
      const markDone = (): void => {}
      const msgProducer = produceMessages(run, abortSignal, enqueue, markDone).catch(() => {})
      const toolProducer = produceToolCalls(
        run,
        abortSignal,
        enqueue,
        markDone,
        safeGetOutput,
        undefined,
        record.topicId
      ).catch(() => {})
      const subAgentProducer = produceSubAgents(
        run,
        abortSignal,
        enqueue,
        markDone,
        safeGetOutput,
        record.topicId
      ).catch(() => {})

      // 会话输入：历史 + 本轮消息
      const input = [...record.messages, new HumanMessage(message)]
      const seenIndexes = new Set<number>()
      const stream = await graph.stream(
        { messages: input },
        {
          streamMode: ['messages'] as const,
          recursionLimit: rt.recursionLimit,
          signal: abortSignal,
          // 团队身份：本会话就是 team board 上的 member（任务认领/更新记到会话 id 上）
          configurable: {
            topicId: record.topicId,
            teamAgent: {
              id: record.id,
              name:
                record.config.rename && record.config.rename !== record.config.name
                  ? record.config.rename
                  : record.config.name,
              isLead: false
            }
          }
        }
      )
      for await (const item of stream) {
        if (abortSignal.aborted) break
        const [, payload] = item as readonly [string, [StreamMessageLike, unknown]]
        const chunk = payload[0]
        const chunkType = chunk._getType?.()
        if (chunkType && chunkType !== 'ai') continue
        // 模型 chunk 转成运行时记录（会话视图与后台任务输出同源）
        // 会话视图拿不到任何流式内容；这里补上主对话同源的转换。
        pushMessageRecords(chunk, queue, seenIndexes)
      }
      queue.close()
      await Promise.allSettled([msgProducer, toolProducer, subAgentProducer])

      if (abortSignal.aborted) {
        turnStatus = 'killed'
        turnNote = m.subagentSessions.interrupted
        const partial = fullText.trim()
        record.messages.push(new HumanMessage(message))
        if (partial) record.messages.push(new AIMessage({ content: partial }))
        record.lastStatus = 'killed'
        record.lastOutput = partial
          ? `${partial}\n${m.subagentSessions.interrupted}`
          : m.subagentSessions.interrupted
        job.settle('killed', record.lastOutput, 'interrupted')
        return
      }
      const output = fullText.trim() || m.subagent.noTextOutput
      if (!fullText.trim()) turnNote = m.subagent.noTextOutput
      record.messages.push(new HumanMessage(message))
      record.messages.push(new AIMessage({ content: output }))
      record.lastStatus = 'completed'
      record.lastOutput = output
      job.settle('completed', output)
    } catch (err) {
      // 中断（interrupt_agent/job_kill）在流式中途会以 AbortError 抛出——结算为 killed
      // 而非 failed（修复：此前落入 failed 分支，英文中止错误文案混进历史且状态语义错误）
      if (abortSignal.aborted) {
        turnStatus = 'killed'
        turnNote = m.subagentSessions.interrupted
        const partial = fullText.trim()
        record.messages.push(new HumanMessage(message))
        if (partial) record.messages.push(new AIMessage({ content: partial }))
        record.lastStatus = 'killed'
        record.lastOutput = partial
          ? `${partial}\n${m.subagentSessions.interrupted}`
          : m.subagentSessions.interrupted
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
      logger.warn(`[SubagentSession] ${record.id} failed to run:`, err)
      const partial = fullText.trim()
      const failureNote = mainFormat(m.subagentSessions.runFailed, { message: messageText })
      turnStatus = 'failed'
      turnNote = failureNote
      record.messages.push(new HumanMessage(message))
      if (partial) record.messages.push(new AIMessage({ content: partial }))
      record.lastStatus = 'failed'
      record.lastOutput = partial ? `${partial}\n${failureNote}` : failureNote
      job.settle('failed', record.lastOutput, messageText)
    } finally {
      collecting.value = false
      // 中止/异常路径下生产者可能还挂在队列迭代器上：关队列让它们收尾（不阻塞结算）
      try {
        queue?.close()
      } catch {
        /* 队列已关闭：忽略 */
      }
      record.lastRunAt = Date.now()
      record.currentAbort = undefined
      // 会话视图本轮结束：渲染层收流并把最后一条助手消息定格（失败/中断附说明）
      this.emitConversation(record, {
        kind: 'turn_end',
        turnId,
        status: turnStatus,
        finishedAt: Date.now(),
        note: turnNote
      })
      record.status = 'idle'
      // 本轮真实用量累加进会话总量（失败/中断轮也保留已发生的模型调用）
      const turnUsage = sumUsage(usageRecords)
      record.usageInputTokens += turnUsage.inputTokens
      record.usageOutputTokens += turnUsage.outputTokens
      record.usageTotalTokens += turnUsage.totalTokens
      record.usageCalls += turnUsage.calls
      this.broadcast(record.topicId)
      // 一轮结束落一次快照：恢复后能回放完整历史 + 终态 + 累计用量
      this.persist(record)

      // 话题已删除（clearTopic 置位 dead）：不再续跑收件箱（僵尸会话闭包仍逐条跑完
      // 收件箱、并在已删除话题下注册不可管理的幽灵任务——已修复）
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
          const { messageId } = await registry.send(subagent_id, topicId, message)
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
