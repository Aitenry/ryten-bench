import {
  BaseMessage,
  HumanMessage,
  AIMessage,
  ToolMessage,
  SystemMessage
} from '@langchain/core/messages'
import logger from 'electron-log'
import type { StructuredMessage, ToolCallDetail, HistoryCompaction } from '../types'
import type { HarnessDialogueRow } from '../db/mapper/harness'
import {
  pruneToolOutput,
  buildCheckpointMessage,
  buildTranscript,
  compactionError,
  PRESSURE_RATIO,
  RETAIN_RATIO,
  type CompactionCheckpoint,
  type SummarizerFn
} from '../runtime/compaction'

/**
 * 数据库中的对话记录（精简版视图，避免循环依赖）。
 * 类型仍从 drizzle schema 推导，不再手抄字段。
 */
export type HistoryDialogue = Pick<
  HarnessDialogueRow,
  'id' | 'topic_id' | 'role' | 'content' | 'blocks' | 'created_at'
>

/** 历史加载回调：根据 topicId 返回对话记录 */
export type LoadHistoryFn = (topicId: number) => Promise<HistoryDialogue[]>

/** 适配 DeepSeek-R1 等模型在 additional_kwargs 中返回的推理内容 */
interface ReasoningMessage {
  additional_kwargs?: {
    reasoning_content?: string
    reasoning?: string
  }
}

/**
 * 从 LangChain 消息列表中提取结构化的消息输出
 */
export function extractStructuredMessages(messages: BaseMessage[]): StructuredMessage[] {
  const result: StructuredMessage[] = []
  const toolOutputs = new Map<string, string>()

  // 第一遍：收集所有工具输出
  for (const msg of messages) {
    if (msg.type === 'tool') {
      const tm = msg as unknown as { tool_call_id: string; content: unknown }
      const rawContent = tm.content
      const content = typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent)
      toolOutputs.set(tm.tool_call_id, content)
    }
  }

  // 第二遍：提取内容和工具调用
  for (const msg of messages) {
    if (msg.type === 'human') continue

    // 推理内容
    const reasoningContent = (msg as unknown as ReasoningMessage).additional_kwargs
      ?.reasoning_content
    if (reasoningContent) {
      result.push({ reasoning_content: reasoningContent })
    }

    // 文本内容
    const content = typeof msg.content === 'string' ? msg.content : ''
    if (content) {
      result.push({ content })
    }

    // 工具调用
    const toolCalls = (
      msg as unknown as {
        tool_calls?: Array<{ name: string; args: Record<string, unknown>; id: string }>
      }
    ).tool_calls
    if (toolCalls && toolCalls.length > 0) {
      for (const tc of toolCalls) {
        result.push({
          tool: {
            name: tc.name,
            input: tc.args,
            output: toolOutputs.get(tc.id) || ''
          }
        })
      }
    }
  }

  return result
}

/**
 * 历史上下文默认字符预算：未配置模型上下文窗口时的默认值（20,000 字符）。
 * 实际预算随当前模型的上下文窗口动态调整（见 HistoryConvertOptions.contextBudget），
 * 字符 ≈ token 的保守换算（中文 1:1，英文更保守）。
 */
export const DEFAULT_HISTORY_BUDGET = 20_000

/** 历史上下文转换结果 */
export interface HistoryContext {
  messages: BaseMessage[]
  /** 是否发生了截断（更早的对话被省略；摘要压缩可用时不再发生） */
  truncated: boolean
  /** 是否发生了摘要压缩（早期对话被压缩为 checkpoint 摘要） */
  compacted?: boolean
  /** 本轮新发生的摘要压缩信息（仅边界推进/首次压缩时携带，供前端展示卡片） */
  compaction?: HistoryCompaction
}

/** 历史转换选项（摘要压缩可选开启） */
export interface HistoryConvertOptions {
  /** 字符预算（默认 DEFAULT_HISTORY_BUDGET；由当前模型的上下文窗口换算注入） */
  maxChars?: number
  /** 摘要回调：由 HarnessService 用当前模型注入；缺省时超预算回退为字符截断 */
  summarizer?: SummarizerFn
  /** 话题 ID（缓存键） */
  topicId?: number
  /** 读取既有压缩 checkpoint（持久化表；缺省视为无） */
  getCheckpoint?: (topicId: number) => Promise<CompactionCheckpoint | undefined>
  /** 落库压缩 checkpoint（持久化表；缺省不保存） */
  saveCheckpoint?: (topicId: number, checkpoint: CompactionCheckpoint) => Promise<void>
  /** 压缩开始回调：确认本轮将产生新的压缩事件时、LLM 摘要调用前立即调用 */
  onCompactionStart?: () => void
  /** 取消信号：中止/取消时跳过摘要压缩，且不落库 checkpoint（前端「停止」贯通到压缩链路） */
  signal?: AbortSignal
}

