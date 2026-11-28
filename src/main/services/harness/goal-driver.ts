import logger from 'electron-log'
import { goalStore, MIN_ROUNDS_FOR_BLOCK } from '../../runtime/harness/goal'
import type { TurnMeta } from './types'
import { mainFormat } from '../../i18n'
import { getAgentToolTexts } from '../../i18n/tool-results-agent'

/**
 * Goal round driver (goal-round-driver)
 *
 * How it works (adapted to the structure that has no event bus):
 * - After a user turn completes, maybeDrive is called: when the goal is active + armed (in-memory
 *   armed state) and the round limit is not reached, the next round is launched automatically
 *   (injecting a <goal_round> message + goal source metadata);
 * - Round counting: roundsStarted means "auto-continuation rounds already started"; the user turn
 *   that created the goal does not count (goal.ts create sets roundsStarted=0), and an auto round
 *   is settled when dispatched (roundsStarted + 1, so the first continuation is round 1). This
 *   keeps the in-round update_goal(complete/blocked) "exact current goal round" check matching,
 *   and keeps the injected prompt's "round N/M", the message badge "round N" and the goal bar
 *   count consistent;
 * - Per-topic mutual exclusion: at most one auto round runs per topic at a time (user messages are
 *   serialized by the UI layer, so they do not actually overlap);
 * - User cancels an auto round → goal disarm (stops auto-continuation; waits for the user to ask
 *   "continue" → resume re-arms);
 * - Round limit reached → blocked(round-limit) and stop.
 */

/** Callback that runs one conversation round (injected by the IPC layer, reuses the runHarnessTurn pipeline) */
export type DriveTurnFn = (params: {
  topicId: number
  question: string
  turnMeta: TurnMeta
}) => Promise<{ topicId: number; cancelled: boolean }>

export class GoalRoundDriver {
  private readonly running = new Set<number>()

  isRunning(topicId: number): boolean {
    return this.running.has(topicId)
  }

  /**
   * Clear the set of topics that are "auto-continuing" (used when switching account data space).
   *
   * The normal path releases in maybeDrive's finally; this covers leftovers "running at the moment
   * of the switch", otherwise a topic with the same id in the new account would be misjudged as
   * "already continuing" and would never dispatch auto rounds.
   */
  reset(): void {
    this.running.clear()
  }

  /** Schedule after a turn ends: launch the next round automatically when conditions hold (dispatch in a loop until a stop condition) */
  async maybeDrive(topicId: number, drive: DriveTurnFn): Promise<void> {
    if (this.running.has(topicId)) return
    // Claim first, then await (fix: the claim used to happen after several awaits, leaving a race
    // window between "guard passes" and "claim", so two concurrent completion points could
    // incrementRound twice and dispatch two auto rounds)
    this.running.add(topicId)
    try {
      while (await this.driveOnce(topicId, drive)) {
        // A round completed without a stop condition: keep dispatching the next one
      }
    } finally {
      this.running.delete(topicId)
    }
  }

  /** Check and dispatch one round; true means this round was dispatched and completed and the next round should be checked */
  private async driveOnce(topicId: number, drive: DriveTurnFn): Promise<boolean> {
    const goal = await goalStore.load(topicId)
    if (!goal || goal.phase !== 'active' || !goalStore.isArmed(topicId)) {
      if (goal && goal.phase === 'active' && !goalStore.isArmed(topicId)) {
        logger.info(`[GoalDriver] topicId=${topicId} goal is active but not armed, not continuing automatically`)
      }
      return false
    }

    // Round limit reached: mark blocked(round-limit) and stop
    if (goal.roundsStarted >= goal.maxGoalRounds) {
      try {
        await goalStore.update(topicId, goal.id, goal.revision, 'blocked', {
          blockedReason: {
            code: 'round-limit',
            message: mainFormat(getAgentToolTexts().goalDriver.roundLimitReached, {
              rounds: goal.maxGoalRounds
            })
          }
        })
      } catch (err) {
        logger.warn('[GoalDriver] Failed to mark round-limit:', err)
      }
      return false
    }

    // Settle at dispatch: roundsStarted + 1 (round = the round number after settlement)
    const updated = await goalStore.incrementRound(topicId)
    if (!updated || updated.phase !== 'active') return false

    const round = updated.roundsStarted
    const question = `<goal_round>
Objective: ${updated.objective}
(Automatic continuation round ${round}/${updated.maxGoalRounds}. Keep pushing the objective forward — do not ask the user for confirmation.)
- If the objective is fully achieved: call update_goal(action: "complete").
- If you hit a blocker you cannot resolve on your own and at least ${MIN_ROUNDS_FOR_BLOCK} rounds have passed: call update_goal(action: "blocked", blocked_reason: { code, message }).
- Otherwise just keep working. When you finish, give a short summary of what this round accomplished.
</goal_round>`
    const turnMeta: TurnMeta = {
      source: 'goal-round',
      goalId: updated.id,
      goalRevision: updated.revision,
      goalRound: round,
      objective: updated.objective
    }

    logger.info(
      `[GoalDriver] Dispatching auto round topicId=${topicId} round=${round}/${updated.maxGoalRounds} goalId=${updated.id}`
    )
    try {
      const result = await drive({ topicId, question, turnMeta })
      if (result.cancelled) {
        // User cancelled the auto round: stop auto-continuation (armed → disarmed), goal stays active
        logger.info('[GoalDriver] Auto round cancelled by user, goal disarmed')
        goalStore.disarm(topicId)
        return false
      }
    } catch (err) {
      logger.warn('[GoalDriver] Auto round failed, goal disarmed:', err)
      goalStore.disarm(topicId)
      return false
    }

    return true
  }
}

/** Process-level singleton */
export const goalRoundDriver = new GoalRoundDriver()
