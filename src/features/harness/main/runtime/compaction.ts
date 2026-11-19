/**
 * 上下文压缩（compaction）— 对应 deepseek-harness 的 compaction 体系
 * （dsh-compaction / dsh-compaction-tool-result-pruner / dsh-compaction-basic）
 *
 * 两臂（参考 DSH 机制）：
 * 1. 工具结果智能裁剪（pruneToolOutput，无模型成本）：
 *    - 在历史回灌路径（convertDialoguesToMessages）执行，实时工具执行由溢出策略
 *      （spill.ts）负责内联上限；
 *    - 回放安全：原始完整结果保留在会话记录（harness_dialogue.blocks），裁剪文本只进
 *      本轮模型上下文（参考 dsh-compaction-tool-result-pruner）。
 * 2. LLM 摘要压缩（summarizeDialogues + topic_compactions 持久化 checkpoint）：
 *    - 压力触发：历史字符总量 ≥ 窗口 × PRESSURE_RATIO 时，把最老一段对话用一次
 *      LLM 调用压缩为结构化 checkpoint，最近 RETAIN_RATIO 段保持原样
 *      （参考 dsh-compaction-basic 的 thresholdRatio/retainRatio）；
 *    - 持久化复用：checkpoint 落库（topic_compactions，每话题一行）。压缩边界
 *      未推进（无新对话进入压缩段）时直接复用既有摘要，不重复调用 LLM；
 *      边界推进（上下文又超预算）时只把新增的早期对话增量合并进既有摘要，
 *      一次调用后更新落库；
 *    - 失败兜底：摘要失败时回退为原有字符预算截断行为（旧 checkpoint 保留，
 *      下次仍可复用）。
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import logger from 'electron-log'
import { mainFormat } from '../../../../main/i18n'
import { getFsToolTexts } from '../../../../main/i18n/tool-results-fs'
import { invokeWithModelRecovery } from './model-recovery'

/** 历史回灌时单个工具结果的内联预算（字符） */
export const TOOL_RESULT_PRUNE_CHARS = 4_000
/** 裁剪保留：头部字符数 */
const PRUNE_HEAD_CHARS = 2_800
/** 裁剪保留：尾部字符数 */
const PRUNE_TAIL_CHARS = 1_000

/** 压缩压力阈值比例：历史总量 ≥ 窗口 × 0.7 即触发摘要压缩（字符启发式，略保守于 DSH 的 0.8，补偿中文/JSON 低估） */
export const PRESSURE_RATIO = 0.7
/** 保留比例：最近 20% 的对话保持原样不参与摘要（DSH retainRatio=0.16） */
export const RETAIN_RATIO = 0.2
/** 摘要输出的目标上限（字符，提示词约束，非硬截断） */
const SUMMARY_TARGET_CHARS = 2_000

/** checkpoint 落地包裹文案（参考 DSH CHECKPOINT_PREAMBLE，英文改写） */
const CHECKPOINT_PREAMBLE =
  'The following is an automatic compacted summary (checkpoint) of earlier conversation. Treat it as established background and continue the task directly; do not restate or acknowledge it:'

/** 压缩指令（结构逐字保留 DSH COMPACTION_INSTRUCTION，统一英文） */
const COMPACTION_INSTRUCTION = `You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.

Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section. Write the content in the same language as the conversation.

## Primary Request and Intent
- [the user's original and evolving goals; quote verbatim where the exact wording matters]
## Key Technical Concepts
- [technologies, frameworks, patterns, and conventions in play]
## Files and Code
- [exact path: why it matters, key changes or snippets]
## Errors and Fixes
- [error: how it was resolved, plus any related user feedback]
## Pending Jobs
- [explicitly requested work not yet completed]
## Current Work
- [precisely what was in progress at this checkpoint]
## Next Step
- [the single next action, directly in line with the most recent request, or "(none)"]
## Critical Context
- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]

Rules:
- Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.
- Capture user feedback and explicit instructions faithfully, especially corrections.
- Do NOT mention this summarization request or that the context was compacted.
- Output only the checkpoint text: do not call any tool or take any other action.
- If the conversation already contains a <compacted-summary> block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.
Complete the output within ${SUMMARY_TARGET_CHARS} characters.`

/** 摘要输入单条记录形态 */
export interface TranscriptDialogue {
  role: 'user' | 'assistant'
  content: string
  blocks?: string | null
}

/** 构建角色标注的对话转录文本（含工具调用名与结果概要，供摘要器理解已完成的工作） */
export function buildTranscript(dialogues: TranscriptDialogue[]): string {
  const lines: string[] = []
  for (const d of dialogues) {
    if (d.role === 'user') {
      lines.push(`[user] ${d.content}`)
      continue
    }
    // 助手消息：文本块 + 工具块概要
    let text = d.content
    if (d.blocks) {
      try {
        const blocks = JSON.parse(d.blocks) as Array<{
          type: string
          text?: string
          tool?: { name: string; input?: Record<string, unknown>; output?: string }
        }>
        const textBlocks = blocks.filter((b) => b.type === 'text').map((b) => b.text || '')
        const toolBlocks = blocks.filter((b) => b.type === 'tool' && b.tool)
        if (textBlocks.length > 0) text = textBlocks.join('\n')
        for (const tb of toolBlocks) {
          const inputText = JSON.stringify(tb.tool?.input ?? {}).slice(0, 300)
          const outputText = (tb.tool?.output ?? '').slice(0, 800)
          lines.push(`[tool call] ${tb.tool?.name} (input: ${inputText})`)
          if (outputText) lines.push(`[tool result] ${outputText}`)
        }
      } catch {
        // blocks 解析失败：仅用 content
      }
    }
    lines.push(`[assistant] ${text}`)
  }
  return lines.join('\n')
}

