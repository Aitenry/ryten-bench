import { BaseMessage, HumanMessage, AIMessage, ToolMessage, SystemMessage } from '../../ai/messages'
import logger from 'electron-log'
import { mainFormat } from '../../i18n'
import { getFsToolTexts } from '../../i18n/tool-results-fs'
import type { StructuredMessage, ToolCallDetail, HistoryCompaction } from './types'
import type { HarnessDialogueRow } from '../../database/mapper/harness/harness'
import {
  pruneToolOutput,
  buildCheckpointMessage,
  buildTranscript,
  compactionError,
  PRESSURE_RATIO,
  RETAIN_RATIO,
  type CompactionCheckpoint,
  type SummarizerFn
} from '../../runtime/harness/compaction'
import {
  decideContextPressure,
  chunkByChars,
  COMPACTION_CHUNK_CHARS,
  TOKEN_PRESSURE_RATIO,
  type ContextPressure
} from '../../runtime/harness/context-pressure'
import { planObservationMask } from '../../runtime/harness/observation-mask'

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
 * 从消息列表中提取结构化的消息输出
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

/** 摘要请求超窗（prompt too long）时的最多拆分重试次数 */
const MAX_PTL_RETRIES = 3
/** 连续压缩失败达到这个次数后停止自动压缩（熔断），避免每轮白烧 token（Claude Code 同款） */
const MAX_CONSECUTIVE_COMPACTION_FAILURES = 3
/** 压缩后重注入：最多恢复这么多个最近读/改过的文件 */
const RESTORE_MAX_FILES = 5
/** 重注入单文件上限（字符；1 字符 ≈ 1 token 的保守口径） */
const RESTORE_PER_FILE_CHARS = 5_000
/** 重注入总上限（字符） */
const RESTORE_TOTAL_CHARS = 25_000

/**
 * 话题 → 连续压缩失败次数（进程级）。
 *
 * 为什么需要：压缩失败后会回退字符截断，但下一轮压力仍然超标，会再次调用摘要模型；
 * 某些会话（超大单条输出、模型不支持长输入）会每轮都失败，白烧 token。连续失败到
 * 上限就跳过自动压缩，直到出现一次成功或用户手动触发。
 */
const compactionFailureStreak = new Map<number, number>()

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
  /**
   * 上一轮模型调用真实回传的上下文规模（token）：有则压缩压力按真实 token 判定
   * （窗口 × 79%），否则退回字符启发式（预算 × 0.7）。见 context-pressure.ts。
   */
  measuredContextTokens?: number | null
  /** 当前模型上下文窗口（token）；与 measuredContextTokens 一起换算压力，缺一即退回字符口径 */
  contextWindowTokens?: number | null
  /** 压缩后重注入用：读取虚拟路径的文件内容（失败返回 error；缺省则不恢复文件） */
  readFile?: (virtualPath: string) => { content: string } | { error: string }
  /** 压缩后重注入用：当前的待办/计划等短状态（可为空；缺省则不注入） */
  restoreNote?: () => string
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

/** 压缩熔断是否已打开（连续失败达到上限） */
function compactionCircuitOpen(topicId: number): boolean {
  return (compactionFailureStreak.get(topicId) ?? 0) >= MAX_CONSECUTIVE_COMPACTION_FAILURES
}

/** 记一次压缩失败：达到上限时打一行日志（只打一次，避免刷屏） */
function noteCompactionFailure(topicId: number): void {
  const next = (compactionFailureStreak.get(topicId) ?? 0) + 1
  compactionFailureStreak.set(topicId, next)
  if (next === MAX_CONSECUTIVE_COMPACTION_FAILURES) {
    logger.warn(
      `[History] Compaction circuit opened topic=${topicId} after ${next} consecutive failures; automatic compaction is paused until a run succeeds`
    )
  }
}

/** 压缩成功：清零失败计数，恢复自动压缩 */
function noteCompactionSuccess(topicId: number): void {
  compactionFailureStreak.delete(topicId)
}