/** 单条对话的字符成本（正文 + blocks） */
function dialogueChars(d: HistoryDialogue): number {
  return d.content.length + (d.blocks ? d.blocks.length : 0)
}

/**
 * 是否为「回合内插话」行（用户在我们正在生成回复时插进来的一句话）。
 *
 * 判定依据是落库时写入的 blocks 标记（`{type:'interjection'}`）——不靠内容或时间猜。
 * blocks 解析失败时按普通对话处理（宁可多带一次上下文，也不要丢掉用户消息）。
 *
 * 现状：插话走**纯注入**（不落库、不进对话流），所以目前没有任何行会带这个标记，
 * 这里恒为 false——纯防御：若将来把插话也落库留痕，回放必须能排除它，
 * 否则同一诉求会被重复送进模型（且回放顺序会变成「先答复再提问」）。
 */
export function isInterjectionRow(d: HistoryDialogue): boolean {
  if (!d.blocks) return false
  try {
    const blocks: unknown = JSON.parse(d.blocks)
    return (
      Array.isArray(blocks) && blocks.some((b) => (b as { type?: string })?.type === 'interjection')
    )
  } catch {
    return false
  }
}

/**
 * 将数据库中的对话记录转换为 LangChain BaseMessage 数组。
 *
 * 上下文压缩策略（参考 dsh-compaction-basic 的阈值/保留机制）：
 * 1. 字符总量 ≥ 预算 × PRESSURE_RATIO 且提供了摘要器时：把最老一段对话用一次
 *    LLM 调用压缩为 checkpoint 摘要（topic_compactions 表持久化，每话题一行）。
 *    后续轮次只要「既有摘要 + 未压缩新内容」未超预算就直接复用，不重复压缩；
 *    只有再次超预算才把新内容最老部分增量合并进摘要（一次调用）；
 * 2. 无摘要器或摘要失败：回退为原有字符预算截断（省略更早对话 + 头部说明）；
 * 3. 工具结果统一经智能裁剪（pruneToolOutput），原始内容保留在数据库中可精确回放。
 */
export async function convertDialoguesToMessages(
  dialogues: HistoryDialogue[],
  options?: HistoryConvertOptions
): Promise<HistoryContext> {
  const maxChars = options?.maxChars ?? DEFAULT_HISTORY_BUDGET
  // 回合内插话（steering）行不进模型上下文：它已经作为 HumanMessage 在本轮回合中
  // 被模型读到、并已体现在同一轮助手的输出里；回放会重复一遍同一诉求
  //（且它落库在助手行之前，重放顺序会把「先答复再提问」颠倒）。前端仍按原样渲染。
  const replayable = dialogues.filter((d) => !isInterjectionRow(d))
  const totalChars = replayable.reduce((sum, d) => sum + dialogueChars(d), 0)

  // 摘要压缩路径：压力达标且有摘要器
  if (options?.summarizer && options.topicId != null && totalChars >= maxChars * PRESSURE_RATIO) {
    try {
      const result = await compactWithSummarizer(replayable, maxChars, options)
      if (result) return result
    } catch (err) {
      // 摘要失败：回退字符截断；已落库的旧 checkpoint 保留，后续轮次仍可复用
      compactionError(err)
    }
  }

  // 回退路径：从后往前选取最近的对话，直到累计字符数超过预算（至少保留最后一条）
  const selected: HistoryDialogue[] = []
  let total = 0
  let truncated = false
  for (let i = replayable.length - 1; i >= 0; i--) {
    const d = replayable[i]
    if (total + dialogueChars(d) > maxChars && selected.length > 0) {
      truncated = true
      break
    }
    selected.unshift(d)
    total += dialogueChars(d)
  }

  const messages: BaseMessage[] = []

  // 截断说明：置于最前，告知模型早期历史被省略
  if (truncated) {
    messages.push(
      new SystemMessage(
        '(Note: earlier conversation was automatically omitted because it exceeded the length budget. Only the most recent messages are included.)'
      )
    )
  }

  appendDialogueMessages(messages, selected)
  return { messages, truncated }
}

