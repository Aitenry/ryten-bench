import type { TFunction } from 'i18next'
import type { MessageBlock, StreamChunk, ToolCall } from '../../../../shared/harness/types'

/** Determine whether a tool block and a tool event are the same call.
 *  Match by callId first; the id from content-block-start and the callId from run.toolCalls come
 *  from different sources and may disagree, in which case fall back to name+status: a block with
 *  the same name that hasn't completed counts as the same call */
export const isSameToolCall = (
  blockTool: ToolCall,
  incoming: { id?: string; name: string }
): boolean => {
  if (incoming.id) {
    if (blockTool.id === incoming.id) return true
    // No id yet during preparing, so match by name
    if (!blockTool.id && blockTool.status === 'preparing' && blockTool.name === incoming.name)
      return true
    // Different id but same name and the block hasn't completed: content-block-start and
    // call.callId come from different sources, so fall back to name
    return !!(
      blockTool.id &&
      blockTool.status &&
      blockTool.status !== 'completed' &&
      blockTool.name === incoming.name
    )
  }
  return blockTool.name === incoming.name || blockTool.name === ''
}

/**
 * Compute the text delta, tolerating providers that send full text instead of a delta.
 * - If incoming extends previous, return only the appended suffix;
 * - otherwise treat it as a delta and return incoming as is.
 *
 * Note: no more "previous.endsWith(incoming) → ''" suffix dedup — the main process already
 * dedups by shape; with delta-shaped chunks an identical suffix is often genuinely repeated model
 * output (e.g. adjacent identical table rows, "OK, OK, …"), and misjudging it as a duplicate
 * resend drops real content and shifts every later delta.
 */
export const computeTextDelta = (incoming: string, previous: string): string => {
  if (incoming.startsWith(previous) && incoming.length > previous.length) {
    return incoming.slice(previous.length)
  }
  return incoming
}

/**
 * Append a new block to the end of the array; append only, never reorder based on agent state.
 * Merging/deduping is the caller's job, so the final order is exactly the event stream order.
 */
export const pushBlock = (blocks: MessageBlock[], block: MessageBlock): void => {
  blocks.push(block)
}

/**
 * Labels for in-progress/completed tools (shared with AssistantMessage rendering; tests assert
 * against the same source):
 * - preparing: the model has emitted the tool name and is generating arguments (phase two,
 *   "building arguments")
 * - executing: the system is running the arguments
 * - otherwise: static tool name
 * Not a component function: the translation is passed in by the caller as `t` (hooks can only be
 * called inside components/custom hooks).
 */
export const getToolStatusLabel = (
  t: TFunction,
  toolName: string,
  phase: 'preparing' | 'executing' | undefined
): string => {
  if (phase === 'preparing') return t('harness.helpers.toolPreparing', { name: toolName })
  if (phase === 'executing') return t('harness.helpers.toolExecuting', { name: toolName })
  return toolName
}

/**
 * Placeholder-name fallback: some providers register the first tool block without a tool name
 * (under the placeholder name 'tool'). When executing finds no matching preparing block by name,
 * fold it into the most recent placeholder block and rename it to the real tool name, so that no
 * ghost "tool · building arguments…" block coexists with the real tool block. Returns the index,
 * or -1 if not found.
 */
export const findPlaceholderPreparingTool = (blocks: MessageBlock[]): number => {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]
    if (b.type === 'tool' && b.tool?.status === 'preparing' && b.tool.name === 'tool') return i
  }
  return -1
}

/**
 * Streaming silence window threshold: when there is already visible output, loading is true, and
 * no new chunk arrives for this long, treat it as "the model is still generating but the stream
 * has no events" (typical of reasoning models going SSE-silent while generating large arguments),
 * and let the UI show a "generating…" shimmer line (honest, doesn't impersonate a tool name).
 */
export const STREAM_SILENCE_MS = 2500

/** Streaming silence indicator decision (pure logic, shared by test scripts and rendering) */
export const shouldShowSilenceIndicator = (args: {
  loading: boolean
  /** Any visible output yet (body text/reasoning/tool blocks/subagent blocks etc.) */
  hasStartedContent: boolean
  now: number
  /** Timestamp of the last received chunk (defaults to the message creation time) */
  lastChunkAt: number
}): boolean => {
  if (!args.loading || !args.hasStartedContent) return false
  return args.now - args.lastChunkAt >= STREAM_SILENCE_MS
}