/**
 * 将数据库中的对话记录转换为 BaseMessage 数组。
 *
 * 上下文压缩策略（参考 dsh-compaction-basic 的阈值/保留机制）：
 * 1. 压力达标且提供了摘要器时：把最老一段对话用一次（或分段多次）LLM 调用
 *    压缩为 checkpoint 摘要（topic_compactions 表持久化，每话题一行）。
 *    压力优先按**真实 token** 判定：上一轮模型调用实际用掉的上下文 ÷ 模型窗口 ≥ 79%
 *    （含系统提示词、工具 schema、注入记忆）；拿不到 usage_metadata 才退回
 *    「历史字符 ≥ 预算 × 0.7」的启发式。判定逻辑见 runtime/harness/context-pressure.ts。
 *    后续轮次只要「既有摘要 + 未压缩新内容」未超预算就直接复用，不重复压缩
 *    （真实 token 已超阈值时除外：复用出来的上下文一样大，必须增量合并才会变小）；
 *    只有再次超预算才把新内容最老部分增量合并进摘要（一次调用，过长时分块）；
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

  // 压缩压力：优先用上一轮真实回传的 token（含系统提示词 / 工具 schema / 注入记忆，
  // 那才是模型真正看到的占用），拿不到再退回字符启发式。每轮一行日志，便于现场核对
  //「为什么这轮压了 / 为什么没压」。
  const pressure = decideContextPressure({
    totalChars,
    maxChars,
    charThreshold: PRESSURE_RATIO,
    measuredContextTokens: options?.measuredContextTokens,
    contextWindowTokens: options?.contextWindowTokens
  })
  logger.info(
    `[History] Context pressure topic=${options?.topicId ?? 'none'} ` +
      (pressure.tokenBased
        ? `tokens=${options?.measuredContextTokens}/${options?.contextWindowTokens} = ${(pressure.ratio * 100).toFixed(1)}%`
        : `chars=${totalChars}/${maxChars} = ${(pressure.ratio * 100).toFixed(1)}%`) +
      ` (threshold ${(pressure.threshold * 100).toFixed(0)}%, triggered=${pressure.triggered})`
  )

  // 摘要压缩路径：压力达标且有摘要器
  if (options?.summarizer && options.topicId != null && pressure.triggered) {
    if (compactionCircuitOpen(options.topicId)) {
      // 连续失败已熔断：跳过自动压缩（回退下面的字符截断），等一次成功或手动触发再恢复
      logger.warn(
        `[History] Skipping auto compaction topic=${options.topicId}: circuit open after ${MAX_CONSECUTIVE_COMPACTION_FAILURES} consecutive failures`
      )
    } else {
      try {
        const result = await compactWithSummarizer(replayable, maxChars, options, pressure)
        if (result) {
          noteCompactionSuccess(options.topicId)
          return result
        }
      } catch (err) {
        // 摘要失败：回退字符截断；已落库的旧 checkpoint 保留，后续轮次仍可复用
        noteCompactionFailure(options.topicId)
        compactionError(err)
      }
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

  appendDialogueMessages(messages, selected, options?.topicId)
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
 *   **例外**：压力由真实 token 判定且已超阈值时不能复用（复用出来的上下文一样大），
 *   必须走下面的增量合并，否则每轮都会「超阈值 → 复用 → 仍超阈值」原地打转；
 * - 总量超预算（又满了）：只把未压缩段中最老的部分（超出保留预算的部分）增量合并
 *   进既有摘要，一次调用后落库、上报压缩卡片，之后又能吸收大量新对话；
 *   待合并段超过单次转录上限时按块顺序摘要（每块都带上前一块的结果），
 *   避免压缩请求本身超窗。
 *
 * 返回 null 表示无需要压缩的最老段（由调用方回退常规路径）。
 */
