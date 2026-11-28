import {
  BaseMessage,
  HumanMessage,
  AIMessage,
  ToolMessage,
  SystemMessage,
  type MessageContentComplex
} from '../../ai/messages'
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
import {
  dialogueBudgetChars,
  planReplayImages,
  planReplayToolImages,
  userMessageContent
} from '../../runtime/harness/image-replay'

/**
 * Dialogue record from the database (trimmed view, avoids circular dependencies).
 * Types are still derived from the drizzle schema; no more hand-copied fields.
 */
export type HistoryDialogue = Pick<
  HarnessDialogueRow,
  'id' | 'topic_id' | 'role' | 'content' | 'blocks' | 'created_at'
>

/** History loader callback: returns dialogue records for a topicId */
export type LoadHistoryFn = (topicId: number) => Promise<HistoryDialogue[]>

/** Adapts reasoning content that models such as DeepSeek-R1 return in additional_kwargs */
interface ReasoningMessage {
  additional_kwargs?: {
    reasoning_content?: string
    reasoning?: string
  }
}

/**
 * Extract structured message output from the message list
 */
export function extractStructuredMessages(messages: BaseMessage[]): StructuredMessage[] {
  const result: StructuredMessage[] = []
  const toolOutputs = new Map<string, string>()

  // First pass: collect all tool outputs
  for (const msg of messages) {
    if (msg.type === 'tool') {
      const tm = msg as unknown as { tool_call_id: string; content: unknown }
      const rawContent = tm.content
      const content = typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent)
      toolOutputs.set(tm.tool_call_id, content)
    }
  }

  // Second pass: extract content and tool calls
  for (const msg of messages) {
    if (msg.type === 'human') continue

    // Reasoning content
    const reasoningContent = (msg as unknown as ReasoningMessage).additional_kwargs
      ?.reasoning_content
    if (reasoningContent) {
      result.push({ reasoning_content: reasoningContent })
    }

    // Text content
    const content = typeof msg.content === 'string' ? msg.content : ''
    if (content) {
      result.push({ content })
    }

    // Tool calls
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
 * Default character budget for historical context: the default when no model context window is
 * configured (20,000 chars). The actual budget adjusts dynamically with the current model's
 * context window (see HistoryConvertOptions.contextBudget); chars ≈ tokens is a conservative
 * conversion (1:1 for Chinese, more conservative for English).
 */
export const DEFAULT_HISTORY_BUDGET = 20_000

/** Maximum number of split retries when a summary request exceeds the window (prompt too long) */
const MAX_PTL_RETRIES = 3
/** After this many consecutive compaction failures, stop auto-compaction (circuit breaker) to avoid burning tokens every turn */
const MAX_CONSECUTIVE_COMPACTION_FAILURES = 3
/** Post-compaction re-injection: restore at most this many recently read/modified files */
const RESTORE_MAX_FILES = 5
/** Per-file limit for re-injection (chars; conservative 1 char ≈ 1 token) */
const RESTORE_PER_FILE_CHARS = 5_000
/** Total limit for re-injection (chars) */
const RESTORE_TOTAL_CHARS = 25_000

/**
 * Topic → consecutive compaction failure count (process-level).
 *
 * Why needed: after a compaction failure it falls back to character truncation, but the next
 * turn's pressure is still over the limit and the summary model is called again; some sessions
 * (huge single output, model does not support long input) fail every turn and burn tokens. Once
 * consecutive failures reach the limit, automatic compaction is skipped until a success occurs or
 * the user triggers it manually.
 */
const compactionFailureStreak = new Map<number, number>()

/** History context conversion result */
export interface HistoryContext {
  messages: BaseMessage[]
  /** Whether truncation happened (earlier dialogues omitted; no longer happens when summary compaction is available) */
  truncated: boolean
  /** Whether summary compaction happened (early dialogues compressed into a checkpoint summary) */
  compacted?: boolean
  /** Summary compaction info newly produced this turn (only carried on boundary advance / first compaction, for the frontend card) */
  compaction?: HistoryCompaction
}

/** History conversion options (summary compaction can be opted in) */
export interface HistoryConvertOptions {
  /** Character budget (defaults to DEFAULT_HISTORY_BUDGET; injected as converted from the current model's context window) */
  maxChars?: number
  /** Summarizer callback: injected by HarnessService using the current model; when absent, over-budget history falls back to character truncation */
  summarizer?: SummarizerFn
  /** Topic ID (cache key) */
  topicId?: number
  /** Read an existing compaction checkpoint (persisted table; absent = none) */
  getCheckpoint?: (topicId: number) => Promise<CompactionCheckpoint | undefined>
  /** Persist the compaction checkpoint (persisted table; absent = not saved) */
  saveCheckpoint?: (topicId: number, checkpoint: CompactionCheckpoint) => Promise<void>
  /** Compaction start callback: called immediately before the LLM summary call once this turn is confirmed to produce a new compaction event */
  onCompactionStart?: () => void
  /** Cancellation signal: on abort/cancel, skip summary compaction and do not persist a checkpoint (the frontend "stop" reaches the compaction chain) */
  signal?: AbortSignal
  /**
   * Context size actually returned by the previous model call (tokens): when present, compaction
   * pressure is judged by real tokens (window × 79%), otherwise it falls back to the character
   * heuristic (budget × 0.7). See context-pressure.ts.
   */
  measuredContextTokens?: number | null
  /** Current model context window (tokens); converted together with measuredContextTokens to pressure; missing either falls back to the character measure */
  contextWindowTokens?: number | null
  /** For post-compaction re-injection: read a file by virtual path (returns error on failure; absent = do not restore files) */
  readFile?: (virtualPath: string) => { content: string } | { error: string }
  /** For post-compaction re-injection: current short state such as todos/plan (may be empty; absent = no injection) */
  restoreNote?: () => string
}

/** Character cost of one dialogue (content + blocks; images in user rows count as an estimate, see image-replay) */
function dialogueChars(d: HistoryDialogue): number {
  return dialogueBudgetChars(d)
}

/**
 * Whether this is an "in-turn interjection" row (a user message inserted while a reply was being
 * generated).
 *
 * The criterion is the blocks marker written at persistence time (`{type:'interjection'}`) — not
 * content or timing guesses. When blocks parsing fails, treat it as a normal dialogue (better to
 * carry the context once too often than to drop a user message).
 *
 * Current state: interjections are **injection-only** (not persisted, not part of the dialogue
 * stream), so no row carries this marker right now and this always returns false — purely
 * defensive: if interjections are persisted later, replay must exclude them, otherwise the same
 * request would be sent to the model twice (and replay order would become "reply then question").
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

/** Whether the compaction circuit breaker is open (consecutive failures reached the limit) */
function compactionCircuitOpen(topicId: number): boolean {
  return (compactionFailureStreak.get(topicId) ?? 0) >= MAX_CONSECUTIVE_COMPACTION_FAILURES
}

/** Record one compaction failure: log one line when the limit is reached (only once, to avoid log spam) */
function noteCompactionFailure(topicId: number): void {
  const next = (compactionFailureStreak.get(topicId) ?? 0) + 1
  compactionFailureStreak.set(topicId, next)
  if (next === MAX_CONSECUTIVE_COMPACTION_FAILURES) {
    logger.warn(
      `[History] Compaction circuit opened topic=${topicId} after ${next} consecutive failures; automatic compaction is paused until a run succeeds`
    )
  }
}

/** Compaction succeeded: reset the failure count and resume automatic compaction */
function noteCompactionSuccess(topicId: number): void {
  compactionFailureStreak.delete(topicId)
}

/**
 * Convert database dialogue records into a BaseMessage array.
 *
 * Context compaction strategy (threshold/retention mechanism):
 * 1. When pressure is reached and a summarizer is provided: compact the oldest stretch of
 *    dialogue with one (or several chunked) LLM calls into a checkpoint summary (persisted in the
 *    topic_compactions table, one row per topic). Pressure is preferably judged by **real
 *    tokens**: the context actually consumed by the previous model call ÷ the model window ≥ 79%
 *    (including system prompt, tool schemas, injected memory); only when usage_metadata is
 *    unavailable does it fall back to the heuristic "history chars ≥ budget × 0.7". See
 *    runtime/harness/context-pressure.ts for the decision logic.
 *    Subsequent turns reuse the existing summary directly as long as "existing summary +
 *    uncompacted new content" stays within budget, without re-compacting (except when real tokens
 *    are already over the threshold: the reused context is just as large, so only incremental
 *    merging makes it smaller); only when over budget again is the oldest part of the new content
 *    incrementally merged into the summary (one call, chunked when too long);
 * 2. No summarizer or summary failure: fall back to the original character-budget truncation
 *    (omit earlier dialogues + a header note);
 * 3. Tool results all go through pruning (pruneToolOutput); the original content stays in the
 *    database for exact replay.
 */
export async function convertDialoguesToMessages(
  dialogues: HistoryDialogue[],
  options?: HistoryConvertOptions
): Promise<HistoryContext> {
  const maxChars = options?.maxChars ?? DEFAULT_HISTORY_BUDGET
  // In-turn interjection (steering) rows do not enter model context: they were already read by
  // the model as a HumanMessage during this turn and are already reflected in the same turn's
  // assistant output; replaying them would repeat the same request (and since they are persisted
  // before the assistant row, replay order would invert "reply then question"). The frontend
  // still renders them as-is.
  const replayable = dialogues.filter((d) => !isInterjectionRow(d))
  const totalChars = replayable.reduce((sum, d) => sum + dialogueChars(d), 0)

  // Compaction pressure: prefer the real tokens returned by the previous turn (including system
  // prompt / tool schema / injected memory — that is what the model actually saw); fall back to
  // the character heuristic when unavailable. One log line per turn makes it easy to check in the
  // field "why did this turn compact / why not".
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

  // Summary compaction path: pressure reached and a summarizer is available
  if (options?.summarizer && options.topicId != null && pressure.triggered) {
    if (compactionCircuitOpen(options.topicId)) {
      // Circuit open after consecutive failures: skip automatic compaction (fall back to the
      // character truncation below) and wait for one success or a manual trigger to recover
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
        // Summary failed: fall back to character truncation; the previously persisted old
        // checkpoint is kept and can still be reused by later turns
        noteCompactionFailure(options.topicId)
        compactionError(err)
      }
    }
  }

  // Fallback path: select the most recent dialogues backwards until the accumulated chars exceed
  // the budget (keep at least the last one)
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

  // Truncation note: placed first to tell the model that early history was omitted
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

/** Split dialogues from the tail by character budget: returns { old, recent } (old is the oldest part, possibly empty) */
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
 * Cancellation-aware summary call: returns null when signal is already aborted or the request is
 * aborted mid-flight (AbortError), and the caller skips compaction and checkpoint persistence (a
 * user cancel leaves no compaction side effects and is not reported as a failure); other errors
 * are thrown as usual (handled by the "summary failed → character truncation" fallback).
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
 * Summary compaction orchestration (checkpoint persisted in the topic_compactions table; compact
 * once and reuse afterwards):
 *
 * - No checkpoint, or boundary moved backwards (dialogues deleted): initial full summary (split
 *   the oldest stretch by the retention budget), persist, report the compaction card;
 * - Existing summary + uncompacted new content ≤ total budget: reuse the existing summary
 *   directly, bring all uncompacted dialogues into the context, no LLM call, no compaction card —
 *   this is the core of "compact once, reuse after": new dialogues only grow the uncompacted
 *   stretch, and as long as the total stays within budget it never compacts twice;
 *   **Exception**: when pressure is judged by real tokens and is over the threshold, reuse is not
 *   allowed (the reused context is just as large), so the incremental merge below must run,
 *   otherwise every turn would loop "over threshold → reuse → still over threshold";
 * - Total over budget (full again): only the oldest part of the uncompacted stretch (the part
 *   beyond the retention budget) is incrementally merged into the existing summary; after one
 *   call it is persisted and the compaction card is reported, and it can then absorb a lot of new
 *   dialogue; when the pending stretch exceeds the per-call transcript limit, summarize in order
 *   by chunk (each chunk carries the previous chunk's result), so the compaction request itself
 *   never exceeds the window.
 *
 * Returning null means there is no oldest stretch that needs compaction (the caller falls back to
 * the regular path).
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
   * Transcript limit for one summary call: no more than half the character budget (the budget is
   * the window converted at 1 char ≈ 1 token), capped by COMPACTION_CHUNK_CHARS.
   *
   * Why chunking is needed: real-token triggering happens later than the character measure, so
   * the stretch to compact can be several times larger than the old implementation handled
   * (especially at 4 chars/token for English); stuffing it all into one summary model call would
   * blow up the compaction request itself.
   */
  const chunkLimit = Math.max(8_000, Math.min(COMPACTION_CHUNK_CHARS, Math.floor(maxChars / 2)))
  const lastDialogueId = dialogues[dialogues.length - 1].id
  const prior = options.getCheckpoint ? await options.getCheckpoint(topicId) : undefined

  // No checkpoint / boundary moved backwards (dialogues deleted, summary contains deleted
  // content): initial or full re-summary
  if (!prior || prior.boundaryId > lastDialogueId) {
    const { old, recent } = splitByBudget(dialogues, retainBudget)
    if (old.length === 0) return null
    options.onCompactionStart?.()
    // User already cancelled (aborted after onCompactionStart was pushed, before the call): skip
    // compaction and persistence, return to the regular path
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

  // Existing checkpoint valid: uncompacted new content = all dialogues after the boundary
  const pending = dialogues.filter((d) => d.id > prior.boundaryId)
  const pendingChars = pending.reduce((sum, d) => sum + dialogueChars(d), 0)

  // Reuse branch: summary + uncompacted new content within the total budget → reuse directly, no
  // LLM call. The uncompacted dialogues (even far beyond the retention budget) all go into the
  // context, and compaction happens only once the total is over budget again.
  //
  // Exception: when real tokens already exceed the threshold, reuse is **not** allowed — the
  // reused context is just as large as now and the next turn is still over the threshold, so it
  // spins (no LLM call, no shrink) and compaction never happens. In that case the incremental
  // merge must run to actually fold the oldest stretch into the summary.
  if (!pressure.tokenBased && prior.summary.length + pendingChars <= maxChars) {
    logger.info(
      `[History] Reusing existing compaction summary topicId=${topicId} (boundary ${prior.boundaryId}, uncompacted ${pending.length} messages / ${pendingChars} chars, summary + uncompacted ${prior.summary.length + pendingChars} <= ${maxChars})`
    )
    const messages: BaseMessage[] = [buildCheckpointMessage(prior.summary)]
    appendDialogueMessages(messages, pending, topicId)
    // Reuse is not a new compaction event: do not re-inject again (otherwise every turn would
    // carry an extra 25K chars of old files)
    return { messages, truncated: false, compacted: true }
  }
  if (pressure.tokenBased && prior.summary.length + pendingChars <= maxChars) {
    logger.info(
      `[History] Skip checkpoint reuse topicId=${topicId}: ${formatPressure(pressure)} >= ${(TOKEN_PRESSURE_RATIO * 100).toFixed(0)}% of the model window (chars would allow reuse), merging oldest pending messages instead`
    )
  }

  // Full again: incrementally merge the oldest part of the uncompacted stretch (beyond the
  // retention budget) into the existing summary
  const { old, recent } = splitByBudget(pending, retainBudget)
  if (old.length === 0) {
    // Edge case: a single dialogue exceeds the retention budget, so keeping the entire
    // uncompacted stretch also exceeds the total budget — a full re-summary would be needed (a
    // transcript including the existing summary would be distorted; incremental semantics are
    // closest: merge the whole stretch), but old being empty means retainBudget covers all of
    // pending, so nothing is compacted and it is carried as-is (the premise that the budget check
    // passed does not hold), falling back conservatively to the regular path.
    return null
  }
  options.onCompactionStart?.()
  if (options.signal?.aborted) return null
  const chunks = chunkByChars(old, dialogueChars, chunkLimit)
  const summary = await summarizeChunks(options, chunks, prior.summary)
  if (summary === null || options.signal?.aborted) return null
  // The old context already contained prior.summary, so count it in the comparison; otherwise a
  // small incremental merge would be misjudged as "did not shrink"
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

/** Pressure description for logs: `tokens 82.4%` / `chars 71.2%` */
function formatPressure(pressure: ContextPressure): string {
  return `${pressure.tokenBased ? 'tokens' : 'chars'} ${(pressure.ratio * 100).toFixed(1)}%`
}

/** Whether a summary request was rejected for "context too long (prompt too long)" (wording differs per provider; catch them all) */
function isPromptTooLongError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /context (length|window)|maximum context|too many tokens|prompt is too long|context_length_exceeded|CONTEXT_WINDOW_EXCEEDED|reduce the length|request too large|413/i.test(
    message
  )
}

/**
 * Chunked summary: call the summarizer chunk by chunk, each chunk carrying the previous result as
 * priorSummary for incremental merging.
 *
 * When any chunk fails (null) or the user cancels, the whole thing returns null — **never persist
 * a half checkpoint**: the boundary must correspond to a complete summary, and half of one would
 * make the next turn's boundary mismatch its summary content.
 *
 * Over-window retry: the chunk limit is only an estimate and real tokens may still exceed it
 * (Chinese/JSON underestimated). On "prompt too long", **split the current chunk in half** and
 * retry (at most [`MAX_PTL_RETRIES`] times) rather than dropping the oldest content — the value of
 * a summary is in the old content, so dropping it is worse than not compacting.
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

/** Persist the checkpoint (failure does not block this turn, only loses persistence for reuse) */
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

/** Assemble compacted messages: checkpoint → recent dialogues → re-injection (recent files + todos) */
async function assembleCompactedMessages(
  summary: string,
  recent: HistoryDialogue[],
  summarized: HistoryDialogue[],
  options: HistoryConvertOptions
): Promise<BaseMessage[]> {
  const messages: BaseMessage[] = [buildCheckpointMessage(summary)]
  appendDialogueMessages(messages, recent, options.topicId)
  // Files already present in the recent window are not injected again (otherwise the same file
  // appears twice in the context, possibly one stale and one fresh)
  await appendRestoredContext(messages, summarized, options, new Set(recentFilePaths(recent)))
  return messages
}

/**
 * A summary must be smaller than the content it replaces, otherwise give up this compaction (the
 * "inflation circuit breaker").
 *
 * The summary model occasionally emits content longer than the original (restating the whole
 * text, runaway formatting); persisting such a summary makes the next turn exceed the threshold
 * again immediately, wasting a call. Throw and let the caller fall back to character truncation.
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
 * Post-compaction re-injection: put the recent read/modified file contents and current todos back
 * into the context.
 *
 * Why needed: a summary is lossy — the model just read a 300-line file, and after compaction all
 * that remains is one sentence in the summary saying "app.ts was modified"; without re-injection
 * it has to explore again. After compaction, re-read up to 5 recent files from the same workspace
 * snapshot, capped at 5K chars per file and 25K chars in total.
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
  // Right after the checkpoint and before the recent dialogues: the model reads the summary
  // first, then the restored files
  messages.splice(1, 0, new SystemMessage([header, ...blocks, note].filter(Boolean).join('\n\n')))
}

/** Paths recently read/modified in the compacted stretch (deduplicated in reverse chronological order, at most [`RESTORE_MAX_FILES`]) */
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

/** Parsed dialogue blocks (one parse shared by the cleanup plan and message assembly) */
type DialogueBlocks = { type: string; text?: string; tool?: ToolCallDetail; reasoning?: string }[]

interface ParsedDialogue {
  dialogue: HistoryDialogue
  /** null when blocks parsing fails (falls back to plain text, no tool structure) */
  blocks: DialogueBlocks | null
  toolBlocks: DialogueBlocks
  content: string
}

/** Parse one dialogue's blocks (parse once, so the cleanup plan and assembly do not each parse again) */
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

/** Call description for the placeholder: tool name + key argument (path/command/pattern), truncated to 120 chars */
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
 * Append the selected dialogues as message objects.
 *
 * Tool results are handled in three tiers (strategy in runtime/harness/observation-mask.ts):
 * - Recent window (last N tool-call pairs / last 2 user turns): keep the content, clipping long
 *   ones by head/tail;
 * - Older, replayable results: replace the whole thing with a placeholder (keeping the tool_call
 *   id and args, never breaking the pairing);
 * - Rows whose blocks fail to parse: fall back to plain text (better a bit less structure than a
 *   lost message).
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
  const replayImages = planReplayImages(selected)
  // Old tool results replaced by observation cleanup no longer replay their images (images follow
  // only tool results that are still visible)
  const maskedToolKeys = new Set<string>()
  for (let i = 0; i < parsed.length; i++) {
    const masked = plan.masked.get(i)
    if (!masked) continue
    for (const toolIndex of masked) maskedToolKeys.add(`${parsed[i].dialogue.id}:${toolIndex}`)
  }
  const replayToolImages = planReplayToolImages(selected, maskedToolKeys)
  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i]
    const d = p.dialogue
    if (d.role === 'user') {
      // Images replay by budget (the most recent N): previously only text was replayed here, so
      // "an image the user posted was only valid in the first turn"
      messages.push(new HumanMessage({ content: userMessageContent(d, replayImages.has(d.id)) }))
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
        // Smart pruning: long results keep only head / middle marker / tail (the full content is
        // in the database blocks)
        content = pruneToolOutput(tool.output ?? '')
      }
      messages.push(new ToolMessage({ content, tool_call_id: toolCalls[ti].id }))
    }

    // Tool result images (read_image): same as real-time execution — append one user image
    // message after all tool results of this assistant message so later turns can still see the
    // images (subject to image-replay's budget).
    const toolImages = replayToolImages.get(d.id)
    if (toolImages && toolImages.length > 0) {
      const fsTexts = getFsToolTexts()
      const blocks: MessageContentComplex[] = [
        {
          type: 'text',
          text: toolImages
            .map((image) =>
              mainFormat(fsTexts.readImage.attached, { tool: image.tool, path: image.path })
            )
            .join('\n')
        }
      ]
      for (const image of toolImages) {
        blocks.push({ type: 'image_url', image_url: { url: image.dataUrl } })
      }
      messages.push(new HumanMessage({ content: blocks }))
    }
  }

  if (plan.maskedCount > 0) {
    const saved = Math.max(0, plan.maskedChars - placeholderChars)
    logger.info(
      `[History] Masked ${plan.maskedCount} old tool result(s), ~${saved.toLocaleString()} chars saved (topic=${topicId ?? 'none'})`
    )
  }
}
