import { tool, type StructuredToolInterface } from '../../ai/tools'
import { z } from 'zod'
import logger from 'electron-log'
import {
  getTopicPlanMode,
  setTopicPlanMode
} from '../../database/mapper/harness/harness'
import { mainFormat } from '../../i18n'
import { getAgentToolTexts } from '../../i18n/tool-results-agent'
import {
  PLAN_REVIEW_APPROVE,
  PLAN_REVIEW_KEEP_PLANNING,
  PLAN_REVIEW_KIND
} from '../../../shared/harness/types'
import { questionService } from './ask'

/**
 * Plan mode — a per-topic boolean switch
 *
 * Mechanism (adapted to conversations organized by topicId):
 * - A boolean switch is persisted per topic (harness_topic.plan_mode) and survives restarts and
 *   topic switches;
 * - While active, the system prompt appends planning guidance: explore and design first, submit
 *   the full plan through `exit_plan_mode` for user review, and do not start work before approval;
 * - `exit_plan_mode` goes through the existing question channel (questionService → frontend
 *   PlanReviewModal): "approve" → leave plan mode and the model continues; "keep planning" →
 *   stay active, the feedback (optional free text) is returned to the model verbatim, and the
 *   model revises and calls again;
 * - Plan mode only constrains the prompt and tool list and **does not change the permission
 *   mode**: the sandbox and approvals work as usual (it is a "soft layer"; use permission modes
 *   for hard enforcement).
 *
 * State sync: the Runtime assembles prompts and tool lists synchronously per request, so the main
 * process reads state from an in-memory cache (`PlanModeStore`); `ensure(topicId)` backfills from
 * the database before each turn, so the first turn after process start does not miss a persisted
 * plan mode.
 */

/** Question id for plan review (the tool layer reads the answer by it) */
export const PLAN_REVIEW_ID = 'plan-review'
/** Question kind for plan review: the frontend renders a dedicated dialog (instead of the generic question dialog) based on it */
export { PLAN_REVIEW_KIND, PLAN_REVIEW_APPROVE, PLAN_REVIEW_KEEP_PLANNING }

/**
 * System prompt section appended while plan mode is active.
 *
 * A deployer-provided guidance text that constrains behavior through words only.
 * Written in English to stay consistent with the base persona and the sandbox section
 * (model-side prompts are all in English).
 */
const PLAN_MODE_GUIDANCE = `## Plan mode
You are in plan mode. The user wants to review and approve a plan before any work is carried out.

- Explore first: read the relevant files, trace the code, and check constraints before proposing anything. Do not modify files, run mutating commands, or start long-running work while planning.
- When the design is complete, call exit_plan_mode with the full plan as Markdown, beginning with a heading. The plan must be concrete enough to execute: ordered steps, files to touch, key decisions and their rationale, and any risks or open questions.
- The user reviews the plan. If they approve, plan mode ends and you carry out the plan from your next step. If they ask for changes, their feedback comes back in the tool result: revise the plan and call exit_plan_mode again.
- Do not call exit_plan_mode for partial plans or for simple questions that need no design work.`

export type PlanModeListener = (topicId: number, active: boolean) => void

/**
 * Plan mode store (process-level singleton, isolated per topicId).
 *
 * The in-memory cache lets the Runtime's synchronous assembly (prompt / tool list) read state;
 * the database is the only source of truth.
 */
export class PlanModeStore {
  private readonly cache = new Map<number, boolean>()

  /** Change callback (injected by the main process to broadcast harness-plan-updated to the plan mode badge in the UI) */
  onChange?: PlanModeListener

  /** Backfills a topic's plan mode from the database (returns the cache when present; read failures are treated as inactive) */
  async ensure(topicId: number): Promise<boolean> {
    if (topicId <= 0) return false
    const cached = this.cache.get(topicId)
    if (cached !== undefined) return cached
    try {
      const active = await getTopicPlanMode(topicId)
      this.cache.set(topicId, active)
      return active
    } catch (err) {
      logger.warn(`[PlanMode] Failed to read plan mode for topic ${topicId}:`, err)
      return false
    }
  }

