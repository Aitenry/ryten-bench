/**
 * LangChain 运行时 — 流式事件契约
 *
 * 设计说明（对应 docs/proposal/04-详细设计.md）：
 * 运行时内部使用「单一事件队列 + 三路过滤迭代器」替代 deepagents 的 streamEvents(v3) 契约，
 * 保持现有 stream-producers 的消费模型（消息/工具/子代理三路并发）。
 */

/** 主代理消息流记录（文本 / 推理 / 工具块 / 模型请求重试进度） */
export type MessageRecord =
  | { kind: 'reasoning'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool_block_start'; index: number; name: string; id?: string }
  | { kind: 'tool_args'; index: number }
  | { kind: 'retry_attempt'; attempt: number; retries: number }

/** 工具调用记录（output 为 Promise，工具完成时解析为字符串） */
export interface ToolCallRecord {
  kind: 'tool_call'
  name: string
  input: Record<string, unknown>
  callId: string
  output: Promise<string>
}

/** 子代理流记录（causeId = 派遣该子代理的 task 工具调用 ID） */
export type SubAgentRecord =
  | { kind: 'sub_start'; name: string; causeId: string; description?: string }
  | { kind: 'sub_reasoning'; name: string; causeId: string; text: string }
  | { kind: 'sub_text'; name: string; causeId: string; text: string }
  | { kind: 'sub_tool_call'; name: string; causeId: string; tool: ToolCallRecord }
  | { kind: 'sub_end'; name: string; causeId: string; output: string }
  | {
      /** 阶段一：子代理模型吐出工具名（参数构建开始） */
      kind: 'sub_tool_block_start'
      name: string
      causeId: string
      index: number
      toolName: string
      id?: string
    }
  | {
      /** 阶段二：子代理工具参数增量（节流保活用） */
      kind: 'sub_tool_args'
      name: string
      causeId: string
      index: number
    }

/** 统一运行时事件（单一队列元素） */
export type RuntimeRecord = MessageRecord | ToolCallRecord | SubAgentRecord

/** 运行时三路流（与 stream-producers 的消费契约一一对应） */
export interface RuntimeStream {
  /** 主代理消息流：推理增量 / 文本增量 / 工具块开始 / 工具参数增量 */
  messages: AsyncIterable<MessageRecord>
  /** 主代理工具调用流：executing → completed 状态由输出 Promise 驱动 */
  toolCalls: AsyncIterable<ToolCallRecord>
  /** 子代理活动流 */
  subagents: AsyncIterable<SubAgentRecord>
  /** 图执行错误（执行失败时设置，供调用方透传到前端） */
  error?: Error
}