/** 按字符预算从尾部切分对话：返回 { old, recent }（old 为最老部分，可为空） */
function splitByBudget(
  dialogues: HistoryDialogue[],
  budget: number
): { old: HistoryDialogue[]; recent: HistoryDialogue[] } {
  let retainStart = dialogues.length
  let retainChars = 0
  for (let i = dialogues.length - 1; i >= 0; i--) {
    retainChars += dialogueChars(dialogues[i])
    retainStart = i
    if (retainChars >= budget) break
  }
  return { old: dialogues.slice(0, retainStart), recent: dialogues.slice(retainStart) }
}

/**
 * 感知取消的摘要调用：signal 已中止或请求途中被中止（AbortError）时返回 null，
 * 由调用方跳过压缩与 checkpoint 落库（用户取消不留压缩副作用，也不误报失败）；
 * 其余错误照常抛出（走「摘要失败回退字符截断」兜底）。
 */
async function summarizeForTurn(
  options: HistoryConvertOptions,
  transcript: string,
  priorSummary?: string
): Promise<string | null> {
  if (options.signal?.aborted) return null
  try {
    return await options.summarizer!(transcript, priorSummary)
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') return null
    throw err
  }
}

/**
 * 摘要压缩编排（checkpoint 持久化于 topic_compactions 表，压缩一次后续复用）：
 *
 * - 无 checkpoint 或边界倒退（对话被删除）：初始全量摘要（按保留预算切分最老段），
 *   落库，上报压缩卡片；
 * - 既有摘要 + 未压缩新内容 ≤ 总预算：直接复用既有摘要，把未压缩对话整体带进
 *   上下文，不调用 LLM、不上报压缩卡片——这是「压缩一次，后续复用」的核心：
 *   新对话只是让未压缩段变大，只要总量未满预算就绝不重复压缩；
 * - 总量超预算（又满了）：只把未压缩段中最老的部分（超出保留预算的部分）增量合并
 *   进既有摘要，一次调用后落库、上报压缩卡片，之后又能吸收大量新对话。
 *
 * 返回 null 表示无需要压缩的最老段（由调用方回退常规路径）。
 */
async function compactWithSummarizer(
  dialogues: HistoryDialogue[],
  maxChars: number,
  options: HistoryConvertOptions
): Promise<HistoryContext | null> {
  const topicId = options.topicId!
  const retainBudget = Math.max(1, Math.floor(maxChars * RETAIN_RATIO))
  const lastDialogueId = dialogues[dialogues.length - 1].id
  const prior = options.getCheckpoint ? await options.getCheckpoint(topicId) : undefined

  // 无 checkpoint / 边界倒退（对话被删除，摘要含已删除内容）：初始或全量重摘要
  if (!prior || prior.boundaryId > lastDialogueId) {
    const { old, recent } = splitByBudget(dialogues, retainBudget)
    if (old.length === 0) return null
    options.onCompactionStart?.()
    // 用户已取消（onCompactionStart 推送后、调用前中止）：跳过压缩与落库，交回常规路径
    if (options.signal?.aborted) return null
    const summary = await summarizeForTurn(options, buildTranscript(old))
    if (summary === null || options.signal?.aborted) return null
    const boundaryId = old[old.length - 1].id
    await saveCheckpointSafe(topicId, { boundaryId, summary }, options)
    const messages: BaseMessage[] = [buildCheckpointMessage(summary)]
    appendDialogueMessages(messages, recent)
    logger.info(
      `[History] 摘要压缩完成 topicId=${topicId}（压缩 ${old.length} 条 → checkpoint，保留最近 ${recent.length} 条，边界 ${boundaryId}）`
    )
    return {
      messages,
      truncated: false,
      compacted: true,
      compaction: { compressedCount: old.length, retainedCount: recent.length, boundaryId }
    }
  }

  // 既有 checkpoint 有效：未压缩的新内容 = 边界之后的全部对话
  const pending = dialogues.filter((d) => d.id > prior.boundaryId)
  const pendingChars = pending.reduce((sum, d) => sum + dialogueChars(d), 0)

  // 复用分支：摘要 + 未压缩新内容未超总预算 → 直接复用，不调用 LLM。
  // 未压缩对话（即使远超保留预算）整体进上下文，直到总量再次超预算才压缩。
  if (prior.summary.length + pendingChars <= maxChars) {
    logger.info(
      `[History] 复用既有压缩摘要 topicId=${topicId}（边界 ${prior.boundaryId}，未压缩 ${pending.length} 条 / ${pendingChars} 字符，摘要+未压缩 ${prior.summary.length + pendingChars} ≤ ${maxChars}）`
    )
    const messages: BaseMessage[] = [buildCheckpointMessage(prior.summary)]
    appendDialogueMessages(messages, pending)
    return { messages, truncated: false, compacted: true }
  }

  // 又满了：把未压缩段中最老的部分（超出保留预算）增量合并进既有摘要
  const { old, recent } = splitByBudget(pending, retainBudget)
  if (old.length === 0) {
    // 极端情况：单条对话就超保留预算，未压缩段全部保留也超总预算——
    // 直接全量重摘要（含既有摘要的转录会失真，走增量语义最接近：整段并入）
    // 但 old 为空意味着 retainBudget 覆盖 pending 全部，此时不压缩直接带上
    //（预算检查已通过的前提不存在），保守回退常规路径。
    return null
  }
  options.onCompactionStart?.()
  if (options.signal?.aborted) return null
  const summary = await summarizeForTurn(options, buildTranscript(old), prior.summary)
  if (summary === null || options.signal?.aborted) return null
  const boundaryId = old[old.length - 1].id
  await saveCheckpointSafe(topicId, { boundaryId, summary }, options)
  const messages: BaseMessage[] = [buildCheckpointMessage(summary)]
  appendDialogueMessages(messages, recent)
  logger.info(
    `[History] 摘要压缩完成 topicId=${topicId}（增量合并 ${old.length} 条 → checkpoint，保留最近 ${recent.length} 条，边界 ${boundaryId}）`
  )
  return {
    messages,
    truncated: false,
    compacted: true,
    compaction: { compressedCount: old.length, retainedCount: recent.length, boundaryId }
  }
}