  /** Synchronous read (reliable only for topics already ensured; unloaded topics are treated as inactive) */
  isActive(topicId: number): boolean {
    return this.cache.get(topicId) === true
  }

  /** Toggles and persists; broadcasts on success and returns the final state */
  async setActive(topicId: number, active: boolean): Promise<boolean> {
    if (topicId <= 0) return false
    await setTopicPlanMode(topicId, active)
    this.cache.set(topicId, active)
    logger.info(`[PlanMode] Plan mode ${active ? 'enabled' : 'disabled'} for topic ${topicId}`)
    try {
      this.onChange?.(topicId, active)
    } catch (err) {
      // A failed broadcast (window destroyed etc.) does not affect the state itself
      logger.warn('[PlanMode] Failed to broadcast plan mode change:', err)
    }
    return active
  }

  /** Drops the cache when a topic is deleted (rows are cascade-deleted with the topic) */
  forget(topicId: number): void {
    this.cache.delete(topicId)
  }

  /** Drops all in-memory state (used when switching account data spaces; same convention as GoalStore.reset) */
  reset(): void {
    this.cache.clear()
  }
}

/** Process-level singleton */
export const planModeStore = new PlanModeStore()

/** Plan mode prompt section (empty string when inactive; adds no tokens) */
export function planModePromptSection(active: boolean): string {
  return active ? `\n\n${PLAN_MODE_GUIDANCE}` : ''
}

/**
 * Builds the `exit_plan_mode` tool (injected into the main agent only while plan mode is active).
 *
 * User review reuses the existing question channel: the question body is the whole plan
 * (Markdown), rendered by a dedicated frontend dialog; answers use stable markers
 * (approve / keep-planning) rather than button texts, so switching the UI language does not
 * affect the decision.
 */
export function buildExitPlanModeTool(topicId: number): StructuredToolInterface {
  return tool(
    async ({ plan }, config) => {
      const tr = getAgentToolTexts()
      if (!planModeStore.isActive(topicId)) {
        return tr.plan.notActive
      }
      const trimmed = plan.trim()
      if (!trimmed) return tr.plan.emptyPlan

      let answer: Awaited<ReturnType<typeof questionService.ask>>
      try {
        answer = await questionService.ask(
          topicId,
          [
            {
              id: PLAN_REVIEW_ID,
              kind: PLAN_REVIEW_KIND,
              header: tr.plan.reviewHeader,
              question: trimmed,
              options: [
                { label: PLAN_REVIEW_APPROVE },
                { label: PLAN_REVIEW_KEEP_PLANNING }
              ]
            }
          ],
          config?.signal
        )
      } catch (err) {
        if ((err as Error)?.name === 'AskAbortedError') return tr.plan.aborted
        return mainFormat(tr.plan.reviewFailed, { message: (err as Error).message })
      }

      const item = answer.answers[0]
      const selected = item?.selected ?? []
      const feedback = item?.custom?.trim()
      if (selected.includes(PLAN_REVIEW_KEEP_PLANNING)) {
        // Keep active: the model revises the plan with the feedback and submits again within the same turn
        return mainFormat(tr.plan.keepPlanning, { feedback: feedback ? ` — ${feedback}` : '' })
      }
      if (selected.includes(PLAN_REVIEW_APPROVE)) {
        // Approval leaves plan mode: the next model request no longer injects the planning guidance / exit tool
        await planModeStore.setActive(topicId, false)
        return feedback
          ? mainFormat(tr.plan.approvedWithFeedback, { feedback })
          : tr.plan.approved
      }
      // No recognizable answer (dialog closed / empty answer): treat as "keep planning" to avoid a false approval
      return tr.plan.reviewNoAnswer
    },
    {
      name: 'exit_plan_mode',
      description:
        'Use only in plan mode. Present the completed plan (full Markdown, starting with a heading) for the user to review. The user may approve — plan mode then ends and you carry out the plan from your next step — or ask for changes; their feedback comes back in the tool result, so revise the plan and present it again. Do not use this tool for partial plans.',
      schema: z.object({
        plan: z
          .string()
          .describe(
            'The complete plan in Markdown, beginning with a heading: ordered steps, files to touch, key decisions and their rationale, risks and open questions.'
          )
      })
    }
  )
}