async function compactWithSummarizer(
  dialogues: HistoryDialogue[],
  maxChars: number,
  options: HistoryConvertOptions,
  pressure: ContextPressure
): Promise<HistoryContext | null> {
  const topicId = options.topicId!
  const retainBudget = Math.max(1, Math.floor(maxChars * RETAIN_RATIO))
  /**
   * 单次摘要调用的转录上限：不超过字符预算的一半（预算是窗口按 1 字符 ≈ 1 token 换算的），
   * 再封顶 COMPACTION_CHUNK_CHARS。
   *
   * 为什么需要分块：真实 token 口径触发得比字符口径晚，待压缩段可能是旧实现的数倍
   * （英文 4 字符/token 时尤其明显），一次性塞进摘要模型会直接把压缩请求本身撑爆。
   */
  const chunkLimit = Math.max(8_000, Math.min(COMPACTION_CHUNK_CHARS, Math.floor(maxChars / 2)))
  const lastDialogueId = dialogues[dialogues.length - 1].id
  const prior = options.getCheckpoint ? await options.getCheckpoint(topicId) : undefined

  // 无 checkpoint / 边界倒退（对话被删除，摘要含已删除内容）：初始或全量重摘要
  if (!prior || prior.boundaryId > lastDialogueId) {
    const { old, recent } = splitByBudget(dialogues, retainBudget)
    if (old.length === 0) return null
    options.onCompactionStart?.()
    // 用户已取消（onCompactionStart 推送后、调用前中止）：跳过压缩与落库，交回常规路径
    if (options.signal?.aborted) return null
    const chunks = chunkByChars(old, dialogueChars, chunkLimit)
    const summary = await summarizeChunks(options, chunks)
    if (summary === null || options.signal?.aborted) return null
    assertSummaryShrinks(summary, old)
    const boundaryId = old[old.length - 1].id
    await saveCheckpointSafe(topicId, { boundaryId, summary }, options)
    const messages = await assembleCompactedMessages(summary, recent, old, options)
    logger.info(
      `[History] Summary compaction done topicId=${topicId} (compacted ${old.length} messages in ${chunks.length} chunk(s) -> checkpoint, kept latest ${recent.length} messages, boundary ${boundaryId}; pressure=${formatPressure(pressure)})`
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
  //
  // 例外：按真实 token 判定已经超阈值时**不能**复用——复用出来的上下文和现在一样大，
  // 下一轮还是超阈值，结果是一轮轮空转（不调 LLM、也不缩小），压缩永远不会发生。
  // 这时必须走增量合并，把最老的一段真正并进摘要。
  if (!pressure.tokenBased && prior.summary.length + pendingChars <= maxChars) {
    logger.info(
      `[History] Reusing existing compaction summary topicId=${topicId} (boundary ${prior.boundaryId}, uncompacted ${pending.length} messages / ${pendingChars} chars, summary + uncompacted ${prior.summary.length + pendingChars} <= ${maxChars})`
    )
    const messages: BaseMessage[] = [buildCheckpointMessage(prior.summary)]
    appendDialogueMessages(messages, pending, topicId)
    // 复用不是一次新的压缩事件：不重复重注入（否则每轮都多背 25K 字符的旧文件）
    return { messages, truncated: false, compacted: true }
  }
  if (pressure.tokenBased && prior.summary.length + pendingChars <= maxChars) {
    logger.info(
      `[History] Skip checkpoint reuse topicId=${topicId}: ${formatPressure(pressure)} >= ${(TOKEN_PRESSURE_RATIO * 100).toFixed(0)}% of the model window (chars would allow reuse), merging oldest pending messages instead`
    )
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
  const chunks = chunkByChars(old, dialogueChars, chunkLimit)
  const summary = await summarizeChunks(options, chunks, prior.summary)
  if (summary === null || options.signal?.aborted) return null
  // 旧上下文里本来就有 prior.summary，比较时算进去，否则小段增量合并会被误判为“没变小”
  assertSummaryShrinks(summary, old, prior.summary.length)
  const boundaryId = old[old.length - 1].id
  await saveCheckpointSafe(topicId, { boundaryId, summary }, options)
  const messages = await assembleCompactedMessages(summary, recent, old, options)
  logger.info(
    `[History] Summary compaction done topicId=${topicId} (incrementally merged ${old.length} messages in ${chunks.length} chunk(s) -> checkpoint, kept latest ${recent.length} messages, boundary ${boundaryId}; pressure=${formatPressure(pressure)})`
  )
  return {
    messages,
    truncated: false,
    compacted: true,
    compaction: { compressedCount: old.length, retainedCount: recent.length, boundaryId }
  }
}

/** 日志用的压力描述：`tokens 82.4%` / `chars 71.2%` */
function formatPressure(pressure: ContextPressure): string {
  return `${pressure.tokenBased ? 'tokens' : 'chars'} ${(pressure.ratio * 100).toFixed(1)}%`
}

/** 判断摘要请求是否因“上下文超长（prompt too long）”被拒（各家措辞不同，统一兜住） */
function isPromptTooLongError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /context (length|window)|maximum context|too many tokens|prompt is too long|context_length_exceeded|CONTEXT_WINDOW_EXCEEDED|reduce the length|request too large|413/i.test(
    message
  )
}

/**
 * 分块摘要：逐块调用摘要器，后一块把前一块的结果当 priorSummary 增量合并。
 *
 * 任意一块失败（null）或用户取消时整体返回 null——**不落半份 checkpoint**：
 * 边界只能对应一份完整摘要，半份会让下一轮的边界与摘要内容对不上。
 *
 * 超窗重试：分块上限只是估算，真实 token 可能仍超（中文/JSON 低估）。命中
 * “prompt too long” 时把当前块**对半拆开**重试（最多 [`MAX_PTL_RETRIES`] 次），
 * 而不是丢掉最老内容——摘要的价值就在老内容里，丢了不如不压。
 */
async function summarizeChunks(
  options: HistoryConvertOptions,
  chunks: HistoryDialogue[][],
  priorSummary?: string
): Promise<string | null> {
  let summary = priorSummary
  const pending = chunks.slice()
  let splits = 0
  while (pending.length > 0) {
    const chunk = pending[0]
    try {
      const next = await summarizeForTurn(options, buildTranscript(chunk), summary)
      if (next === null) return null
      if (options.signal?.aborted) return null
      summary = next
      pending.shift()
    } catch (err) {
      if (splits < MAX_PTL_RETRIES && chunk.length > 1 && isPromptTooLongError(err)) {
        const mid = Math.ceil(chunk.length / 2)
        pending.splice(0, 1, chunk.slice(0, mid), chunk.slice(mid))
        splits++
        logger.warn(
          `[History] Compaction transcript too long; split ${chunk.length} messages into ${mid}+${chunk.length - mid} (retry ${splits}/${MAX_PTL_RETRIES})`
        )
        continue
      }
      throw err
    }
  }
  return summary ?? null
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
    logger.warn(
      '[History] Failed to persist compaction checkpoint (does not affect this round):',
      err
    )
  }
}

/** 组装压缩后的消息：checkpoint → 最近对话 → 重注入（最近文件 + 待办） */
async function assembleCompactedMessages(
  summary: string,
  recent: HistoryDialogue[],
  summarized: HistoryDialogue[],
  options: HistoryConvertOptions
): Promise<BaseMessage[]> {
  const messages: BaseMessage[] = [buildCheckpointMessage(summary)]
  appendDialogueMessages(messages, recent, options.topicId)
  // 最近窗口里已经有的文件不再重复注入（否则同一文件在上下文里出现两份，还可能一旧一新）
  await appendRestoredContext(messages, summarized, options, new Set(recentFilePaths(recent)))
  return messages
}

/**
 * 摘要必须比它替换掉的内容更小，否则放弃本次压缩（DSH / Gemini 的“通胀熔断”）。
 *
 * 摘要模型偶尔会输出比原文还长的内容（复述全文、格式失控）；这种摘要落库后会让
 * 下一轮直接又超阈值，等于白烧一次调用。抛错交给调用方回退字符截断。
 */
function assertSummaryShrinks(summary: string, replaced: HistoryDialogue[], priorChars = 0): void {
  const replacedChars = priorChars + replaced.reduce((sum, d) => sum + dialogueChars(d), 0)
  if (summary.length >= replacedChars) {
    throw new Error(
      `compaction summary did not shrink the context (${summary.length} >= ${replacedChars} chars)`
    )
  }
}

/**
 * 压缩后重注入：把最近读/改过的文件内容与当前待办放回上下文。
 *
 * 为什么需要：摘要是有损的——模型刚读过 300 行的文件，压缩后只剩摘要里一句
 * “改过 app.ts”，不重注入就得重新探索。Claude Code 压缩后会重读最多 5 个最近
 * 文件，Cursor 则给一个 history 文件引用；这里用同一份工作区快照重读，单文件
 * 5K 字符、总计 25K 字符封顶。
 */
async function appendRestoredContext(
  messages: BaseMessage[],
  summarized: HistoryDialogue[],
  options: HistoryConvertOptions,
  skipPaths: Set<string> = new Set()
): Promise<void> {
  if (!options.readFile && !options.restoreNote) return
  const blocks: string[] = []
  let total = 0
  if (options.readFile) {
    for (const path of recentFilePaths(summarized)) {
      if (skipPaths.has(path)) continue
      let result: { content: string } | { error: string }
      try {
        result = options.readFile(path)
      } catch {
        continue
      }
      if ('error' in result) continue
      const clipped =
        result.content.length > RESTORE_PER_FILE_CHARS
          ? `${result.content.slice(0, RESTORE_PER_FILE_CHARS)}\n…(file truncated)`
          : result.content
      const block = `### ${path}\n\`\`\`\n${clipped}\n\`\`\``
      if (total + block.length > RESTORE_TOTAL_CHARS) break
      blocks.push(block)
      total += block.length
    }
  }
  const note = (options.restoreNote?.() ?? '').trim()
  if (blocks.length === 0 && !note) return
  const header = mainFormat(getFsToolTexts().compaction.restoredContext, {})
  // 紧跟在 checkpoint 之后、最近对话之前：模型先读摘要，再读恢复的文件
  messages.splice(1, 0, new SystemMessage([header, ...blocks, note].filter(Boolean).join('\n\n')))
}

/** 压缩段里最近读过/改过的文件路径（按时间倒序去重，最多 [`RESTORE_MAX_FILES`] 个） */
function recentFilePaths(dialogues: HistoryDialogue[]): string[] {
  const seen = new Set<string>()
  const paths: string[] = []
  for (let i = dialogues.length - 1; i >= 0 && paths.length < RESTORE_MAX_FILES; i--) {
    const parsed = parseDialogue(dialogues[i])
    for (let b = parsed.toolBlocks.length - 1; b >= 0; b--) {
      const tool = parsed.toolBlocks[b].tool!
      if (tool.name !== 'read_file' && tool.name !== 'edit_file' && tool.name !== 'write_file') {
        continue
      }
      const path = tool.input?.path ?? tool.input?.file_path
      if (typeof path !== 'string' || !path.trim() || seen.has(path)) continue
      seen.add(path)
      paths.push(path)
      if (paths.length >= RESTORE_MAX_FILES) break
    }
  }
  return paths
}

/** 解析后的对话块（清理计划与消息组装共用一次解析） */
type DialogueBlocks = { type: string; text?: string; tool?: ToolCallDetail; reasoning?: string }[]

interface ParsedDialogue {
  dialogue: HistoryDialogue
  /** blocks 解析失败时为 null（回退纯文本，不构造工具结构） */
  blocks: DialogueBlocks | null
  toolBlocks: DialogueBlocks
  content: string
}

/** 解析一条对话的 blocks（只解析一次，避免清理计划与组装各解析一遍） */
function parseDialogue(d: HistoryDialogue): ParsedDialogue {
  if (d.role !== 'assistant') {
    return { dialogue: d, blocks: [], toolBlocks: [], content: d.content }
  }
  let blocks: DialogueBlocks
  try {
    blocks = d.blocks ? (JSON.parse(d.blocks) as DialogueBlocks) : []
  } catch {
    logger.warn(
      `[History] Failed to parse blocks for dialogue id=${d.id}, falling back to plain text`
    )
    return { dialogue: d, blocks: null, toolBlocks: [], content: d.content }
  }
  const textBlocks = blocks.filter((b) => b.type === 'text')
  const toolBlocks = blocks.filter((b) => b.type === 'tool' && b.tool)
  const content = textBlocks.map((b) => b.text || '').join('\n') || d.content
  return { dialogue: d, blocks, toolBlocks, content }
}

/** 占位符里的调用描述：工具名 + 关键参数（路径/命令/模式），截断到 120 字符 */
function describeToolCall(tool: ToolCallDetail): string {
  const input = tool.input ?? {}
  for (const key of ['path', 'file_path', 'command', 'pattern', 'query', 'url']) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) {
      const exit = tool.card?.exitCode != null ? ` (exit ${tool.card.exitCode})` : ''
      return `${tool.name} ${value.slice(0, 120)}${exit}`
    }
  }
  return tool.name
}