/**
 * Whether a chunk carries "only body text" / "only reasoning": any other payload (tool, subagent,
 * memory injection, compaction, retry, error, goal-round marker, steering segment boundary)
 * counts as a boundary and must not be merged into the same text delta.
 */
const isPureTextChunk = (chunk: StreamChunk): boolean =>
  Boolean(chunk.content) &&
  !chunk.tool &&
  !chunk.reasoning_content &&
  !chunk.subAgent &&
  !chunk.memoryInjected &&
  !chunk.historyCompacted &&
  !chunk.historyCompacting &&
  !chunk.retrying &&
  !chunk.streamError &&
  !chunk.goalRound &&
  !chunk.steered

const isPureReasoningChunk = (chunk: StreamChunk): boolean =>
  Boolean(chunk.reasoning_content) &&
  !chunk.content &&
  !chunk.tool &&
  !chunk.subAgent &&
  !chunk.memoryInjected &&
  !chunk.historyCompacted &&
  !chunk.historyCompacting &&
  !chunk.retrying &&
  !chunk.streamError &&
  !chunk.goalRound &&
  !chunk.steered

/**
 * "Task segments" within a single assistant message — used to fold message content by task.
 *
 * Background: in a long reply, tool cards and reasoning spans can accumulate into hundreds of
 * blocks, and rendering cost is proportional to the **number of simultaneously mounted blocks**
 * (simulation bench: 375 blocks = 253–305KB per flush, 80 blocks = 77KB). After folding by task,
 * a folded task isn't rendered as a whole group, and cost drops with the number of visible blocks.
 *
 * Attribution rules (blocks and tasks have no link in storage, so they must be derived from the
 * stream):
 * - A `write_todos` tool block is a **segment boundary**: it carries a full snapshot of the list
 *   at that moment;
 * - The item marked `in_progress` in the snapshot is the task that the **immediately following**
 *   blocks belong to (the model starts a task before working on it);
 * - When the snapshot has no in_progress item (e.g. the final "all done" closing write), **no new
 *   segment starts**: subsequent blocks join the current segment, avoiding a meaningless empty
 *   task header;
 * - Blocks before the first write_todos (memory-injection card, body text before the wrap-up…)
 *   belong to the `task: null` segment, which shows no task header.
 */
export interface TaskSegment {
  /** Stable key: task name + occurrence index of that task (a restarted task with the same name won't clash) */
  key: string
  /** Task name; null = not part of any task (header content / unplanned blocks) */
  task: string | null
  /** Status of this task in the snapshot; null for the null segment */
  status: 'completed' | 'in_progress' | 'pending' | null
  /** Indices of the segment's blocks in the merged block array (original order preserved) */
  blockIndices: number[]
  /** Indices of write_todos blocks in the segment: no longer rendered in the body (the fold header's "list" expands them on demand instead) */
  writeIndices: number[]
  /** The **last** write_todos snapshot in the segment: what the "list" shows when opened */
  snapshot: { content: string; status: string }[]
}

/** Get the list items from a write_todos snapshot (returns null for non-write_todos blocks) */
const todoSnapshotOf = (block: MessageBlock): { content: string; status: string }[] | null => {
  if (block.type !== 'tool' || block.tool?.name !== 'write_todos') return null
  const todos = (
    block.tool.input as { todos?: { content?: string; status?: string }[] } | undefined
  )?.todos
  if (!Array.isArray(todos)) return null
  return todos.map((t) => ({ content: String(t?.content ?? ''), status: String(t?.status ?? '') }))
}

/** Get the "current task" from a write_todos snapshot */
const inProgressTaskOf = (block: MessageBlock): string | null => {
  const todos = todoSnapshotOf(block)
  if (!todos) return null
  return todos.find((t) => t.status === 'in_progress')?.content ?? null
}

/** Split the block sequence into task segments (pure function: takes blocks, returns segments, doesn't mutate its input)
 *
 *  `streaming`: whether the message is still streaming. Only affects the status derivation of the **last segment** — see below.
 */
