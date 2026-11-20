import type { RuntimeRecord } from './types'
import type { SubAgentToolContext } from './agent'

/**
 * 模型流式 chunk → 运行时记录 的转换（独立模块，供测试脚本直接验证框架处理行为）。
 *
 * 模型工具调用两阶段语义：
 *   阶段一：模型吐出工具名（tool_call_chunks 首个 delta，含 name/id）→ tool_block_start
 *   阶段二：模型为每个工具生成参数（后续 delta 的 args 片段）→ tool_args（节流保活）
 * 非流式 provider 一次性给出完整 tool_calls 时走 fullCalls 兜底分支。
 */

/** 轻量消息块接口：流式 chunk（AIMessageChunk）的兼容形状 */
export interface StreamMessageLike {
  content?: unknown
  additional_kwargs?: Record<string, unknown>
  tool_call_chunks?: Array<{ index?: number; name?: string; id?: string; args?: string }>
  tool_calls?: Array<{ name?: string; id?: string; args?: unknown }>
  /** chunk 类型（'ai' / 'tool' / ...），用于过滤非模型消息 */
  _getType?: () => string
}

/** 将模型 chunk 转换为消息流记录（推理/文本/工具块） */
export function pushMessageRecords(
  chunk: StreamMessageLike,
  queue: { push(record: RuntimeRecord): void },
  seenIndexes: Set<number>,
  subagentCtx?: SubAgentToolContext
): void {
  // 只处理 AI 消息 chunk：messages 模式下工具结果（ToolMessage）等也会以 chunk 流出，需过滤
  const chunkType = chunk._getType?.()
  if (chunkType && chunkType !== 'ai') return

  const kwargs = (chunk.additional_kwargs ?? {}) as Record<string, unknown>
  const reasoning = kwargs.reasoning_content ?? kwargs.reasoning
  if (typeof reasoning === 'string' && reasoning) {
    pushRecord(queue, { kind: 'reasoning', text: reasoning }, subagentCtx)
  }

  // 文本内容（字符串或多模态内容块中的文本部分）
  const content = chunk.content
  if (typeof content === 'string' && content) {
    pushRecord(queue, { kind: 'text', text: content }, subagentCtx)
  } else if (Array.isArray(content)) {
    const text = (content as Array<{ type?: string; text?: string }>)
      .filter((c) => c && c.type === 'text')
      .map((c) => c.text || '')
      .join('')
    if (text) {
      pushRecord(queue, { kind: 'text', text }, subagentCtx)
    }
  }

  // 工具调用增量（流式）
  const toolCallChunks = chunk.tool_call_chunks
  if (Array.isArray(toolCallChunks)) {
    for (const tc of toolCallChunks) {
      if (tc.index == null) continue
      if (!seenIndexes.has(tc.index)) {
        seenIndexes.add(tc.index)
        pushRecord(
          queue,
          { kind: 'tool_block_start', index: tc.index, name: tc.name || 'tool', id: tc.id },
          subagentCtx
        )
      } else if (tc.args) {
        pushRecord(queue, { kind: 'tool_args', index: tc.index }, subagentCtx)
      }
    }
  }

  // 完整工具调用（非流式形态，部分 provider 一次给全）。
  // 仅当尚未通过增量块登记任何工具时处理，避免与 tool_call_chunks 重复。
  const fullCalls = chunk.tool_calls
  if (Array.isArray(fullCalls) && fullCalls.length > 0 && seenIndexes.size === 0) {
    for (const tc of fullCalls) {
      if (!tc.name) continue
      const index = seenIndexes.size
      seenIndexes.add(index)
      pushRecord(queue, { kind: 'tool_block_start', index, name: tc.name, id: tc.id }, subagentCtx)
    }
  }
}

/** 按上下文推送记录（主代理直推；子代理包一层 sub_* 记录） */
export function pushRecord(
  queue: { push(record: RuntimeRecord): void } | ((record: RuntimeRecord) => void),
  record: RuntimeRecord,
  subagentCtx?: SubAgentToolContext
): void {
  const doPush = typeof queue === 'function' ? queue : (r: RuntimeRecord) => queue.push(r)
  if (!subagentCtx) {
    doPush(record)
    return
  }
  const { name, causeId } = subagentCtx
  if (record.kind === 'reasoning') {
    doPush({ kind: 'sub_reasoning', name, causeId, text: record.text })
  } else if (record.kind === 'text') {
    doPush({ kind: 'sub_text', name, causeId, text: record.text })
  } else if (record.kind === 'tool_call') {
    doPush({ kind: 'sub_tool_call', name, causeId, tool: record })
  } else if (record.kind === 'tool_block_start') {
    // 阶段一：子代理工具名已知 → 前端嵌套工具卡「参数构建中…」（与主代理同款两阶段展示）
    doPush({
      kind: 'sub_tool_block_start',
      name,
      causeId,
      index: record.index,
      toolName: record.name,
      id: record.id
    })
  } else if (record.kind === 'tool_args') {
    // 阶段二：子代理工具参数增量（节流保活）
    doPush({ kind: 'sub_tool_args', name, causeId, index: record.index })
  }
}
