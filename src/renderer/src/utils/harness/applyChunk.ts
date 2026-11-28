import type { MessageBlock, StreamChunk, ToolCall } from '../../../../shared/harness/types'
import type { Message } from '../../types/harness/types'
import {
  computeTextDelta,
  findPlaceholderPreparingTool,
  isSameToolCall,
  pushBlock
} from './harnessHelpers'

/**
 * Apply one streaming chunk to the assistant message with the given id and return a shallow copy
 * of the updated messages.
 *
 * This is the **single merge semantic shared** by the main conversation and the background
 * subagent conversation view (extracted from useHarnessHandlers into a standalone pure function on
 * 2026-11-26): text/reasoning deltas, tools going preparing → executing → completed, nested
 * subagent blocks, and retry/compaction transition blocks are all merged here. The subagent
 * conversation view reuses the same StructuredMessage chunks sent by the main process, so its
 * rendering is pixel-identical to the main conversation.
 *
 * @param activeCauseIds Set of "currently running subagent causeIds" for the current topic (the
 *   task tool's subagent blocks use it to fold running events into the same nested block; sessions
 *   without subagents can pass an empty Set)
 */
export function applyChunkToMessages(
  msgs: Message[],
  aiMessageId: string,
  chunk: StreamChunk,
  activeCauseIds: Set<string>
): Message[] {
  return msgs.map((msg) => {
    if (msg.id !== aiMessageId) return msg

    const updatedReasoning = chunk.reasoning_content
      ? msg.reasoning_content && String(chunk.reasoning_content).startsWith(msg.reasoning_content)
        ? String(chunk.reasoning_content)
        : msg.reasoning_content && msg.reasoning_content.endsWith(String(chunk.reasoning_content))
          ? msg.reasoning_content
          : (msg.reasoning_content || '') + chunk.reasoning_content
      : msg.reasoning_content

    const updatedContent = chunk.content
      ? msg.content && chunk.content.startsWith(msg.content)
        ? chunk.content
        : msg.content + chunk.content
      : msg.content

    let updatedToolCalls = msg.toolCalls || []
    if (chunk.tool) {
      const existingIndex = updatedToolCalls.findIndex((tc) =>
        isSameToolCall(tc, chunk.tool as ToolCall)
      )
      if (existingIndex >= 0) {
        updatedToolCalls = [
          ...updatedToolCalls.slice(0, existingIndex),
          chunk.tool as ToolCall,
          ...updatedToolCalls.slice(existingIndex + 1)
        ]
      } else {
        updatedToolCalls = [...updatedToolCalls, chunk.tool as ToolCall]
      }
    }
    let updatedBlocks = [...msg.blocks]

    // The "retrying" transition block only shows while the request has not recovered: once real
    // content/tools/agents/compaction results arrive, the retry has succeeded and the model is
    // emitting normally, so remove the transition block immediately
    const retryFinished =
      Boolean(chunk.content) ||
      Boolean(chunk.reasoning_content) ||
      Boolean(chunk.tool) ||
      Boolean(chunk.subAgent) ||
      Boolean(chunk.historyCompacted)
    if (retryFinished) {
      updatedBlocks = updatedBlocks.filter((b) => b.type !== 'retrying')
    }
    // When summary compaction fails/is abandoned (no historyCompacted result at all), collapse the
    // leftover "compacting early conversation…" transition card once text starts (so the card does
    // not sit alongside the body and mislead)
    if (retryFinished && !updatedBlocks.some((b) => b.type === 'historyCompacted')) {
      updatedBlocks = updatedBlocks.filter((b) => b.type !== 'historyCompacting')
    }

    // After a single failed model request, retry at the original call site (no full-turn rerun):
    // insert a "retrying" transition row and keep only the latest attempt's progress; already
    // emitted content and tool blocks are preserved (a retry does not invalidate them)
    if (chunk.retrying) {
      updatedBlocks = updatedBlocks.filter((b) => b.type !== 'retrying')
      updatedBlocks.push({
        type: 'retrying',
        retrying: { attempt: chunk.retrying.attempt, retries: chunk.retrying.retries }
      })
    }

    // Hot memory injection for this turn: placed at the very top of the message blocks (inserted
    // once when the first chunk arrives)
    if (chunk.memoryInjected) {
      const exists = updatedBlocks.some((b) => b.type === 'memoryInjected')
      if (!exists) {
        updatedBlocks.unshift({
          type: 'memoryInjected',
          memory: {
            user: chunk.memoryInjected.user,
            memory: chunk.memoryInjected.memory,
            usage: chunk.memoryInjected.usage
          }
        })
      }
    }

    // Summary compaction starts: insert a "compacting" transition block (shown only for the
    // current turn, not persisted; replaced in place when the result block arrives, hidden when
    // the message ends if compaction fails)
    if (chunk.historyCompacting) {
      const exists = updatedBlocks.some(
        (b) => b.type === 'historyCompacting' || b.type === 'historyCompacted'
      )
      if (!exists) {
        updatedBlocks.push({ type: 'historyCompacting' })
      }
    }

    // Early conversation summary compaction for this turn: follows the memory injection block
    // (arrives before the text stream starts, inserted once)
    if (chunk.historyCompacted) {
      const compacted = {
        type: 'historyCompacted' as const,
        compaction: {
          compressedCount: chunk.historyCompacted.compressedCount,
          retainedCount: chunk.historyCompacted.retainedCount,
          boundaryId: chunk.historyCompacted.boundaryId
        }
      }
      // Replace the "compacting" transition block in place (keeps the card position stable)
      const compactingIdx = updatedBlocks.findIndex((b) => b.type === 'historyCompacting')
      if (compactingIdx >= 0) {
        updatedBlocks[compactingIdx] = compacted
      } else if (!updatedBlocks.some((b) => b.type === 'historyCompacted')) {
        updatedBlocks.push(compacted)
      }
    }

    if (chunk.reasoning_content) {
      const reasoningDelta = computeTextDelta(
        String(chunk.reasoning_content),
        msg.reasoning_content || ''
      )
      if (reasoningDelta) {
        const lastBlock = updatedBlocks[updatedBlocks.length - 1]
        if (lastBlock?.type === 'reasoning') {
          updatedBlocks[updatedBlocks.length - 1] = {
            type: 'reasoning',
            reasoning: (lastBlock.reasoning || '') + reasoningDelta
          }
        } else {
          pushBlock(updatedBlocks, { type: 'reasoning', reasoning: reasoningDelta })
        }
      }
    }

    if (chunk.content) {
      const contentDelta = computeTextDelta(String(chunk.content), msg.content || '')
      if (contentDelta) {
        const lastBlock = updatedBlocks[updatedBlocks.length - 1]
        if (lastBlock?.type === 'text') {
          updatedBlocks[updatedBlocks.length - 1] = {
            type: 'text',
            text: (lastBlock.text || '') + contentDelta
          }
        } else {
          pushBlock(updatedBlocks, { type: 'text', text: contentDelta })
        }
      }
    }

    if (chunk.tool) {
      if (chunk.tool.name !== 'task') {
        if (chunk.tool.status === 'completed') {
          for (let i = updatedBlocks.length - 1; i >= 0; i--) {
            const b = updatedBlocks[i]
            if (
              b.type === 'tool' &&
              b.tool &&
              b.tool.status !== 'completed' &&
              isSameToolCall(b.tool, chunk.tool)
            ) {
              updatedBlocks[i] = {
                type: 'tool',
                tool: {
                  ...b.tool,
                  output: chunk.tool.output,
                  status: chunk.tool.status,
                  card: chunk.tool.card
                }
              }
              break
            }
          }
        } else if (chunk.tool.status === 'preparing') {
          const exists = updatedBlocks.some(
            (b) => b.type === 'tool' && isSameToolCall(b.tool as ToolCall, chunk.tool as ToolCall)
          )
          if (!exists) {
            const blockTool = {
              name: chunk.tool.name,
              input: {},
              output: '',
              status: 'preparing' as const,
              id: chunk.tool.id
            }
            pushBlock(updatedBlocks, { type: 'tool', tool: blockTool })
          }
        } else {
          let merged = false
          for (let i = updatedBlocks.length - 1; i >= 0; i--) {
            const b = updatedBlocks[i]
            if (
              b.type === 'tool' &&
              b.tool?.status === 'preparing' &&
              isSameToolCall(b.tool, chunk.tool)
            ) {
              updatedBlocks[i] = {
                type: 'tool',
                tool: {
                  name: chunk.tool.name,
                  input: chunk.tool.input,
                  output: '',
                  status: 'executing',
                  id: b.tool.id ?? chunk.tool.id
                }
              }
              merged = true
              break
            }
          }
          // Defensive: some providers' first tool block carries no tool name (registered under the
          // placeholder name 'tool') — when no preparing block matches by name, merge into the
          // nearest placeholder block and rename it to the real tool name, so the ghost
          // "tool · building args…" block does not coexist with the real tool block
          if (!merged) {
            const placeholderIdx = findPlaceholderPreparingTool(updatedBlocks)
            if (placeholderIdx >= 0) {
              const b = updatedBlocks[placeholderIdx]
              if (b.type === 'tool' && b.tool) {
                updatedBlocks[placeholderIdx] = {
                  type: 'tool',
                  tool: {
                    name: chunk.tool.name,
                    input: chunk.tool.input,
                    output: '',
                    status: 'executing',
                    id: b.tool.id ?? chunk.tool.id
                  }
                }
                merged = true
              }
            }
          }
          if (!merged) {
            const blockTool = {
              name: chunk.tool.name,
              input: chunk.tool.input,
              output: chunk.tool.output,
              status: (chunk.tool.status || 'executing') as ToolCall['status'],
              id: chunk.tool.id
            }
            pushBlock(updatedBlocks, { type: 'tool', tool: blockTool })
          }
        }
      }
    }

    if (chunk.subAgent) {
      const sa = chunk.subAgent

      const findSaBlock = (): number => {
        for (let i = updatedBlocks.length - 1; i >= 0; i--) {
          const block = updatedBlocks[i]
          if (block.type !== 'subAgent' || !block.subAgent) continue
          if (sa.causeId && block.subAgent.causeId && block.subAgent.causeId === sa.causeId) {
            return i
          }
          if (block.subAgent.name === sa.name && (!sa.causeId || !block.subAgent.causeId)) {
            return i
          }
        }
        return -1
      }

      if (sa.status === 'started') {
        const idx = findSaBlock()
        if (idx < 0) {
          pushBlock(updatedBlocks, {
            type: 'subAgent',
            subAgent: {
              name: sa.name,
              causeId: sa.causeId,
              status: 'started',
              taskDescription: sa.taskDescription
            },
            children: []
          })
        } else {
          // Copy then update: never rewrite the subAgent object shared with the previous state
          // (in-place mutation of shared objects during render/update risks text duplication;
          // always use immutable replacement)
          const existing = updatedBlocks[idx]
          const prevSa = existing.subAgent!
          updatedBlocks[idx] = {
            ...existing,
            subAgent: {
              ...prevSa,
              status: 'started',
              taskDescription: prevSa.taskDescription || sa.taskDescription
            }
          }
        }
        if (sa.causeId) {
          activeCauseIds.add(sa.causeId)
        }
      } else if (sa.status === 'dispatched') {
        // Lightweight background-dispatch card: fixed at "dispatched", with name + summary +
        // conversation id only (results are viewed in the top bar)
        const idx = findSaBlock()
        if (idx < 0) {
          pushBlock(updatedBlocks, {
            type: 'subAgent',
            subAgent: {
              name: sa.name,
              causeId: sa.causeId,
              status: 'dispatched',
              taskDescription: sa.taskDescription,
              subagentId: sa.subagentId
            },
            children: []
          })
        } else {
          const existing = updatedBlocks[idx]
          const prevSa = existing.subAgent!
          updatedBlocks[idx] = {
            ...existing,
            subAgent: {
              ...prevSa,
              status: 'dispatched',
              taskDescription: prevSa.taskDescription || sa.taskDescription,
              subagentId: sa.subagentId ?? prevSa.subagentId
            }
          }
        }
      } else if (sa.status === 'completed' || sa.status === 'error') {
        const idx = findSaBlock()
        if (idx >= 0) {
          const existing = updatedBlocks[idx]
          const prevSa = existing.subAgent!
          updatedBlocks[idx] = {
            ...existing,
            subAgent: {
              ...prevSa,
              status: sa.status,
              output: sa.output ?? prevSa.output,
              error: sa.error ?? prevSa.error,
              taskDescription: prevSa.taskDescription || sa.taskDescription
            }
          }
        }
        if (sa.causeId) {
          activeCauseIds.delete(sa.causeId)
        }
      } else if (sa.content || sa.reasoning_content || sa.tool) {
        const idx = findSaBlock()
        let block: MessageBlock
        if (idx >= 0) {
          // Copy into a new block, then update in place: the new block owns its subAgent object and
          // children array, so later writes to block.subAgent/block.children do not pollute objects
          // shared with the previous state
          const existing = updatedBlocks[idx]
          block = {
            ...existing,
            subAgent: { ...existing.subAgent! },
            children: existing.children ? [...existing.children] : []
          }
          updatedBlocks[idx] = block
        } else {
          block = {
            type: 'subAgent',
            subAgent: {
              name: sa.name,
              causeId: sa.causeId,
              status: 'running',
              taskDescription: sa.taskDescription
            },
            children: []
          }
          pushBlock(updatedBlocks, block)
        }
        if (block.subAgent!.status !== 'completed' && block.subAgent!.status !== 'error') {
          block.subAgent!.status = 'running'
        }
        block.subAgent!.taskDescription = block.subAgent!.taskDescription || sa.taskDescription
        if (!block.children) block.children = []

        if (sa.reasoning_content) {
          const totalPrevReasoning = block.children
            .filter((c) => c.type === 'reasoning')
            .map((c) => c.reasoning || '')
            .join('')
          const reasoningDelta = computeTextDelta(String(sa.reasoning_content), totalPrevReasoning)
          if (reasoningDelta) {
            const lastChild = block.children[block.children.length - 1]
            if (lastChild?.type === 'reasoning') {
              block.children[block.children.length - 1] = {
                type: 'reasoning',
                reasoning: (lastChild.reasoning || '') + reasoningDelta
              }
            } else {
              pushBlock(block.children, { type: 'reasoning', reasoning: reasoningDelta })
            }
          }
        }

        if (sa.content) {
          const totalPrevText = block.children
            .filter((c) => c.type === 'text')
            .map((c) => c.text || '')
            .join('')
          const contentDelta = computeTextDelta(String(sa.content), totalPrevText)
          if (contentDelta) {
            const lastChild = block.children[block.children.length - 1]
            if (lastChild?.type === 'text') {
              block.children[block.children.length - 1] = {
                type: 'text',
                text: (lastChild.text || '') + contentDelta
              }
            } else {
              pushBlock(block.children, { type: 'text', text: contentDelta })
            }
          }
        }

        if (sa.tool) {
          if (sa.tool.name !== 'task') {
            if (sa.tool.status === 'completed') {
              for (let i = block.children.length - 1; i >= 0; i--) {
                const c = block.children[i]
                if (
                  c.type === 'tool' &&
                  c.tool &&
                  c.tool.status !== 'completed' &&
                  isSameToolCall(c.tool, sa.tool)
                ) {
                  block.children[i] = {
                    type: 'tool',
                    tool: {
                      ...c.tool,
                      output: sa.tool.output,
                      status: sa.tool.status,
                      card: sa.tool.card
                    }
                  }
                  break
                }
              }
            } else if (sa.tool.status === 'preparing') {
              const exists = block.children.some(
                (c) => c.type === 'tool' && isSameToolCall(c.tool as ToolCall, sa.tool as ToolCall)
              )
              if (!exists) {
                pushBlock(block.children, {
                  type: 'tool',
                  tool: {
                    name: sa.tool.name,
                    input: {},
                    output: '',
                    status: 'preparing',
                    id: sa.tool.id
                  }
                })
              }
            } else {
              let merged = false
              for (let i = block.children.length - 1; i >= 0; i--) {
                const c = block.children[i]
                if (
                  c.type === 'tool' &&
                  c.tool?.status === 'preparing' &&
                  isSameToolCall(c.tool, sa.tool)
                ) {
                  block.children[i] = {
                    type: 'tool',
                    tool: {
                      name: sa.tool.name,
                      input: sa.tool.input,
                      output: '',
                      status: 'executing',
                      id: c.tool.id ?? sa.tool.id
                    }
                  }
                  merged = true
                  break
                }
              }
              // Defensive: some providers' first tool block carries no tool name (registered under
              // the placeholder name 'tool') — when no preparing block matches by name, merge into
              // the nearest placeholder block and rename it to the real tool name
              if (!merged) {
                const placeholderIdx = findPlaceholderPreparingTool(block.children)
                if (placeholderIdx >= 0) {
                  const c = block.children[placeholderIdx]
                  if (c.type === 'tool' && c.tool) {
                    block.children[placeholderIdx] = {
                      type: 'tool',
                      tool: {
                        name: sa.tool.name,
                        input: sa.tool.input,
                        output: '',
                        status: 'executing',
                        id: c.tool.id ?? sa.tool.id
                      }
                    }
                    merged = true
                  }
                }
              }
              if (!merged) {
                pushBlock(block.children, {
                  type: 'tool',
                  tool: {
                    name: sa.tool.name,
                    input: sa.tool.input,
                    output: sa.tool.output,
                    status: (sa.tool.status || 'executing') as ToolCall['status'],
                    id: sa.tool.id
                  }
                })
              }
            }
          }
        }
      }
    }

    /**
     * **Do not touch the fold layout while streaming** (user report, 2026-09-24: "content still
     * moves out of the fold and then back in a moment later"): the live `answer` flags the main
     * process sends with each chunk no longer drive layout — the boundary is not settled at that
     * point (the model may keep calling tools, and the sentence just written is then not the
     * answer), so pulling content out causes repeated back-and-forth between inside and outside
     * the fold.
     *
     * Layout is frozen once, on the done event, using the main process's authoritative conclusion:
     * outside the fold only the **final result text + the thinking immediately next to it**, with
     * everything else staying inside the task-segment fold (the segment before the first
     * write_todos has not been folded since 2026-09-25 and is always expanded).
     */
    return {
      ...msg,
      content: updatedContent,
      blocks: updatedBlocks,
      toolCalls: updatedToolCalls.length > 0 ? updatedToolCalls : undefined,
      reasoning_content: updatedReasoning,
      // Transient field: records the last chunk timestamp for the silence indicator
      // ("generating…") check
      lastChunkAt: Date.now()
    }
  })
}
