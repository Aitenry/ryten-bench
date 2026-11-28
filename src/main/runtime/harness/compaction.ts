/**
 * Context compaction.
 *
 * Two arms:
 * 1. Smart tool-result pruning (pruneToolOutput, no model cost):
 *    - Runs on the history re-feed path (convertDialoguesToMessages); live tool execution is
 *      bounded inline by the spill policy (spill.ts);
 *    - Replay-safe: the full original result stays in the session record (harness_dialogue.blocks);
 *      the pruned text only enters this round's model context.
 *    - Older, replayable results are cleared to placeholders on re-feed (observation masking, see
 *      runtime/harness/observation-mask.ts and history.ts) — the call structure is kept and only
 *      the content is cleared.
 * 2. LLM summary compaction (summarizeDialogues + persisted topic_compactions checkpoints):
 *    - Pressure trigger: **prefer real tokens** — compaction fires when the context used by the
 *      previous model call is >= 79% of the window (see context-pressure.ts; this includes the
 *      system prompt, tool schemas and injected memory). Without usage_metadata it falls back to
 *      the character heuristic: total history chars >= window * PRESSURE_RATIO (0.7). After
 *      triggering, the oldest stretch of conversation becomes a structured checkpoint while the
 *      most recent RETAIN_RATIO portion stays as-is; a stretch exceeding the per-call transcript
 *      limit is merged incrementally in chunks so the request itself does not overflow the window;
 *    - Persistence reuse: checkpoints live in topic_compactions (one row per topic). If the boundary
 *      has not advanced (no new dialogue entered the compacted range), the existing summary is
 *      reused with no LLM call; if it advanced, only the newly added early dialogue is merged into
 *      the summary and the row is updated after one call;
 *    - Failure fallback: on summary failure, fall back to the previous character-budget truncation
 *      behavior, keeping the old checkpoint for reuse next time.
 */

import type { BaseChatModel } from '../../ai/chat-model'
import { HumanMessage, SystemMessage } from '../../ai/messages'
import logger from 'electron-log'
import { mainFormat } from '../../i18n'
import { getFsToolTexts } from '../../i18n/tool-results-fs'
import { invokeWithModelRecovery } from './model-recovery'
import { extractCheckpointText } from './summary-format'

/** Inline budget per tool result when re-feeding history (characters) */
export const TOOL_RESULT_PRUNE_CHARS = 4_000
/** Pruning keeps this many head characters */
const PRUNE_HEAD_CHARS = 2_800
/** Pruning keeps this many tail characters */
const PRUNE_TAIL_CHARS = 1_000

/**
 * Character-based compaction pressure threshold (0.7): **a fallback used only when real tokens
 * are unavailable**.
 * The real-token threshold is TOKEN_PRESSURE_RATIO (0.79) in context-pressure.ts.
 */
export const PRESSURE_RATIO = 0.7
/** Retain ratio: the most recent 20% of the dialogue stays as-is and is not summarized */
export const RETAIN_RATIO = 0.2
/** Target cap for summary output (characters, a prompt constraint rather than a hard cut) */
const SUMMARY_TARGET_CHARS = 2_000

/** Wrapper text for the landed checkpoint */
const CHECKPOINT_PREAMBLE =
  'The following is an automatic compacted summary (checkpoint) of earlier conversation. Treat it as established background and continue the task directly; do not restate or acknowledge it:'

/** Compaction instruction (adds an `<analysis>` scratchpad and a verbatim "User Messages" section for recall) */
const COMPACTION_INSTRUCTION = `You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.

First think in a private <analysis> block: walk the transcript briefly and note (a) what the user asked for, (b) what was actually completed, (c) what failed and why, (d) what is still pending. Use a few terse bullets. The analysis is a scratchpad: it is stripped before the checkpoint is shown to the resumed model, so use it to avoid missing important details.

Then output the checkpoint inside <summary></summary>, using EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section. Write the content in the same language as the conversation.

## Primary Request and Intent
- [the user's original and evolving goals; quote verbatim where the exact wording matters]
## Key Technical Concepts
- [technologies, frameworks, patterns, and conventions in play]
## Files and Code
- [exact path: why it matters, key changes or snippets]
## Errors and Fixes
- [error: how it was resolved, plus any related user feedback]
## User Messages
- [verbatim quotes of the user's explicit instructions, corrections and preferences, in order; keep exact wording where it matters]
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
- Output only the <analysis> and <summary> blocks: do not call any tool or take any other action.
- If the conversation already contains a <compacted-summary> block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.
Keep the checkpoint within ${SUMMARY_TARGET_CHARS} characters (the analysis is stripped, but keep it short anyway).`