/** 摘要回调契约：transcript 为早期对话转录，priorSummary 为既有摘要（增量合并时传入） */
export type SummarizerFn = (transcript: string, priorSummary?: string) => Promise<string>

/** 构造标准 AbortError（调用方按 name 识别为「用户取消」，静默放弃而非报错） */
function compactionAbortError(): Error {
  const err = new Error('Compaction aborted')
  err.name = 'AbortError'
  return err
}

/**
 * 用 LLM 生成 checkpoint 摘要（一次调用，只取文本输出；失败抛错由调用方兜底）。
 * signal 贯通后：已中止时立即抛 AbortError（不发起请求）；请求途中中止由底层
 * model.invoke 以 AbortError 拒绝，真正中断摘要调用（不再白烧 token）。
 */
export async function summarizeDialogues(
  model: BaseChatModel,
  transcript: string,
  priorSummary?: string,
  signal?: AbortSignal
): Promise<string> {
  if (signal?.aborted) throw compactionAbortError()
  const mergeBlock = priorSummary
    ? `Existing checkpoint (the prior summary to preserve):\n<compacted-summary>\n${priorSummary}\n</compacted-summary>\n\nEarlier conversation added after that summary — merge it into the checkpoint above:\n\n${transcript}`
    : `Conversation to compact:\n\n${transcript}`
  const response = await model.invoke(
    [
      new SystemMessage(
        'You are a conversation compaction engine. Output only the checkpoint text and call no tools.'
      ),
      new HumanMessage(`${mergeBlock}\n\n${COMPACTION_INSTRUCTION}`)
    ],
    { signal }
  )
  const text =
    typeof response.content === 'string'
      ? response.content
      : (response.content as Array<{ type?: string; text?: string }>)
          .filter((c) => c && c.type === 'text')
          .map((c) => c.text || '')
          .join('')
  const summary = text.trim()
  if (!summary) throw new Error(getFsToolTexts().compaction.summaryEmpty)
  return summary
}

/** 摘要压缩模型调用的恢复环境（重试进度上报 + 换模型询问所需身份） */
export interface SummarizeRecoveryEnv {
  topicId: number
  /** 调用来源：'goal-round' 的目标自动续跑轮不弹换模型询问 */
  turnSource?: string
  signal?: AbortSignal
  /** 自动重试进度（第 attempt/retries 次）：由 IPC 层推送「正在重试」过渡 chunk */
  onRetry?: (attempt: number, retries: number) => void
}

/**
 * 带自动重试与「换模型继续」兜底的摘要调用（与正文 callModel 同款恢复语义，共用同一个执行器）：
 * - 失败先分类：永久性错误（鉴权/模型不存在/请求被拒/上下文超长/图片不支持）直接抛错，
 *   不重试也不弹窗；瞬时错误（限流/5xx/网络/网关超时）原地自动重试各自预算内的次数，
 *   每次重试前经 env.onRetry 上报进度（前端展示「正在重试（第 N/M 次）」并保持「正在压缩…」卡）；
 * - 瞬时错误重试耗尽且允许询问（主话题、非目标自动轮）→ 挂起弹出换模型选择，用户选定后
 *   用新模型在原位置重新压缩（不丢弃既有 checkpoint、不静默回退截断）；
 * - 用户放弃/询问不可用 → 抛错，由调用方回退字符预算截断（旧 checkpoint 保留复用）。
 */
export async function summarizeDialoguesWithRecovery(
  model: BaseChatModel,
  transcript: string,
  priorSummary?: string,
  env?: SummarizeRecoveryEnv
): Promise<string> {
  let activeModel = model
  return await invokeWithModelRecovery({
    label: '[Compaction]',
    ctx: {
      topicId: env?.topicId ?? 0,
      turnSource: env?.turnSource,
      signal: env?.signal
    },
    call: () => summarizeDialogues(activeModel, transcript, priorSummary, env?.signal),
    onRetry: (attempt, retries) => env?.onRetry?.(attempt, retries),
    onSwitch: (next) => {
      activeModel = next
    }
  })
}

/** 组装 checkpoint 落地消息（置于消息头，模型视作既定背景） */
export function buildCheckpointMessage(summary: string): SystemMessage {
  return new SystemMessage(
    `${CHECKPOINT_PREAMBLE}\n\n<compacted-summary>\n${summary}\n</compacted-summary>`
  )
}

/** 压缩 checkpoint（持久化于 topic_compactions 表，每话题一行） */
export interface CompactionCheckpoint {
  /** 已摘要段的最末对话记录 id（边界；后续只合并新增的早期对话） */
  boundaryId: number
  summary: string
}

/**
 * 工具结果裁剪：超预算时保留有界头/尾，中间替换为省略标记。
 * 未超预算时原样返回（无成本）。
 */
export function pruneToolOutput(text: string, budget = TOOL_RESULT_PRUNE_CHARS): string {
  if (!text || text.length <= budget) return text
  const omitted = text.length - PRUNE_HEAD_CHARS - PRUNE_TAIL_CHARS
  const head = text.slice(0, PRUNE_HEAD_CHARS)
  const tail = text.slice(-PRUNE_TAIL_CHARS)
  const marker = mainFormat(getFsToolTexts().compaction.toolResultPruned, {
    omitted: omitted.toLocaleString()
  })
  return `${head}\n${marker}\n${tail}`
}

/** 供日志使用的安全错误格式化 */
export function compactionError(err: unknown): void {
  logger.warn('[Compaction] 摘要压缩失败，回退字符预算截断:', err)
}