/**
 * 将选中的对话追加为消息对象。
 *
 * 工具结果分三档处理（策略见 runtime/harness/observation-mask.ts）：
 * - 最近窗口（最近 N 对工具调用 / 最近 2 个用户回合）：保留内容，超长按 head/tail 裁剪；
 * - 更早、可重放的结果：整段换成占位符（保留 tool_call 的 id 与参数，绝不破坏配对）；
 * - blocks 解析失败的行：回退纯文本（宁可少一点结构，也不要丢消息）。
 */
function appendDialogueMessages(
  messages: BaseMessage[],
  selected: HistoryDialogue[],
  topicId?: number
): void {
  const parsed = selected.map(parseDialogue)
  const plan = planObservationMask(
    parsed.map((p) => ({
      role: p.dialogue.role === 'user' ? ('user' as const) : ('assistant' as const),
      tools: p.toolBlocks.map((tb) => ({
        name: tb.tool!.name,
        chars: (tb.tool!.output ?? '').length
      }))
    }))
  )

  let placeholderChars = 0
  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i]
    const d = p.dialogue
    if (d.role === 'user') {
      messages.push(new HumanMessage(d.content))
      continue
    }
    if (p.blocks === null) {
      messages.push(new AIMessage(d.content))
      continue
    }
    if (p.toolBlocks.length === 0) {
      messages.push(new AIMessage(p.content))
      continue
    }

    const toolCalls = p.toolBlocks.map((tb, ti) => ({
      id: `hist_${d.id}_${ti}`,
      name: tb.tool!.name,
      args: tb.tool!.input
    }))
    messages.push(new AIMessage({ content: p.content, tool_calls: toolCalls }))

    const maskedTools = plan.masked.get(i)
    for (let ti = 0; ti < toolCalls.length; ti++) {
      const tool = p.toolBlocks[ti].tool!
      let content: string
      if (maskedTools?.has(ti)) {
        content = mainFormat(getFsToolTexts().compaction.observationMasked, {
          call: describeToolCall(tool),
          callId: toolCalls[ti].id
        })
        placeholderChars += content.length
      } else {
        // 智能裁剪：超长结果只留 head/中间标记/tail（完整内容在数据库 blocks 里）
        content = pruneToolOutput(tool.output ?? '')
      }
      messages.push(new ToolMessage({ content, tool_call_id: toolCalls[ti].id }))
    }
  }

  if (plan.maskedCount > 0) {
    const saved = Math.max(0, plan.maskedChars - placeholderChars)
    logger.info(
      `[History] Masked ${plan.maskedCount} old tool result(s), ~${saved.toLocaleString()} chars saved (topic=${topicId ?? 'none'})`
    )
  }
}