/** Shape of one transcript record fed to summarization */
export interface TranscriptDialogue {
  role: 'user' | 'assistant'
  content: string
  blocks?: string | null
}

/** Build role-annotated transcript text (with tool call names and result snippets so the summarizer can see what was done) */
export function buildTranscript(dialogues: TranscriptDialogue[]): string {
  const lines: string[] = []
  for (const d of dialogues) {
    if (d.role === 'user') {
      lines.push(`[user] ${d.content}`)
      continue
    }
    // Assistant message: text blocks + tool block summaries
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
        // blocks failed to parse: use content only
      }
    }
    lines.push(`[assistant] ${text}`)
  }
  return lines.join('\n')
}

/** Summary callback contract: transcript is the early-dialogue transcript, priorSummary the existing summary (passed when merging incrementally) */
export type SummarizerFn = (transcript: string, priorSummary?: string) => Promise<string>

/** Build a standard AbortError (callers recognize it by name as user cancel and give up silently) */
function compactionAbortError(): Error {
  const err = new Error('Compaction aborted')
  err.name = 'AbortError'
  return err
}

/**
 * Generate a checkpoint summary with the LLM (one call, text output only; failures throw and the
 * caller falls back). With signal wired through: throw AbortError immediately if already aborted
 * (no request is made); an abort mid-request rejects via model.invoke as AbortError, truly
 * interrupting the summary call (no more wasted tokens).
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
  // Keep only the <summary> body (<analysis> scratchpad never enters context); if the model ignored the format, keep the full text
  const summary = extractCheckpointText(text)
  if (!summary) throw new Error(getFsToolTexts().compaction.summaryEmpty)
  return summary
}

/** Recovery environment for compaction model calls (retry progress reporting + identity needed for the model-switch prompt) */
export interface SummarizeRecoveryEnv {
  topicId: number
  /** Call origin: 'goal-round' automatic continuation rounds skip the model-switch prompt */
  turnSource?: string
  signal?: AbortSignal
  /** Automatic retry progress (attempt/retries): the IPC layer pushes a "retrying" transition chunk */
  onRetry?: (attempt: number, retries: number) => void
}

/**
 * Summary call with automatic retry and model-switch fallback (same recovery semantics as
 * callModel, sharing one executor):
 * - Classify first: permanent errors (auth, missing model, rejected request, oversized context, unsupported image) throw at once;
 *   transient errors (rate limit, 5xx, network, gateway timeout) retry in place within budget, reporting progress via env.onRetry each attempt (frontend shows "retrying (N/M)" beside the "compacting…" card);
 * - If transient retries are exhausted and prompting is allowed (main topic, not a goal auto round), suspend with a model-switch choice and re-compact in place with the chosen model (checkpoint kept, no silent truncation);
 *   if the user gives up or prompting is unavailable, throw so the caller falls back to character-budget truncation (old checkpoint preserved).
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

/** Build the landed checkpoint message (placed at the head of messages so the model treats it as established background) */
export function buildCheckpointMessage(summary: string): SystemMessage {
  return new SystemMessage(
    `${CHECKPOINT_PREAMBLE}\n\n<compacted-summary>\n${summary}\n</compacted-summary>`
  )
}

/** Compaction checkpoint (persisted in topic_compactions, one row per topic) */
export interface CompactionCheckpoint {
  /** Last dialogue record id of the summarized stretch (the boundary; later runs merge only newly added early dialogue) */
  boundaryId: number
  summary: string
}

/**
 * Tool-result pruning: when over budget keep a bounded head/tail and replace the middle with an
 * omission marker. Returns the input unchanged when within budget (zero cost).
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

/** Safe error formatting for logs */
export function compactionError(err: unknown): void {
  logger.warn('[Compaction] Summary compaction failed, falling back to character-budget truncation:', err)
}
