import { tool, type StructuredToolInterface } from '../../ai/tools'
import { z } from 'zod'
import { randomUUID } from 'crypto'
import logger from 'electron-log'
import {
  getGoalByTopic,
  upsertGoal,
  deleteGoalByTopic,
  type GoalRow
} from '../../database/mapper/harness/goal'
import { mainFormat } from '../../i18n'
import { getAgentToolTexts } from '../../i18n/tool-results-agent'

/**
 * Conversation goal system (goal)
 *
 * Mechanics (adapted to conversations organized by topicId in this project):
 * - Each topic has at most one current goal (single-goal semantics); revision increments by 1 on
 *   every change, and tool updates must carry {goal_id, revision} (CAS optimistic concurrency;
 *   a stale revision is rejected with GOAL_STALE_REVISION);
 * - State machine: active ⇄ paused / → blocked / → complete; blocked can only be entered from
 *   active;
 * - activation (armed/disarmed) is in-memory: only an armed goal lets the round driver
 *   auto-continue; a process restart always leaves it disarmed (activation is not persisted), and
 *   when the user asks to "continue" → resume re-arms it;
 * - authority is checked at execution time: create/edit/pause/resume require a direct human
 *   request (the turn was initiated by a user message); complete/blocked accept a direct human
 *   request or an exact match of the current goal round (the goal source injected by an
 *   auto-continuation round); an autonomous round may additionally report blocked only when
 *   roundsStarted ≥ 3 (i.e. at least 3 auto-continuation rounds have completed, matching
 *   "at least 3 rounds have passed" in the injected prompt).
 */

/** Goal view (shared by tool output and the frontend) */
export interface GoalView {
  id: string
  revision: number
  objective: string
  phase: 'active' | 'paused' | 'blocked' | 'complete'
  roundsStarted: number
  maxGoalRounds: number
  blockedReason?: { code: string; message: string }
  /** In-memory state: armed = auto-continuation is armed / disarmed = auto-continuation is stopped */
  activation: 'armed' | 'disarmed'
}

/** Blocking reason (categorized by a stable lowercase kebab-case code) */
export interface GoalBlockedReason {
  code: string
  message: string
}

/** Update action (matches the update_goal actions) */
export type GoalUpdateAction = 'edit' | 'pause' | 'resume' | 'complete' | 'blocked'

/**
 * Minimum number of rounds already started before an autonomous round (self-reported by the model)
 * may mark the goal blocked (default threshold).
 * Counted in "auto-continuation rounds": rounds are settled at dispatch time, so reaching this
 * value means the third auto-continuation round is currently in progress (equivalent to "at least
 * 3 rounds have passed" in the injected prompt).
 */
export const MIN_ROUNDS_FOR_BLOCK = 3
/** Default round limit */
export const DEFAULT_MAX_GOAL_ROUNDS = 256

/** Source of this turn (injected via graph configurable.turnSource) */
export type TurnSource = 'user' | 'goal-round'

/** Goal round source info (injected by the driver for auto-continuation rounds; used for round-level authority checks on complete/blocked) */
export interface GoalRoundSource {
  goalId: string
  revision: number
  round: number
}

/** configurable snapshot of a goal tool call */
interface GoalToolConfig {
  turnSource?: TurnSource
  goalRound?: GoalRoundSource
}

export type GoalUpdateListener = (topicId: number, goal: GoalView | null) => void

/** Goal store (process-level singleton, isolated by topicId; PGlite persistence + in-memory armed state) */
export class GoalStore {
  private readonly cache = new Map<number, GoalView>()
  private readonly armedTopics = new Set<number>()

  /** Change callback (injected by the main process, broadcasts harness-goal-updated) */
  onChange?: GoalUpdateListener

