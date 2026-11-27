import type { MessageBlock, StreamChunk, ToolCall } from '../../../../shared/harness/types'
import type { Message } from '../../types/harness/types'
import {
  computeTextDelta,
  findPlaceholderPreparingTool,
  isSameToolCall,
  pushBlock
} from './harnessHelpers'

/**
 * 把一条流式 chunk 应用到指定 id 的助手消息上，返回更新后的 messages 浅拷贝。
 *
 * 这是主对话与「后台子代理会话视图」**共用的唯一合并语义**（2026-11-26 从
 * useHarnessHandlers 抽成独立纯函数）：正文/推理增量、工具 preparing → executing →
 * completed、子代理嵌套块、重试/压缩过渡块都在这里合并。子代理会话视图直接复用
 * 同一主进程下发的 StructuredMessage chunk，渲染结果与主对话逐像素同源。
 *
 * @param activeCauseIds 当前话题「正在运行的子代理 causeId」集合（task 工具的子代理块
 *   据此把 running 事件归并到同一个嵌套块；没有子代理的会话传空 Set 即可）
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

    // 「正在重试」过渡块仅在请求未恢复时展示：一旦真实内容/工具/智能体/压缩结果到达，
    // 说明重试已成功、模型开始正常输出，立即移除该过渡块
    const retryFinished =
      Boolean(chunk.content) ||
      Boolean(chunk.reasoning_content) ||
      Boolean(chunk.tool) ||
      Boolean(chunk.subAgent) ||
      Boolean(chunk.historyCompacted)
    if (retryFinished) {
      updatedBlocks = updatedBlocks.filter((b) => b.type !== 'retrying')
    }
    // 摘要压缩失败/放弃（全程没有 historyCompacted 结果）时，正文一旦开始就收起
    // 残留的「正在压缩早期对话…」过渡卡（避免压缩卡与正文并行误导）
    if (retryFinished && !updatedBlocks.some((b) => b.type === 'historyCompacted')) {
      updatedBlocks = updatedBlocks.filter((b) => b.type !== 'historyCompacting')
    }

    // 模型单次请求失败后在原调用处自动重试（不整轮重跑）：插入「正在重试」过渡行，
    // 只保留最新一次进度；已输出的历史内容与工具块原样保留（重试不会作废它们）
    if (chunk.retrying) {
      updatedBlocks = updatedBlocks.filter((b) => b.type !== 'retrying')
      updatedBlocks.push({
        type: 'retrying',
        retrying: { attempt: chunk.retrying.attempt, retries: chunk.retrying.retries }
      })
    }

    // 本轮热记忆注入：置于消息块最顶部（首个 chunk 到达，仅插入一次）
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

    // 摘要压缩开始：插入「压缩中」过渡块（仅当前轮展示，不落库；
    // 结果块到达后在原位置替换，压缩失败时随消息结束隐藏）
    if (chunk.historyCompacting) {
      const exists = updatedBlocks.some(
        (b) => b.type === 'historyCompacting' || b.type === 'historyCompacted'
      )
      if (!exists) {
        updatedBlocks.push({ type: 'historyCompacting' })
      }
    }

    // 本轮早期对话摘要压缩：紧随记忆注入块（正文流开始前到达，仅插入一次）
    if (chunk.historyCompacted) {
      const compacted = {
        type: 'historyCompacted' as const,
        compaction: {
          compressedCount: chunk.historyCompacted.compressedCount,
          retainedCount: chunk.historyCompacted.retainedCount,
          boundaryId: chunk.historyCompacted.boundaryId
        }
      }
      // 原地替换「压缩中」过渡块（保持卡片位置稳定）
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
          // 防御：部分 provider 首个工具块不携带工具名（以占位名 'tool' 登记）——
          // 未按名称匹配到 preparing 块时，并入最近的占位块并改名为真实工具名，
          // 避免「tool · 参数构建中…」幽灵块与真实工具块并存
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
          // 复制后更新：不改写与旧状态共享的 subAgent 对象（渲染/更新期就地改共享对象
          // 是文本自复制的隐患，统一走不可变替换）
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
        // 后台派发轻量卡：定格「已派发」，仅名称+简述+会话 id（结果在顶部栏查看）
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
          // 复制成新块后再就地更新：新块独占 subAgent 对象与 children 数组，
          // 后续对 block.subAgent/block.children 的写入不会污染与旧状态共享的对象
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
              // 防御：部分 provider 首个工具块不携带工具名（以占位名 'tool' 登记）——
              // 未按名称匹配到 preparing 块时，并入最近的占位块并改名为真实工具名
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
     * **流式期间不动折叠布局**（用户 2026-09-24：「还是出现内容从折叠里面移到外面，
     * 一会又被移进去」）：主进程随 chunk 下发的 `answer` 实时标记不再驱动布局——
     * 那时边界还没有定论（模型随时可能接着调工具，刚写的那句话就不是答复），
     * 一摘就会出现「先露到折叠外、再被收回折叠里」的来回搬。
     *
     * 布局只在 done 事件（下面的 done 分支）一次性按主进程的权威结论定格：
     * 折叠外只留**最终结果正文 + 紧挨着它的思考**，其余内容全部留在任务段折叠里
     * （第一个 write_todos 之前那段 2026-09-25 起不折叠、始终铺开）。
     */
    return {
      ...msg,
      content: updatedContent,
      blocks: updatedBlocks,
      toolCalls: updatedToolCalls.length > 0 ? updatedToolCalls : undefined,
      reasoning_content: updatedReasoning,
      // 瞬时字段：记录最后 chunk 时间戳，供静默指示（正在生成…）判定
      lastChunkAt: Date.now()
    }
  })
}
