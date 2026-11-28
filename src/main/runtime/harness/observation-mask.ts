/**
 * Observation masking policy — pure functions, no IO / no electron dependency, easy to unit test.
 *
 * Practical experience: old tool results account for the vast majority of history tokens, but
 * what the model really needs is "what was done and what the conclusion was", not the raw bytes.
 * The safest and cheapest compression is to **keep the tool-call structure and replace old
 * result content with placeholders** — never delete messages themselves (`tool_calls` and tool
 * results must stay paired; deleting one side returns 400).
 *
 * This module answers one question: given a time-ordered conversation (including its tool
 * calls), which tool results can be cleared? What text replaces them and how messages are
 * written back is history.ts's job.
 */

/** Mutable tools: results are replayable/reproducible; losing them just means reading again */
export const MASKABLE_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'grep',
  'glob',
  'ls',
  'execute',
  'web_fetch'
])

export interface ObservationMaskPolicy {
  /** The most recent this many **tool calls** are kept verbatim (8 is a stable practical value) */
  keepToolPairs: number
  /** Tool results within the most recent this many **user turns** are kept verbatim (one task chain often spans several turns) */
  keepUserTurns: number
  /** Results shorter than this many characters are not masked: little is saved and noise increases */
  minChars: number
}

export const DEFAULT_OBSERVATION_POLICY: ObservationMaskPolicy = {
  keepToolPairs: 8,
  keepUserTurns: 2,
  minChars: 500
}

export interface MaskableToolCall {
  name: string
  /** Character count of this tool result (pass 0 for missing/empty results) */
  chars: number
}

export interface MaskableDialogue {
  role: 'user' | 'assistant'
  tools: MaskableToolCall[]
}

export interface ObservationMaskPlan {
  /** Conversation index → set of tool indexes to mask within that conversation */
  masked: Map<number, Set<number>>
  /** Number of masked results */
  maskedCount: number
  /** Total original character count of masked results (excluding placeholders) */
  maskedChars: number
}

/**
 * Computes the mask plan.
 *
 * Protection boundary: accumulate from the newest conversation backwards until both "user
 * turns >= keepUserTurns" and "tool calls >= keepToolPairs" hold; the boundary **includes**
 * that conversation (kept entirely). In conversations before the boundary, only results that
 * belong to [`MASKABLE_TOOLS`] and are at least `minChars` long are masked.
 *
 * Why slice by "conversation row" instead of by message: in this project's data model one
 * assistant conversation row carries all of its own tool_calls and results, so slicing between
 * rows never splits a pair.
 */
export function planObservationMask(
  dialogues: MaskableDialogue[],
  policy: Partial<ObservationMaskPolicy> = {}
): ObservationMaskPlan {
  const merged: ObservationMaskPolicy = { ...DEFAULT_OBSERVATION_POLICY, ...policy }
  const keepTurns = Math.max(0, merged.keepUserTurns)
  const keepPairs = Math.max(0, merged.keepToolPairs)
  const minChars = Math.max(0, merged.minChars)

  let userTurns = 0
  let toolCalls = 0
  let boundary = 0
  for (let i = dialogues.length - 1; i >= 0; i--) {
    if (dialogues[i].role === 'user') userTurns++
    toolCalls += dialogues[i].tools.length
    if (userTurns >= keepTurns && toolCalls >= keepPairs) {
      boundary = i
      break
    }
  }

  const masked = new Map<number, Set<number>>()
  let maskedCount = 0
  let maskedChars = 0
  for (let i = 0; i < boundary; i++) {
    const tools = dialogues[i].tools
    if (tools.length === 0) continue
    const set = new Set<number>()
    for (let t = 0; t < tools.length; t++) {
      const tool = tools[t]
      if (!MASKABLE_TOOLS.has(tool.name)) continue
      if (tool.chars < minChars) continue
      set.add(t)
      maskedCount++
      maskedChars += tool.chars
    }
    if (set.size > 0) masked.set(i, set)
  }

  return { masked, maskedCount, maskedChars }
}