  private static fromRow(row: GoalRow): GoalView {
    let blockedReason: GoalView['blockedReason']
    if (row.blocked_reason) {
      try {
        blockedReason = JSON.parse(row.blocked_reason) as GoalBlockedReason
      } catch {
        blockedReason = { code: 'unknown', message: row.blocked_reason }
      }
    }
    return {
      id: row.goal_id,
      revision: row.revision,
      objective: row.objective,
      phase: row.phase,
      roundsStarted: row.rounds_started,
      maxGoalRounds: row.max_goal_rounds,
      blockedReason,
      activation: 'disarmed'
    }
  }

  /** Read the topic's current goal (DB → cache); the armed state is layered on from the in-memory Set */
  async load(topicId: number): Promise<GoalView | null> {
    const cached = this.cache.get(topicId)
    if (cached) {
      return { ...cached, activation: this.armedTopics.has(topicId) ? 'armed' : 'disarmed' }
    }
    try {
      const row = await getGoalByTopic(topicId)
      if (!row) return null
      const view = GoalStore.fromRow(row)
      this.cache.set(topicId, view)
      return { ...view, activation: 'disarmed' }
    } catch (err) {
      logger.error('[Goal] Failed to read goal:', err)
      return null
    }
  }

  /**
   * After this round ends, will the driver automatically dispatch another round? (Basis for the
   * round-finalization fallback decision)
   *
   * This mirrors the dispatch gates in GoalRoundDriver.driveOnce one by one — those three gates are
   * "phase === 'active'", "isArmed", and "roundsStarted < maxGoalRounds (otherwise mark blocked and
   * stop)", which are equivalent to the three lines below. Deliberately kept inside the store rather
   * than scattered across call sites: once the goal stops, nobody closes out the checklist's
   * "in progress" item (this is exactly how the user-reported bug of 2026-09-23 — "everything is
   * done but the last item still shows as unfinished" — happened), and getting this decision wrong
   * leaves the frontend spinning forever, so there must be only one place for it. The
   * test/verify-todo-closeout.mjs harness calls this method directly.
   */
  async willContinue(topicId: number): Promise<boolean> {
    const goal = await this.load(topicId)
    if (goal?.phase !== 'active' || !this.isArmed(topicId)) return false
    return goal.roundsStarted < goal.maxGoalRounds
  }

  /** Persist, refresh the cache, and broadcast the change */
  private async persist(topicId: number, view: GoalView): Promise<GoalView> {
    await upsertGoal({
      topic_id: topicId,
      goal_id: view.id,
      revision: view.revision,
      objective: view.objective,
      phase: view.phase,
      rounds_started: view.roundsStarted,
      max_goal_rounds: view.maxGoalRounds,
      blocked_reason: view.blockedReason ? JSON.stringify(view.blockedReason) : null
    })
    this.cache.set(topicId, view)
    logger.info(
      `[Goal] Goal persisted topicId=${topicId} id=${view.id} phase=${view.phase} round=${view.roundsStarted}/${view.maxGoalRounds} revision=${view.revision}`
    )
    this.onChange?.(topicId, { ...view, activation: this.isArmed(topicId) ? 'armed' : 'disarmed' })
    return view
  }

  /** CAS check: goal id + revision must match the current values */
  private assertCurrent(goalId: string, revision: number, view: GoalView | null): GoalView {
    const m = getAgentToolTexts()
    if (!view) throw new Error(m.goal.noGoal)
    if (view.id !== goalId || view.revision !== revision) {
      throw new Error(
        mainFormat(m.goal.staleRevision, {
          marker: 'GOAL_STALE_REVISION',
          current: view.revision,
          provided: revision
        })
      )
    }
    return view
  }