export function buildTaskSegments(
  blocks: MessageBlock[],
  options: { streaming?: boolean } = {}
): TaskSegment[] {
  const segments: TaskSegment[] = []
  const seen = new Map<string, number>()
  const fresh = (extra: Partial<TaskSegment>): TaskSegment => ({
    key: 'segment-head',
    task: null,
    status: null,
    blockIndices: [],
    writeIndices: [],
    snapshot: [],
    ...extra
  })
  let current = fresh({})

  for (let i = 0; i < blocks.length; i += 1) {
    const snapshot = todoSnapshotOf(blocks[i])
    const started = inProgressTaskOf(blocks[i])
    if (started) {
      // Close the current segment first if it has content (empty segments produce nothing, so consecutive write_todos don't create empty task headers)
      if (current.blockIndices.length > 0) {
        // This write_todos is also the **closing snapshot** of the previous segment (it usually
        // marks the previous segment's task as completed). Record it in the previous segment:
        // otherwise that task stays in_progress in the previous segment's list forever while the
        // segment header dot is already green, and the two colors contradict each other (users
        // reported "there are colors everywhere"). It isn't part of the previous segment's body,
        // so it doesn't go into writeIndices.
        if (snapshot) current.snapshot = snapshot
        segments.push(current)
      }
      const nth = (seen.get(started) ?? 0) + 1
      seen.set(started, nth)
      current = fresh({ key: `segment-${nth}-${started}`, task: started, status: 'in_progress' })
    }
    current.blockIndices.push(i)
    if (snapshot) {
      current.writeIndices.push(i)
      current.snapshot = snapshot
    }
  }
  if (current.blockIndices.length > 0) segments.push(current)

  /**
   * Task status derivation (user, 2026-09-19: "all tasks are done, but it doesn't show green,
   * there are all sorts of colors").
   *
   * What the old implementation got wrong: a segment's status was written as 'in_progress' at
   * the moment the segment opened and never updated again — so ① even after new tasks had
   * already started (= this task ended long ago) it stayed blue; ② after a round finished, the
   * last "all done" write also landed in the final segment, whose dot stayed blue. Now status is
   * derived from "the last snapshot in the segment is the single source of truth", rules:
   *  - non-final segment: another task segment follows ⇒ this task has ended → completed (green);
   *  - final segment: look at this task's status in the **last snapshot of this segment**; if the
   *    snapshot doesn't contain it (renamed etc.), fall back to "still streaming → in_progress,
   *    otherwise completed" — once a round has ended it shouldn't show "in progress";
   *  - pending stays pending (gray); a task that hasn't started is never called complete.
   */
  return segments.map((segment, index) => {
    if (!segment.task) return segment
    const isLast = index === segments.length - 1
    if (!isLast) return { ...segment, status: 'completed' as const }
    const own = segment.snapshot.find((item) => item.content === segment.task)?.status
    if (own === 'pending') return { ...segment, status: 'pending' as const }
    if (own === 'completed') return { ...segment, status: 'completed' as const }
    return {
      ...segment,
      status: options.streaming ? ('in_progress' as const) : ('completed' as const)
    }
  })
}

/**
 * "Fold consecutive identical tool calls together" (user, 2026-09-25: "consecutive identical
 * tool calls need to be folded together").
 *
 * Motivation: after the early-exploration span stopped folding (another request from the same
 * day), a model reading 10 files in a row and grepping 5 times in a row in one round sprawls
 * into a dozen cards, and the expanded body becomes a wall again. Merging does just one thing:
 * collect **adjacent same-name tool blocks** into one collapsed group whose header says which
 * tool and how many times; clicking the card expands it and no content is lost.
 *
 * Rules (pure function, easy to assert offline):
 *  - Only **adjacent** same-name calls (`read_file → read_file`). Another tool, body text or
 *    reasoning in between breaks the run — those are two steps already, and merging them would
 *    hide the execution order;
 *  - A group needs length ≥ `TOOL_RUN_MIN`; a single call stays as-is (don't add a fold layer
 *    for one call);
 *  - Todo bookkeeping tools (write_todos / read_todos) **neither participate nor break**: they
 *    aren't rendered in the body (see AssistantMessage notes), so they're visually transparent
 *    anyway, and letting them cut a run of file reads in half would be wrong;
 *  - Non-tool blocks are returned as-is in order; the caller still renders them through the
 *    block-level cache.
 */
const HIDDEN_INLINE_TOOLS = new Set(['write_todos', 'read_todos'])

/** Minimum run length for grouping: 2 = two adjacent same-name calls merge into one group */
export const TOOL_RUN_MIN = 2

export type ToolRunEntry =
  { kind: 'block'; index: number } | { kind: 'run'; name: string; indices: number[] }

