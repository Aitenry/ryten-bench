import { tool, type StructuredToolInterface } from '../../ai/tools'
import { z } from 'zod'
import { randomUUID } from 'crypto'
import logger from 'electron-log'
import { mainFormat } from '../../i18n'
import { getFsToolTexts } from '../../i18n/tool-results-fs'
import { buildCancelledAnswer } from './question-cancel'

/**
 * Ask the user a question (ask_user_question).
 *
 * Mechanism:
 * - Ask a human while a tool runs: the tool node suspends and waits (the graph stays at the tools
 *   node); the answer is collected by the frontend dialog over IPC and written back, and the model
 *   continues the same loop with the answer (no extra turn consumed);
 * - Explicitly no timeout: aborted only by the turn's cancel signal (ASK_ABORTED); when the stream
 *   is cancelled all pending questions are rejected;
 * - Only the main agent holds this tool (subagents cannot ask; v1 keeps them without it).
 */

/** An option */
export interface AskOption {
  label: string
  description?: string
  /** Group key (e.g. provider type 'openai'), used by the frontend for tree grouping */
  group?: string
}

/** A single question */
export interface AskQuestion {
  id: string
  question: string
  header?: string
  options?: AskOption[]
  multi_select?: boolean
  /** Question kind (e.g. 'model-recovery' = "switch model and continue" after a failed model request; absent for normal questions) */
  kind?: string
  /** Failure reason when kind='model-recovery' (display only) */
  error?: string
  /** Label of the "give up" option when kind='model-recovery' (listed last and treated as abandon) */
  abandonLabel?: string
}

/** Answer (single choice takes the first item; multi-select is an array; empty selected with custom = user-typed "other") */
export interface AskAnswer {
  answers: Array<{ id: string; selected: string[]; custom?: string }>
  /**
   * The user clicked Cancel: this turn is **not aborted**; the tool returns this answer with
   * cancelled set and the model continues from it (see question-cancel.ts).
   */
  cancelled?: boolean
}

/** View of a pending question (broadcast to the frontend) */
export interface PendingQuestionView {
  topicId: number
  requestId: string
  questions: AskQuestion[]
}

interface PendingRecord extends PendingQuestionView {
  resolve: (answer: AskAnswer) => void
  reject: (err: Error) => void
  signal?: AbortSignal
  /** Abort handler for signal (removes the listener after settle/abort to avoid leaked closures) */
  onAbort?: () => void
}

export type AskListener = (pending: PendingQuestionView) => void

/** Question service (process-wide singleton: pending queue + IPC answer write-back) */
export class QuestionService {
  private readonly pending = new Map<string, PendingRecord>()

  /** New-question broadcast callback (injected by the main process to open the frontend dialog) */
  onAsk?: AskListener

  /**
   * A pending item settled (user answered / turn aborted) -> notify the UI that this session is
   * no longer waiting.
   *
   * Pairs with onAsk: a question's lifecycle = ask broadcast (onAsk) -> settle broadcast (here).
   * The sidebar's "waiting for confirmation" dot flips on both ends; missing the settle end
   * leaves it on forever.
   */
  onResolved?: (topicId: number) => void

  /** Settle broadcast: failure only means one missed UI flip and must not affect the settlement itself */
  private notifyResolved(topicId: number): void {
    try {
      this.onResolved?.(topicId)
    } catch {
      // Broadcast outlet is gone (window destroyed, etc.): ignore, settlement already completed
    }
  }