  /**
   * Create a goal: only allowed when there is no goal or the existing goal is complete.
   * On success, auto-continuation is armed.
   *
   * roundsStarted counts from **0**: it means "the number of auto-continuation rounds already
   * started"; the user turn that creates the goal does **not** count as a round.
   * (It previously counted from 1, which made the first auto-continuation round label itself
   * "round 2" — the message badge said round 2 and the goal bar showed 2/40 while only 1
   * continuation had actually run; the prompt sent to the model said "Automatic continuation round
   * 2/40" as well. Now that the counter matches the "auto round" semantics, all three places agree:
   * the first continuation is round 1.)
   */
  async create(
    topicId: number,
    objective: string,
    maxGoalRounds = DEFAULT_MAX_GOAL_ROUNDS
  ): Promise<GoalView> {
    const current = await this.load(topicId)
    if (current && current.phase !== 'complete') {
      throw new Error(
        mainFormat(getAgentToolTexts().goal.alreadyInProgress, { phase: current.phase })
      )
    }
    const view: GoalView = {
      id: `goal-${randomUUID()}`,
      revision: 1,
      objective: objective.trim(),
      phase: 'active',
      roundsStarted: 0,
      maxGoalRounds,
      activation: 'armed'
    }
    const persisted = await this.persist(topicId, view)
    // Arm only after a successful persistence (fix: memory state used to be changed before the DB
    // write, so a failed write left a fake armed-but-goal-less state behind)
    this.armedTopics.add(topicId)
    logger.info(
      `[Goal] Goal created topicId=${topicId} id=${view.id} (maxGoalRounds=${maxGoalRounds}, auto-continuation rounds start from round 1)`
    )
    return persisted
  }

  /** Update the goal (CAS + state machine transitions; authority is validated first by the caller (tool layer)) */
  async update(
    topicId: number,
    goalId: string,
    revision: number,
    action: GoalUpdateAction,
    fields?: {
      objective?: string
      maxGoalRounds?: number
      blockedReason?: GoalBlockedReason
    }
  ): Promise<GoalView> {
    const current = await this.load(topicId)
    // Shallow-copy before mutating (fix: the cached object returned by load used to be mutated
    // directly — when persist failed, the cache carried unpersisted fake state and later load/CAS
    // calls read dirty data)
    const base = this.assertCurrent(goalId, revision, current)
    const view: GoalView = { ...base }
    const m = getAgentToolTexts()
    let armChange: 'add' | 'delete' | null = null

    switch (action) {
      case 'edit': {
        if (fields?.objective != null) view.objective = fields.objective.trim()
        if (fields?.maxGoalRounds != null && fields.maxGoalRounds > 0) {
          view.maxGoalRounds = fields.maxGoalRounds
        }
        break
      }
      case 'pause': {
        if (view.phase !== 'active') {
          throw new Error(mainFormat(m.goal.cannotPause, { phase: view.phase }))
        }
        view.phase = 'paused'
        armChange = 'delete'
        break
      }
      case 'resume': {
        if (view.phase === 'complete') throw new Error(m.goal.cannotResumeComplete)
        if (view.roundsStarted >= view.maxGoalRounds) {
          throw new Error(mainFormat(m.goal.cannotResumeRoundLimit, { limit: view.maxGoalRounds }))
        }
        view.phase = 'active'
        view.blockedReason = undefined
        armChange = 'add'
        break
      }
      case 'complete': {
        if (view.phase === 'complete') throw new Error(m.goal.alreadyComplete)
        view.phase = 'complete'
        armChange = 'delete'
        break
      }
      case 'blocked': {
        if (view.phase !== 'active') {
          throw new Error(mainFormat(m.goal.cannotBlock, { phase: view.phase }))
        }
        view.phase = 'blocked'
        view.blockedReason = fields?.blockedReason ?? {
          code: 'unspecified',
          message: m.goal.defaultBlockedReason
        }
        armChange = 'delete'
        break
      }
      default:
        throw new Error(mainFormat(m.goal.unknownAction, { action }))
    }

    view.revision += 1
    const persisted = await this.persist(topicId, view)
    // Apply the armed-state change only after a successful DB write (fix: memory state used to be
    // changed before the write, causing divergence on failure)
    if (armChange === 'add') {
      this.armedTopics.add(topicId)
    } else if (armChange === 'delete') {
      this.armedTopics.delete(topicId)
    }
    return persisted
  }