/** Merge a sequence of block indices into a render sequence of "single block / same-name tool group" (original order preserved) */
export function buildToolRuns(items: MessageBlock[], indices: number[]): ToolRunEntry[] {
  const out: ToolRunEntry[] = []
  let runName = ''
  let runIndices: number[] = []
  const flush = (): void => {
    if (runIndices.length >= TOOL_RUN_MIN) {
      out.push({ kind: 'run', name: runName, indices: runIndices })
    } else {
      for (const index of runIndices) out.push({ kind: 'block', index })
    }
    runName = ''
    runIndices = []
  }

  for (const index of indices) {
    const block = items[index]
    const name = block?.type === 'tool' ? block.tool?.name : undefined
    if (name && HIDDEN_INLINE_TOOLS.has(name)) continue
    if (name && name === runName) {
      runIndices.push(index)
      continue
    }
    flush()
    if (name) {
      runName = name
      runIndices = [index]
    } else {
      out.push({ kind: 'block', index })
    }
  }
  flush()
  return out
}

/**
 * Merge same-kind deltas in "cumulative shape" within a batch (body text / reasoning each form
 * their own span).
 *
 * Background (measured renderer memory, 2026-09-18): batching only reduces the number of React
 * commits; applying chunk by chunk still does `(accumulated text) + delta` at every step — with
 * a cumulative provider this is an O(L) full copy, and a reply of several hundred thousand
 * characters with twenty thousand deltas means O(L²) instant allocation (workingSet measured
 * going from 534MB to 5991MB; under long goal rounds this must OOM). In cumulative shape, "the
 * last chunk of a batch" already is the batch's full result, so using it to represent the whole
 * span keeps the downstream computeTextDelta semantics while cutting allocation to once per
 * batch.
 *
 * Only segments confirmed to be cumulative (last starts with first and is longer) are merged.
 * Merging delta-shaped segments (each carrying only the new fragment) would conflict with
 * computeTextDelta's cumulative detection semantics, so they are always kept as-is.
 */
export function coalesceChunks(batch: StreamChunk[]): StreamChunk[] {
  const out: StreamChunk[] = []
  let i = 0
  while (i < batch.length) {
    const head = batch[i]
    const kind: 'content' | 'reasoning_content' | null = isPureTextChunk(head)
      ? 'content'
      : isPureReasoningChunk(head)
        ? 'reasoning_content'
        : null

    if (!kind) {
      out.push(head)
      i += 1
      continue
    }

    let j = i + 1
    while (
      j < batch.length &&
      (kind === 'content' ? isPureTextChunk(batch[j]) : isPureReasoningChunk(batch[j]))
    ) {
      j += 1
    }

    const run = batch.slice(i, j)
    if (run.length > 1) {
      const first = String(run[0][kind] ?? '')
      const last = String(run[run.length - 1][kind] ?? '')
      if (last.length > first.length && last.startsWith(first)) {
        // Cumulative shape: the last chunk is the full text, collapse the whole span into one
        out.push({ ...run[run.length - 1] })
        i = j
        continue
      }
    }

    // Single chunk / delta shape: keep chunk-by-chunk, semantics identical to before batching
    out.push(...run)
    i = j
  }
  return out
}

/**
 * "Answer phase" detection (criterion chosen on 2026-09-25):
 * whether the **last non-content block** in the message is a closing `write_todos` — the list has
 * at least one `completed` item and no `in_progress` items. Returns its index in the block array
 * if so, otherwise -1.
 *
 * Why this signal: in real sessions (topic 237/292, 236/282) the block sequence is
 * `write_todos(task one) → one sentence → write_todos(task one done/task two) → one sentence →
 * … → final answer`, and while streaming the sentence at the end of each task looks exactly like
 * the final answer. Only this "list closed" write is the data-layer fact that the model is
 * **declaring "the work is done, what follows is the answer delivered to the user"** — only with
 * it can the final answer render outside the fold from the very beginning, without moving each
 * task's sentence out either, and without moving anything back and forth.
 *
 * The criterion is "the last non-content block", so a model that calls another tool after closing
 * the list (a self-contradictory case) naturally doesn't qualify: content pulled out live at that
 * point is put back into the fold (the only case that jumps, and only when the model changes its
 * mind).
 *
 * @param blocks renderer-side merged block array (or main-process accumulated blocks; both
 * append in arrival order)
 */