  /**
   * Suspend and wait for the user's answer.
   * When signal aborts -> throws ASK_ABORTED (the tool layer catches it and returns a cancel message).
   */
  ask(topicId: number, questions: AskQuestion[], signal?: AbortSignal): Promise<AskAnswer> {
    const tr = getFsToolTexts()
    return new Promise<AskAnswer>((resolve, reject) => {
      const requestId = `q-${randomUUID()}`
      const onAbort = (): void => {
        this.pending.delete(requestId)
        const err = new Error(tr.ask.aborted)
        err.name = 'AskAbortedError'
        reject(err)
        this.notifyResolved(topicId)
      }
      const record: PendingRecord = { topicId, requestId, questions, resolve, reject, signal }
      record.onAbort = onAbort
      this.pending.set(requestId, record)
      if (signal) {
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      try {
        // Broadcast only a serializable view: PendingRecord contains resolve/reject/signal and
        // passing it to webContents.send would throw "Failed to serialize arguments" (Electron structured clone)
        this.onAsk?.({
          topicId: record.topicId,
          requestId: record.requestId,
          questions: record.questions
        })
      } catch (err) {
        // Broadcast failed (serialization error / no window): clean up the pending record and
        // signal listener to avoid leaks and permanent hangs
        this.pending.delete(requestId)
        if (signal) signal.removeEventListener('abort', onAbort)
        reject(err instanceof Error ? err : new Error(String(err)))
        return
      }
      logger.info(`[Ask] Pending question requestId=${requestId} (${questions.length} questions)`)
    })
  }

  /** Remove the signal listener of a pending record (after settle it would otherwise stay attached until fired/GC) */
  private detach(record: PendingRecord): void {
    if (record.signal && record.onAbort) {
      record.signal.removeEventListener('abort', record.onAbort)
    }
  }

  /** User answered: write the answer back if the pending question exists, else return false */
  answer(requestId: string, answers: AskAnswer['answers']): boolean {
    const record = this.pending.get(requestId)
    if (!record) return false
    this.pending.delete(requestId)
    this.detach(record)
    record.resolve({ answers })
    this.notifyResolved(record.topicId)
    logger.info(`[Ask] Question ${requestId} answered (${answers.length} items)`)
    return true
  }

  /**
   * User cancelled: **do not abort the turn**; settle the pending item as `cancelled: true` and
   * let the model continue.
   *
   * Difference from `abortTopic`: abort makes the tool throw AskAbortedError (turn ends); here the
   * tool returns normally and the model decides the next step from the cancel flag instead of
   * waiting for the user.
   */
  cancel(requestId: string): boolean {
    const record = this.pending.get(requestId)
    if (!record) return false
    this.pending.delete(requestId)
    this.detach(record)
    record.resolve(buildCancelledAnswer(record.questions))
    this.notifyResolved(record.topicId)
    logger.info(`[Ask] Question ${requestId} cancelled by user (turn continues)`)
    return true
  }

  /** Read a topic's pending question (for frontend reload/restore) */
  getPending(topicId: number): PendingQuestionView | null {
    for (const record of this.pending.values()) {
      if (record.topicId === topicId) {
        return { topicId: record.topicId, requestId: record.requestId, questions: record.questions }
      }
    }
    return null
  }

  /** Abort all pending questions of a topic (called when a stream is cancelled) */
  abortTopic(topicId: number): void {
    const tr = getFsToolTexts()
    let settled = false
    for (const [id, record] of this.pending) {
      if (record.topicId !== topicId) continue
      this.pending.delete(id)
      this.detach(record)
      const err = new Error(tr.ask.aborted)
      err.name = 'AskAbortedError'
      record.reject(err)
      settled = true
    }
    if (settled) this.notifyResolved(topicId)
  }

  /** Abort all pending questions (app-level cancel fallback) */
  abortAll(): void {
    const tr = getFsToolTexts()
    const topics = new Set<number>()
    for (const [id, record] of this.pending) {
      this.pending.delete(id)
      this.detach(record)
      const err = new Error(tr.ask.aborted)
      err.name = 'AskAbortedError'
      record.reject(err)
      topics.add(record.topicId)
    }
    for (const topicId of topics) this.notifyResolved(topicId)
  }
}

/** Process-wide singleton */
export const questionService = new QuestionService()

const askOptionSchema = z.object({
  label: z.string().describe('Option text shown to the user'),
  description: z.string().optional().describe('One-sentence explanation of the option')
})

const askQuestionSchema = z.object({
  id: z.string().describe('Stable question id (echoed back verbatim in the answer)'),
  question: z.string().describe('The concrete question to ask the user'),
  header: z.string().optional().describe('Optional short heading'),
  options: z
    .array(askOptionSchema)
    .optional()
    .describe('Candidate options; without options the answer is free-form text'),
  multi_select: z
    .boolean()
    .optional()
    .describe('Whether multiple options may be selected (default false)')
})

/** Build the ask tool (injected into the main agent only) */
export function buildAskUserTool(fallbackTopicId = 0): StructuredToolInterface {
  return tool(
    async ({ questions }, config) => {
      const configurable = (config?.configurable ?? {}) as Record<string, unknown>
      const topicId =
        typeof configurable.topicId === 'number' && configurable.topicId > 0
          ? configurable.topicId
          : fallbackTopicId
      try {
        const answer = await questionService.ask(topicId, questions, config?.signal)
        return JSON.stringify(answer)
      } catch (err) {
        const tr = getFsToolTexts()
        if ((err as Error)?.name === 'AskAbortedError') {
          return tr.ask.abortedDetail
        }
        return mainFormat(tr.ask.failed, { message: (err as Error).message })
      }
    },
    {
      name: 'ask_user_question',
      description:
        'Ask the user one or more questions and wait for the answers within the same turn (the conversation does not end). Use it when you cannot continue without user input: choosing between approaches, confirming a permission or a destructive action, or filling in missing critical information. Ask several questions at once when they belong together. Put the recommended option first and append "(Recommended)" to its label. For choice questions the UI appends an extra "Other" choice that lets the user type their own answer, so do not add your own "Other" option. The answers arrive as JSON: { answers: [{ id, selected: string[], custom? }] }. For a choice question selected normally holds one element (single) or the checked ones (multi); when the user typed a free-form / "Other" answer, selected may be empty and custom holds the typed text instead. If the user cancels instead of answering, the result is { answers: [], cancelled: true } and you must continue on your best judgment without waiting or asking again.',
      schema: z.object({
        questions: z
          .array(askQuestionSchema)
          .describe('Questions to ask, in the order they should be shown')
      })
    }
  )
}