  /** Settle an auto-continuation round: roundsStarted + 1 (called by the driver after the round completes) */
  async incrementRound(topicId: number): Promise<GoalView | null> {
    const current = await this.load(topicId)
    if (!current || current.phase !== 'active') return current
    // Copy before mutating (fix: mutating the cached object directly left unpersisted fake state
    // when persist failed)
    return this.persist(topicId, {
      ...current,
      roundsStarted: current.roundsStarted + 1,
      revision: current.revision + 1
    })
  }

  /** Clean up the goal when a topic is deleted (DB + cache + armed state) */
  async delete(topicId: number): Promise<void> {
    this.cache.delete(topicId)
    this.armedTopics.delete(topicId)
    try {
      await deleteGoalByTopic(topicId)
    } catch (err) {
      logger.error('[Goal] Failed to delete goal:', err)
    }
  }

  isArmed(topicId: number): boolean {
    return this.armedTopics.has(topicId)
  }

  arm(topicId: number): void {
    this.armedTopics.add(topicId)
  }

  disarm(topicId: number): void {
    this.armedTopics.delete(topicId)
  }

  /**
   * Discard all in-memory state (cache + armed state); the next access re-reads from the database.
   *
   * Used when switching the account data space: topicId is an **auto-increment id within each
   * account's database**, so after switching databases the same id may belong to another account's
   * topic — without clearing, the previous account's goal/armed state would be applied to the new
   * account's topic. The policy matches a "process restart": always disarmed after an account
   * switch.
   */
  reset(): void {
    this.cache.clear()
    this.armedTopics.clear()
  }
}

/** Process-level singleton: shared across requests (same pattern as todoStore) */
export const goalStore = new GoalStore()

/** Extract this turn's source info from the tool config */
function readToolConfig(config?: Record<string, unknown>): GoalToolConfig {
  const c = (config ?? {}) as unknown as GoalToolConfig
  return { turnSource: c.turnSource, goalRound: c.goalRound }
}

/** Whether this is a "direct human request": the turn was initiated by a user message (auto-continuation rounds have the goal-round source) */
function isDirectHuman(cfg: GoalToolConfig): boolean {
  return cfg.turnSource !== 'goal-round'
}

/** Whether this exactly matches the current goal round (the goal source carried by an auto-continuation round equals the current goal) */
function isExactGoalRound(cfg: GoalToolConfig, goal: GoalView): boolean {
  if (cfg.turnSource !== 'goal-round' || !cfg.goalRound) return false
  return (
    cfg.goalRound.goalId === goal.id &&
    cfg.goalRound.revision === goal.revision &&
    cfg.goalRound.round === goal.roundsStarted
  )
}

/** Goal view → tool return text (JSON-serialized, shared by the model and the frontend) */
function formatGoal(view: GoalView | null): string {
  if (!view) return JSON.stringify({ goal: null })
  return JSON.stringify({ goal: view })
}

/**
 * Build the goal tool set (injected into the main agent only; subagents do not hold goal tools).
 * Authority is validated at tool execution time.
 */