/** 落库 checkpoint（失败不阻断本轮，仅丢失持久化复用能力） */
async function saveCheckpointSafe(
  topicId: number,
  checkpoint: CompactionCheckpoint,
  options: HistoryConvertOptions
): Promise<void> {
  if (!options.saveCheckpoint) return
  try {
    await options.saveCheckpoint(topicId, checkpoint)
  } catch (err) {
    logger.warn('[History] 压缩 checkpoint 落库失败（不影响本轮）:', err)
  }
}

/** 将选中的对话追加为 LangChain 消息（工具结果经智能裁剪） */
function appendDialogueMessages(messages: BaseMessage[], selected: HistoryDialogue[]): void {
  for (const d of selected) {
    if (d.role === 'user') {
      messages.push(new HumanMessage(d.content))
    } else if (d.role === 'assistant') {
      let blocks: { type: string; text?: string; tool?: ToolCallDetail; reasoning?: string }[]
      try {
        blocks = d.blocks ? JSON.parse(d.blocks) : []
      } catch {
        logger.warn(
          `[History] Failed to parse blocks for dialogue id=${d.id}, falling back to plain text`
        )
        messages.push(new AIMessage(d.content))
        continue
      }

      const textBlocks = blocks.filter((b) => b.type === 'text')
      const toolBlocks = blocks.filter((b) => b.type === 'tool')
      const content = textBlocks.map((b) => b.text || '').join('\n') || d.content

      if (toolBlocks.length > 0) {
        // 构建 AIMessage 的 tool_calls 数组
        const toolCalls: { name: string; args: Record<string, unknown>; id: string }[] = []
        for (const tb of toolBlocks) {
          const callId = `hist_${d.id}_${toolCalls.length}`
          toolCalls.push({
            id: callId,
            name: tb.tool!.name,
            args: tb.tool!.input
          })
        }

        if (toolCalls.length > 0) {
          messages.push(
            new AIMessage({
              content,
              tool_calls: toolCalls.map((tc) => ({
                id: tc.id,
                name: tc.name,
                args: tc.args
              }))
            })
          )
          // 每个工具调用后跟一个 ToolMessage
          for (let ti = 0; ti < toolCalls.length; ti++) {
            const tb = toolBlocks[ti]
            // 智能裁剪：超长工具结果在回灌时裁剪为 head/中间标记/tail（无模型成本；
            // 完整内容保留在数据库 blocks 中供精确回放与前端展示）
            const rawOutput = tb.tool!.output
            messages.push(
              new ToolMessage({
                content: pruneToolOutput(rawOutput),
                tool_call_id: toolCalls[ti].id
              })
            )
          }
        } else {
          // 所有工具调用都被窗口截断了，只保留文本
          messages.push(new AIMessage(content))
        }
      } else {
        messages.push(new AIMessage(content))
      }
    }
  }
}
