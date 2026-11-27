import type { StructuredMessage } from '../../services/harness/types'

/**
 * 后台子代理会话的「可查看会话」事件契约。
 *
 * 背景（用户 2026-11-26 口径）：右上角的后台子代理入口点开一个子代理后，主对话区
 * 要切换成这个子代理的**流式会话记录**（正文 / 思考 / 工具卡与主对话同款），并且能
 * 返回主智能体。已有实现只在会话结束时把纯文本 `lastOutput` 塞进弹窗，运行中什么都
 * 看不到——本模块把子代理每一轮的流式 chunk 记成事件流，交给渲染层用与主对话相同的
 * reducer 重放，从而得到完全一致的流式渲染。
 *
 * 设计要点：
 * - 事件流是**唯一真源**：主进程只追加事件（seq 单调递增），快照 = 全量事件 + 当前
 *   seq，渲染层按 seq 合并增量；不需要在主进程再维护一份 block 状态（避免与主对话
 *   的 block 合并逻辑出现第二套口径）。
 * - 事件里的 chunk 就是主对话的 `StructuredMessage`（content / reasoning_content /
 *   tool / retrying 子集），渲染层复用同一套 `applyChunkToMessages` reducer。
 * - 会话按 topicId 隔离；事件流快照持久化到 `subagent_session`（见 subagent-sessions），
 *   重启后恢复为 inactive 并可冷恢复续聊；打开会话时默认只返回最近若干轮，更早的
 *   轮次通过 history 通道按需加载（避免大历史会话一次性 IPC）。
 */

/** 一轮子代理运行的终态 */
export type SubagentTurnStatus = 'completed' | 'failed' | 'killed'

/** 一轮开始：追加一条用户消息 + 一条助手占位消息 */
export interface SubagentConversationTurnStart {
  kind: 'turn_start'
  seq: number
  /** 本轮 id（事件流内唯一，跨轮不重复） */
  turnId: string
  /** 本轮用户消息正文（首轮 = 派遣时的 prompt；后续 = send_message 内容） */
  prompt: string
  startedAt: number
}

/** 一轮内的流式 chunk（与主对话同构） */
export interface SubagentConversationChunk {
  kind: 'chunk'
  seq: number
  turnId: string
  chunk: StructuredMessage
}

/** 一轮结束：助手消息收流，标记终态 */
export interface SubagentConversationTurnEnd {
  kind: 'turn_end'
  seq: number
  turnId: string
  status: SubagentTurnStatus
  finishedAt: number
  /** 失败/中断时的补充说明（渲染层追加到正文末尾，便于排查） */
  note?: string
}

export type SubagentConversationEvent =
  SubagentConversationTurnStart | SubagentConversationChunk | SubagentConversationTurnEnd

/**
 * 追加事件时的入参（seq 由注册表统一分配）。
 *
 * 用显式联合而不是 `Omit<SubagentConversationEvent,'seq'>`：Omit 对联合类型不会
 * 分发，会丢判别字段。
 */
export type SubagentConversationEventInput =
  | Omit<SubagentConversationTurnStart, 'seq'>
  | Omit<SubagentConversationChunk, 'seq'>
  | Omit<SubagentConversationTurnEnd, 'seq'>

/**
 * 会话快照（打开子代理会话时拉一次）：
 * 渲染层把 events 重放一遍即可得到与主对话相同结构的 `Message[]`；seq 之后的增量
 * 由 `harness:harness-agent-conversation-updated` 事件补齐。
 */
export interface SubagentConversationSnapshot {
  topicId: number
  agentId: string
  name: string
  label: string
  /** 会话首轮任务指令（兼容旧 readOutput 的 prompt 字段） */
  prompt: string
  status: 'running' | 'idle' | 'inactive'
  lastStatus?: SubagentTurnStatus
  /** 运行中排队等待的用户消息条数（顶部栏面包屑展示） */
  queuedMessages: number
  /** 快照之前是否还有更早的轮次（会话视图顶部滚动加载） */
  hasOlder: boolean
  /** 已发出的最大事件序号；渲染层用它丢弃快照之前/重复的事件 */
  seq: number
  events: SubagentConversationEvent[]
}

/** 更早一页会话事件（滚动到顶部时按 beforeSeq 向前取，以 turn_start 为界） */
export interface SubagentConversationHistory {
  /** 比当前已加载首事件更早的一页事件（seq 升序） */
  events: SubagentConversationEvent[]
  /** 这一页之前是否还有更早的轮次 */
  hasOlder: boolean
}

/**
 * 从会话视图向子代理投递一条消息的结果。
 *
 * 语义与主代理的 `send_message` 工具完全一致（同一个 registry.send）：
 * - 会话空闲：立即开启新一轮（返回投递回执后 conversation 事件里会出现 turn_start）；
 * - 会话运行中：进入 FIFO 收件箱，当前轮结束后自动继续（视图用排队条数提示）。
 */
export interface SubagentPromptResult {
  ok: boolean
  /** 投递回执 id（ok=true 时存在） */
  messageId?: string
  /** 失败原因（会话不存在 / 话题已删等；ok=false 时存在） */
  error?: string
}