export function buildGoalTools(store: GoalStore, topicId: number): StructuredToolInterface[] {
  const getCurrent = (): Promise<GoalView | null> => store.load(topicId)

  return [
    tool(
      async ({ objective, max_goal_rounds }, config) => {
        const m = getAgentToolTexts()
        const cfg = readToolConfig((config?.configurable ?? {}) as Record<string, unknown>)
        if (!isDirectHuman(cfg)) {
          return m.goal.createRequiresHumanRequest
        }
        try {
          const view = await store.create(topicId, objective, max_goal_rounds)
          return formatGoal(view)
        } catch (err) {
          return mainFormat(m.goal.createFailed, { message: (err as Error).message })
        }
      },
      {
        name: 'create_goal',
        description:
          'Create a long-running goal that advances automatically across turns: each round auto-continues until the goal is completed, blocked, or the round limit is reached. Only one goal may be in progress at a time; an existing goal must first be complete or blocked before a new one can be created. Use only when the user expresses a clear long-horizon intent; do not create a goal for simple Q&A.',
        schema: z.object({
          objective: z
            .string()
            .describe(
              'Concrete objective to achieve: an outcome that can be verified independently'
            ),
          max_goal_rounds: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(`Round limit for auto-continuation (default ${DEFAULT_MAX_GOAL_ROUNDS})`)
        })
      }
    ),
    tool(
      async () => {
        try {
          const view = await getCurrent()
          return formatGoal(view)
        } catch (err) {
          return mainFormat(getAgentToolTexts().goal.readFailed, {
            message: (err as Error).message
          })
        }
      },
      {
        name: 'get_goal',
        description:
          'Read the current goal state for this topic (id/revision/phase/rounds and so on).',
        schema: z.object({})
      }
    ),
    tool(
      async ({ goal_id, revision, action, objective, max_goal_rounds, blocked_reason }, config) => {
        const m = getAgentToolTexts()
        const cfg = readToolConfig((config?.configurable ?? {}) as Record<string, unknown>)
        try {
          const current = await getCurrent()
          if (!current) return m.goal.noGoal

          // authority: edit/pause/resume require a direct human request;
          // complete/blocked allow a direct human request or an exact match of the current goal
          // round (an auto-continuation round)
          const direct = isDirectHuman(cfg)
          const exactRound = isExactGoalRound(cfg, current)
          if (action === 'edit' || action === 'pause' || action === 'resume') {
            if (!direct) {
              return mainFormat(m.goal.requiresHumanRequest, { action })
            }
          } else if (action === 'complete' || action === 'blocked') {
            if (!direct && !exactRound) {
              return mainFormat(m.goal.notAuthorized, { action })
            }
            if (action === 'blocked' && !direct && current.roundsStarted < MIN_ROUNDS_FOR_BLOCK) {
              return mainFormat(m.goal.blockedMinRounds, {
                minRounds: MIN_ROUNDS_FOR_BLOCK,
                rounds: current.roundsStarted
              })
            }
          }

          const view = await store.update(topicId, goal_id, revision, action, {
            objective,
            maxGoalRounds: max_goal_rounds,
            blockedReason: blocked_reason
              ? { code: blocked_reason.code, message: blocked_reason.message }
              : undefined
          })

          // Autonomous-round complete/blocked: inject wrap-up guidance (no hard truncation)
          if (!direct && exactRound && (action === 'complete' || action === 'blocked')) {
            const wrapup =
              action === 'complete'
                ? m.goal.wrapupComplete
                : mainFormat(m.goal.wrapupBlocked, {
                    code: view.blockedReason?.code ?? 'unspecified'
                  })
            return `${formatGoal(view)}\n\n${wrapup}`
          }
          return formatGoal(view)
        } catch (err) {
          return mainFormat(m.goal.updateFailed, { message: (err as Error).message })
        }
      },
      {
        name: 'update_goal',
        description:
          'Update the current goal. Actions: edit (change the objective or the round limit), pause (stop auto-continuation), resume (restore and resume auto-continuation), complete (mark as completed), blocked (mark as blocked; a reason is required). Always pass goal_id and the latest revision (call get_goal first). edit/pause/resume require a direct human request; complete/blocked may be called from an auto-continuation round (blocked then requires at least 3 rounds already started).',
        schema: z.object({
          goal_id: z.string().describe('Goal ID (from create_goal / get_goal)'),
          revision: z
            .number()
            .int()
            .positive()
            .describe('Current revision (a stale revision is rejected; call get_goal first)'),
          action: z
            .enum(['edit', 'pause', 'resume', 'complete', 'blocked'])
            .describe('Action to perform'),
          objective: z.string().optional().describe('(edit) New objective'),
          max_goal_rounds: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('(edit) New round limit'),
          blocked_reason: z
            .object({
              code: z
                .string()
                .describe(
                  'Stable lowercase kebab-case category, e.g. round-limit / model-reported / user-paused'
                ),
              message: z.string().describe('Explanation of the blocking condition')
            })
            .optional()
            .describe('(blocked) Reason the goal is blocked')
        })
      }
    )
  ]
}
