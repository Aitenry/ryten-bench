import type { RuntimeRecord } from './types'
import type { SubAgentToolContext } from './agent'

/**
 * Model streaming chunk -> runtime record conversion (a separate module so test scripts can verify
 * the framework's handling directly).
 *
 * Two-phase tool-call semantics:
 *   Phase 1: the model emits the tool name (first delta of tool_call_chunks, with name/id) ->
 *   tool_block_start
 *   Phase 2: the model generates arguments for each tool (args fragments in later deltas) ->
 *   tool_args (throttled keep-alive)
 * Non-streaming providers that return complete tool_calls in one go take the fullCalls fallback
 * branch.
 */

/** Lightweight message-block interface: compatible shape of a streaming chunk (AIMessageChunk) */
export interface StreamMessageLike {
  content?: unknown
  additional_kwargs?: Record<string, unknown>
  tool_call_chunks?: Array<{ index?: number; name?: string; id?: string; args?: string }>
  tool_calls?: Array<{ name?: string; id?: string; args?: unknown }>
  /** chunk type ('ai' / 'tool' / ...), used to filter out non-model messages */
  _getType?: () => string
}

/** Convert a model chunk into message-stream records (reasoning/text/tool blocks) */
export function pushMessageRecords(
  chunk: StreamMessageLike,
  queue: { push(record: RuntimeRecord): void },
  seenIndexes: Set<number>,
  subagentCtx?: SubAgentToolContext
): void {
  // Only handle AI message chunks: in messages mode tool results (ToolMessage) etc. also stream out
  // as chunks and must be filtered
  const chunkType = chunk._getType?.()
  if (chunkType && chunkType !== 'ai') return

  const kwargs = (chunk.additional_kwargs ?? {}) as Record<string, unknown>
  const reasoning = kwargs.reasoning_content ?? kwargs.reasoning
  if (typeof reasoning === 'string' && reasoning) {
    pushRecord(queue, { kind: 'reasoning', text: reasoning }, subagentCtx)
  }

  // Text content (a string, or the text parts of multimodal content blocks)
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

  // Tool-call increments (streaming)
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

  // Complete tool calls (non-streaming shape; some providers return them all at once).
  // Only handled when no tool was registered through incremental chunks yet, to avoid duplicating
  // tool_call_chunks.
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

/** Push a record per context (main agent pushes directly; subagents wrap it in a sub_* record) */
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
    // Phase 1: subagent tool name known -> nested card shows "building arguments…" (same two-phase
    // display as the main agent)
    doPush({
      kind: 'sub_tool_block_start',
      name,
      causeId,
      index: record.index,
      toolName: record.name,
      id: record.id
    })
  } else if (record.kind === 'tool_args') {
    // Phase 2: subagent tool argument increments (throttled keep-alive)
    doPush({ kind: 'sub_tool_args', name, causeId, index: record.index })
  }
}