export function answerPhaseFrom(blocks: MessageBlock[]): number {
  let lastNonContent = -1
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const type = blocks[i]?.type
    if (type === 'reasoning' || type === 'text') continue
    lastNonContent = i
    break
  }
  if (lastNonContent < 0) return -1
  const block = blocks[lastNonContent]
  if (block.type !== 'tool' || block.tool?.name !== 'write_todos') return -1
  const todos = (block.tool.input as { todos?: { status?: string }[] } | undefined)?.todos
  if (!Array.isArray(todos) || todos.length === 0) return -1
  const statusOf = (item: { status?: string }): string => String(item?.status ?? '')
  if (todos.some((item) => statusOf(item) === 'in_progress')) return -1
  return todos.some((item) => statusOf(item) === 'completed') ? lastNonContent : -1
}

/**
 * Indices in the block array of the trailing "reasoning + body text" span (trailing consecutive
 * reasoning/text blocks, containing at least one text block).
 *
 * Same criterion as the main-process `answerTrailingCount` / `answerTailIndices` (scan backwards
 * until the first non-content block); the two renderer call sites share it: the fallback scan
 * after a round ends, and the live extraction in answer phase (`answerPhaseFrom`). Returns an
 * empty array when the span ends with reasoning (nothing to extract) — there is no answer
 * delivered to the user, so the fold keeps it.
 */
export function tailContentIndices(blocks: MessageBlock[], indices: readonly number[]): number[] {
  let cut = indices.length
  let sawText = false
  while (cut > 0) {
    const type = blocks[indices[cut - 1]]?.type
    if (type === 'text') {
      sawText = true
      cut -= 1
      continue
    }
    if (type === 'reasoning') {
      cut -= 1
      continue
    }
    break
  }
  return sawText ? indices.slice(cut) : []
}

/**
 * Answer boundary (protocol-layer source of truth) → block index set on the renderer side.
 *
 * The main process tags content chunks with `answer` and sends the `answerBlocks` count with the
 * done event (see plugins/harness/main/service/answer-boundary.ts). The renderer **reads, never
 * guesses**: here "the last N blocks are the answer" is translated into an index set over this
 * side's merged block array, with two guards —
 *   ① the count must fall within the array range (on protocol evolution/version mismatch, rather
 *      mark nothing than cut wrongly);
 *   ② the marked blocks must be reasoning/text.
 *
 * Returning null = definitively no answer (round aborted, only tools/reasoning, or the main
 * process retracted the marker); returning undefined = the main process gave no conclusion (old
 * version/error path) — the renderer keeps the old behavior then.
 *
 * @param blocks renderer-side merged block array (**transitional blocks that exist only on the
 * renderer side, e.g. retrying, must be filtered out first**)
 */
export function answerTailIndices(
  blocks: MessageBlock[],
  count: number | null | undefined
): Set<number> | null | undefined {
  if (count === undefined) return undefined
  if (count === null || count <= 0) return null
  if (count > blocks.length) return undefined
  const start = blocks.length - count
  const out = new Set<number>()
  for (let i = start; i < blocks.length; i += 1) {
    const type = blocks[i]?.type
    if (type !== 'reasoning' && type !== 'text') return undefined
    out.add(i)
  }
  return out
}

/**
 * Derive this side's current answer index set from **already accumulated markers** (recomputed on
 * every block during streaming).
 *
 * The criterion **must match the main process's `answerTrailingCount` word for word**: trailing
 * consecutive reasoning/text blocks **with at least one text block** count as the answer — a
 * reasoning-only tail doesn't (round aborted, or reasoning just started flowing and the body text
 * hasn't arrived yet). This was once missed: the renderer returned a set whenever the tail was
 * reasoning, so as soon as the final round's reasoning started flowing it was pulled outside the
 * fold, while the main process's boundary at the same moment was 0 — the two sides drew opposite
 * conclusions about the same shape.
 *
 * It uses this side's own block array, so differences in block counts between the two sides don't
 * matter (the renderer merges adjacent reasoning blocks and also has transitional blocks that
 * exist only on the renderer side). Returning null = no answer currently (the caller uses that to
 * put the answer back into the fold).
 */
export function answerMarkedIndices(blocks: MessageBlock[]): Set<number> | null {
  let start = blocks.length
  let sawText = false
  while (start > 0) {
    const type = blocks[start - 1]?.type
    if (type === 'text') {
      sawText = true
      start -= 1
      continue
    }
    if (type === 'reasoning') {
      start -= 1
      continue
    }
    break
  }
  if (!sawText) return null
  const out = new Set<number>()
  for (let i = start; i < blocks.length; i += 1) out.add(i)
  return out
}
